import { describe, expect, it } from 'vitest';

import {
  AppError,
  CircuitOpenError,
  ConfigError,
  HttpStatusError,
  NetworkError,
  TimeoutError,
  ValidationError,
  ensureError,
  err,
  isAppError,
  isErr,
  isOk,
  isRetryable,
  isTransientStatus,
  ok,
  tryCatch,
  unwrapOr,
} from '../../src/lib/errors.js';

describe('AppError', () => {
  it('carries code, retryable flag, frozen context and the subclass name', () => {
    const error = new AppError('INTERNAL', 'boom', { context: { a: 1 } });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AppError');
    expect(error.code).toBe('INTERNAL');
    expect(error.retryable).toBe(false);
    expect(error.context).toEqual({ a: 1 });
    expect(Object.isFrozen(error.context)).toBe(true);
  });

  it('preserves the cause and serialises it in toJSON', () => {
    const cause = new Error('root');
    const error = new AppError('INTERNAL', 'wrapped', { cause });
    expect(error.cause).toBe(cause);
    expect(error.toJSON()).toEqual({
      name: 'AppError',
      code: 'INTERNAL',
      message: 'wrapped',
      retryable: false,
      context: {},
      cause: { name: 'Error', message: 'root' },
    });
  });

  it('serialises a nested AppError cause through its own toJSON, and passes raw causes through', () => {
    const inner = new ConfigError('missing');
    const outer = new AppError('INTERNAL', 'outer', { cause: inner });
    expect(outer.toJSON().cause).toEqual(inner.toJSON());
    const rawCause = new AppError('INTERNAL', 'raw', { cause: 'a string' });
    expect(rawCause.toJSON().cause).toBe('a string');
  });

  it('omits cause from toJSON when there is none', () => {
    expect('cause' in new AppError('INTERNAL', 'x').toJSON()).toBe(false);
  });
});

describe('subclasses', () => {
  it('ConfigError is never retryable', () => {
    const error = new ConfigError('no env', { context: { name: 'X' } });
    expect(error.name).toBe('ConfigError');
    expect(error.code).toBe('CONFIG');
    expect(error.retryable).toBe(false);
    expect(error.context).toEqual({ name: 'X' });
    expect(error).toBeInstanceOf(AppError);
  });

  it('ValidationError keeps issues and counts them in context', () => {
    const error = new ValidationError('bad', [{ path: 'a.b', message: 'required' }]);
    expect(error.code).toBe('VALIDATION');
    expect(error.issues).toEqual([{ path: 'a.b', message: 'required' }]);
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(error.context['issueCount']).toBe(1);
    expect(error.toJSON().issues).toHaveLength(1);
    expect(new ValidationError('empty').issues).toEqual([]);
  });

  it('TimeoutError is retryable and records the deadline', () => {
    const error = new TimeoutError('slow', 1500);
    expect(error.code).toBe('TIMEOUT');
    expect(error.retryable).toBe(true);
    expect(error.timeoutMs).toBe(1500);
    expect(error.context['timeoutMs']).toBe(1500);
  });

  it('TimeoutError retryability can be overridden by the caller', () => {
    expect(new TimeoutError('slow', 1, { retryable: false }).retryable).toBe(false);
  });

  it('NetworkError is retryable by default', () => {
    expect(new NetworkError('reset').retryable).toBe(true);
    expect(new NetworkError('reset').code).toBe('NETWORK');
  });

  it('HttpStatusError is retryable only for transient statuses', () => {
    expect(new HttpStatusError('x', 503).retryable).toBe(true);
    expect(new HttpStatusError('x', 429).retryable).toBe(true);
    expect(new HttpStatusError('x', 404).retryable).toBe(false);
    expect(new HttpStatusError('x', 400).retryable).toBe(false);
    expect(new HttpStatusError('x', 503).status).toBe(503);
    expect(new HttpStatusError('x', 503).context['status']).toBe(503);
  });

  it('CircuitOpenError names the origin and the wait', () => {
    const error = new CircuitOpenError('https://api.example.com', 1234);
    expect(error.code).toBe('CIRCUIT_OPEN');
    expect(error.retryable).toBe(true);
    expect(error.origin).toBe('https://api.example.com');
    expect(error.retryAfterMs).toBe(1234);
    expect(error.message).toContain('https://api.example.com');
    expect(error.message).toContain('1234ms');
  });
});

describe('isTransientStatus', () => {
  it('treats 408, 425, 429 and all 5xx as transient', () => {
    expect([408, 425, 429, 500, 502, 503, 599].every(isTransientStatus)).toBe(true);
    expect([200, 301, 400, 401, 403, 404, 409, 422].some(isTransientStatus)).toBe(false);
  });
});

describe('guards', () => {
  it('isAppError / isRetryable', () => {
    expect(isAppError(new NetworkError('x'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError('x')).toBe(false);
    expect(isRetryable(new NetworkError('x'))).toBe(true);
    expect(isRetryable(new ConfigError('x'))).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe('ensureError', () => {
  it('returns Error instances unchanged', () => {
    const original = new TypeError('t');
    expect(ensureError(original)).toBe(original);
  });

  it.each([
    ['a string', 'a string', 'string'],
    [42, 'Non-error value thrown: 42', 'number'],
    [true, 'Non-error value thrown: true', 'boolean'],
    [10n, 'Non-error value thrown: 10n', 'bigint'],
    [null, 'Non-error value thrown: null', 'object'],
    [undefined, 'Non-error value thrown: undefined', 'undefined'],
    [{ a: 1 }, 'Non-error object thrown', 'object'],
    [Symbol('s'), 'Non-error value thrown: Symbol(s)', 'symbol'],
    [() => 1, 'Non-error function thrown', 'function'],
  ])('wraps thrown non-error %p into an AppError', (thrown, message, thrownType) => {
    const error = ensureError(thrown);
    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toBe(message);
    expect((error as AppError).code).toBe('UNKNOWN_THROWN');
    expect((error as AppError).context['thrownType']).toBe(thrownType);
    expect(error.cause).toBe(thrown);
  });
});

describe('Result', () => {
  it('ok / err / guards / unwrapOr', () => {
    const good = ok(1);
    const bad = err(new ConfigError('x'));
    expect(isOk(good)).toBe(true);
    expect(isErr(good)).toBe(false);
    expect(isOk(bad)).toBe(false);
    expect(isErr(bad)).toBe(true);
    expect(unwrapOr(good, 9)).toBe(1);
    expect(unwrapOr(bad, 9)).toBe(9);
  });

  it('tryCatch converts throws to Err and keeps values as Ok', async () => {
    await expect(tryCatch(() => Promise.resolve('v'))).resolves.toEqual(ok('v'));
    const failed = await tryCatch(() => Promise.reject(new Error('nope')));
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.message).toBe('nope');
    }
    const thrownString = await tryCatch(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error, no-restricted-syntax -- proving the guard
      throw 'raw';
    });
    expect(thrownString.ok).toBe(false);
    if (!thrownString.ok) {
      expect(thrownString.error).toBeInstanceOf(AppError);
      expect((thrownString.error as AppError).code).toBe('UNKNOWN_THROWN');
    }
  });
});
