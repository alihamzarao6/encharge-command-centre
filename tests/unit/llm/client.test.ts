/**
 * Claude wrapper (src/lib/llm/client.ts) — Part C items 1, 2, 3, 4, 5 and 8 measured with
 * a scripted fetch, an in-memory usage store and a capturing log sink. No network.
 */
import { describe, expect, it } from 'vitest';

import { serialiseForLog } from '../../../src/lib/logger.js';
import {
  createClaudeClient,
  type buildRequestBody,
  type AlertEvent,
  type Alerter,
  type CompletionRequest,
} from '../../../src/lib/llm/client.js';
import { costUsd, DEFAULT_PRICING } from '../../../src/lib/llm/pricing.js';
import {
  FAKE_KEY,
  capturingLogger,
  fixture,
  httpFor,
  infraError,
  memoryUsageStore,
  scriptedFetch,
  testConfig,
  type Step,
} from './helpers.js';

const SYSTEM = [{ text: 'placeholder system', cache: true }];

function bodyOf(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    system: SYSTEM,
    messages: [{ role: 'user', content: 'hello there' }],
    operation: 'chat.turn',
    userId: 'a0000000-0000-4000-8000-000000000001',
    conversationId: 'c0000000-0000-4000-8000-000000000001',
    ...overrides,
  };
}

function recordingAlerter(): Alerter & { events: AlertEvent[] } {
  const events: AlertEvent[] = [];
  return {
    events,
    notify: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}

interface Harness {
  readonly client: ReturnType<typeof createClaudeClient>;
  readonly fetch: ReturnType<typeof scriptedFetch>;
  readonly usage: ReturnType<typeof memoryUsageStore>;
  readonly alerts: ReturnType<typeof recordingAlerter>;
  readonly lines: string[];
}

function harness(
  steps: readonly Step[],
  options: {
    spent?: { day: number; month: number };
    config?: Partial<Parameters<typeof testConfig>[0]>;
    timeoutMs?: number;
  } = {},
): Harness {
  const { log, lines } = capturingLogger();
  const fetch = scriptedFetch(steps);
  const usage = memoryUsageStore(options.spent);
  const alerts = recordingAlerter();
  const config = testConfig(options.config);
  const client = createClaudeClient({
    config,
    http: httpFor(fetch.fetch, log, options.timeoutMs ?? config.timeoutMs),
    usage,
    log,
    alert: alerts,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    now: () => new Date('2026-08-25T10:00:00Z'),
  });
  return { client, fetch, usage, alerts, lines };
}

const ok200: Step = { kind: 'status', status: 200, body: fixture('messages-ok') };

describe('spend cap — Part C items 1 and 2', () => {
  it('refuses BEFORE the HTTP call when the daily cap is already spent: zero fetches, no usage row, typed error', async () => {
    const h = harness([ok200], { spent: { day: 5, month: 5 } });
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SPEND_CAP');
    expect(result.error.context['window']).toBe('day');
    expect(h.fetch.calls).toHaveLength(0);
    expect(h.usage.rows).toHaveLength(0);
    expect(h.alerts.events).toEqual([
      { kind: 'cap_reached', window: 'day', spentUsd: 5, capUsd: 5 },
    ]);
  });

  it('refuses on the monthly cap even when the day is fine', async () => {
    const h = harness([ok200], { spent: { day: 0, month: 49.999 } });
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SPEND_CAP');
    expect(result.error.context['window']).toBe('month');
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('a cap of 0 refuses everything — the deliberate "trip the cap" configuration', async () => {
    const h = harness([ok200], {
      config: { caps: { dailyUsd: 0, monthlyUsd: 50, warnFraction: 0.8 } },
    });
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    expect(h.fetch.calls).toHaveLength(0);
  });

  it("counts THIS call's worst case: spent under the cap but spent + estimate over it is refused", async () => {
    // 256 max tokens × $15/M = $0.00384 output alone; day cap leaves $0.001.
    const h = harness([ok200], { spent: { day: 4.999, month: 10 } });
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('refuses when spend-to-date cannot be read (fail closed): no fetch', async () => {
    const h = harness([ok200]);
    h.usage.failSpent = infraError();
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NETWORK');
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('a refusal is a returned value, never a thrown exception', async () => {
    const h = harness([ok200], { spent: { day: 5, month: 5 } });
    await expect(h.client.complete(request())).resolves.toMatchObject({ ok: false });
  });

  it('warns and alerts at 80% of a cap without refusing', async () => {
    const h = harness([ok200], { spent: { day: 4.2, month: 10 } });
    const result = await h.client.complete(request());
    expect(result.ok).toBe(true);
    expect(h.alerts.events).toEqual([
      { kind: 'cap_warning', window: 'day', spentUsd: 4.2, capUsd: 5 },
    ]);
    expect(h.lines.some((l) => l.includes('spend approaching cap'))).toBe(true);
  });
});

describe('successful call — Part C item 3', () => {
  it("writes exactly one api_usage row with the response's non-zero token counts and the computed cost", async () => {
    const h = harness([ok200]);
    const result = await h.client.complete(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain('brand voice');
    expect(result.value.model).toBe('claude-sonnet-5');
    expect(result.value.stopReason).toBe('end_turn');
    expect(result.value.attempts).toBe(1);

    expect(h.usage.rows).toHaveLength(1);
    const row = h.usage.rows[0];
    expect(row).toMatchObject({
      provider: 'anthropic',
      operation: 'chat.turn',
      model: 'claude-sonnet-5',
      inputTokens: 168,
      outputTokens: 118,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      userId: 'a0000000-0000-4000-8000-000000000001',
      conversationId: 'c0000000-0000-4000-8000-000000000001',
    });
    expect(row?.inputTokens).toBeGreaterThan(0);
    expect(row?.outputTokens).toBeGreaterThan(0);
    // 168 × $3/M + 118 × $15/M = 0.000504 + 0.00177 = 0.002274
    expect(row?.costUsd).toBe(0.002274);
    expect(result.value.costUsd).toBe(
      costUsd(
        DEFAULT_PRICING['claude-sonnet-5'] ?? {
          inputPerMTok: 0,
          outputPerMTok: 0,
          cacheWritePerMTok: 0,
          cacheReadPerMTok: 0,
        },
        result.value.usage,
      ),
    );
  });

  it('sends the key as x-api-key, the version header, cache_control on the stable prefix, and a POST to /v1/messages', async () => {
    const h = harness([ok200]);
    await h.client.complete(request());
    const call = h.fetch.calls[0];
    expect(call?.url).toBe('https://anthropic.test/v1/messages');
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(FAKE_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(bodyOf(call?.init)) as ReturnType<typeof buildRequestBody>;
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.max_tokens).toBe(256);
    // Sonnet 5 thinks adaptively when the field is omitted; the chat path must say so explicitly.
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.system[0]).toEqual({
      type: 'text',
      text: 'placeholder system',
      cache_control: { type: 'ephemeral' },
    });
    expect(body.messages).toEqual([{ role: 'user', content: 'hello there' }]);
  });

  it('routes "fast" to the fast model and prices it at Haiku rates', async () => {
    const haiku = fixture('messages-ok').replace('claude-sonnet-5', 'claude-haiku-4-5-20251001');
    const h = harness([{ kind: 'status', status: 200, body: haiku }]);
    const result = await h.client.complete(request({ route: 'fast' }));
    expect(result.ok).toBe(true);
    const body = JSON.parse(bodyOf(h.fetch.calls[0]?.init)) as { model: string };
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    // 168 × $1/M + 118 × $5/M = 0.000168 + 0.00059
    expect(h.usage.rows[0]?.costUsd).toBe(0.000758);
  });

  it('records cache tokens and prices them at write 1.25× / read 0.1×', async () => {
    const cached = fixture('messages-ok')
      .replace('"cache_creation_input_tokens": 0', '"cache_creation_input_tokens": 1000')
      .replace('"cache_read_input_tokens": 0', '"cache_read_input_tokens": 2000');
    const h = harness([{ kind: 'status', status: 200, body: cached }]);
    const result = await h.client.complete(request());
    expect(result.ok).toBe(true);
    // 0.002274 + 1000 × 3.75/M (0.00375) + 2000 × 0.30/M (0.0006) = 0.006624
    expect(h.usage.rows[0]).toMatchObject({
      cacheWriteTokens: 1000,
      cacheReadTokens: 2000,
      costUsd: 0.006624,
    });
  });

  it('a model refusal is billed, recorded, and returned as MODEL_REFUSAL with its category', async () => {
    const h = harness([{ kind: 'status', status: 200, body: fixture('messages-refusal') }]);
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MODEL_REFUSAL');
    expect(result.error.context['category']).toBe('fixture_category');
    expect(h.usage.rows).toHaveLength(1);
    expect(h.usage.rows[0]?.inputTokens).toBe(90);
  });

  it('still returns the completion when the usage row cannot be written, and alerts loudly', async () => {
    const h = harness([ok200]);
    h.usage.failRecord = infraError();
    const result = await h.client.complete(request());
    expect(result.ok).toBe(true);
    expect(h.alerts.events).toEqual([
      { kind: 'usage_unrecorded', operation: 'chat.turn', costUsd: 0.002274 },
    ]);
    expect(h.lines.some((l) => l.includes('api_usage row NOT recorded'))).toBe(true);
  });
});

describe('failure mid-flight — Part C items 4 and 8', () => {
  it('a timeout after send records the worst-case reservation and is NOT retried', async () => {
    const h = harness([{ kind: 'hang' }, ok200], { timeoutMs: 20 });
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TIMEOUT');
    expect(h.fetch.calls).toHaveLength(1);
    expect(h.usage.rows).toHaveLength(1);
    const row = h.usage.rows[0];
    expect(row?.operation).toBe('chat.turn:unconfirmed');
    expect(row?.outputTokens).toBe(256);
    expect(row?.inputTokens).toBeGreaterThan(0);
    expect(row?.costUsd).toBeGreaterThan(0);
  });

  it('a transport failure after send records the reservation and is NOT retried', async () => {
    const h = harness([{ kind: 'throw', error: new Error('ECONNRESET') }, ok200]);
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NETWORK');
    expect(h.fetch.calls).toHaveLength(1);
    expect(h.usage.rows.map((r) => r.operation)).toEqual(['chat.turn:unconfirmed']);
  });

  it('a 200 with an unreadable body (billed, unknown usage) records the reservation', async () => {
    const h = harness([{ kind: 'status', status: 200, body: '{"type":"message"' }]);
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(h.usage.rows.map((r) => r.operation)).toEqual(['chat.turn:unconfirmed']);
  });

  it('a 200 that is not a Messages API shape is refused by the schema and recorded', async () => {
    const h = harness([{ kind: 'status', status: 200, body: '{"type":"message","id":"x"}' }]);
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(h.usage.rows).toHaveLength(1);
  });

  it('retries a 429 (provably unbilled) once, honouring Retry-After, then succeeds with ONE usage row', async () => {
    const h = harness([
      { kind: 'status', status: 429, body: fixture('error-429'), headers: { 'retry-after': '1' } },
      ok200,
    ]);
    const result = await h.client.complete(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(2);
    expect(h.fetch.calls).toHaveLength(2);
    expect(h.usage.rows).toHaveLength(1);
  });

  it('retries a 529 overloaded error envelope, then succeeds', async () => {
    const h = harness([{ kind: 'status', status: 529, body: fixture('error-529') }, ok200]);
    const result = await h.client.complete(request());
    expect(result.ok).toBe(true);
    expect(h.fetch.calls).toHaveLength(2);
  });

  it('gives up after the configured retries with a typed RATE_LIMITED error and no usage row', async () => {
    const limited: Step = { kind: 'status', status: 429, body: fixture('error-429') };
    const h = harness([limited, limited, limited]);
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RATE_LIMITED');
    expect(h.fetch.calls).toHaveLength(3); // 1 + retries(2)
    expect(h.usage.rows).toHaveLength(0);
  });

  it('a 4xx error envelope is returned at once with the API error type, no retry, no row', async () => {
    const h = harness([{ kind: 'status', status: 400, body: fixture('error-400') }, ok200]);
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('HTTP_STATUS');
    expect(result.error.message).toContain('invalid_request_error');
    expect(h.fetch.calls).toHaveLength(1);
    expect(h.usage.rows).toHaveLength(0);
  });

  it('with retries = 0 a 529 is returned as HTTP_STATUS after a single attempt', async () => {
    const h = harness([{ kind: 'status', status: 529, body: fixture('error-529') }], {
      config: { retries: 0 },
    });
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('HTTP_STATUS');
    expect(h.fetch.calls).toHaveLength(1);
  });

  it('does not call at all while the circuit is open', async () => {
    const { log, lines } = capturingLogger();
    const fetch = scriptedFetch([{ kind: 'throw', error: new Error('down') }, ok200]);
    const usage = memoryUsageStore();
    const http = httpFor(fetch.fetch, log);
    // Trip the breaker directly through http.ts (threshold 100 in httpFor → use a fresh one).
    const tripped = (await import('../../../src/lib/http.js')).createHttpClient({
      fetch: fetch.fetch,
      retries: 0,
      breaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
      logger: log,
    });
    const client = createClaudeClient({ config: testConfig(), http: tripped, usage, log });
    const first = await client.complete(request());
    expect(first.ok).toBe(false);
    const second = await client.complete(request());
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('CIRCUIT_OPEN');
    expect(fetch.calls).toHaveLength(1);
    expect(usage.rows).toHaveLength(1); // only the first (network) reservation
    expect(http).toBeDefined();
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe('input validation', () => {
  it('refuses an unknown (unpriced) model before any call', async () => {
    const h = harness([ok200], { config: { models: { default: 'claude-unknown-9', fast: 'x' } } });
    const result = await h.client.complete(request());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG');
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('refuses an empty message list', async () => {
    const h = harness([ok200]);
    const result = await h.client.complete(request({ messages: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(h.fetch.calls).toHaveLength(0);
  });
});

describe('the key — Part C item 5', () => {
  it('appears in no log line, no returned value and no error, across success, cap refusal, timeout and 4xx', async () => {
    const scenarios: {
      steps: Step[];
      spent?: { day: number; month: number };
      timeoutMs?: number;
    }[] = [
      { steps: [ok200] },
      { steps: [ok200], spent: { day: 5, month: 5 } },
      { steps: [{ kind: 'hang' }], timeoutMs: 20 },
      { steps: [{ kind: 'status', status: 400, body: fixture('error-400') }] },
      { steps: [{ kind: 'throw', error: new Error(`boom ${FAKE_KEY}`) }] },
    ];
    for (const scenario of scenarios) {
      const h = harness(scenario.steps, {
        ...(scenario.spent === undefined ? {} : { spent: scenario.spent }),
        ...(scenario.timeoutMs === undefined ? {} : { timeoutMs: scenario.timeoutMs }),
      });
      const result = await h.client.complete(request());
      expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
      expect(JSON.stringify(serialiseForLog(result))).not.toContain(FAKE_KEY);
      for (const line of h.lines) {
        expect(line, line).not.toContain(FAKE_KEY);
      }
      // The header is the ONLY place the key exists — and the header object is not logged.
      expect(h.lines.join('\n')).not.toContain('x-api-key');
    }
  });
});
