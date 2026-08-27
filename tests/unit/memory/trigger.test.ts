/**
 * The trigger end to end (src/lib/memory/trigger.ts) with the REAL Claude client and the
 * REAL Voyage adapter over scripted fetches (the recorded Haiku summary, the Voyage
 * fixture), an in-memory ledger, and an in-memory chunk store that enforces no-overlap.
 * Part C, in order:
 *
 *   1. a conversation crossing the threshold → exactly one chunk, range [1,11)
 *   2. re-running the same summarisation → no second chunk (policy AND the constraint path)
 *   3. the chunk's embedding is 1024-d and non-zero
 *   4. every Voyage call writes an api_usage row with real tokens and a cost
 *   5. the cap refuses before the Voyage call — no HTTP, and no Haiku call either
 *   7. the Voyage key is in no log line and no returned value
 *   8. summarisation failing never surfaces as a thrown/rejected hook
 */
import { describe, expect, it } from 'vitest';

import { AppError, ok } from '../../../src/lib/errors.js';
import { createHttpClient, type FetchLike } from '../../../src/lib/http.js';
import { createClaudeClient } from '../../../src/lib/llm/client.js';
import { createVoyageEmbedder, type EmbeddingRequest } from '../../../src/lib/memory/embed.js';
import {
  createAfterTurnHook,
  summariseConversation,
  sweepIdleConversations,
  type MemoryDeps,
} from '../../../src/lib/memory/trigger.js';
import { capturingLogger, memoryUsageStore, testConfig } from '../llm/helpers.js';
import {
  CONVERSATION,
  FAKE_VOYAGE_KEY,
  POLICY,
  anthropicFixture,
  fakeChunkStore,
  fakeEmbedder,
  messagesOf,
  voyageConfig,
  voyageFixture,
} from './helpers.js';

const NOW = new Date('2026-08-25T12:00:00Z');

interface Harness {
  readonly deps: MemoryDeps;
  readonly store: ReturnType<typeof fakeChunkStore>;
  readonly usage: ReturnType<typeof memoryUsageStore>;
  readonly lines: string[];
  readonly calls: { anthropic: number; voyage: number };
}

function harness(
  messages = messagesOf(10),
  options: { voyageDailyCap?: number; anthropicDailyCap?: number; summaryBody?: string } = {},
): Harness {
  const { log, lines } = capturingLogger();
  const calls = { anthropic: 0, voyage: 0 };
  const fetch: FetchLike = (url) => {
    if (url.startsWith('https://anthropic.test')) {
      calls.anthropic += 1;
      return Promise.resolve(
        new Response(options.summaryBody ?? anthropicFixture('summary-ok'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    calls.voyage += 1;
    return Promise.resolve(
      new Response(voyageFixture('embeddings-ok'), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  const http = createHttpClient({ fetch, retries: 0, sleep: () => Promise.resolve(), logger: log });
  const usage = memoryUsageStore();
  const claude = createClaudeClient({
    config: testConfig({
      caps: { dailyUsd: options.anthropicDailyCap ?? 5, monthlyUsd: 50, warnFraction: 0.8 },
    }),
    http,
    usage,
    log,
    now: () => NOW,
  });
  const embedder = createVoyageEmbedder({
    config: voyageConfig({
      caps: { dailyUsd: options.voyageDailyCap ?? 0.5, monthlyUsd: 5, warnFraction: 0.8 },
    }),
    http,
    usage,
    log,
    now: () => NOW,
  });
  const store = fakeChunkStore(messages);
  return {
    deps: { claude, embedder, chunks: store, policy: POLICY, log, now: () => NOW },
    store,
    usage,
    lines,
    calls,
  };
}

describe('Part C 1–4: one window → one chunk, idempotent, 1024-d, metered', () => {
  it('1. crossing the threshold produces exactly one chunk with turn_range [1,11)', async () => {
    const h = harness();
    const result = await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.planned).toEqual([{ lo: 1, hi: 11 }]);
    expect(result.value.chunks.map((c) => c.result)).toEqual(['inserted']);
    expect(h.store.chunks).toHaveLength(1);
    const chunk = h.store.chunks[0];
    expect(chunk?.range).toEqual({ lo: 1, hi: 11 });
    expect(chunk?.conversationId).toBe(CONVERSATION.id);
    expect(chunk?.userId).toBe(CONVERSATION.userId);
    expect(chunk?.scope).toBe('workspace');
    // The stored text is the recorded Haiku note, not the messages.
    expect(chunk?.summary).toContain('The user is a mortgage broker');
    expect(chunk?.summary).not.toContain('User message 1');
    expect(h.calls).toEqual({ anthropic: 1, voyage: 1 });
  });

  it('2. re-running the same summarisation does not produce a second chunk, and spends nothing', async () => {
    const h = harness();
    await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    const rowsAfterFirst = h.usage.rows.length;
    const again = await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.planned).toEqual([]);
    expect(h.store.chunks).toHaveLength(1);
    expect(h.usage.rows).toHaveLength(rowsAfterFirst);
    expect(h.calls).toEqual({ anthropic: 1, voyage: 1 });
  });

  it('2b. if two writers race, the constraint path reports exists and the run still succeeds', async () => {
    const h = harness();
    // Simulate the other writer landing between the coverage read and the insert.
    const originalCoverage = h.store.coverage.bind(h.store);
    h.store.coverage = async () => {
      const coverage = await originalCoverage(CONVERSATION.id);
      h.store.chunks.push({
        id: 'raced',
        conversationId: CONVERSATION.id,
        userId: CONVERSATION.userId,
        scope: 'workspace',
        summary: 'raced',
        audience: null,
        embedding: [1],
        range: { lo: 1, hi: 11 },
      });
      return coverage;
    };
    const result = await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.chunks.map((c) => c.result)).toEqual(['exists']);
    expect(h.store.chunks).toHaveLength(1);
  });

  it('3. the embedding stored is 1024 dimensions and non-zero', async () => {
    const h = harness();
    await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    const vector = h.store.chunks[0]?.embedding ?? [];
    expect(vector).toHaveLength(1024);
    expect(vector.filter((n) => n !== 0).length).toBeGreaterThan(1000);
    expect(vector.every((n) => Number.isFinite(n))).toBe(true);
  });

  it('4. the Voyage call and the Haiku call each write an api_usage row with real tokens and a cost', async () => {
    const h = harness();
    await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    expect(h.usage.rows).toEqual([
      {
        provider: 'anthropic',
        operation: 'memory.summarise',
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 915,
        outputTokens: 241,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        // 915 × $1/M + 241 × $5/M
        costUsd: 0.00212,
        userId: CONVERSATION.userId,
        conversationId: CONVERSATION.id,
      },
      {
        provider: 'voyage',
        operation: 'memory.embed',
        model: 'voyage-3',
        inputTokens: 212,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        // 212 × $0.06/M
        costUsd: 0.000013,
        userId: CONVERSATION.userId,
        conversationId: CONVERSATION.id,
      },
    ]);
  });
});

describe('Part C 5: the cap refuses before the Voyage call', () => {
  it('Voyage daily cap 0 → no Voyage HTTP, no Haiku HTTP, nothing recorded, range left uncovered', async () => {
    const h = harness(messagesOf(10), { voyageDailyCap: 0 });
    const result = await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.chunks.map((c) => [c.result, c.error?.code])).toEqual([
      ['failed', 'SPEND_CAP'],
    ]);
    expect(h.calls).toEqual({ anthropic: 0, voyage: 0 });
    expect(h.usage.rows).toEqual([]);
    expect(h.store.chunks).toHaveLength(0);
  });

  it('Anthropic daily cap 0 → the summary is refused before any request; Voyage is never asked to embed', async () => {
    const h = harness(messagesOf(10), { anthropicDailyCap: 0 });
    const result = await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.chunks[0]?.error?.code).toBe('SPEND_CAP');
    expect(h.calls).toEqual({ anthropic: 0, voyage: 0 });
    expect(h.store.chunks).toHaveLength(0);
  });
});

describe('Part C 7: the Voyage key', () => {
  it('appears in no log line and in no returned value of a full run', async () => {
    const h = harness();
    const result = await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    expect(h.lines.length).toBeGreaterThan(0);
    for (const line of h.lines) expect(line, line).not.toContain(FAKE_VOYAGE_KEY);
    expect(JSON.stringify(result)).not.toContain(FAKE_VOYAGE_KEY);
    expect(JSON.stringify(h.store.chunks)).not.toContain(FAKE_VOYAGE_KEY);
  });
});

describe('Part C 8: failures stay inside the hook', () => {
  it('a rejected summary leaves the range uncovered and stops before later ranges', async () => {
    const h = harness(messagesOf(20), { summaryBody: anthropicFixture('summary-preamble') });
    const result = await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.planned).toEqual([
      { lo: 1, hi: 11 },
      { lo: 11, hi: 21 },
    ]);
    // Rejected twice (rule 13) on the first range, then the loop stops: no gap can form.
    expect(result.value.chunks.map((c) => c.result)).toEqual(['failed']);
    expect(h.calls.anthropic).toBe(2);
    expect(h.calls.voyage).toBe(0);
    expect(h.store.chunks).toHaveLength(0);
  });

  it('the hook never rejects: a store that throws is logged, not raised', async () => {
    const h = harness();
    h.store.coverage = () => Promise.reject(new Error(`db exploded ${FAKE_VOYAGE_KEY}`));
    const hook = createAfterTurnHook(h.deps);
    await expect(
      hook({
        conversation: CONVERSATION,
        userMessageId: 'm1',
        assistantMessageId: 'm2',
        messagesAppended: 2,
      }),
    ).resolves.toBeUndefined();
    expect(h.lines.some((l) => l.includes('memory hook threw'))).toBe(true);
    for (const line of h.lines) expect(line).not.toContain(FAKE_VOYAGE_KEY);
  });

  it('a failed coverage read or tail read returns the error and writes nothing', async () => {
    const h = harness();
    h.store.failCoverage = new AppError('NETWORK', 'down', { retryable: true });
    expect((await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 })).ok).toBe(
      false,
    );
    h.store.failCoverage = null;
    h.store.failMessages = new AppError('NETWORK', 'down', { retryable: true });
    expect((await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 })).ok).toBe(
      false,
    );
    expect(h.store.chunks).toHaveLength(0);
    expect(h.calls).toEqual({ anthropic: 0, voyage: 0 });
  });

  it('an embed failure after a paid summary is reported with the summary cost, and nothing stored', async () => {
    const h = harness();
    const failing = fakeEmbedder({
      ok: false,
      error: new AppError('NETWORK', 'voyage down', { retryable: true }),
    });
    // checkBudget passes (real embedder), embed fails (fake) — the summary was paid for.
    const deps: MemoryDeps = {
      ...h.deps,
      embedder: {
        checkBudget: (chars) => h.deps.embedder.checkBudget(chars),
        embed: (request) => failing.embed(request),
      },
    };
    const result = await summariseConversation(deps, CONVERSATION, { freshMessages: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.chunks[0]).toMatchObject({ result: 'failed', summaryCostUsd: 0.00212 });
    expect(h.store.chunks).toHaveLength(0);
  });

  it('an insert failure is reported and the summary/embedding cost is not hidden', async () => {
    const h = harness();
    h.store.failInsert = new AppError('HTTP_STATUS', 'refused', { retryable: false });
    const result = await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.chunks[0]).toMatchObject({
      result: 'failed',
      summaryCostUsd: 0.00212,
      embedCostUsd: 0.000013,
    });
  });
});

describe('the idle rule and the sweep', () => {
  it('a five-message conversation revisited a day later gets its old tail summarised, not the new turn', async () => {
    const old = messagesOf(4, new Date('2026-08-24T09:00:00Z'));
    const fresh = messagesOf(2, new Date('2026-08-25T11:59:00Z')).map((m) => ({
      ...m,
      ordinal: m.ordinal + 4,
    }));
    const h = harness([...old, ...fresh]);
    const result = await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.planned).toEqual([{ lo: 1, hi: 5 }]);
    expect(h.store.chunks[0]?.range).toEqual({ lo: 1, hi: 5 });
  });

  it('force (the CLI flush) summarises a live short tail now', async () => {
    const h = harness(messagesOf(4, new Date('2026-08-25T11:58:00Z')));
    const result = await summariseConversation(h.deps, CONVERSATION, {
      freshMessages: 0,
      force: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.planned).toEqual([{ lo: 1, hi: 5 }]);
    expect(h.store.chunks).toHaveLength(1);
  });

  it('tool rows count in ordinals but are not sent to the summariser', async () => {
    const messages = messagesOf(10);
    const fifth = messages[4];
    if (fifth !== undefined) messages[4] = { ...fifth, role: 'tool', content: null };
    const h = harness(messages);
    const original = h.deps.claude.complete.bind(h.deps.claude);
    let prompt = '';
    h.deps.claude.complete = (request) => {
      prompt = request.messages[0]?.content ?? '';
      return original(request);
    };
    await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    expect(prompt).toContain('[4] Assistant');
    expect(prompt).not.toContain('[5]');
    expect(prompt).toContain('[6] Assistant');
    expect(h.store.chunks[0]?.range).toEqual({ lo: 1, hi: 11 });
  });

  it('the sweep visits idle conversations and summarises their stale tails', async () => {
    const h = harness(messagesOf(4, new Date('2026-08-20T09:00:00Z')));
    h.store.idle = [CONVERSATION];
    const result = await sweepIdleConversations(h.deps, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toBe(1);
    expect(result.value.outcomes[0]?.planned).toEqual([{ lo: 1, hi: 5 }]);
    expect(h.store.chunks).toHaveLength(1);
  });

  it('a backlog is paid for over several triggers, never in one burst', async () => {
    const h = harness(messagesOf(60, new Date('2026-08-20T09:00:00Z')));
    const first = await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    expect(first.ok && first.value.planned.length).toBe(POLICY.maxChunksPerTrigger);
    expect(h.store.chunks).toHaveLength(3);
    expect(h.calls).toEqual({ anthropic: 3, voyage: 3 });
    const second = await summariseConversation(h.deps, CONVERSATION, { freshMessages: 2 });
    expect(second.ok && second.value.nextOrdinalBefore).toBe(31);
    expect(h.store.chunks.map((c) => c.range.lo)).toEqual([1, 11, 21, 31, 41, 51]);
    // The remaining 58 is a live tail of < 10; nothing more is planned.
    expect(h.store.chunks[5]?.range).toEqual({ lo: 51, hi: 61 });
    expect(ok(undefined).ok).toBe(true);
  });
});

describe('what is embedded (review, 26 Aug)', () => {
  it('embeds the title and the Perth date of the newest message above the note; stores the note alone', async () => {
    const h = harness();
    let embeddedText = '';
    const real = h.deps.embedder;
    const deps: MemoryDeps = {
      ...h.deps,
      embedder: {
        checkBudget: (chars: number) => real.checkBudget(chars),
        embed: (request: EmbeddingRequest) => {
          embeddedText = request.texts[0] ?? '';
          return real.embed(request);
        },
      },
    };
    await summariseConversation(deps, CONVERSATION, { freshMessages: 2 });
    // messagesOf(10) runs 09:00–09:09 UTC on 25 Aug = 17:00 Perth, same date.
    expect(
      embeddedText.startsWith(
        'Conversation: Offset accounts post for tradies\nDate: 2026-08-25\n\n',
      ),
    ).toBe(true);
    expect(embeddedText).toContain('The user is a mortgage broker');
    expect(h.store.chunks[0]?.summary.startsWith('Conversation:')).toBe(false);
  });
});
