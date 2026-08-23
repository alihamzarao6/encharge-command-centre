/**
 * Fetch wrapper with the three things CLAUDE.md rule 8 demands of every external call:
 * a timeout, retry with exponential backoff and jitter, and a circuit breaker per origin.
 *
 * Design decisions, stated so they are not re-litigated per call site:
 *  - Only idempotent requests are retried. GET / HEAD / OPTIONS are idempotent by default;
 *    anything else must say `idempotent: true` (and carry an idempotency key upstream) or it
 *    runs exactly once. "Never blindly retry non-idempotent writes."
 *  - 4xx other than 408 / 425 / 429 is a caller error, not a service failure: it is not
 *    retried and does not count towards the breaker.
 *  - Every failure is returned as a typed `Result`, never thrown. Callers branch on `code`.
 *  - Time, sleep, randomness and fetch itself are injectable so the behaviour is unit-testable
 *    without a network and without real waiting.
 */

import {
  CircuitOpenError,
  ConfigError,
  HttpStatusError,
  NetworkError,
  TimeoutError,
  ValidationError,
  ensureError,
  err,
  ok,
  type Result,
} from './errors.js';
import { type Logger, logger as defaultLogger } from './logger.js';

export type HttpError = TimeoutError | NetworkError | HttpStatusError | CircuitOpenError;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface BreakerOptions {
  /** Consecutive failures (timeouts, network errors, transient statuses) before opening. */
  readonly failureThreshold?: number;
  /** How long the breaker stays open before allowing one trial request. */
  readonly resetTimeoutMs?: number;
}

export interface HttpClientOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** Retry attempts after the first try. 3 → up to 4 requests in total. */
  readonly retries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Upper bound honoured for a server-supplied Retry-After. */
  readonly maxRetryAfterMs?: number;
  readonly breaker?: BreakerOptions;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Uniform [0, 1). Injected for deterministic jitter in tests. */
  readonly random?: () => number;
  readonly logger?: Logger;
}

export interface HttpRequestOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Overrides the method-based default. Required to retry POST / PUT / PATCH / DELETE. */
  readonly idempotent?: boolean;
  readonly timeoutMs?: number;
  readonly retries?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
  readonly bodyText: string;
  /** Total requests made for this call, including the successful one. */
  readonly attempts: number;
}

export type BreakerState =
  | { readonly state: 'closed'; readonly consecutiveFailures: number }
  | { readonly state: 'open'; readonly openedAt: number; readonly reopensAt: number }
  | { readonly state: 'half_open'; readonly trialInFlight: boolean };

export interface HttpClient {
  request(url: string, options?: HttpRequestOptions): Promise<Result<HttpResponse, HttpError>>;
  getBreakerState(origin: string): BreakerState;
}

const DEFAULTS = {
  timeoutMs: 15_000,
  retries: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  maxRetryAfterMs: 30_000,
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
} as const;

const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

interface MutableBreaker {
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  openedAt: number;
  trialInFlight: boolean;
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const retries = options.retries ?? DEFAULTS.retries;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs;
  const failureThreshold = options.breaker?.failureThreshold ?? DEFAULTS.failureThreshold;
  const resetTimeoutMs = options.breaker?.resetTimeoutMs ?? DEFAULTS.resetTimeoutMs;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? ((): number => Date.now());
  const random = options.random ?? ((): number => Math.random());
  const log = (options.logger ?? defaultLogger).child({ component: 'http' });

  assertPositive('timeoutMs', timeoutMs);
  assertNonNegative('retries', retries);
  assertPositive('baseDelayMs', baseDelayMs);
  assertPositive('maxDelayMs', maxDelayMs);
  assertPositive('failureThreshold', failureThreshold);
  assertPositive('resetTimeoutMs', resetTimeoutMs);

  const breakers = new Map<string, MutableBreaker>();

  const breakerFor = (origin: string): MutableBreaker => {
    let breaker = breakers.get(origin);
    if (breaker === undefined) {
      breaker = { state: 'closed', consecutiveFailures: 0, openedAt: 0, trialInFlight: false };
      breakers.set(origin, breaker);
    }
    return breaker;
  };

  /** Returns null when a request may proceed, or the error to return when it may not. */
  const admit = (origin: string): CircuitOpenError | null => {
    const breaker = breakerFor(origin);
    if (breaker.state === 'open') {
      const elapsed = now() - breaker.openedAt;
      if (elapsed < resetTimeoutMs) {
        return new CircuitOpenError(origin, resetTimeoutMs - elapsed);
      }
      breaker.state = 'half_open';
      breaker.trialInFlight = false;
      log.warn('circuit half-open, allowing one trial request', { origin });
    }
    if (breaker.state === 'half_open') {
      if (breaker.trialInFlight) {
        return new CircuitOpenError(origin, resetTimeoutMs, {
          context: { reason: 'trial_in_flight' },
        });
      }
      breaker.trialInFlight = true;
    }
    return null;
  };

  const recordSuccess = (origin: string): void => {
    const breaker = breakerFor(origin);
    if (breaker.state !== 'closed') {
      log.info('circuit closed', { origin });
    }
    breaker.state = 'closed';
    breaker.consecutiveFailures = 0;
    breaker.trialInFlight = false;
  };

  const recordFailure = (origin: string): void => {
    const breaker = breakerFor(origin);
    if (breaker.state === 'half_open') {
      breaker.state = 'open';
      breaker.openedAt = now();
      breaker.trialInFlight = false;
      log.warn('circuit re-opened after failed trial', { origin });
      return;
    }
    breaker.consecutiveFailures += 1;
    if (breaker.consecutiveFailures >= failureThreshold) {
      breaker.state = 'open';
      breaker.openedAt = now();
      log.error('circuit opened', { origin, consecutiveFailures: breaker.consecutiveFailures });
    }
  };

  const attemptOnce = async (
    url: string,
    init: RequestInit,
    deadlineMs: number,
  ): Promise<Result<Response, TimeoutError | NetworkError>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, deadlineMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      return ok(response);
    } catch (caught: unknown) {
      if (controller.signal.aborted) {
        return err(new TimeoutError(`Request timed out after ${deadlineMs}ms`, deadlineMs));
      }
      const cause = ensureError(caught);
      return err(new NetworkError(`Request failed: ${cause.message}`, { cause }));
    } finally {
      clearTimeout(timer);
    }
  };

  const request = async (
    url: string,
    requestOptions: HttpRequestOptions = {},
  ): Promise<Result<HttpResponse, HttpError>> => {
    const method = (requestOptions.method ?? 'GET').toUpperCase();
    const idempotent = requestOptions.idempotent ?? IDEMPOTENT_METHODS.has(method);
    const maxAttempts = 1 + (idempotent ? (requestOptions.retries ?? retries) : 0);
    const deadlineMs = requestOptions.timeoutMs ?? timeoutMs;
    const origin = originOf(url);
    const safeUrl = redactedUrl(url);
    const init: RequestInit = {
      method,
      ...(requestOptions.headers === undefined ? {} : { headers: requestOptions.headers }),
      ...(requestOptions.body === undefined ? {} : { body: requestOptions.body }),
    };

    let lastError: HttpError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const denied = admit(origin);
      if (denied !== null) {
        return err(denied);
      }

      const outcome = await attemptOnce(url, init, deadlineMs);

      if (outcome.ok) {
        const response = outcome.value;
        if (response.ok || (response.status >= 300 && response.status < 400)) {
          recordSuccess(origin);
          const bodyText = await readBody(response);
          return ok({
            status: response.status,
            headers: response.headers,
            url: response.url || url,
            bodyText,
            attempts: attempt,
          });
        }
        const bodyText = await readBody(response);
        lastError = new HttpStatusError(
          `${method} ${safeUrl} responded ${response.status}`,
          response.status,
          { context: { method, url: safeUrl, attempt, bodySnippet: bodyText.slice(0, 200) } },
        );
        if (!lastError.retryable) {
          // A definite answer from the service: not a failure of the service.
          return err(lastError);
        }
        recordFailure(origin);
        if (attempt < maxAttempts) {
          const delay = retryDelayMs(attempt, response.headers.get('retry-after'));
          log.warn('retrying after transient status', {
            method,
            url: safeUrl,
            status: response.status,
            attempt,
            delayMs: delay,
          });
          await sleep(delay);
        }
        continue;
      }

      lastError = outcome.error;
      recordFailure(origin);
      if (attempt < maxAttempts) {
        const delay = retryDelayMs(attempt, null);
        log.warn('retrying after transport failure', {
          method,
          url: safeUrl,
          code: lastError.code,
          attempt,
          delayMs: delay,
        });
        await sleep(delay);
      }
    }

    // maxAttempts >= 1, so the loop ran at least once and lastError is set.
    return err(
      lastError ?? new NetworkError('Request made no attempts', { context: { url: safeUrl } }),
    );
  };

  const retryDelayMs = (attempt: number, retryAfterHeader: string | null): number => {
    const fromHeader = parseRetryAfterMs(retryAfterHeader, now);
    if (fromHeader !== null) {
      return Math.min(fromHeader, maxRetryAfterMs);
    }
    // Exponential backoff with equal jitter: [cap/2, cap) where cap = base * 2^(attempt-1).
    const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    const half = cap / 2;
    return Math.round(half + random() * half);
  };

  const getBreakerState = (origin: string): BreakerState => {
    const breaker = breakerFor(origin);
    switch (breaker.state) {
      case 'closed':
        return { state: 'closed', consecutiveFailures: breaker.consecutiveFailures };
      case 'open':
        return {
          state: 'open',
          openedAt: breaker.openedAt,
          reopensAt: breaker.openedAt + resetTimeoutMs,
        };
      case 'half_open':
        return { state: 'half_open', trialInFlight: breaker.trialInFlight };
    }
  };

  return { request, getBreakerState };
}

/** Parse a response body as JSON without throwing. */
export function parseJsonBody(response: HttpResponse): Result<unknown, ValidationError> {
  try {
    return ok(JSON.parse(response.bodyText) as unknown);
  } catch (caught: unknown) {
    const cause = ensureError(caught);
    return err(
      new ValidationError(
        'Response body is not valid JSON',
        [{ path: '', message: cause.message }],
        {
          cause,
          context: { status: response.status, url: redactedUrl(response.url) },
        },
      ),
    );
  }
}

/** Seconds or an HTTP-date, per RFC 9110 §10.2.3. Null when absent or unparseable. */
export function parseRetryAfterMs(header: string | null, now: () => number): number | null {
  if (header === null) {
    return null;
  }
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return null;
  }
  return Math.max(0, at - now());
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid-url';
  }
}

/** URL safe to log: no credentials, no query string (tokens travel in query strings). */
export function redactedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function assertPositive(name: string, value: number): void {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new ConfigError(`http client option ${name} must be a positive number`, {
      context: { option: name, value },
    });
  }
}

function assertNonNegative(name: string, value: number): void {
  if (!(Number.isFinite(value) && value >= 0)) {
    throw new ConfigError(`http client option ${name} must be zero or a positive number`, {
      context: { option: name, value },
    });
  }
}
