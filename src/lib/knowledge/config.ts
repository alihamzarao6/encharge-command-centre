/**
 * Knowledge configuration (Milestone 5 part 5) — the server environment's numbers for
 * learning documents and retrieving them. Every value has a default that is the decision on
 * record, and a malformed value is a CONFIG error rather than a silent fallback.
 *
 * The defaults are set for the Voyage account AS IT IS (free plan, measured 16 Oct 2026):
 * three requests a minute and no Retry-After; a single request of about 39,000 characters
 * refused outright; 12,000 characters the only size that never failed, at 2 to 55 seconds.
 * So a batch is at most 12,000 characters, a run sends at most two of them 25 seconds apart
 * (the third request of each minute is left for the chat's own query), a refusal rests the
 * drain for 65 seconds, and nothing is retried inside a run.
 *
 * When a payment method is added to the Voyage account (2,000 requests a minute) NOTHING here
 * changes in code: raise KNOWLEDGE_EMBED_BATCH_CHARS (e.g. 100000), KNOWLEDGE_EMBED_REQUESTS_PER_RUN
 * (e.g. 20) and drop KNOWLEDGE_EMBED_GAP_MS to 0 in the function secrets. RUNBOOK says so.
 */
import { ConfigError, err, ok, type Result } from '../errors.js';

export interface KnowledgeEmbedConfig {
  /** Characters of chunk text (with headers) in one Voyage request. */
  readonly batchChars: number;
  /** Inputs in one request (Voyage allows 128). */
  readonly batchInputs: number;
  /** Voyage requests one drain run may send. */
  readonly requestsPerRun: number;
  /** Pause between two requests of one run. */
  readonly gapMs: number;
  /** One ingestion request may take this long (background work, not the reply's path). */
  readonly timeoutMs: number;
  /** After Voyage refuses (429, 5xx, timeout), nothing is sent for this long. */
  readonly cooldownSeconds: number;
  /** After Voyage says the key is wrong (401/403), nothing is sent for this long. */
  readonly authCooldownSeconds: number;
  /** How long one run may hold the drain. Longer than a run can take, shorter than a minute + run. */
  readonly leaseSeconds: number;
  /** Pending documents one run cuts into chunks (no Voyage call; a database write each). */
  readonly capturesPerRun: number;
}

export interface KnowledgeRetrievalConfig {
  /** Nearest chunks asked of the database for one turn. */
  readonly candidates: number;
  /** Cosine similarity floor for what was learned elsewhere. Below it a chunk is not about the question. */
  readonly minSimilarity: number;
  /** The floor for this conversation's own long attachments: the person is talking about them. */
  readonly attachedMinSimilarity: number;
  /** Chunks either side of a chosen one, added for continuity when there is room. */
  readonly neighbours: number;
  /** The shared query embedding must arrive inside this, or the turn goes without a search. */
  readonly queryTimeoutMs: number;
  /** Rewrite the message into a search query first (knowledge/query.ts). */
  readonly rewrite: boolean;
  /** The rewrite gets this long; past it the words as typed are searched. */
  readonly rewriteTimeoutMs: number;
  /** An overview question: how many documents' summaries it may draw on. */
  readonly overviewDocuments: number;
  /** An overview question: passages in full beside the summary, for exact figures and quotes. */
  readonly overviewDetailChars: number;
}

/**
 * The summary written once while a long document is learned (summarise.ts): what an overview
 * question — "break down week one" on a 33-page call transcript — is answered from.
 */
export interface KnowledgeSummaryConfig {
  readonly enabled: boolean;
  /** Documents with fewer characters of passages need none: they nearly fit a question whole. */
  readonly minChars: number;
  /** Pages are summarised in runs of about this many characters, one fast-model call each. */
  readonly blockChars: number;
  /** The most words one block's summary may have. */
  readonly maxWords: number;
  readonly maxTokens: number;
  /** Calls for one document at the same time. */
  readonly concurrency: number;
  /** One call may take this long. */
  readonly timeoutMs: number;
  /** After this many failed tries the document is learned without a summary. */
  readonly maxAttempts: number;
}

export interface KnowledgeConfig {
  readonly embed: KnowledgeEmbedConfig;
  readonly retrieval: KnowledgeRetrievalConfig;
  readonly summary: KnowledgeSummaryConfig;
}

export const KNOWLEDGE_DEFAULTS: KnowledgeConfig = Object.freeze({
  embed: Object.freeze({
    batchChars: 12_000,
    batchInputs: 32,
    requestsPerRun: 2,
    gapMs: 25_000,
    timeoutMs: 55_000,
    cooldownSeconds: 65,
    authCooldownSeconds: 900,
    leaseSeconds: 140,
    capturesPerRun: 5,
  }),
  retrieval: Object.freeze({
    candidates: 40,
    // Measured 17 Oct on a 33-page transcript (voyage-3): questions about it scored 0.33–0.49 on
    // the right pages, a topic it does not contain 0.27. 0.40 turned away right answers.
    minSimilarity: 0.3,
    // In the conversation a document is attached to, the person is talking about it: "week one
    // breakdown" scored 0.29 on the right pages before sections were labelled (17 Oct).
    attachedMinSimilarity: 0.2,
    neighbours: 1,
    queryTimeoutMs: 6_000,
    rewrite: true,
    rewriteTimeoutMs: 3_000,
    overviewDocuments: 3,
    overviewDetailChars: 6_000,
  }),
  summary: Object.freeze({
    enabled: true,
    // Half the per-question budget: below it, the passages of almost all of it reach a question.
    minChars: 24_000,
    // About seven pages of the client's transcript (5,700 characters a page): five calls for 33.
    blockChars: 40_000,
    maxWords: 350,
    // Room for the model overshooting 350 words (17 Oct): a reply cut off is asked for again.
    maxTokens: 1_200,
    concurrency: 3,
    timeoutMs: 45_000,
    maxAttempts: 3,
  }),
});

type Env = Readonly<Record<string, string | undefined>>;

function integer(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
): Result<number, ConfigError> {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return ok(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return err(
      new ConfigError(`${name} must be an integer from ${String(min)} to ${String(max)}`, {
        context: { name },
      }),
    );
  }
  return ok(value);
}

function fraction(env: Env, name: string, fallback: number): Result<number, ConfigError> {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return ok(fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return err(new ConfigError(`${name} must be between 0 and 1`, { context: { name } }));
  }
  return ok(value);
}

export function loadKnowledgeConfig(env: Env = process.env): Result<KnowledgeConfig, ConfigError> {
  const d = KNOWLEDGE_DEFAULTS;
  const batchChars = integer(
    env,
    'KNOWLEDGE_EMBED_BATCH_CHARS',
    d.embed.batchChars,
    2_000,
    400_000,
  );
  if (!batchChars.ok) return batchChars;
  const batchInputs = integer(env, 'KNOWLEDGE_EMBED_BATCH_INPUTS', d.embed.batchInputs, 1, 128);
  if (!batchInputs.ok) return batchInputs;
  const requests = integer(env, 'KNOWLEDGE_EMBED_REQUESTS_PER_RUN', d.embed.requestsPerRun, 1, 100);
  if (!requests.ok) return requests;
  const gapMs = integer(env, 'KNOWLEDGE_EMBED_GAP_MS', d.embed.gapMs, 0, 60_000);
  if (!gapMs.ok) return gapMs;
  const timeoutMs = integer(env, 'KNOWLEDGE_EMBED_TIMEOUT_MS', d.embed.timeoutMs, 1_000, 120_000);
  if (!timeoutMs.ok) return timeoutMs;
  const cooldown = integer(env, 'KNOWLEDGE_COOLDOWN_SECONDS', d.embed.cooldownSeconds, 1, 3_600);
  if (!cooldown.ok) return cooldown;
  const authCooldown = integer(
    env,
    'KNOWLEDGE_AUTH_COOLDOWN_SECONDS',
    d.embed.authCooldownSeconds,
    60,
    86_400,
  );
  if (!authCooldown.ok) return authCooldown;
  const lease = integer(env, 'KNOWLEDGE_LEASE_SECONDS', d.embed.leaseSeconds, 10, 600);
  if (!lease.ok) return lease;
  const captures = integer(env, 'KNOWLEDGE_CAPTURES_PER_RUN', d.embed.capturesPerRun, 1, 50);
  if (!captures.ok) return captures;
  const candidates = integer(env, 'KNOWLEDGE_RETRIEVAL_CANDIDATES', d.retrieval.candidates, 1, 200);
  if (!candidates.ok) return candidates;
  const floor = fraction(env, 'KNOWLEDGE_RETRIEVAL_MIN_SIMILARITY', d.retrieval.minSimilarity);
  if (!floor.ok) return floor;
  const attachedFloor = fraction(
    env,
    'KNOWLEDGE_RETRIEVAL_ATTACHED_MIN_SIMILARITY',
    d.retrieval.attachedMinSimilarity,
  );
  if (!attachedFloor.ok) return attachedFloor;
  const neighbours = integer(env, 'KNOWLEDGE_RETRIEVAL_NEIGHBOURS', d.retrieval.neighbours, 0, 3);
  if (!neighbours.ok) return neighbours;
  const queryTimeout = integer(
    env,
    'KNOWLEDGE_QUERY_TIMEOUT_MS',
    d.retrieval.queryTimeoutMs,
    500,
    30_000,
  );
  if (!queryTimeout.ok) return queryTimeout;
  const rewriteTimeout = integer(
    env,
    'KNOWLEDGE_QUERY_REWRITE_TIMEOUT_MS',
    d.retrieval.rewriteTimeoutMs,
    200,
    20_000,
  );
  if (!rewriteTimeout.ok) return rewriteTimeout;
  const summaryMin = integer(env, 'KNOWLEDGE_SUMMARY_MIN_CHARS', d.summary.minChars, 0, 10_000_000);
  if (!summaryMin.ok) return summaryMin;
  const summaryBlock = integer(
    env,
    'KNOWLEDGE_SUMMARY_BLOCK_CHARS',
    d.summary.blockChars,
    5_000,
    150_000,
  );
  if (!summaryBlock.ok) return summaryBlock;
  const summaryRaw = env['KNOWLEDGE_SUMMARY']?.trim();
  if (
    summaryRaw !== undefined &&
    summaryRaw !== '' &&
    summaryRaw !== 'on' &&
    summaryRaw !== 'off'
  ) {
    return err(
      new ConfigError('KNOWLEDGE_SUMMARY must be "on" or "off"', {
        context: { name: 'KNOWLEDGE_SUMMARY' },
      }),
    );
  }
  const rewriteRaw = env['KNOWLEDGE_QUERY_REWRITE']?.trim();
  if (
    rewriteRaw !== undefined &&
    rewriteRaw !== '' &&
    rewriteRaw !== 'on' &&
    rewriteRaw !== 'off'
  ) {
    return err(
      new ConfigError('KNOWLEDGE_QUERY_REWRITE must be "on" or "off"', {
        context: { name: 'KNOWLEDGE_QUERY_REWRITE' },
      }),
    );
  }
  return ok({
    embed: {
      batchChars: batchChars.value,
      batchInputs: batchInputs.value,
      requestsPerRun: requests.value,
      gapMs: gapMs.value,
      timeoutMs: timeoutMs.value,
      cooldownSeconds: cooldown.value,
      authCooldownSeconds: authCooldown.value,
      leaseSeconds: lease.value,
      capturesPerRun: captures.value,
    },
    retrieval: {
      candidates: candidates.value,
      minSimilarity: floor.value,
      attachedMinSimilarity: attachedFloor.value,
      neighbours: neighbours.value,
      queryTimeoutMs: queryTimeout.value,
      rewrite:
        rewriteRaw === undefined || rewriteRaw === '' ? d.retrieval.rewrite : rewriteRaw === 'on',
      rewriteTimeoutMs: rewriteTimeout.value,
      overviewDocuments: d.retrieval.overviewDocuments,
      overviewDetailChars: d.retrieval.overviewDetailChars,
    },
    summary: {
      ...d.summary,
      enabled:
        summaryRaw === undefined || summaryRaw === '' ? d.summary.enabled : summaryRaw === 'on',
      minChars: summaryMin.value,
      blockChars: summaryBlock.value,
    },
  });
}
