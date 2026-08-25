/**
 * Claude wrapper (Stage 2 part 4; streaming added in part 6). Two entry points that share
 * every gate — `complete()` and `stream()` — each of which:
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
 * `stream()` differs only after the headers arrive: it reads server-sent events, forwards
 * each text delta to the caller, and bills from the wire — input and cache tokens from
 * `message_start`, output tokens from `message_delta` — so a streamed turn produces the
 * same single api_usage row as a completed one. A stream that dies mid-reply records what
 * it consumed as `<operation>:partial` (real input figures, output estimated from the
 * text received) and returns the partial text in the error's context, so the caller can
 * show it and say so. One row per turn, always.
 *
 * The API key is set as one request header and appears nowhere else — not in the returned
 * value, not in any error, not in any log field (the logger also redacts it by pattern).
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
import { readSse } from '../sse.js';
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
import {
  INITIAL_STREAM_STATE,
  applyAnthropicEvent,
  finalUsage,
  partialUsage,
  type StreamState,
} from './stream.js';

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

/** Called with each text delta as it arrives; must not throw. */
export type TextDeltaSink = (delta: string) => void;

export interface ClaudeClient {
  complete(request: CompletionRequest): Promise<Result<Completion, LlmError>>;
  /**
   * Same contract as `complete`, delivering text as it is generated. On an interrupted
   * stream the error carries `context.partialText` (what arrived) and the usage consumed
   * has been recorded. Optional so a test double or a runtime without streams can omit it;
   * callers fall back to `complete`.
   */
  stream?(request: CompletionRequest, onText: TextDeltaSink): Promise<Result<Completion, LlmError>>;
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
  readonly stream?: true;
}

export function buildRequestBody(
  model: string,
  maxTokens: number,
  system: readonly SystemBlock[],
  messages: readonly ChatMessage[],
  thinking: ThinkingMode,
  stream = false,
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
    ...(stream ? { stream: true as const } : {}),
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

/** Everything both entry points settle before a request leaves the process. */
interface Prepared {
  readonly model: string;
  readonly maxTokens: number;
  readonly pricing: ModelPricing;
  readonly chars: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly reservation: UsageRecord;
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

  // --- steps 1–3: price, read spend, check the cap — before anything leaves ---------------
  const prepare = async (request: CompletionRequest): Promise<Result<Prepared, LlmError>> => {
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

    return ok({
      model,
      maxTokens,
      pricing,
      chars,
      headers: buildHeaders(config),
      reservation: {
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
      },
    });
  };

  /**
   * What to do with a failed attempt. `retry` = sleep then try again (the envelope proved
   * nothing was billed); `fail` = give up with this error (a reservation is recorded when
   * the request may have been billed).
   */
  const settleFailure = async (
    error: HttpStatusError | TimeoutError | NetworkError | CircuitOpenError,
    attempt: number,
    maxAttempts: number,
    prepared: Prepared,
  ): Promise<{ readonly retry: true } | { readonly retry: false; readonly error: LlmError }> => {
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
        return { retry: true };
      }
      if (error.status === 429) {
        const retryAfterMs = parseRetryAfterMs(retryAfterHeader, () => now().getTime());
        log.warn('anthropic rate limited', { attempt, retryAfterMs });
        return {
          retry: false,
          error: new RateLimitedError(retryAfterMs, { context: { attempts: attempt } }),
        };
      }
      log.error('anthropic error response', {
        status: error.status,
        apiErrorType: info?.type ?? null,
        apiErrorMessage: info?.message ?? null,
        attempt,
      });
      return {
        retry: false,
        error: new HttpStatusError(
          `Anthropic responded ${error.status}${info === null ? '' : ` (${info.type}: ${info.message})`}`,
          error.status,
          { context: { apiErrorType: info?.type ?? null, attempts: attempt } },
        ),
      };
    }
    if (error.code === 'CIRCUIT_OPEN') {
      // Nothing was sent.
      log.warn('anthropic circuit open; call not attempted', { error });
      return { retry: false, error };
    }
    // TIMEOUT or NETWORK after the request left: it may have been billed. Record the
    // reservation, do not retry. The transport error is re-issued with a redacted message
    // and no cause: whatever fetch threw is not allowed to carry request material (the
    // header object) to a caller.
    log.error('anthropic call failed after send; recording reservation, not retrying', {
      code: error.code,
      attempt,
    });
    await record(prepared.reservation);
    return {
      retry: false,
      error:
        error.code === 'TIMEOUT'
          ? new TimeoutError(redactString(error.message), config.timeoutMs, {
              context: { attempts: attempt },
            })
          : new NetworkError(redactString(error.message), { context: { attempts: attempt } }),
    };
  };

  const recordCompleted = async (
    request: CompletionRequest,
    prepared: Prepared,
    model: string,
    tokenUsage: TokenUsage,
    stopReason: string | null,
    attempts: number,
    requestId: string | null,
    streamed: boolean,
  ): Promise<number> => {
    const cost = costUsd(prepared.pricing, tokenUsage);
    await record({
      provider: 'anthropic',
      operation: request.operation,
      model,
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      cacheReadTokens: tokenUsage.cacheReadTokens,
      cacheWriteTokens: tokenUsage.cacheWriteTokens,
      costUsd: cost,
      userId: request.userId,
      conversationId: request.conversationId,
    });
    // Field names avoid the word "token": the logger redacts any key containing it.
    log.info('anthropic call completed', {
      model,
      stopReason,
      usage: {
        in: tokenUsage.inputTokens,
        out: tokenUsage.outputTokens,
        cacheRead: tokenUsage.cacheReadTokens,
        cacheWrite: tokenUsage.cacheWriteTokens,
      },
      costUsd: cost,
      attempts,
      requestId,
      streamed,
    });
    return cost;
  };

  const complete = async (request: CompletionRequest): Promise<Result<Completion, LlmError>> => {
    const prepared = await prepare(request);
    if (!prepared.ok) return prepared;
    const p = prepared.value;
    const body = JSON.stringify(
      buildRequestBody(p.model, p.maxTokens, request.system, request.messages, config.thinking),
    );

    const maxAttempts = 1 + config.retries;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await http.request(url, {
        method: 'POST',
        headers: p.headers,
        body,
        idempotent: false,
        timeoutMs: config.timeoutMs,
      });
      if (!response.ok) {
        const settled = await settleFailure(response.error, attempt, maxAttempts, p);
        if (settled.retry) continue;
        return err(settled.error);
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
        await record(p.reservation);
        return err(json.error);
      }
      const parsed = parseMessageResponse(json.value);
      if (!parsed.ok) {
        await record(p.reservation);
        log.error('anthropic 200 with unparseable body; reservation recorded', {
          error: parsed.error,
        });
        return err(parsed.error);
      }
      const message = parsed.value;
      const requestId = http200.headers.get('request-id');
      const cost = await recordCompleted(
        request,
        p,
        message.model,
        message.usage,
        message.stopReason,
        attempts,
        requestId,
        false,
      );
      if (message.stopReason === 'refusal') {
        return err(new ModelRefusalError(message.refusalCategory, { context: { costUsd: cost } }));
      }
      return ok({
        text: message.text,
        model: message.model,
        stopReason: message.stopReason,
        usage: message.usage,
        costUsd: cost,
        requestId,
        attempts,
      });
    }
  };

  const stream = async (
    request: CompletionRequest,
    onText: TextDeltaSink,
  ): Promise<Result<Completion, LlmError>> => {
    const prepared = await prepare(request);
    if (!prepared.ok) return prepared;
    const p = prepared.value;
    const body = JSON.stringify(
      buildRequestBody(
        p.model,
        p.maxTokens,
        request.system,
        request.messages,
        config.thinking,
        true,
      ),
    );

    const maxAttempts = 1 + config.retries;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const opened = await http.open(url, {
        method: 'POST',
        headers: { ...p.headers, accept: 'text/event-stream' },
        body,
        timeoutMs: config.timeoutMs,
      });
      if (!opened.ok) {
        const settled = await settleFailure(opened.error, attempt, maxAttempts, p);
        if (settled.retry) continue;
        return err(settled.error);
      }
      return consume(opened.value.body, opened.value.headers.get('request-id'), attempt);
    }
    return err(new ValidationError('stream loop exited without a result'));

    async function consume(
      stream: ReadableStream<Uint8Array> | null,
      requestId: string | null,
      attempts: number,
    ): Promise<Result<Completion, LlmError>> {
      if (stream === null) {
        await record(p.reservation);
        return err(new ValidationError('Anthropic 200 with no body'));
      }
      let state: StreamState = INITIAL_STREAM_STATE;
      let ignored = 0;
      const outcome = await readSse(stream, {
        idleTimeoutMs: config.timeoutMs,
        onEvent: (event) => {
          const step = applyAnthropicEvent(state, event);
          state = step.state;
          if (step.ignored) ignored += 1;
          if (step.textDelta !== '') onText(step.textDelta);
          // Stop reading on the API's own error or once the message is complete.
          return state.apiError === null && !state.complete ? undefined : false;
        },
      });
      if (ignored > 0) {
        log.warn('anthropic stream: events ignored', { ignored });
      }

      const usage = finalUsage(state);
      const model = state.model ?? p.model;
      if (
        outcome.kind !== 'transport' &&
        outcome.kind !== 'idle_timeout' &&
        state.apiError === null &&
        state.complete &&
        usage !== null
      ) {
        const cost = await recordCompleted(
          request,
          p,
          model,
          usage,
          state.stopReason,
          attempts,
          requestId ?? state.requestId,
          true,
        );
        if (state.stopReason === 'refusal') {
          return err(new ModelRefusalError(state.refusalCategory, { context: { costUsd: cost } }));
        }
        return ok({
          text: state.text,
          model,
          stopReason: state.stopReason,
          usage,
          costUsd: cost,
          requestId: requestId ?? state.requestId,
          attempts,
        });
      }

      // Interrupted: record what was consumed, hand back what arrived.
      const consumed = partialUsage(state, p.reservation.inputTokens);
      const cost = costUsd(p.pricing, consumed);
      await record({
        ...p.reservation,
        operation: `${request.operation}:partial`,
        model,
        inputTokens: consumed.inputTokens,
        outputTokens: consumed.outputTokens,
        cacheReadTokens: consumed.cacheReadTokens,
        cacheWriteTokens: consumed.cacheWriteTokens,
        costUsd: cost,
      });
      const context = {
        attempts,
        partialText: state.text,
        partialChars: state.text.length,
        outcome: outcome.kind,
        costUsd: cost,
      };
      log.error('anthropic stream interrupted; partial usage recorded', {
        outcome: outcome.kind,
        apiErrorType: state.apiError?.type ?? null,
        partialChars: state.text.length,
        complete: state.complete,
        hadFinalUsage: usage !== null,
      });
      if (state.apiError !== null) {
        return err(
          new HttpStatusError(
            `Anthropic stream error (${state.apiError.type}: ${state.apiError.message})`,
            state.apiError.type === 'overloaded_error' ? 529 : 502,
            { context: { ...context, apiErrorType: state.apiError.type } },
          ),
        );
      }
      if (outcome.kind === 'idle_timeout') {
        return err(new TimeoutError('Anthropic stream went silent', outcome.idleMs, { context }));
      }
      return err(
        new NetworkError(
          outcome.kind === 'transport'
            ? redactString(`Anthropic stream failed: ${outcome.error.message}`)
            : 'Anthropic stream ended before the message completed',
          { context },
        ),
      );
    }
  };

  return { complete, stream };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
