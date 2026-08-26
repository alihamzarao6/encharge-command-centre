/**
 * Voyage AI adapter (Stage 3 part 1). One entry point, `embed()`, with the same gates as
 * the Claude client because it spends the client's money the same way:
 *
 *   1. price the call (chars ÷ 3 pessimistic tokens × the per-million rate);
 *   2. read Voyage spend-to-date for the UTC day and month from `api_usage`; if the ledger
 *      cannot answer, REFUSE (fail closed);
 *   3. check spent + this call's worst case against the Voyage caps BEFORE any request
 *      leaves the process — a refusal is a typed SpendCapError and makes no HTTP call;
 *   4. POST /v1/embeddings through src/lib/http.ts with timeout, per-origin breaker, and
 *      — unlike the Messages call — retries with backoff and jitter, because an embedding
 *      is idempotent: the same text yields the same vector, and the worst a retried
 *      attempt can do is bill the same few hundred tokens twice (≈ $0.00002);
 *   5. validate the response (Zod: count, dimensions, finite numbers) — a vector of the
 *      wrong width must never reach the 1024-wide column;
 *   6. record EVERY billed or possibly-billed call in api_usage under provider 'voyage'
 *      with the wire token count — success, a malformed 200, and timeouts/transport
 *      failures after the request was sent (as the worst-case reservation).
 *
 * The key is set as one request header and appears nowhere else: not in a return value,
 * not in an error (transport messages are redacted), not in a log field (the logger
 * redacts `Authorization` by name and `Bearer …` / `pa-…` by pattern).
 */
import { z } from 'zod';

import {
  HttpStatusError,
  NetworkError,
  TimeoutError,
  ValidationError,
  err,
  ok,
  type AppError,
  type CircuitOpenError,
  type ConfigError,
  type Result,
} from '../errors.js';
import { parseJsonBody, parseRetryAfterMs, type HttpClient } from '../http.js';
import { redactString, type Logger } from '../logger.js';
import type { Alerter, UsageRecord, UsageStore } from '../llm/client.js';
import { RateLimitedError, SpendCapError } from '../llm/errors.js';
import { estimateInputTokens, roundUsd } from '../llm/pricing.js';
import { checkSpendCap, utcDayStart, utcMonthStart, type SpentSoFar } from '../llm/spend.js';
import type { VoyageConfig } from './config.js';

export type EmbeddingInputType = 'document' | 'query';

export interface EmbeddingRequest {
  readonly texts: readonly string[];
  /** `document` for stored chunks, `query` for retrieval (part 2). Voyage tunes on it. */
  readonly inputType: EmbeddingInputType;
  /** Recorded in api_usage.operation, e.g. `memory.embed`. */
  readonly operation: string;
  readonly userId: string | null;
  readonly conversationId: string | null;
}

export interface Embedding {
  /** One vector per input text, in order, each exactly `config.dimensions` wide. */
  readonly vectors: readonly (readonly number[])[];
  readonly model: string;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly attempts: number;
}

export type EmbedError =
  | SpendCapError
  | RateLimitedError
  | TimeoutError
  | NetworkError
  | HttpStatusError
  | CircuitOpenError
  | ValidationError
  | ConfigError
  | AppError;

export interface Embedder {
  embed(request: EmbeddingRequest): Promise<Result<Embedding, EmbedError>>;
  /**
   * Would a call of about `chars` characters be allowed right now? The cap check alone,
   * with no request. The trigger asks this BEFORE paying for a summary, so a tripped Voyage
   * cap refuses the whole chunk instead of buying a summary it cannot store.
   */
  checkBudget(chars: number): Promise<Result<void, EmbedError>>;
}

export interface VoyageEmbedderDeps {
  readonly config: VoyageConfig;
  readonly http: HttpClient;
  readonly usage: UsageStore;
  readonly log: Logger;
  readonly alert?: Alerter;
  readonly now?: () => Date;
}

/** Voyage's documented maximum inputs per request. */
export const VOYAGE_MAX_INPUTS = 128;

const RESPONSE_SCHEMA = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number().int().nonnegative(),
    }),
  ),
  model: z.string(),
  usage: z.object({ total_tokens: z.number().int().nonnegative() }),
});

/** Voyage error bodies are `{ detail: "…" }`. Best effort; never trusted beyond a log line. */
function parseErrorDetail(bodySnippet: string): string | null {
  try {
    const parsed: unknown = JSON.parse(bodySnippet);
    if (typeof parsed === 'object' && parsed !== null && 'detail' in parsed) {
      const detail: unknown = parsed.detail;
      return typeof detail === 'string' ? detail.slice(0, 200) : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function voyageCostUsd(pricePerMTok: number, tokens: number): number {
  return roundUsd((tokens * pricePerMTok) / 1_000_000);
}

/** The one place the key is used. Returned object is never logged. */
export function buildVoyageHeaders(config: VoyageConfig): Readonly<Record<string, string>> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
  };
}

export function createVoyageEmbedder(deps: VoyageEmbedderDeps): Embedder {
  const { config, http, usage } = deps;
  const log = deps.log.child({ component: 'voyage' });
  const now = deps.now ?? ((): Date => new Date());
  const url = `${config.baseUrl}/v1/embeddings`;

  const readSpent = async (): Promise<Result<SpentSoFar>> => {
    const at = now();
    const day = await usage.spentSince('voyage', utcDayStart(at));
    if (!day.ok) return err(day.error);
    const month = await usage.spentSince('voyage', utcMonthStart(at));
    if (!month.ok) return err(month.error);
    return ok({ dayUsd: day.value, monthUsd: month.value });
  };

  const record = async (row: UsageRecord): Promise<void> => {
    const result = await usage.record(row);
    if (!result.ok) {
      log.error('api_usage row NOT recorded', { error: result.error, operation: row.operation });
      if (deps.alert !== undefined) {
        await deps.alert.notify({
          kind: 'usage_unrecorded',
          operation: row.operation,
          costUsd: row.costUsd,
        });
      }
    }
  };

  /** Steps 1–3: price, read the ledger, check the cap. Nothing leaves the process. */
  const preflight = async (
    chars: number,
  ): Promise<Result<{ estimateTokens: number; estimateUsd: number }, EmbedError>> => {
    const estimateTokens = estimateInputTokens(chars);
    const estimateUsd = voyageCostUsd(config.pricePerMTok, estimateTokens);
    const spent = await readSpent();
    if (!spent.ok) {
      log.error('voyage spend-to-date unavailable; refusing call (fail closed)', {
        error: spent.error,
      });
      return err(spent.error);
    }
    const decision = checkSpendCap(config.caps, spent.value, estimateUsd);
    if (!decision.allowed) {
      const refusal = new SpendCapError(
        decision.window,
        decision.spentUsd,
        decision.capUsd,
        decision.estimateUsd,
      );
      log.error('voyage spend cap reached; call refused before request', { error: refusal });
      if (deps.alert !== undefined) {
        await deps.alert.notify({
          kind: 'cap_reached',
          window: decision.window,
          spentUsd: decision.spentUsd,
          capUsd: decision.capUsd,
        });
      }
      return err(refusal);
    }
    for (const window of decision.warnings) {
      log.warn('voyage spend approaching cap', {
        window,
        spentUsd: window === 'day' ? spent.value.dayUsd : spent.value.monthUsd,
        capUsd: window === 'day' ? config.caps.dailyUsd : config.caps.monthlyUsd,
      });
    }
    return ok({ estimateTokens, estimateUsd });
  };

  const checkBudget = async (chars: number): Promise<Result<void, EmbedError>> => {
    const checked = await preflight(chars);
    return checked.ok ? ok(undefined) : checked;
  };

  const embed = async (request: EmbeddingRequest): Promise<Result<Embedding, EmbedError>> => {
    if (request.texts.length === 0 || request.texts.length > VOYAGE_MAX_INPUTS) {
      return err(
        new ValidationError(`embed needs 1 to ${VOYAGE_MAX_INPUTS} texts`, [
          { path: 'texts', message: `got ${request.texts.length}` },
        ]),
      );
    }
    if (request.texts.some((t) => t.trim() === '')) {
      return err(
        new ValidationError('embed refuses an empty text', [{ path: 'texts', message: 'blank' }]),
      );
    }

    // 1–3: price, read the ledger, check the cap — before anything leaves.
    const chars = request.texts.reduce((n, t) => n + t.length, 0);
    const checked = await preflight(chars);
    if (!checked.ok) return checked;
    const { estimateTokens, estimateUsd } = checked.value;

    const reservation: UsageRecord = {
      provider: 'voyage',
      operation: `${request.operation}:unconfirmed`,
      model: config.model,
      inputTokens: estimateTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: estimateUsd,
      userId: request.userId,
      conversationId: request.conversationId,
    };

    // 4: the request. Idempotent, so http.ts owns the retry policy for this one.
    const response = await http.request(url, {
      method: 'POST',
      headers: buildVoyageHeaders(config),
      body: JSON.stringify({
        input: request.texts,
        model: config.model,
        input_type: request.inputType,
        output_dimension: config.dimensions,
      }),
      idempotent: true,
      retries: config.retries,
      timeoutMs: config.timeoutMs,
    });
    if (!response.ok) {
      const failure = response.error;
      if (failure instanceof HttpStatusError) {
        const snippet = failure.context['bodySnippet'];
        const detail = parseErrorDetail(typeof snippet === 'string' ? snippet : '');
        const retryAfter = failure.context['retryAfter'];
        if (failure.status === 429) {
          const retryAfterMs = parseRetryAfterMs(
            typeof retryAfter === 'string' ? retryAfter : null,
            () => now().getTime(),
          );
          log.warn('voyage rate limited', { retryAfterMs });
          return err(new RateLimitedError(retryAfterMs, { context: { provider: 'voyage' } }));
        }
        // An error envelope is not billed. Logged, not recorded.
        log.error('voyage error response', { status: failure.status, detail });
        return err(
          new HttpStatusError(
            `Voyage responded ${failure.status}${detail === null ? '' : ` (${detail})`}`,
            failure.status,
            { context: { provider: 'voyage' } },
          ),
        );
      }
      if (failure.code === 'CIRCUIT_OPEN') {
        log.warn('voyage circuit open; call not attempted', { error: failure });
        return err(failure);
      }
      // TIMEOUT / NETWORK after the request left: may have been billed. Reserve; re-issue
      // the error with a redacted message and no cause so no request material travels.
      log.error('voyage call failed after send; recording reservation', { code: failure.code });
      await record(reservation);
      return err(
        failure.code === 'TIMEOUT'
          ? new TimeoutError(redactString(failure.message), config.timeoutMs)
          : new NetworkError(redactString(failure.message)),
      );
    }

    // 5–6: validate, then record what the wire says was billed.
    const json = parseJsonBody(response.value);
    if (!json.ok) {
      await record(reservation);
      return err(json.error);
    }
    const parsed = RESPONSE_SCHEMA.safeParse(json.value);
    if (!parsed.success) {
      await record(reservation);
      log.error('voyage 200 with unparseable body; reservation recorded', {
        issues: parsed.error.issues.length,
      });
      return err(
        new ValidationError(
          'Voyage response did not match the expected shape',
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
    }
    const body = parsed.data;
    const cost = voyageCostUsd(config.pricePerMTok, body.usage.total_tokens);
    await record({
      provider: 'voyage',
      operation: request.operation,
      model: body.model,
      inputTokens: body.usage.total_tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: cost,
      userId: request.userId,
      conversationId: request.conversationId,
    });
    log.info('voyage call completed', {
      model: body.model,
      inputs: request.texts.length,
      usage: { in: body.usage.total_tokens },
      costUsd: cost,
      attempts: response.value.attempts,
    });

    // The column is exactly `dimensions` wide; anything else is refused here, never at
    // the insert (where a Postgres error would be the first sign).
    const ordered = [...body.data].sort((a, b) => a.index - b.index);
    const vectors = ordered.map((d) => d.embedding);
    const issues: { path: string; message: string }[] = [];
    if (vectors.length !== request.texts.length) {
      issues.push({
        path: 'data',
        message: `${vectors.length} vectors for ${request.texts.length} texts`,
      });
    }
    vectors.forEach((v, i) => {
      if (v.length !== config.dimensions) {
        issues.push({
          path: `data.${i}`,
          message: `${v.length} dimensions, expected ${config.dimensions}`,
        });
      } else if (!v.every((n) => Number.isFinite(n)) || v.every((n) => n === 0)) {
        issues.push({ path: `data.${i}`, message: 'non-finite or all-zero vector' });
      }
    });
    if (issues.length > 0) {
      log.error('voyage returned unusable vectors (billed, recorded, not stored)', {
        issueCount: issues.length,
      });
      return err(new ValidationError('Voyage returned unusable vectors', issues));
    }
    return ok({
      vectors,
      model: body.model,
      totalTokens: body.usage.total_tokens,
      costUsd: cost,
      attempts: response.value.attempts,
    });
  };

  return { embed, checkBudget };
}
