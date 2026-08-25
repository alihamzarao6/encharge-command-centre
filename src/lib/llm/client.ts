/**
 * Claude wrapper (Stage 2 part 4). One entry point — `complete()` — that:
 *
 *   1. prices the call (unknown model → refused, cannot cap what cannot be priced);
 *   2. reads spend-to-date for the UTC day and month; if the store cannot answer, the call
 *      is REFUSED (fail closed — a blind cap is no cap);
 *   3. checks spent + worst case of this call against both caps BEFORE any request leaves
 *      the process; a refusal is a typed SpendCapError, alerts, and makes no HTTP call;
 *   4. POSTs /v1/messages through src/lib/http.ts (timeout, per-origin circuit breaker),
 *      with the request marked NON-idempotent so http.ts never retries it on its own;
 *   5. retries ONLY responses that provably billed nothing: 429 and 5xx/529 error
 *      envelopes. A timeout or transport failure after the request was sent may have been
 *      billed and is never retried (rule 8: no blind retry of a non-idempotent call);
 *   6. records EVERY billed or possibly-billed call in api_usage — success, model refusal,
 *      and unconfirmed failures (timeout / transport / unparseable 200), the last as the
 *      worst-case reservation so the cap counts money we cannot see.
 *
 * The API key is set as one request header and appears nowhere else — not in the returned
 * value, not in any error, not in any log field (the logger also redacts it by pattern).
 *
 * Streaming: not built. The request builder, response parser and usage recorder are
 * separate functions so a `stream()` sibling reuses them; only SSE parsing would be new.
 */
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
import { parseJsonBody, parseRetryAfterMs, type HttpClient, type HttpResponse } from '../http.js';
import { redactString, type Logger } from '../logger.js';
import type { LlmConfig, ThinkingMode } from './config.js';
import { ModelRefusalError, RateLimitedError, SpendCapError, type SpendWindow } from './errors.js';
import {
  costUsd,
  estimateInputTokens,
  estimateWorstCaseUsd,
  pricingFor,
  type ModelPricing,
  type TokenUsage,
} from './pricing.js';
import type { SystemBlock } from './prompt.js';
import { parseErrorEnvelope, parseMessageResponse } from './response.js';
import { checkSpendCap, utcDayStart, utcMonthStart, type SpentSoFar } from './spend.js';

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export type ModelRoute = 'default' | 'fast';

export interface CompletionRequest {
  readonly route?: ModelRoute;
  readonly system: readonly SystemBlock[];
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
  /** Recorded in api_usage.operation, e.g. `chat.turn`. */
  readonly operation: string;
  readonly userId: string | null;
  readonly conversationId: string | null;
}

export interface Completion {
  readonly text: string;
  readonly model: string;
  readonly stopReason: string | null;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly requestId: string | null;
  readonly attempts: number;
}

export type LlmError =
  | SpendCapError
  | RateLimitedError
  | ModelRefusalError
  | TimeoutError
  | NetworkError
  | HttpStatusError
  | CircuitOpenError
  | ValidationError
  | ConfigError
  | AppError;

export interface UsageRecord {
  readonly provider: 'anthropic';
  readonly operation: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly userId: string | null;
  readonly conversationId: string | null;
}

export interface UsageStore {
  /** Sum of cost_usd for the provider since `since` (inclusive). */
  spentSince(provider: 'anthropic', since: Date): Promise<Result<number>>;
  record(row: UsageRecord): Promise<Result<void>>;
}

export type AlertEvent =
  | {
      readonly kind: 'cap_reached';
      readonly window: SpendWindow;
      readonly spentUsd: number;
      readonly capUsd: number;
    }
  | {
      readonly kind: 'cap_warning';
      readonly window: SpendWindow;
      readonly spentUsd: number;
      readonly capUsd: number;
    }
  | { readonly kind: 'usage_unrecorded'; readonly operation: string; readonly costUsd: number };

export interface Alerter {
  notify(event: AlertEvent): Promise<void>;
}

export interface ClaudeClientDeps {
  readonly config: LlmConfig;
  readonly http: HttpClient;
  readonly usage: UsageStore;
  readonly log: Logger;
  readonly alert?: Alerter;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface ClaudeClient {
  complete(request: CompletionRequest): Promise<Result<Completion, LlmError>>;
}

const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;
const MAX_RETRY_AFTER_MS = 30_000;

/** The one place the key is used. Returned object is never logged. */
export function buildHeaders(config: LlmConfig): Readonly<Record<string, string>> {
  return {
    'content-type': 'application/json',
    'anthropic-version': config.apiVersion,
    'x-api-key': config.apiKey,
  };
}

interface RequestBody {
  readonly model: string;
  readonly max_tokens: number;
  /** Always sent explicitly — see LlmConfig.thinking for why an omitted field is a bug. */
  readonly thinking: { readonly type: ThinkingMode };
  readonly system: readonly {
    readonly type: 'text';
    readonly text: string;
    readonly cache_control?: { readonly type: 'ephemeral' };
  }[];
  readonly messages: readonly ChatMessage[];
}

export function buildRequestBody(
  model: string,
  maxTokens: number,
  system: readonly SystemBlock[],
  messages: readonly ChatMessage[],
  thinking: ThinkingMode,
): RequestBody {
  return {
    model,
    max_tokens: maxTokens,
    thinking: { type: thinking },
    system: system.map((block) =>
      block.cache
        ? { type: 'text', text: block.text, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: block.text },
    ),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
}

export function inputChars(
  system: readonly SystemBlock[],
  messages: readonly ChatMessage[],
): number {
  return (
    system.reduce((n, b) => n + b.text.length, 0) +
    messages.reduce((n, m) => n + m.content.length, 0)
  );
}

/** Logs only; the webhook/email alerter is a Stage 6 monitoring deliverable. */
export function loggingAlerter(log: Logger): Alerter {
  return {
    notify: (event) => {
      log.error('spend alert', { alert: event });
      return Promise.resolve();
    },
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function createClaudeClient(deps: ClaudeClientDeps): ClaudeClient {
  const { config, http, usage } = deps;
  const log = deps.log.child({ component: 'llm' });
  const alert = deps.alert ?? loggingAlerter(log);
  const now = deps.now ?? ((): Date => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? ((): number => Math.random());
  const url = `${config.baseUrl}/v1/messages`;

  const readSpent = async (): Promise<Result<SpentSoFar>> => {
    const at = now();
    const day = await usage.spentSince('anthropic', utcDayStart(at));
    if (!day.ok) return err(day.error);
    const month = await usage.spentSince('anthropic', utcMonthStart(at));
    if (!month.ok) return err(month.error);
    return ok({ dayUsd: day.value, monthUsd: month.value });
  };

  const record = async (row: UsageRecord): Promise<void> => {
    const result = await usage.record(row);
    if (!result.ok) {
      // The money is spent; the reply exists. Returning an error here would invite a resend
      // (double spend). Instead: alert loudly, and the NEXT call fails closed because
      // spentSince will fail against the same store.
      log.error('api_usage row NOT recorded', { error: result.error, operation: row.operation });
      await alert.notify({
        kind: 'usage_unrecorded',
        operation: row.operation,
        costUsd: row.costUsd,
      });
    }
  };

  const retryDelay = (attempt: number, retryAfter: string | null): number => {
    const fromHeader = parseRetryAfterMs(retryAfter, () => now().getTime());
    if (fromHeader !== null) {
      return Math.min(fromHeader, MAX_RETRY_AFTER_MS);
    }
    const cap = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    return Math.round(cap / 2 + random() * (cap / 2));
  };

  const complete = async (request: CompletionRequest): Promise<Result<Completion, LlmError>> => {
    const model = request.route === 'fast' ? config.models.fast : config.models.default;
    const maxTokens = request.maxTokens ?? config.maxTokens;
    const priced = pricingFor(config.pricing, model);
    if (!priced.ok) return priced;
    const pricing: ModelPricing = priced.value;

    if (request.messages.length === 0) {
      return err(new ValidationError('A completion needs at least one message'));
    }

    const chars = inputChars(request.system, request.messages);
    const estimateUsd = estimateWorstCaseUsd(pricing, chars, maxTokens);

    // --- cap: check, refuse, alert — before anything leaves the process -----------------
    const spent = await readSpent();
    if (!spent.ok) {
      log.error('spend-to-date unavailable; refusing call (fail closed)', {
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
      log.error('spend cap reached; call refused before request', { error: refusal });
      await alert.notify({
        kind: 'cap_reached',
        window: decision.window,
        spentUsd: decision.spentUsd,
        capUsd: decision.capUsd,
      });
      return err(refusal);
    }
    for (const window of decision.warnings) {
      const spentUsd = window === 'day' ? spent.value.dayUsd : spent.value.monthUsd;
      const capUsd = window === 'day' ? config.caps.dailyUsd : config.caps.monthlyUsd;
      log.warn('spend approaching cap', { window, spentUsd, capUsd });
      await alert.notify({ kind: 'cap_warning', window, spentUsd, capUsd });
    }

    // --- the call -----------------------------------------------------------------------
    const body = JSON.stringify(
      buildRequestBody(model, maxTokens, request.system, request.messages, config.thinking),
    );
    const headers = buildHeaders(config);
    const reservation: UsageRecord = {
      provider: 'anthropic',
      operation: `${request.operation}:unconfirmed`,
      model,
      inputTokens: estimateInputTokens(chars),
      outputTokens: maxTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: estimateUsd,
      userId: request.userId,
      conversationId: request.conversationId,
    };

    const maxAttempts = 1 + config.retries;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await http.request(url, {
        method: 'POST',
        headers,
        body,
        idempotent: false,
        timeoutMs: config.timeoutMs,
      });

      if (!response.ok) {
        const error = response.error;
        if (error instanceof HttpStatusError) {
          const snippet = error.context['bodySnippet'];
          const info = parseErrorEnvelope(typeof snippet === 'string' ? snippet : '');
          const retryAfter = error.context['retryAfter'];
          const retryAfterHeader = typeof retryAfter === 'string' ? retryAfter : null;
          if (isRetryableStatus(error.status) && attempt < maxAttempts) {
            // An error envelope is not billed — this is the only retry the wrapper makes.
            const delay = retryDelay(attempt, retryAfterHeader);
            log.warn('anthropic transient error; retrying', {
              status: error.status,
              apiErrorType: info?.type ?? null,
              attempt,
              delayMs: delay,
            });
            await sleep(delay);
            continue;
          }
          if (error.status === 429) {
            const retryAfterMs = parseRetryAfterMs(retryAfterHeader, () => now().getTime());
            log.warn('anthropic rate limited', { attempt, retryAfterMs });
            return err(new RateLimitedError(retryAfterMs, { context: { attempts: attempt } }));
          }
          log.error('anthropic error response', {
            status: error.status,
            apiErrorType: info?.type ?? null,
            apiErrorMessage: info?.message ?? null,
            attempt,
          });
          return err(
            new HttpStatusError(
              `Anthropic responded ${error.status}${info === null ? '' : ` (${info.type}: ${info.message})`}`,
              error.status,
              { context: { apiErrorType: info?.type ?? null, attempts: attempt } },
            ),
          );
        }
        if (error.code === 'CIRCUIT_OPEN') {
          // Nothing was sent.
          log.warn('anthropic circuit open; call not attempted', { error });
          return err(error);
        }
        // TIMEOUT or NETWORK after the request left: it may have been billed. Record the
        // reservation, do not retry. The transport error is re-issued with a redacted
        // message and no cause: whatever fetch threw is not allowed to carry request
        // material (the header object) to a caller.
        log.error('anthropic call failed after send; recording reservation, not retrying', {
          code: error.code,
          attempt,
        });
        await record(reservation);
        return err(
          error.code === 'TIMEOUT'
            ? new TimeoutError(redactString(error.message), config.timeoutMs, {
                context: { attempts: attempt },
              })
            : new NetworkError(redactString(error.message), { context: { attempts: attempt } }),
        );
      }

      return finishSuccess(response.value, attempt);
    }

    // Unreachable: the loop returns on every path. Kept typed rather than asserted.
    return err(new ValidationError('completion loop exited without a result'));

    async function finishSuccess(
      http200: HttpResponse,
      attempts: number,
    ): Promise<Result<Completion, LlmError>> {
      const json = parseJsonBody(http200);
      if (!json.ok) {
        await record(reservation);
        return err(json.error);
      }
      const parsed = parseMessageResponse(json.value);
      if (!parsed.ok) {
        await record(reservation);
        log.error('anthropic 200 with unparseable body; reservation recorded', {
          error: parsed.error,
        });
        return err(parsed.error);
      }
      const message = parsed.value;
      const cost = costUsd(pricing, message.usage);
      await record({
        provider: 'anthropic',
        operation: request.operation,
        model: message.model,
        inputTokens: message.usage.inputTokens,
        outputTokens: message.usage.outputTokens,
        cacheReadTokens: message.usage.cacheReadTokens,
        cacheWriteTokens: message.usage.cacheWriteTokens,
        costUsd: cost,
        userId: request.userId,
        conversationId: request.conversationId,
      });
      // Field names avoid the word "token": the logger redacts any key containing it.
      log.info('anthropic call completed', {
        model: message.model,
        stopReason: message.stopReason,
        usage: {
          in: message.usage.inputTokens,
          out: message.usage.outputTokens,
          cacheRead: message.usage.cacheReadTokens,
          cacheWrite: message.usage.cacheWriteTokens,
        },
        costUsd: cost,
        attempts,
        requestId: http200.headers.get('request-id'),
      });
      if (message.stopReason === 'refusal') {
        return err(new ModelRefusalError(message.refusalCategory, { context: { costUsd: cost } }));
      }
      return ok({
        text: message.text,
        model: message.model,
        stopReason: message.stopReason,
        usage: message.usage,
        costUsd: cost,
        requestId: http200.headers.get('request-id'),
        attempts,
      });
    }
  };

  return { complete };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
