/**
 * Voyage adapter (src/lib/memory/embed.ts) against scripted fetches and an in-memory
 * ledger. Part C items 3, 4, 5 and 7 at the adapter level: dimensions, the api_usage row
 * with wire tokens, the cap refusing before any HTTP, the key in no log line.
 */
import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/lib/errors.js';
import { createVoyageEmbedder } from '../../../src/lib/memory/embed.js';
import { capturingLogger, httpFor, memoryUsageStore, scriptedFetch } from '../llm/helpers.js';
import { FAKE_VOYAGE_KEY, voyageConfig, voyageFixture } from './helpers.js';

const NOW = new Date('2026-08-25T12:00:00Z');
const TEXT = 'The user said most of his clients are tradies in Perth and prefers plain language.';

function embedder(
  steps: Parameters<typeof scriptedFetch>[0],
  overrides: Parameters<typeof voyageConfig>[0] = {},
  spent = { day: 0, month: 0 },
) {
  const { log, lines } = capturingLogger();
  const fetch = scriptedFetch(steps);
  const usage = memoryUsageStore(spent);
  const config = voyageConfig(overrides);
  const http = httpFor(fetch.fetch, log, config.timeoutMs);
  const client = createVoyageEmbedder({ config, http, usage, log, now: () => NOW });
  return { client, fetch, usage, lines };
}

const request = {
  texts: [TEXT],
  inputType: 'document' as const,
  operation: 'memory.embed',
  userId: 'u1',
  conversationId: 'c1',
};

describe('a successful call', () => {
  it('returns one 1024-dimension non-zero vector and records the wire token count', async () => {
    const e = embedder([{ kind: 'status', status: 200, body: voyageFixture('embeddings-ok') }]);
    const result = await e.client.embed(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vectors).toHaveLength(1);
    expect(result.value.vectors[0]).toHaveLength(1024);
    expect(result.value.vectors[0]?.some((n) => n !== 0)).toBe(true);
    expect(result.value.totalTokens).toBe(212);
    // 212 × $0.06 / 1e6 = $0.00001272 → 6 dp
    expect(result.value.costUsd).toBe(0.000013);
    expect(result.value.attempts).toBe(1);

    expect(e.usage.rows).toEqual([
      {
        provider: 'voyage',
        operation: 'memory.embed',
        model: 'voyage-3',
        inputTokens: 212,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.000013,
        userId: 'u1',
        conversationId: 'c1',
      },
    ]);
  });

  it('sends the documented request shape with the key in exactly one header', async () => {
    const e = embedder([{ kind: 'status', status: 200, body: voyageFixture('embeddings-ok') }]);
    await e.client.embed(request);
    expect(e.fetch.calls).toHaveLength(1);
    const call = e.fetch.calls[0];
    expect(call?.url).toBe('https://voyage.test/v1/embeddings');
    expect(JSON.parse(call?.init.body as string)).toEqual({
      input: [TEXT],
      model: 'voyage-3',
      input_type: 'document',
      output_dimension: 1024,
    });
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${FAKE_VOYAGE_KEY}`);
    expect(call?.init.body as string).not.toContain(FAKE_VOYAGE_KEY);
  });

  it('orders vectors by index, whatever order the wire used', async () => {
    const e = embedder([{ kind: 'status', status: 200, body: voyageFixture('embeddings-two') }]);
    const result = await e.client.embed({ ...request, texts: ['a', 'b'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vectors).toHaveLength(2);
    expect(result.value.vectors[0]?.[0]).toBe(-(result.value.vectors[1]?.[0] ?? 0));
    expect(result.value.totalTokens).toBe(420);
  });
});

describe('the cap — Part C item 5', () => {
  it('refuses before any HTTP call when the daily cap is 0, and records nothing', async () => {
    const e = embedder([{ kind: 'status', status: 200, body: voyageFixture('embeddings-ok') }], {
      caps: { dailyUsd: 0, monthlyUsd: 5, warnFraction: 0.8 },
    });
    const result = await e.client.embed(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SPEND_CAP');
    expect(result.error.context['window']).toBe('day');
    expect(e.fetch.calls).toHaveLength(0);
    expect(e.usage.rows).toEqual([]);
  });

  it('counts spent-so-far plus this call: the month cap trips first', async () => {
    const e = embedder([], {}, { day: 0, month: 4.999999 });
    const result = await e.client.embed(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SPEND_CAP');
    expect(result.error.context['window']).toBe('month');
    expect(e.fetch.calls).toHaveLength(0);
  });

  it('checkBudget is the same gate with no request', async () => {
    const open = embedder([]);
    expect(await open.client.checkBudget(2_000)).toEqual({ ok: true, value: undefined });
    const shut = embedder([], { caps: { dailyUsd: 0, monthlyUsd: 5, warnFraction: 0.8 } });
    const refused = await shut.client.checkBudget(2_000);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('SPEND_CAP');
    expect(shut.fetch.calls).toHaveLength(0);
  });

  it('fails closed when the ledger cannot be read', async () => {
    const e = embedder([]);
    e.usage.failSpent = new AppError('NETWORK', 'ledger down', { retryable: true });
    const result = await e.client.embed(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NETWORK');
    expect(e.fetch.calls).toHaveLength(0);
  });

  it('warns at 80% without refusing', async () => {
    const e = embedder(
      [{ kind: 'status', status: 200, body: voyageFixture('embeddings-ok') }],
      {},
      { day: 0.41, month: 0.41 },
    );
    const result = await e.client.embed(request);
    expect(result.ok).toBe(true);
    expect(e.lines.some((l) => l.includes('approaching cap'))).toBe(true);
  });
});

describe('failures', () => {
  it('retries a 5xx (idempotent) and succeeds on the second attempt', async () => {
    const e = embedder([
      { kind: 'status', status: 503, body: '{"detail":"try later"}' },
      { kind: 'status', status: 200, body: voyageFixture('embeddings-ok') },
    ]);
    const result = await e.client.embed(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(2);
    expect(e.usage.rows).toHaveLength(1);
  });

  it('429 after retries → RATE_LIMITED with the server delay, nothing recorded', async () => {
    const e = embedder(
      Array.from({ length: 3 }, () => ({
        kind: 'status' as const,
        status: 429,
        body: voyageFixture('error-429'),
        headers: { 'retry-after': '7' },
      })),
    );
    const result = await e.client.embed(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RATE_LIMITED');
    expect(result.error.context['retryAfterMs']).toBe(7_000);
    expect(e.usage.rows).toEqual([]);
  });

  it('401 → HTTP_STATUS carrying the detail, never the key, nothing recorded', async () => {
    const e = embedder([{ kind: 'status', status: 401, body: voyageFixture('error-401') }]);
    const result = await e.client.embed(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('HTTP_STATUS');
    expect(result.error.message).toContain('401');
    expect(result.error.message).toContain('API key is invalid');
    expect(JSON.stringify(result.error.toJSON())).not.toContain(FAKE_VOYAGE_KEY);
    expect(e.usage.rows).toEqual([]);
  });

  it('a timeout after send records the worst-case reservation', async () => {
    const e = embedder([{ kind: 'hang' }, { kind: 'hang' }, { kind: 'hang' }], { timeoutMs: 20 });
    const result = await e.client.embed(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TIMEOUT');
    expect(e.usage.rows).toHaveLength(1);
    expect(e.usage.rows[0]).toMatchObject({
      provider: 'voyage',
      operation: 'memory.embed:unconfirmed',
      inputTokens: Math.ceil(TEXT.length / 3),
    });
  });

  it('a 200 with the wrong dimensions is billed, recorded, and refused', async () => {
    const e = embedder([
      { kind: 'status', status: 200, body: voyageFixture('embeddings-wrong-dims') },
    ]);
    const result = await e.client.embed(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.message).toContain('unusable vectors');
    expect(e.usage.rows).toHaveLength(1);
    expect(e.usage.rows[0]).toMatchObject({ operation: 'memory.embed', inputTokens: 212 });
  });

  it('a 200 that is not the documented shape records the reservation', async () => {
    const e = embedder([{ kind: 'status', status: 200, body: '{"data":"nope"}' }]);
    const result = await e.client.embed(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(e.usage.rows[0]?.operation).toBe('memory.embed:unconfirmed');
  });

  it('refuses an empty batch and a blank text without touching the ledger', async () => {
    const e = embedder([]);
    expect((await e.client.embed({ ...request, texts: [] })).ok).toBe(false);
    expect((await e.client.embed({ ...request, texts: ['   '] })).ok).toBe(false);
    expect(e.usage.spentQueries).toHaveLength(0);
  });
});

describe('the key — Part C item 7', () => {
  it('appears in no log line across success, refusal and failure', async () => {
    const e = embedder([
      { kind: 'status', status: 200, body: voyageFixture('embeddings-ok') },
      { kind: 'status', status: 401, body: voyageFixture('error-401') },
      { kind: 'throw', error: new Error(`boom ${FAKE_VOYAGE_KEY}`) },
      { kind: 'throw', error: new Error(`boom ${FAKE_VOYAGE_KEY}`) },
      { kind: 'throw', error: new Error(`boom ${FAKE_VOYAGE_KEY}`) },
    ]);
    const first = await e.client.embed(request);
    const second = await e.client.embed(request);
    const third = await e.client.embed(request);
    expect(e.lines.length).toBeGreaterThan(0);
    for (const line of e.lines) expect(line, line).not.toContain(FAKE_VOYAGE_KEY);
    for (const r of [first, second, third]) {
      expect(JSON.stringify(r.ok ? r.value : r.error.toJSON())).not.toContain(FAKE_VOYAGE_KEY);
    }
  });
});
