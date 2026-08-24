/**
 * Typed errors and the Result type used across src/lib.
 *
 * Rules this module exists to enforce (CLAUDE.md §6, rule 7):
 *  - never throw a string or a bare object — throw an AppError subclass;
 *  - every failure carries a stable `code`, a `retryable` flag and structured `context`,
 *    so callers branch on the code and the logger can serialise it without guessing;
 *  - external calls return `Result`, they do not throw across module boundaries.
 */

export type ErrorCode =
  | 'CONFIG'
  | 'VALIDATION'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP_STATUS'
  | 'CIRCUIT_OPEN'
  | 'UNKNOWN_THROWN'
  | 'INTERNAL'
  // Added in Stage 2 part 3 (auth): authorization refusals and duplicate-identity
  // conflicts are first-class outcomes, not validation failures. Never retryable.
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'CONFLICT';

export type ErrorContext = Readonly<Record<string, unknown>>;

export interface AppErrorOptions {
  readonly retryable?: boolean;
  readonly context?: ErrorContext;
  readonly cause?: unknown;
}

/** JSON shape produced by `AppError.toJSON()`; stable so log consumers can rely on it. */
export interface SerialisedAppError {
  readonly name: string;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly context: ErrorContext;
  readonly cause?: unknown;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly context: ErrorContext;

  public constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.context = Object.freeze({ ...(options.context ?? {}) });
    // Keep the prototype chain intact when compiled to ES5-ish targets or when subclassed.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public toJSON(): SerialisedAppError {
    const base: SerialisedAppError = {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
    };
    return this.cause === undefined ? base : { ...base, cause: serialiseCause(this.cause) };
  }
}

/** A required configuration value (env var, option) is missing or malformed. Never retryable. */
export class ConfigError extends AppError {
  public constructor(message: string, options: Omit<AppErrorOptions, 'retryable'> = {}) {
    super('CONFIG', message, { ...options, retryable: false });
  }
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Input or model output failed schema validation. Never retryable as-is. */
export class ValidationError extends AppError {
  public readonly issues: readonly ValidationIssue[];

  public constructor(
    message: string,
    issues: readonly ValidationIssue[] = [],
    options: Omit<AppErrorOptions, 'retryable'> = {},
  ) {
    super('VALIDATION', message, {
      ...options,
      retryable: false,
      context: { ...(options.context ?? {}), issueCount: issues.length },
    });
    this.issues = Object.freeze([...issues]);
  }

  public override toJSON(): SerialisedAppError & { readonly issues: readonly ValidationIssue[] } {
    return { ...super.toJSON(), issues: this.issues };
  }
}

/** An operation exceeded its deadline. Retryable when the operation is idempotent. */
export class TimeoutError extends AppError {
  public readonly timeoutMs: number;

  public constructor(message: string, timeoutMs: number, options: AppErrorOptions = {}) {
    super('TIMEOUT', message, {
      retryable: true,
      ...options,
      context: { ...(options.context ?? {}), timeoutMs },
    });
    this.timeoutMs = timeoutMs;
  }
}

/** The transport failed before a response arrived (DNS, reset, refused). Retryable. */
export class NetworkError extends AppError {
  public constructor(message: string, options: AppErrorOptions = {}) {
    super('NETWORK', message, { retryable: true, ...options });
  }
}

/** A response arrived with a non-success status. Retryable only for transient statuses. */
export class HttpStatusError extends AppError {
  public readonly status: number;

  public constructor(message: string, status: number, options: AppErrorOptions = {}) {
    super('HTTP_STATUS', message, {
      retryable: isTransientStatus(status),
      ...options,
      context: { ...(options.context ?? {}), status },
    });
    this.status = status;
  }
}

/** The circuit breaker for an origin is open; the call was not attempted. */
export class CircuitOpenError extends AppError {
  public readonly origin: string;
  public readonly retryAfterMs: number;

  public constructor(origin: string, retryAfterMs: number, options: AppErrorOptions = {}) {
    super('CIRCUIT_OPEN', `Circuit open for ${origin}; retry after ${retryAfterMs}ms`, {
      retryable: true,
      ...options,
      context: { ...(options.context ?? {}), origin, retryAfterMs },
    });
    this.origin = origin;
    this.retryAfterMs = retryAfterMs;
  }
}

/** HTTP statuses worth retrying on an idempotent request. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** True when the error says it is safe to retry. Unknown values are never retryable. */
export function isRetryable(value: unknown): boolean {
  return isAppError(value) && value.retryable;
}

/**
 * Normalise anything that was thrown into an Error. A caught `unknown` that is not an Error
 * (a string, a number, a plain object) becomes an AppError with code UNKNOWN_THROWN so it can
 * never escape as a bare value.
 */
export function ensureError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new AppError('UNKNOWN_THROWN', describeThrown(value), {
    context: { thrownType: typeof value },
    cause: value,
  });
}

function describeThrown(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'undefined':
      return 'Non-error value thrown: undefined';
    case 'object':
      return value === null ? 'Non-error value thrown: null' : 'Non-error object thrown';
    case 'symbol':
      return `Non-error value thrown: ${value.toString()}`;
    case 'number':
    case 'boolean':
      return `Non-error value thrown: ${String(value)}`;
    case 'bigint':
      return `Non-error value thrown: ${value.toString()}n`;
    case 'function':
      return 'Non-error function thrown';
  }
}

function serialiseCause(cause: unknown): unknown {
  if (cause instanceof AppError) {
    return cause.toJSON();
  }
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  return cause;
}

// ---------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}
export type Result<T, E = AppError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Return the value or a fallback. Use when a failure has a safe default; never to hide one. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Run `fn`, converting a throw into `Err<Error>` via `ensureError`. */
export async function tryCatch<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await fn());
  } catch (caught: unknown) {
    return err(ensureError(caught));
  }
}
