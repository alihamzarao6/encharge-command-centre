/**
 * Production wiring for knowledge (Milestone 5 part 5): the one place the environment becomes
 * the drain's, the search's and the per-turn query's dependencies. The environment is passed in,
 * never read implicitly — Deno.env on an Edge Function, process.env in a script, a literal in a
 * test.
 *
 * Two Voyage embedders are built here, neither of them the memory summariser's:
 *
 *   * the INGESTION embedder — no retries (a retried 429 is three requests where one was
 *     refused; the queue rests instead) and a long timeout (55 s: it runs behind `waitUntil` or
 *     on the schedule, never on the reply's path);
 *   * the QUERY embedder — no retries and a short timeout, because it IS on the reply's path:
 *     past `queryTimeoutMs` the turn goes without a search, and says so.
 *
 * Both go through embed.ts, so both are under the Voyage spend caps and both write api_usage.
 * Without a Voyage key nothing here is built and the chat runs without knowledge.
 */
import {
  createServiceClient,
  loadSupabaseAuthConfig,
  type SupabaseAuthConfig,
} from '../auth/clients.js';
import { TimeoutError, err, ok, type ConfigError, type Result } from '../errors.js';
import type { TurnKnowledge } from '../files/context.js';
import { createHttpClient } from '../http.js';
import type { TurnQuery, TurnQueryInput, TurnSearch } from '../llm/chat.js';
import { createClaudeClient, type ClaudeClient } from '../llm/client.js';
import { loadLlmConfig } from '../llm/config.js';
import { supabaseUsageStore } from '../llm/store.js';
import type { Logger } from '../logger.js';
import { hasVoyageKey, loadVoyageConfig, type VoyageConfig } from '../memory/config.js';
import { createVoyageEmbedder, type Embedder } from '../memory/embed.js';
import { RECALL_OPERATION } from '../memory/retrieve.js';
import { loadKnowledgeConfig, type KnowledgeConfig } from './config.js';
import type { KnowledgeIngestDeps } from './ingest.js';
import { MAX_QUERY_NAMES, asksForOverview, searchTextFor, type SearchText } from './query.js';
import { createKnowledgeServiceClient, supabaseKnowledgeStore } from './store.js';

type Env = Readonly<Record<string, string | undefined>>;

/** The drain's dependencies, or null when there is no Voyage key (nothing can be learned). */
export function createKnowledgeIngest(
  env: Env,
  log: Logger,
): Result<KnowledgeIngestDeps | null, ConfigError> {
  if (!hasVoyageKey(env)) return ok(null);
  const supabase = loadSupabaseAuthConfig(env);
  if (!supabase.ok) return supabase;
  const voyage = loadVoyageConfig(env);
  if (!voyage.ok) return voyage;
  const knowledge = loadKnowledgeConfig(env);
  if (!knowledge.ok) return knowledge;
  const timeoutMs = knowledge.value.embed.timeoutMs;
  const usage = supabaseUsageStore(createServiceClient(supabase.value));
  // Summaries need the fast model; without an Anthropic key a document is learned without one.
  const llm = loadLlmConfig(env);
  const summaries =
    llm.ok && knowledge.value.summary.enabled
      ? {
          claude: createClaudeClient({
            config: llm.value,
            http: createHttpClient({ timeoutMs: llm.value.timeoutMs, retries: 0, logger: log }),
            usage,
            log,
          }),
          config: knowledge.value.summary,
        }
      : undefined;
  return ok({
    store: supabaseKnowledgeStore(createKnowledgeServiceClient(supabase.value)),
    embedder: createVoyageEmbedder({
      config: { ...voyage.value, retries: 0, timeoutMs },
      http: createHttpClient({ timeoutMs, retries: 0, logger: log }),
      usage,
      log,
    }),
    config: knowledge.value.embed,
    ...(summaries === undefined ? {} : { summaries }),
    log,
  });
}

/** The turn's query embedder: one request, no retries, bounded by `timeoutMs`. */
export function createTurnQuery(
  voyage: VoyageConfig,
  supabase: SupabaseAuthConfig,
  timeoutMs: number,
  log: Logger,
  rewrite?: QueryRewrite,
): TurnQuery {
  return queryFromEmbedder(
    createVoyageEmbedder({
      config: { ...voyage, retries: 0, timeoutMs },
      http: createHttpClient({ timeoutMs, retries: 0, logger: log }),
      usage: supabaseUsageStore(createServiceClient(supabase)),
      log,
    }),
    timeoutMs,
    rewrite,
  );
}

/** The search rewrite (knowledge/query.ts): the fast model, and where the names come from. */
export interface QueryRewrite {
  readonly claude: ClaudeClient;
  readonly names: () => Promise<Result<readonly string[]>>;
  readonly timeoutMs: number;
  readonly log: Logger;
}

/**
 * The per-turn query over any embedder, bounded as a whole — the ledger read before the request
 * counts too. The terminal (`npm run knowledge`) builds it over an embedder with an in-memory
 * ledger; production over the one above.
 */
export function queryFromEmbedder(
  embedder: Embedder,
  timeoutMs: number,
  rewrite?: QueryRewrite,
): TurnQuery {
  const textFor = async (input: TurnQueryInput): Promise<SearchText> => {
    if (rewrite === undefined)
      return {
        text: input.text,
        outcome: 'skipped',
        aboutDocuments: null,
        overview: asksForOverview(input.message),
      };
    const names = await rewrite.names();
    return searchTextFor(
      { claude: rewrite.claude, log: rewrite.log, timeoutMs: rewrite.timeoutMs },
      {
        message: input.message,
        previousUserMessage: input.previousUserMessage,
        documentNames: names.ok ? names.value : [],
        userId: input.userId,
        conversationId: input.conversationId,
      },
      input.text,
    );
  };
  return {
    embed: async (input) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The ledger read before the request counts too: the whole thing is bounded.
      const deadline = new Promise<Result<TurnSearch>>((resolve) => {
        timer = setTimeout(() => {
          resolve(err(new TimeoutError('query embedding took too long', timeoutMs)));
        }, timeoutMs);
      });
      const work = textFor(input).then(async (searched): Promise<Result<TurnSearch>> => {
        const embedded = await embedder.embed({
          texts: [searched.text],
          inputType: 'query',
          operation: RECALL_OPERATION,
          userId: input.userId,
          conversationId: input.conversationId,
        });
        if (!embedded.ok) return embedded;
        const vector = embedded.value.vectors[0];
        return vector === undefined
          ? err(new TimeoutError('query embedding returned nothing', timeoutMs))
          : ok({
              vector,
              text: searched.text,
              aboutDocuments: searched.aboutDocuments,
              overview: searched.overview,
            });
      });
      const result = await Promise.race([work, deadline]);
      clearTimeout(timer);
      return result;
    },
  };
}

/** What the chat's document loading needs to search what was learned. */
export function createTurnKnowledge(
  supabase: SupabaseAuthConfig,
  config: KnowledgeConfig,
  log: Logger,
): TurnKnowledge {
  const store = supabaseKnowledgeStore(createKnowledgeServiceClient(supabase));
  return {
    sourcesForFiles: (ids) => store.sourcesForFiles(ids),
    match: (query, params) => store.match(query, params),
    neighbours: (sourceId, ordinals) => store.neighbours(sourceId, ordinals),
    summaries: (sourceId) => store.summariesOf(sourceId),
    anyReady: () => store.anyReady(),
    config: config.retrieval,
    log: log.child({ component: 'knowledge.retrieve' }),
  };
}

/** Everything the chat path needs from knowledge, or null without a Voyage key. */
export function createChatKnowledge(
  env: Env,
  log: Logger,
  claude?: ClaudeClient,
): Result<{ readonly knowledge: TurnKnowledge; readonly query: TurnQuery } | null, ConfigError> {
  if (!hasVoyageKey(env)) return ok(null);
  const supabase = loadSupabaseAuthConfig(env);
  if (!supabase.ok) return supabase;
  const voyage = loadVoyageConfig(env);
  if (!voyage.ok) return voyage;
  const config = loadKnowledgeConfig(env);
  if (!config.ok) return config;
  const store = supabaseKnowledgeStore(createKnowledgeServiceClient(supabase.value));
  const rewrite: QueryRewrite | undefined =
    claude === undefined || !config.value.retrieval.rewrite
      ? undefined
      : {
          claude,
          names: () => store.recentNames(MAX_QUERY_NAMES),
          timeoutMs: config.value.retrieval.rewriteTimeoutMs,
          log,
        };
  return ok({
    knowledge: createTurnKnowledge(supabase.value, config.value, log),
    query: createTurnQuery(
      voyage.value,
      supabase.value,
      config.value.retrieval.queryTimeoutMs,
      log,
      rewrite,
    ),
  });
}
