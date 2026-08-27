/**
 * Memory-layer configuration (Stage 3 part 1, FND-300) — SERVER environment only.
 *
 * This is the only module in the repository that reads VOYAGE_API_KEY
 * (tests/security/voyage-key.test.ts asserts it, the same rule as the Anthropic key). The key
 * is held in the returned config and used by embed.ts to set one request header; it is
 * never logged (the logger redacts `Authorization` by key name, `Bearer …` and the `pa-`
 * key shape by pattern), never returned, never part of an error message.
 *
 * Voyage gets its OWN spend caps rather than sharing the Anthropic ones. Reasoning
 * (MEMORY.md, 26 Aug): the Anthropic cap is the $50 promise the client holds and is read
 * from the ledger per provider; folding Voyage into it would mean widening every
 * `spentSince('anthropic')` read and re-proving the part-4 cap tests for no gain, because
 * Voyage at $0.06 per million tokens cannot threaten $50 — the only way it spends real
 * money is a runaway loop making thousands of calls, and a SMALL cap of its own trips on
 * that far sooner than a shared $50 would. The Haiku summariser goes through the existing
 * Claude client and is therefore under the Anthropic cap automatically. The client's
 * total ceiling is the sum of the two, stated in SECURITY.md §8.
 *
 * A missing key is NOT a configuration error for the chat path: the memory hook is simply
 * not wired (wiring.ts logs a warning on every invocation) and the assistant keeps
 * answering. The key is a client deliverable (R5) that may arrive after this code ships.
 */
import { ConfigError, err, ok, type Result } from '../errors.js';
import type { SpendCaps } from '../llm/spend.js';

export interface VoyageConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  /** Must equal the `memory_chunks.embedding` column width. */
  readonly dimensions: number;
  readonly timeoutMs: number;
  /** Retries after the first attempt; embeddings are idempotent so http.ts may retry. */
  readonly retries: number;
  /** USD per 1,000,000 input tokens. Voyage bills input only. */
  readonly pricePerMTok: number;
  readonly caps: SpendCaps;
}

/** The chunking policy knobs. Pure numbers; policy.ts turns them into ranges. */
export interface MemoryPolicyConfig {
  /** Messages per chunk. A chunk is written once this many are uncovered. */
  readonly chunkMessages: number;
  /** Smallest tail the idle rule will summarise (a lone user message is not memory). */
  readonly minTailMessages: number;
  /** An uncovered tail whose newest message is older than this is a closed episode. */
  readonly idleHours: number;
  /** Chunks written per trigger, so a long backlog is paid for over several turns. */
  readonly maxChunksPerTrigger: number;
  /** Hard ceiling on the summary text stored (characters). */
  readonly summaryMaxChars: number;
}

/**
 * Retrieval knobs (part 2). Characters, not tokens, like the history bounds: a hard
 * ceiling an operator can reason about. Everything recalled sits BELOW the cache
 * breakpoint and inside `MAX_BELOW_BREAKPOINT_CHARS` (4,000, voice/prompt.ts); the
 * defaults are chosen so the worst case renders inside it without truncation.
 */
export interface RetrievalConfig {
  /** Nearest chunks asked of the database; fewer may clear the floor. */
  readonly topK: number;
  /** Cosine similarity floor. Below it a chunk is noise, not memory. */
  readonly minSimilarity: number;
  /** Rendered characters of chunk notes per turn; lowest similarity is dropped first. */
  readonly chunkBudgetChars: number;
  /** Rendered characters of facts per turn; the oldest is dropped first. */
  readonly factBudgetChars: number;
  readonly maxFacts: number;
  /** The whole recall step (capture + embed + search) must finish inside this, or the turn goes without. */
  readonly timeoutMs: number;
}

export interface MemoryConfig {
  readonly voyage: VoyageConfig;
  readonly policy: MemoryPolicyConfig;
  readonly retrieval: RetrievalConfig;
}

export const VOYAGE_API_BASE_URL = 'https://api.voyageai.com';

export const VOYAGE_DEFAULTS = {
  model: 'voyage-3',
  dimensions: 1024,
  timeoutMs: 20_000,
  retries: 2,
  /** Voyage list price for voyage-3, 26 Aug 2026: $0.06 per million tokens. */
  pricePerMTok: 0.06,
  dailyCapUsd: 0.5,
  monthlyCapUsd: 5,
  warnFraction: 0.8,
} as const;

export const POLICY_DEFAULTS: MemoryPolicyConfig = Object.freeze({
  chunkMessages: 10,
  minTailMessages: 2,
  idleHours: 24,
  maxChunksPerTrigger: 3,
  summaryMaxChars: 2_000,
});

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function readNumber(
  env: Env,
  name: string,
  fallback: number,
  predicate: (n: number) => boolean,
  requirement: string,
): Result<number, ConfigError> {
  const raw = read(env, name);
  if (raw === undefined) return ok(fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || !predicate(value)) {
    return err(new ConfigError(`${name} must be ${requirement}`, { context: { name } }));
  }
  return ok(value);
}

const positiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;
const nonNegative = (n: number): boolean => n >= 0;

/** Logged by the wiring on every invocation that runs without the key. */
export const MEMORY_DISABLED_WARNING =
  'memory layer disabled: VOYAGE_API_KEY is not set (Stage 3, R5); the chat runs without memory';

/** True when the environment carries a Voyage key at all — the switch for the memory hook. */
export function hasVoyageKey(env: Env): boolean {
  return read(env, 'VOYAGE_API_KEY') !== undefined;
}

export function loadVoyageConfig(env: Env = process.env): Result<VoyageConfig, ConfigError> {
  const apiKey = read(env, 'VOYAGE_API_KEY');
  if (apiKey === undefined) {
    return err(new ConfigError('VOYAGE_API_KEY is required (server environment only)'));
  }
  const baseUrl = read(env, 'VOYAGE_BASE_URL') ?? VOYAGE_API_BASE_URL;
  if (!baseUrl.startsWith('https://')) {
    return err(new ConfigError('VOYAGE_BASE_URL must be an https URL'));
  }
  const dimensions = readNumber(
    env,
    'VOYAGE_DIMENSIONS',
    VOYAGE_DEFAULTS.dimensions,
    positiveInt,
    'a positive integer',
  );
  if (!dimensions.ok) return dimensions;
  const timeoutMs = readNumber(
    env,
    'VOYAGE_TIMEOUT_MS',
    VOYAGE_DEFAULTS.timeoutMs,
    positiveInt,
    'a positive integer',
  );
  if (!timeoutMs.ok) return timeoutMs;
  const retries = readNumber(
    env,
    'VOYAGE_RETRIES',
    VOYAGE_DEFAULTS.retries,
    (n) => Number.isInteger(n) && n >= 0 && n <= 5,
    'an integer from 0 to 5',
  );
  if (!retries.ok) return retries;
  const price = readNumber(
    env,
    'VOYAGE_PRICE_PER_MTOK',
    VOYAGE_DEFAULTS.pricePerMTok,
    nonNegative,
    '>= 0',
  );
  if (!price.ok) return price;
  // Caps DO have defaults here, unlike Anthropic's: they are small, the ledger is the
  // same, and an operator who sets the key without thinking about Voyage money should get
  // a cap that trips on a loop, not an unlimited one — and not a refusal of every call.
  const daily = readNumber(
    env,
    'VOYAGE_DAILY_SPEND_CAP_USD',
    VOYAGE_DEFAULTS.dailyCapUsd,
    nonNegative,
    '>= 0',
  );
  if (!daily.ok) return daily;
  const monthly = readNumber(
    env,
    'VOYAGE_MONTHLY_SPEND_CAP_USD',
    VOYAGE_DEFAULTS.monthlyCapUsd,
    nonNegative,
    '>= 0',
  );
  if (!monthly.ok) return monthly;
  const warn = readNumber(
    env,
    'VOYAGE_SPEND_WARN_FRACTION',
    VOYAGE_DEFAULTS.warnFraction,
    (n) => n > 0 && n <= 1,
    'between 0 and 1',
  );
  if (!warn.ok) return warn;

  return ok({
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model: read(env, 'VOYAGE_MODEL') ?? VOYAGE_DEFAULTS.model,
    dimensions: dimensions.value,
    timeoutMs: timeoutMs.value,
    retries: retries.value,
    pricePerMTok: price.value,
    caps: { dailyUsd: daily.value, monthlyUsd: monthly.value, warnFraction: warn.value },
  });
}

export function loadMemoryPolicy(env: Env = process.env): Result<MemoryPolicyConfig, ConfigError> {
  const chunk = readNumber(
    env,
    'MEMORY_CHUNK_MESSAGES',
    POLICY_DEFAULTS.chunkMessages,
    (n) => Number.isInteger(n) && n >= 2 && n <= 100,
    'an integer from 2 to 100',
  );
  if (!chunk.ok) return chunk;
  const minTail = readNumber(
    env,
    'MEMORY_MIN_TAIL_MESSAGES',
    POLICY_DEFAULTS.minTailMessages,
    (n) => Number.isInteger(n) && n >= 1 && n <= chunk.value,
    `an integer from 1 to MEMORY_CHUNK_MESSAGES (${chunk.value})`,
  );
  if (!minTail.ok) return minTail;
  const idle = readNumber(env, 'MEMORY_IDLE_HOURS', POLICY_DEFAULTS.idleHours, nonNegative, '>= 0');
  if (!idle.ok) return idle;
  const perTrigger = readNumber(
    env,
    'MEMORY_MAX_CHUNKS_PER_TRIGGER',
    POLICY_DEFAULTS.maxChunksPerTrigger,
    (n) => Number.isInteger(n) && n >= 1 && n <= 20,
    'an integer from 1 to 20',
  );
  if (!perTrigger.ok) return perTrigger;
  const maxChars = readNumber(
    env,
    'MEMORY_SUMMARY_MAX_CHARS',
    POLICY_DEFAULTS.summaryMaxChars,
    (n) => Number.isInteger(n) && n >= 200,
    'an integer >= 200',
  );
  if (!maxChars.ok) return maxChars;
  return ok({
    chunkMessages: chunk.value,
    minTailMessages: minTail.value,
    idleHours: idle.value,
    maxChunksPerTrigger: perTrigger.value,
    summaryMaxChars: maxChars.value,
  });
}

export const RETRIEVAL_DEFAULTS: RetrievalConfig = Object.freeze({
  topK: 3,
  minSimilarity: 0.45,
  chunkBudgetChars: 2_000,
  factBudgetChars: 900,
  maxFacts: 12,
  timeoutMs: 4_000,
});

export function loadRetrievalConfig(env: Env = process.env): Result<RetrievalConfig, ConfigError> {
  const topK = readNumber(
    env,
    'MEMORY_RETRIEVAL_TOP_K',
    RETRIEVAL_DEFAULTS.topK,
    (n) => Number.isInteger(n) && n >= 0 && n <= 10,
    'an integer from 0 to 10',
  );
  if (!topK.ok) return topK;
  const floor = readNumber(
    env,
    'MEMORY_RETRIEVAL_MIN_SIMILARITY',
    RETRIEVAL_DEFAULTS.minSimilarity,
    (n) => n >= 0 && n <= 1,
    'between 0 and 1',
  );
  if (!floor.ok) return floor;
  const chunkChars = readNumber(
    env,
    'MEMORY_RETRIEVAL_CHUNK_CHARS',
    RETRIEVAL_DEFAULTS.chunkBudgetChars,
    (n) => Number.isInteger(n) && n >= 0 && n <= 2_600,
    'an integer from 0 to 2600',
  );
  if (!chunkChars.ok) return chunkChars;
  const factChars = readNumber(
    env,
    'MEMORY_RETRIEVAL_FACT_CHARS',
    RETRIEVAL_DEFAULTS.factBudgetChars,
    (n) => Number.isInteger(n) && n >= 0 && n <= 1_200,
    'an integer from 0 to 1200',
  );
  if (!factChars.ok) return factChars;
  const maxFacts = readNumber(
    env,
    'MEMORY_RETRIEVAL_MAX_FACTS',
    RETRIEVAL_DEFAULTS.maxFacts,
    (n) => Number.isInteger(n) && n >= 0 && n <= 50,
    'an integer from 0 to 50',
  );
  if (!maxFacts.ok) return maxFacts;
  const timeoutMs = readNumber(
    env,
    'MEMORY_RECALL_TIMEOUT_MS',
    RETRIEVAL_DEFAULTS.timeoutMs,
    positiveInt,
    'a positive integer',
  );
  if (!timeoutMs.ok) return timeoutMs;
  return ok({
    topK: topK.value,
    minSimilarity: floor.value,
    chunkBudgetChars: chunkChars.value,
    factBudgetChars: factChars.value,
    maxFacts: maxFacts.value,
    timeoutMs: timeoutMs.value,
  });
}

export function loadMemoryConfig(env: Env = process.env): Result<MemoryConfig, ConfigError> {
  const voyage = loadVoyageConfig(env);
  if (!voyage.ok) return voyage;
  const policy = loadMemoryPolicy(env);
  if (!policy.ok) return policy;
  const retrieval = loadRetrievalConfig(env);
  if (!retrieval.ok) return retrieval;
  return ok({ voyage: voyage.value, policy: policy.value, retrieval: retrieval.value });
}
