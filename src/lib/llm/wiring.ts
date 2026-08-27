/**
 * Production wiring for the chat path. One function, called by the Supabase Edge Function
 * (supabase/functions/chat) and by the CLI runner (scripts/chat.ts), so both run the same
 * code and there is exactly one place where the environment is turned into dependencies.
 *
 * The environment is passed in, never read implicitly: on Deno it is Deno.env, on Node it
 * is process.env, and in tests it is a literal.
 *
 * Stage 3 part 1: the memory hook is wired when — and only when — the Voyage key is set
 * (config.ts is its only reader).
 * Without it the chat works exactly as in Stage 2 and every invocation logs a warning, so
 * "memory is off" is visible in the function logs rather than silent. A PRESENT but
 * malformed memory configuration is a CONFIG error like any other: the operator set it and
 * got it wrong, and a wrong cap must not be guessed at.
 */
import {
  createServiceClient,
  loadSupabaseAuthConfig,
  supabaseAuditWriter,
  supabaseVerifyDeps,
  type ServiceClient,
} from '../auth/clients.js';
import { ok, type ConfigError, type Result } from '../errors.js';
import { createHttpClient } from '../http.js';
import type { Logger } from '../logger.js';
import { supabaseChunkStore } from '../memory/chunks.js';
import {
  MEMORY_DISABLED_WARNING,
  hasVoyageKey,
  loadMemoryConfig,
  type MemoryConfig,
} from '../memory/config.js';
import { createVoyageEmbedder } from '../memory/embed.js';
import { supabaseFactStore } from '../memory/facts.js';
import { supabaseMemoryPageStore, type MemoryPageDeps } from '../memory/page.js';
import { recallForTurn, supabaseChunkSearch, type RecallDeps } from '../memory/retrieve.js';
import { createAfterTurnHook, type MemoryDeps } from '../memory/trigger.js';
import type { ChatDeps, TurnMemory } from './chat.js';
import { createClaudeClient, type ClaudeClient } from './client.js';
import { loadLlmConfig } from './config.js';
import { supabaseConversationStore, supabaseUsageStore } from './store.js';

type Env = Readonly<Record<string, string | undefined>>;

/** The memory layer's dependencies from one service client and the shared Claude client. */
export function createMemoryDeps(
  config: MemoryConfig,
  service: ServiceClient,
  claude: ClaudeClient,
  log: Logger,
): MemoryDeps {
  const http = createHttpClient({
    timeoutMs: config.voyage.timeoutMs,
    retries: config.voyage.retries,
    logger: log,
  });
  return {
    claude,
    embedder: createVoyageEmbedder({
      config: config.voyage,
      http,
      usage: supabaseUsageStore(service),
      log,
    }),
    chunks: supabaseChunkStore(service),
    policy: config.policy,
    log,
  };
}

export function createChatDeps(
  env: Env,
  log: Logger,
  waitUntil?: (work: Promise<void>) => void,
): Result<ChatDeps, ConfigError> {
  const supabase = loadSupabaseAuthConfig(env);
  if (!supabase.ok) return supabase;
  const llm = loadLlmConfig(env);
  if (!llm.ok) return llm;

  const service = createServiceClient(supabase.value);
  const http = createHttpClient({
    timeoutMs: llm.value.timeoutMs,
    // client.ts owns the retry policy (only provably-unbilled failures); http.ts must not
    // add a second layer on top.
    retries: 0,
    logger: log,
  });
  const claude = createClaudeClient({
    config: llm.value,
    http,
    usage: supabaseUsageStore(service),
    log,
  });

  let afterTurn: ChatDeps['afterTurn'];
  let memory: ChatDeps['memory'];
  if (hasVoyageKey(env)) {
    const config = loadMemoryConfig(env);
    if (!config.ok) return config;
    const memoryDeps = createMemoryDeps(config.value, service, claude, log);
    afterTurn = createAfterTurnHook(memoryDeps);
    memory = createTurnMemory(config.value, service, memoryDeps);
  } else {
    log.warn(MEMORY_DISABLED_WARNING);
  }

  return ok({
    verify: supabaseVerifyDeps(service),
    claude,
    conversations: supabaseConversationStore(service),
    log,
    history: llm.value.history,
    ...(afterTurn === undefined ? {} : { afterTurn }),
    ...(memory === undefined ? {} : { memory }),
    ...(waitUntil === undefined ? {} : { waitUntil }),
  });
}

/**
 * Stage 3 part 3: the memory page's write endpoint. Deliberately NOT dependent on the
 * Voyage key — nothing here embeds anything, so correcting or removing a note keeps working
 * on a day when memory itself is degraded, which is precisely the day someone wants to.
 * The Claude side is required: adding a note runs the same extractor as "remember that…".
 */
export function createMemoryPageDeps(env: Env, log: Logger): Result<MemoryPageDeps, ConfigError> {
  const supabase = loadSupabaseAuthConfig(env);
  if (!supabase.ok) return supabase;
  const llm = loadLlmConfig(env);
  if (!llm.ok) return llm;

  const service = createServiceClient(supabase.value);
  const http = createHttpClient({ timeoutMs: llm.value.timeoutMs, retries: 0, logger: log });
  return ok({
    verify: supabaseVerifyDeps(service),
    claude: createClaudeClient({
      config: llm.value,
      http,
      usage: supabaseUsageStore(service),
      log,
    }),
    facts: supabaseFactStore(service),
    store: supabaseMemoryPageStore(service),
    audit: supabaseAuditWriter(service),
    log,
  });
}

/** The on-path half of memory (part 2): recall for a turn, plus the fact-source back-fill. */
export function createTurnMemory(
  config: MemoryConfig,
  service: ServiceClient,
  memoryDeps: MemoryDeps,
): TurnMemory {
  const facts = supabaseFactStore(service);
  const recallDeps: RecallDeps = {
    claude: memoryDeps.claude,
    embedder: memoryDeps.embedder,
    facts,
    search: supabaseChunkSearch(service),
    config: config.retrieval,
    log: memoryDeps.log,
  };
  return {
    recall: (input) => recallForTurn(recallDeps, input),
    attachSource: (factId, messageId) => facts.setSource(factId, messageId),
  };
}
