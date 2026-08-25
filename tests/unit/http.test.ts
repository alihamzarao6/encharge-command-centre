import { describe, expect, it } from 'vitest';

import { CircuitOpenError, ConfigError } from '../../src/lib/errors.js';
import {
  createHttpClient,
  originOf,
  parseJsonBody,
  parseRetryAfterMs,
  redactedUrl,
  type FetchLike,
  type HttpClientOptions,
} from '../../src/lib/http.js';
import { createLogger } from '../../src/lib/logger.js';

const URL_A = 'https://api-a.example.com/v1/thing?token=secret';
const URL_B = 'https://api-b.example.com/v1/other';

type Step =
  | { kind: 'status'; status: number; body?: string; headers?: Record<string, string> }
  | { kind: 'throw'; error: unknown }
  | { kind: 'hang' };

/** A scripted fetch: each call consumes the next step. Hangs resolve only on abort. */
function scriptedFetch(steps: readonly Step[]): { fetch: FetchLike; calls: RequestInit[] } {
  const remaining = [...steps];
  const calls: RequestInit[] = [];
  const fetch: FetchLike = (_input, init) => {
    calls.push(init);
    const step = remaining.shift();
    if (step === undefined) {
      return Promise.reject(new Error('scriptedFetch: no step left'));
    }
    switch (step.kind) {
      case 'status':
        return Promise.resolve(
          new Response(step.body ?? `body-${step.status}`, {
            status: step.status,
            headers: step.headers ?? {},
          }),
        );
      case 'throw':
        // Deliberately rejecting with whatever the test scripted — including non-Errors —
        // because http.ts must normalise anything fetch throws.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(step.error);
      case 'hang':
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
    }
  };
  return { fetch, calls };
}

function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

const silentLogger = createLogger({ level: 'silent' });

function client(
  steps: readonly Step[],
  overrides: Partial<HttpClientOptions> = {},
): {
  http: ReturnType<typeof createHttpClient>;
  calls: RequestInit[];
  sleeps: number[];
} {
  const { fetch, calls } = scriptedFetch(steps);
  const sleeps: number[] = [];
  const http = createHttpClient({
    fetch,
    logger: silentLogger,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 1, // deterministic: upper edge of the jitter band
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    retries: 3,
    ...overrides,
  });
  return { http, calls, sleeps };
}

describe('createHttpClient — basics', () => {
  it('returns the body and status on first-try success without sleeping', async () => {
    const { http, calls, sleeps } = client([{ kind: 'status', status: 200, body: 'ok!' }]);
    const result = await http.request(URL_A);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe(200);
      expect(result.value.bodyText).toBe('ok!');
      expect(result.value.attempts).toBe(1);
      expect(result.value.url).toBe(URL_A);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(sleeps).toEqual([]);
  });

  it('passes method, headers and body through and always attaches an abort signal', async () => {
    const { http, calls } = client([{ kind: 'status', status: 201 }]);
    await http.request(URL_A, {
      method: 'post',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.body).toBe('{"a":1}');
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats 3xx as success (fetch follows redirects; a surfaced 3xx is a definite answer)', async () => {
    const { http } = client([{ kind: 'status', status: 302 }]);
    const result = await http.request(URL_A);
    expect(result.ok).toBe(true);
  });

  it('rejects invalid options with a ConfigError rather than running with them', () => {
    expect(() => createHttpClient({ timeoutMs: 0 })).toThrow(ConfigError);
    expect(() => createHttpClient({ retries: -1 })).toThrow(ConfigError);
    expect(() => createHttpClient({ baseDelayMs: Number.NaN })).toThrow(ConfigError);
    expect(() => createHttpClient({ breaker: { failureThreshold: 0 } })).toThrow(ConfigError);
  });
});

describe('retry — counts and idempotency', () => {
  it('retries a GET on 5xx and succeeds: 500, 502, then 200 = 3 attempts, 2 sleeps', async () => {
    const { http, calls, sleeps } = client([
      { kind: 'status', status: 500 },
      { kind: 'status', status: 502 },
      { kind: 'status', status: 200 },
    ]);
    const result = await http.request(URL_A);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.attempts).toBe(3);
    }
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it('gives up after retries are exhausted: retries=3 → exactly 4 requests', async () => {
    const { http, calls, sleeps } = client([
      { kind: 'status', status: 503 },
      { kind: 'status', status: 503 },
      { kind: 'status', status: 503 },
      { kind: 'status', status: 503 },
    ]);
    const result = await http.request(URL_A);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('HTTP_STATUS');
      expect(result.error.context['status']).toBe(503);
      expect(result.error.context['attempt']).toBe(4);
      expect(result.error.retryable).toBe(true);
    }
    expect(calls).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
  });

  it('honours a per-request retries override', async () => {
    const { http, calls } = client([
      { kind: 'status', status: 500 },
      { kind: 'status', status: 500 },
    ]);
    const result = await http.request(URL_A, { retries: 1 });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('retries=0 means exactly one request', async () => {
    const { http, calls } = client([{ kind: 'status', status: 500 }], { retries: 0 });
    await http.request(URL_A);
    expect(calls).toHaveLength(1);
  });

  it('never retries a POST by default, even on 5xx', async () => {
    const { http, calls, sleeps } = client([{ kind: 'status', status: 503 }]);
    const result = await http.request(URL_A, { method: 'POST', body: 'x' });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('retries a POST only when the caller declares it idempotent', async () => {
    const { http, calls } = client([
      { kind: 'status', status: 503 },
      { kind: 'status', status: 200 },
    ]);
    const result = await http.request(URL_A, { method: 'POST', body: 'x', idempotent: true });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('lets the caller mark a GET as non-idempotent to disable retries', async () => {
    const { http, calls } = client([{ kind: 'status', status: 503 }]);
    await http.request(URL_A, { idempotent: false });
    expect(calls).toHaveLength(1);
  });

  it('does not retry a 4xx — a definite answer is not a transient failure', async () => {
    const { http, calls, sleeps } = client([{ kind: 'status', status: 404, body: 'missing' }]);
    const result = await http.request(URL_A);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('HTTP_STATUS');
      expect(result.error.retryable).toBe(false);
      expect(result.error.context['bodySnippet']).toBe('missing');
      // The logged URL carries no query string: tokens travel in query strings.
      expect(result.error.context['url']).toBe('https://api-a.example.com/v1/thing');
      expect(result.error.message).not.toContain('secret');
    }
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('retries 408, 425 and 429 like 5xx', async () => {
    const { http, calls } = client([
      { kind: 'status', status: 408 },
      { kind: 'status', status: 425 },
      { kind: 'status', status: 429 },
      { kind: 'status', status: 200 },
    ]);
    const result = await http.request(URL_A);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('retries on a network error and reports NETWORK when it never recovers', async () => {
    const { http, calls } = client([
      { kind: 'throw', error: new TypeError('fetch failed') },
      { kind: 'throw', error: new TypeError('fetch failed') },
    ]);
    const result = await http.request(URL_A, { retries: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK');
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain('fetch failed');
      expect(result.error.cause).toBeInstanceOf(TypeError);
    }
    expect(calls).toHaveLength(2);
  });

  it('wraps a thrown non-Error from fetch via ensureError', async () => {
    const { http } = client([{ kind: 'throw', error: 'string failure' }], { retries: 0 });
    const result = await http.request(URL_A);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK');
      expect(result.error.message).toContain('string failure');
    }
  });
});

describe('retry — backoff, jitter, Retry-After', () => {
  it('grows exponentially from baseDelayMs with equal jitter, capped at maxDelayMs', async () => {
    // random=1 → full cap each time: 100, 200, 400 (base * 2^(attempt-1)), then capped at 1000.
    const { http, sleeps } = client(
      [
        { kind: 'status', status: 500 },
        { kind: 'status', status: 500 },
        { kind: 'status', status: 500 },
        { kind: 'status', status: 500 },
        { kind: 'status', status: 500 },
        { kind: 'status', status: 200 },
      ],
      { retries: 5 },
    );
    await http.request(URL_A);
    expect(sleeps).toEqual([100, 200, 400, 800, 1000]);
  });

  it('jitter keeps delays inside [cap/2, cap]: random=0 gives the lower edge', async () => {
    const { http, sleeps } = client(
      [
        { kind: 'status', status: 500 },
        { kind: 'status', status: 500 },
        { kind: 'status', status: 200 },
      ],
      { random: () => 0 },
    );
    await http.request(URL_A);
    expect(sleeps).toEqual([50, 100]);
  });

  it('honours Retry-After in seconds, capped at maxRetryAfterMs', async () => {
    const { http, sleeps } = client(
      [
        { kind: 'status', status: 429, headers: { 'retry-after': '2' } },
        { kind: 'status', status: 429, headers: { 'retry-after': '999' } },
        { kind: 'status', status: 200 },
      ],
      { maxRetryAfterMs: 5_000 },
    );
    await http.request(URL_A);
    expect(sleeps).toEqual([2_000, 5_000]);
  });

  it('honours an HTTP-date Retry-After relative to the injected clock', async () => {
    const clock = fakeClock(Date.parse('2026-08-23T10:00:00Z'));
    const { http, sleeps } = client(
      [
        {
          kind: 'status',
          status: 503,
          headers: { 'retry-after': 'Sun, 23 Aug 2026 10:00:03 GMT' },
        },
        { kind: 'status', status: 200 },
      ],
      { now: clock.now },
    );
    await http.request(URL_A);
    expect(sleeps).toEqual([3_000]);
  });

  it('falls back to backoff when Retry-After is unparseable', async () => {
    const { http, sleeps } = client([
      { kind: 'status', status: 503, headers: { 'retry-after': 'soon' } },
      { kind: 'status', status: 200 },
    ]);
    await http.request(URL_A);
    expect(sleeps).toEqual([100]);
  });
});

describe('timeout', () => {
  it('aborts a hanging request after timeoutMs and reports TIMEOUT', async () => {
    const { http, calls } = client([{ kind: 'hang' }], { timeoutMs: 20, retries: 0 });
    const result = await http.request(URL_A);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TIMEOUT');
      expect(result.error.context['timeoutMs']).toBe(20);
      expect(result.error.retryable).toBe(true);
    }
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('retries after a timeout on an idempotent request', async () => {
    const { http, calls } = client([{ kind: 'hang' }, { kind: 'status', status: 200 }], {
      timeoutMs: 20,
    });
    const result = await http.request(URL_A, { retries: 1 });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('a per-request timeout overrides the client default', async () => {
    const { http } = client([{ kind: 'hang' }], { timeoutMs: 60_000, retries: 0 });
    const result = await http.request(URL_A, { timeoutMs: 15 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context['timeoutMs']).toBe(15);
    }
  });
});

describe('circuit breaker', () => {
  const failing = (n: number): Step[] =>
    Array.from({ length: n }, () => ({ kind: 'status', status: 503 }));

  it('opens after failureThreshold consecutive failures and then refuses without calling fetch', async () => {
    const clock = fakeClock();
    const { http, calls } = client(failing(3), {
      retries: 0,
      now: clock.now,
      breaker: { failureThreshold: 3, resetTimeoutMs: 10_000 },
    });
    const origin = originOf(URL_A);

    expect(http.getBreakerState(origin)).toEqual({ state: 'closed', consecutiveFailures: 0 });
    await http.request(URL_A);
    await http.request(URL_A);
    expect(http.getBreakerState(origin)).toEqual({ state: 'closed', consecutiveFailures: 2 });
    await http.request(URL_A);
    expect(http.getBreakerState(origin)).toEqual({
      state: 'open',
      openedAt: clock.now(),
      reopensAt: clock.now() + 10_000,
    });
    expect(calls).toHaveLength(3);

    clock.advance(5_000);
    const refused = await http.request(URL_A);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toBeInstanceOf(CircuitOpenError);
      expect(refused.error.code).toBe('CIRCUIT_OPEN');
      expect((refused.error as CircuitOpenError).retryAfterMs).toBe(5_000);
    }
    expect(calls).toHaveLength(3); // fetch was not called while open
  });

  it('goes half-open after resetTimeoutMs, and a successful trial CLOSES it', async () => {
    const clock = fakeClock();
    const { http, calls } = client(
      [...failing(2), { kind: 'status', status: 200 }, { kind: 'status', status: 200 }],
      {
        retries: 0,
        now: clock.now,
        breaker: { failureThreshold: 2, resetTimeoutMs: 1_000 },
      },
    );
    const origin = originOf(URL_A);
    await http.request(URL_A);
    await http.request(URL_A);
    expect(http.getBreakerState(origin).state).toBe('open');

    clock.advance(1_000);
    const trial = await http.request(URL_A);
    expect(trial.ok).toBe(true);
    expect(http.getBreakerState(origin)).toEqual({ state: 'closed', consecutiveFailures: 0 });

    const after = await http.request(URL_A);
    expect(after.ok).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('a failed trial RE-OPENS it for another full reset window', async () => {
    const clock = fakeClock();
    const { http, calls } = client(failing(3), {
      retries: 0,
      now: clock.now,
      breaker: { failureThreshold: 2, resetTimeoutMs: 1_000 },
    });
    const origin = originOf(URL_A);
    await http.request(URL_A);
    await http.request(URL_A);
    clock.advance(1_000);
    const trial = await http.request(URL_A); // third 503 — the trial fails
    expect(trial.ok).toBe(false);
    expect(http.getBreakerState(origin)).toEqual({
      state: 'open',
      openedAt: clock.now(),
      reopensAt: clock.now() + 1_000,
    });
    clock.advance(500);
    const refused = await http.request(URL_A);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('CIRCUIT_OPEN');
    }
    expect(calls).toHaveLength(3);
  });

  it('allows only one trial request while half-open', async () => {
    const clock = fakeClock();
    const { fetch, calls } = scriptedFetch([...failing(2), { kind: 'hang' }]);
    const http = createHttpClient({
      fetch,
      logger: silentLogger,
      retries: 0,
      timeoutMs: 50,
      now: clock.now,
      breaker: { failureThreshold: 2, resetTimeoutMs: 1_000 },
    });
    await http.request(URL_A);
    await http.request(URL_A);
    clock.advance(1_000);
    const trial = http.request(URL_A); // hangs until the timeout
    const concurrent = await http.request(URL_A);
    expect(concurrent.ok).toBe(false);
    if (!concurrent.ok) {
      expect(concurrent.error.code).toBe('CIRCUIT_OPEN');
      expect(concurrent.error.context['reason']).toBe('trial_in_flight');
    }
    expect(http.getBreakerState(originOf(URL_A))).toEqual({
      state: 'half_open',
      trialInFlight: true,
    });
    const trialResult = await trial;
    expect(trialResult.ok).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it('is keyed per origin: failures on A do not open B', async () => {
    const clock = fakeClock();
    const { http } = client([...failing(2), { kind: 'status', status: 200 }], {
      retries: 0,
      now: clock.now,
      breaker: { failureThreshold: 2, resetTimeoutMs: 1_000 },
    });
    await http.request(URL_A);
    await http.request(URL_A);
    expect(http.getBreakerState(originOf(URL_A)).state).toBe('open');
    const b = await http.request(URL_B);
    expect(b.ok).toBe(true);
    expect(http.getBreakerState(originOf(URL_B))).toEqual({
      state: 'closed',
      consecutiveFailures: 0,
    });
  });

  it('4xx responses do not count towards the breaker', async () => {
    const { http } = client(
      [...Array.from({ length: 5 }, (): Step => ({ kind: 'status', status: 404 }))],
      {
        breaker: { failureThreshold: 2 },
      },
    );
    for (let i = 0; i < 5; i += 1) {
      await http.request(URL_A);
    }
    expect(http.getBreakerState(originOf(URL_A))).toEqual({
      state: 'closed',
      consecutiveFailures: 0,
    });
  });

  it('a success resets the consecutive-failure count', async () => {
    const { http } = client([...failing(2), { kind: 'status', status: 200 }, ...failing(2)], {
      retries: 0,
      breaker: { failureThreshold: 3 },
    });
    const origin = originOf(URL_A);
    await http.request(URL_A);
    await http.request(URL_A);
    await http.request(URL_A);
    expect(http.getBreakerState(origin)).toEqual({ state: 'closed', consecutiveFailures: 0 });
    await http.request(URL_A);
    await http.request(URL_A);
    expect(http.getBreakerState(origin)).toEqual({ state: 'closed', consecutiveFailures: 2 });
  });

  it('opens mid-retry-loop and the remaining attempts are refused, not made', async () => {
    const { http, calls } = client(failing(6), {
      retries: 5,
      breaker: { failureThreshold: 2, resetTimeoutMs: 60_000 },
    });
    const result = await http.request(URL_A);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CIRCUIT_OPEN');
    }
    expect(calls).toHaveLength(2);
  });
});

describe('helpers', () => {
  it('parseJsonBody returns Ok for JSON and a ValidationError otherwise', () => {
    const good = parseJsonBody({
      status: 200,
      headers: new Headers(),
      url: URL_A,
      bodyText: '{"a":1}',
      attempts: 1,
    });
    expect(good).toEqual({ ok: true, value: { a: 1 } });
    const bad = parseJsonBody({
      status: 200,
      headers: new Headers(),
      url: URL_A,
      bodyText: 'not json',
      attempts: 1,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('VALIDATION');
      expect(bad.error.context['url']).toBe('https://api-a.example.com/v1/thing');
    }
  });

  it('parseRetryAfterMs handles seconds, dates, garbage and null', () => {
    const now = (): number => Date.parse('2026-08-23T10:00:00Z');
    expect(parseRetryAfterMs('3', now)).toBe(3_000);
    expect(parseRetryAfterMs(' 0 ', now)).toBe(0);
    expect(parseRetryAfterMs('Sun, 23 Aug 2026 10:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfterMs('Sun, 23 Aug 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs('later', now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
  });

  it('originOf and redactedUrl never throw and never expose the query string', () => {
    expect(originOf(URL_A)).toBe('https://api-a.example.com');
    expect(originOf('nope')).toBe('invalid-url');
    expect(redactedUrl('https://u:p@h.example.com/a/b?key=1#frag')).toBe(
      'https://h.example.com/a/b',
    );
    expect(redactedUrl('::')).toBe('invalid-url');
  });

  it('uses the global fetch when none is injected (and reaches no network here)', async () => {
    const originalFetch = globalThis.fetch;
    let seen = '';
    globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
      seen = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(new Response('g', { status: 200 }));
    };
    try {
      const http = createHttpClient({ logger: silentLogger });
      const result = await http.request(URL_B);
      expect(result.ok).toBe(true);
      expect(seen).toBe(URL_B);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the real sleep when none is injected (short delay, no network)', async () => {
    const { fetch } = scriptedFetch([
      { kind: 'status', status: 503 },
      { kind: 'status', status: 200 },
    ]);
    const http = createHttpClient({ fetch, logger: silentLogger, baseDelayMs: 1, maxDelayMs: 2 });
    const started = Date.now();
    const result = await http.request(URL_A);
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('open() — one attempt, headers under the timeout, body left for streaming', () => {
  it('returns the unread body on 2xx and counts a success on the breaker', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start: (c) => {
              c.enqueue(new TextEncoder().encode('hi'));
              c.close();
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          },
        ),
      );
    const client = createHttpClient({ fetch: fetchImpl, timeoutMs: 1_000, retries: 3 });
    const result = await client.open('https://api.example.com/v1', { method: 'POST', body: '{}' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.status).toBe(200);
    expect(await new Response(result.value.body).text()).toBe('hi');
    expect(client.getBreakerState('https://api.example.com')).toEqual({
      state: 'closed',
      consecutiveFailures: 0,
    });
  });

  it('a non-2xx reads the body into an HttpStatusError and never retries', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve(new Response('{"type":"error"}', { status: 529 }));
    };
    const client = createHttpClient({ fetch: fetchImpl, timeoutMs: 1_000, retries: 3 });
    const result = await client.open('https://api.example.com/v1', { method: 'POST' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('HTTP_STATUS');
    expect(result.error.context['bodySnippet']).toBe('{"type":"error"}');
    expect(calls).toBe(1);
  });

  it('respects the breaker and the header timeout', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const client = createHttpClient({
      fetch: hang,
      timeoutMs: 20,
      retries: 0,
      breaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
    });
    const first = await client.open('https://api.example.com/v1', { method: 'POST' });
    expect(!first.ok && first.error.code).toBe('TIMEOUT');
    const second = await client.open('https://api.example.com/v1', { method: 'POST' });
    expect(!second.ok && second.error.code).toBe('CIRCUIT_OPEN');
  });
});
