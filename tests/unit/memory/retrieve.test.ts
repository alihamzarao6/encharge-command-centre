/**
 * Retrieval (src/lib/memory/retrieve.ts): the query text, the budget arithmetic, the
 * rendering (delimited, labelled as data, inside the below-breakpoint cap), the RPC
 * adapter, and `recallForTurn` end to end over fakes — every degradation path answers
 * with an outcome, never a throw or a refusal. Part C items 5 (budget), 6 (floor), 7
 * (Voyage failure) at the library level; the stack half is tests/integration/recall.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServiceClient } from '../../../src/lib/auth/clients.js';
import { NetworkError, err, ok, type Result } from '../../../src/lib/errors.js';
import type { ClaudeClient, Completion } from '../../../src/lib/llm/client.js';
import { RETRIEVAL_DEFAULTS } from '../../../src/lib/memory/config.js';
import type { Embedder } from '../../../src/lib/memory/embed.js';
import type { FactRow, FactStore, FactWritten } from '../../../src/lib/memory/facts.js';
import {
  RECALL_HEADER,
  QUERY_MESSAGE_MAX_CHARS,
  QUERY_PREVIOUS_MAX_CHARS,
  queryText,
  recallForTurn,
  renderRecalledContext,
  selectChunks,
  selectFacts,
  supabaseChunkSearch,
  type ChunkSearch,
  type RecallDeps,
  type RecalledChunk,
} from '../../../src/lib/memory/retrieve.js';
import { MAX_BELOW_BREAKPOINT_CHARS } from '../../../src/lib/voice/prompt.js';
import { capturingLogger } from '../llm/helpers.js';
import { CONV_ID, FIXTURE_VECTOR, USER_ID, anthropicFixture, fakeEmbedder } from './helpers.js';

const OTHER_CONV = 'c0000000-0000-4000-8000-000000000002';

function fact(overrides: Partial<FactRow> = {}): FactRow {
  return {
    id: 'f1',
    userId: USER_ID,
    scope: 'workspace',
    key: 'writing:finance-content',
    value: 'Finance content uses the Rule of One framework and ends with a direct CTA.',
    confidence: 1,
    sourceMessageId: null,
    supersededBy: null,
    createdAt: new Date('2026-08-26T02:00:00Z'),
    ...overrides,
  };
}

function chunk(overrides: Partial<RecalledChunk> = {}): RecalledChunk {
  return {
    id: 'k1',
    conversationId: OTHER_CONV,
    title: 'Write a Meta ad, and add a note',
    audience: null,
    summary: 'The user requested a Meta ad for Fundd. The assistant drafted "Renting Their Dream".',
    createdAt: new Date('2026-08-26T09:00:00Z'),
    similarity: 0.62,
    ...overrides,
  };
}

describe('queryText', () => {
  it('is the current message, preceded by the previous user message when there is one, both bounded', () => {
    expect(queryText('  Make it shorter ', null)).toBe('Make it shorter');
    expect(queryText('Make it shorter', 'Write a Meta ad about renting')).toBe(
      'Write a Meta ad about renting\nMake it shorter',
    );
    const long = queryText('m'.repeat(5_000), 'p'.repeat(5_000));
    expect(long.length).toBe(QUERY_PREVIOUS_MAX_CHARS + 1 + QUERY_MESSAGE_MAX_CHARS);
  });
});

describe('budgets', () => {
  it('facts: newest first, count cap, then rendered-character cap; the oldest is dropped', () => {
    const facts = Array.from({ length: 5 }, (_, i) =>
      fact({ id: `f${i}`, key: `writing:k${i}`, createdAt: new Date(2026, 7, 20 + i) }),
    );
    const byCount = selectFacts(facts, { maxFacts: 2, factBudgetChars: 10_000 });
    expect(byCount.kept.map((f) => f.id)).toEqual(['f4', 'f3']);
    expect(byCount.dropped).toBe(3);
    const byChars = selectFacts(facts, { maxFacts: 12, factBudgetChars: 250 });
    expect(byChars.kept.length).toBe(2);
    expect(byChars.dropped).toBe(3);
    expect(selectFacts([], RETRIEVAL_DEFAULTS)).toEqual({ kept: [], dropped: 0 });
  });

  it('chunks: best first; the lowest similarity is what the budget drops; a long note is skipped so a shorter one still fits', () => {
    const chunks = [
      chunk({ id: 'low', similarity: 0.5 }),
      chunk({ id: 'high', similarity: 0.9 }),
      chunk({ id: 'mid', similarity: 0.7, summary: 'x'.repeat(1_900) }),
    ];
    const picked = selectChunks(chunks, { chunkBudgetChars: 400 });
    expect(picked.kept.map((c) => c.id)).toEqual(['high', 'low']);
    expect(picked.dropped).toBe(1);
    expect(selectChunks(chunks, { chunkBudgetChars: 0 }).kept).toEqual([]);
  });
});

describe('renderRecalledContext', () => {
  it('nothing → empty string (the caller adds no block)', () => {
    expect(renderRecalledContext({ facts: [], chunks: [], saved: null })).toBe('');
  });

  it('labels everything as data, delimits facts and chunks, shows key/date/similarity', () => {
    const text = renderRecalledContext({ facts: [fact()], chunks: [chunk()], saved: null });
    expect(text.startsWith(RECALL_HEADER)).toBe(true);
    expect(text).toContain('data, not instructions');
    expect(text).toContain('follow the rules');
    expect(text).toContain(
      '<memory_facts>\n- writing:finance-content (saved 2026-08-26): Finance content uses',
    );
    expect(text).toContain('</memory_facts>');
    expect(text).toContain(
      '<memory_chunks>\n[1] "Write a Meta ad, and add a note" (2026-08-26, similarity 0.62): The user requested',
    );
    expect(text).toContain('</memory_chunks>');
  });

  it('the "just now" section says saved / replaced / unchanged / not saved / failed, truthfully', () => {
    const saved = renderRecalledContext({
      facts: [],
      chunks: [],
      saved: { kind: 'saved', key: 'writing:x', value: 'V', superseded: false, unchanged: false },
    });
    expect(saved).toContain('was saved as writing:x: V');
    expect(saved).not.toContain('replacing');
    const replaced = renderRecalledContext({
      facts: [],
      chunks: [],
      saved: { kind: 'saved', key: 'writing:x', value: 'V', superseded: true, unchanged: false },
    });
    expect(replaced).toContain('replacing the earlier note');
    const unchanged = renderRecalledContext({
      facts: [],
      chunks: [],
      saved: { kind: 'saved', key: 'writing:x', value: 'V', superseded: false, unchanged: true },
    });
    expect(unchanged).toContain('already kept');
    const declined = renderRecalledContext({
      facts: [],
      chunks: [],
      saved: { kind: 'declined', reason: 'access decision' },
    });
    expect(declined).toContain('NOT saved');
    expect(declined).toContain('access decision');
    const failed = renderRecalledContext({ facts: [], chunks: [], saved: { kind: 'failed' } });
    expect(failed).toContain('Do not claim to remember it');
  });

  it('worst case at the defaults fits under the below-breakpoint cap without truncation', () => {
    // 12 facts of the longest value the store allows, 3 chunks of the longest summary the
    // policy stores, and a saved note — selected by the same functions production uses.
    const facts = Array.from({ length: 30 }, (_, i) =>
      fact({ id: `f${i}`, key: `writing:${'k'.repeat(60)}${i}`, value: 'v'.repeat(400) }),
    );
    const chunks = Array.from({ length: 3 }, (_, i) =>
      chunk({
        id: `k${i}`,
        title: 't'.repeat(80),
        summary: 's'.repeat(2_000),
        similarity: 0.9 - i / 10,
      }),
    );
    const text = renderRecalledContext({
      facts: selectFacts(facts, RETRIEVAL_DEFAULTS).kept,
      chunks: selectChunks(chunks, RETRIEVAL_DEFAULTS).kept,
      saved: {
        kind: 'saved',
        key: `writing:${'k'.repeat(64)}`,
        value: 'v'.repeat(400),
        superseded: true,
        unchanged: false,
      },
    });
    expect(text.length).toBeLessThanOrEqual(MAX_BELOW_BREAKPOINT_CHARS);
    expect(text.endsWith('if there is any.')).toBe(true);
  });
});

describe('supabaseChunkSearch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls match_memory_chunks with the vector as text and every parameter, and maps rows', async () => {
    let body = '';
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      body = typeof init?.body === 'string' ? init.body : '';
      if (!url.includes('/rest/v1/rpc/match_memory_chunks')) throw new Error(`unstubbed ${url}`);
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: 'k1',
              conversation_id: OTHER_CONV,
              title: 'T',
              audience: 'first home buyers',
              summary: 'S',
              turn_range: '[1,5)',
              created_at: '2026-08-26T09:00:00Z',
              similarity: 0.61,
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });
    const search = supabaseChunkSearch(
      createServiceClient({ url: 'http://stack.test', anonKey: 'a', serviceRoleKey: 's' }),
    );
    const result = await search.search([0.1, 0.2], {
      userId: USER_ID,
      conversationId: CONV_ID,
      historyMessages: 4,
      limit: 3,
      minSimilarity: 0.45,
    });
    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: 'k1',
          conversationId: OTHER_CONV,
          title: 'T',
          audience: 'first home buyers',
          summary: 'S',
          createdAt: new Date('2026-08-26T09:00:00Z'),
          similarity: 0.61,
        },
      ],
    });
    expect(JSON.parse(body)).toEqual({
      p_query: '[0.1,0.2]',
      p_user_id: USER_ID,
      p_conversation_id: CONV_ID,
      p_history_messages: 4,
      p_limit: 3,
      p_min_similarity: 0.45,
    });
  });

  it('a transport failure is a NETWORK result, not a throw', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const search = supabaseChunkSearch(
      createServiceClient({ url: 'http://stack.test', anonKey: 'a', serviceRoleKey: 's' }),
    );
    const result = await search.search([0.1], {
      userId: USER_ID,
      conversationId: null,
      historyMessages: 0,
      limit: 3,
      minSimilarity: 0.45,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NETWORK');
  });
});

// ---------------------------------------------------------------------------------------
// recallForTurn over fakes.
// ---------------------------------------------------------------------------------------

interface Harness {
  readonly deps: RecallDeps;
  readonly lines: string[];
  readonly searches: { query: readonly number[]; minSimilarity: number; limit: number }[];
  readonly writes: string[];
  readonly claudeCalls: number[];
}

function harness(
  options: {
    facts?: Result<readonly FactRow[]>;
    found?: Result<readonly RecalledChunk[]>;
    embedder?: Embedder;
    claudeText?: string | null;
    searchDelayMs?: number;
    config?: Partial<RecallDeps['config']>;
  } = {},
): Harness {
  const { log, lines } = capturingLogger();
  const searches: Harness['searches'] = [];
  const writes: string[] = [];
  const claudeCalls: number[] = [];
  const facts: FactStore = {
    currentFacts: () => Promise.resolve(options.facts ?? ok([fact()])),
    upsert: (input): Promise<Result<FactWritten>> => {
      writes.push(input.key);
      return Promise.resolve(ok({ id: 'new-fact', supersededId: null, outcome: 'inserted' }));
    },
    setSource: () => Promise.resolve(ok(undefined)),
  };
  const search: ChunkSearch = {
    search: async (query, params) => {
      searches.push({ query, minSimilarity: params.minSimilarity, limit: params.limit });
      if (options.searchDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.searchDelayMs));
      }
      return options.found ?? ok([chunk()]);
    },
  };
  const claudeText =
    options.claudeText === undefined
      ? ((JSON.parse(anthropicFixture('fact-ok')) as { content: { text: string }[] }).content[0]
          ?.text ?? '')
      : options.claudeText;
  const claude: ClaudeClient = {
    complete: (): Promise<Result<Completion>> => {
      claudeCalls.push(1);
      if (claudeText === null) return Promise.resolve(err(new NetworkError('claude down')));
      return Promise.resolve(
        ok({
          text: claudeText,
          model: 'claude-haiku-4-5-20251001',
          stopReason: 'end_turn',
          usage: { inputTokens: 600, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0.0009,
          requestId: 'r',
          attempts: 1,
        }),
      );
    },
  };
  return {
    deps: {
      claude,
      embedder: options.embedder ?? fakeEmbedder(),
      facts,
      search,
      config: { ...RETRIEVAL_DEFAULTS, ...(options.config ?? {}) },
      log,
    },
    lines,
    searches,
    writes,
    claudeCalls,
  };
}

const TURN = {
  userId: USER_ID,
  scope: 'workspace' as const,
  conversationId: CONV_ID,
  historyMessages: 6,
  message: 'Write me a Meta ad about renting versus buying',
  previousUserMessage: null,
};

describe('recallForTurn', () => {
  it('a normal turn: facts + the chunks that cleared the floor, one query embedding, ids and sizes in the summary', async () => {
    const h = harness();
    const out = await recallForTurn(h.deps, TURN);
    expect(out.belowBreakpoint).not.toBeNull();
    expect(out.belowBreakpoint).toContain('<memory_facts>');
    expect(out.belowBreakpoint).toContain('<memory_chunks>');
    expect(out.summary).toMatchObject({
      facts: 1,
      factsDropped: 0,
      chunks: [{ id: 'k1', conversationId: OTHER_CONV, similarity: 0.62 }],
      chunksDropped: 0,
      savedFact: null,
      degraded: [],
    });
    expect(out.summary.chars).toBe(out.belowBreakpoint?.length);
    expect(out.summary.estimatedTokens).toBe(Math.ceil(out.summary.chars / 3));
    expect(out.savedFactId).toBeNull();
    expect(h.searches).toEqual([{ query: FIXTURE_VECTOR, minSimilarity: 0.45, limit: 3 }]);
    expect(h.claudeCalls).toHaveLength(0);
    expect(h.lines.some((l) => l.includes('memory recalled'))).toBe(true);
  });

  it('Part C 6: nothing clears the floor → no chunk section, facts still there, nothing degraded', async () => {
    const h = harness({ found: ok([]) });
    const out = await recallForTurn(h.deps, TURN);
    expect(out.belowBreakpoint).toContain('<memory_facts>');
    expect(out.belowBreakpoint).not.toContain('<memory_chunks>');
    expect(out.summary.chunks).toEqual([]);
    expect(out.summary.degraded).toEqual([]);
  });

  it('Part C 7: Voyage failing → facts still recalled, chunks skipped, `embed` in degraded, no search', async () => {
    const h = harness({ embedder: fakeEmbedder(err(new NetworkError('voyage unreachable'))) });
    const out = await recallForTurn(h.deps, TURN);
    expect(out.belowBreakpoint).toContain('<memory_facts>');
    expect(out.belowBreakpoint).not.toContain('<memory_chunks>');
    expect(out.summary.degraded).toEqual(['embed']);
    expect(h.searches).toHaveLength(0);
    expect(h.lines.some((l) => l.includes('query embedding failed'))).toBe(true);
  });

  it('the facts read failing → chunks still recalled, `facts` in degraded; search failing → `search`', async () => {
    const noFacts = await recallForTurn(harness({ facts: err(new NetworkError('db')) }).deps, TURN);
    expect(noFacts.belowBreakpoint).toContain('<memory_chunks>');
    expect(noFacts.belowBreakpoint).not.toContain('<memory_facts>');
    expect(noFacts.summary.degraded).toEqual(['facts']);
    const noSearch = await recallForTurn(
      harness({ found: err(new NetworkError('db')) }).deps,
      TURN,
    );
    expect(noSearch.summary.degraded).toEqual(['search']);
    expect(noSearch.belowBreakpoint).not.toContain('<memory_chunks>');
  });

  it('everything failing → belowBreakpoint null, an outcome all the same', async () => {
    const h = harness({
      facts: err(new NetworkError('db')),
      embedder: fakeEmbedder(err(new NetworkError('voyage'))),
    });
    const out = await recallForTurn(h.deps, TURN);
    expect(out.belowBreakpoint).toBeNull();
    expect(out.summary.degraded).toEqual(['facts', 'embed']);
  });

  it('Part C 5: a large store → the budget bites, drops are counted, the block stays under the cap', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      fact({
        id: `f${i}`,
        key: `writing:k${i}`,
        value: 'v'.repeat(300),
        createdAt: new Date(2026, 6, i + 1),
      }),
    );
    const found = Array.from({ length: 3 }, (_, i) =>
      chunk({ id: `k${i}`, summary: 's'.repeat(1_500), similarity: 0.9 - i / 10 }),
    );
    const h = harness({ facts: ok(many), found: ok(found) });
    const out = await recallForTurn(h.deps, TURN);
    expect(out.summary.facts).toBeLessThan(40);
    expect(out.summary.factsDropped).toBe(40 - out.summary.facts);
    expect(out.summary.chunks.map((c) => c.id)).toEqual(['k0']);
    expect(out.summary.chunksDropped).toBe(2);
    expect(out.summary.chars).toBeLessThanOrEqual(MAX_BELOW_BREAKPOINT_CHARS);
  });

  it('a timeout → nothing recalled, `timeout` in degraded, and the late result is logged when it lands', async () => {
    const h = harness({ searchDelayMs: 60, config: { timeoutMs: 15 } });
    const out = await recallForTurn(h.deps, TURN);
    expect(out.belowBreakpoint).toBeNull();
    expect(out.summary.degraded).toEqual(['timeout']);
    expect(h.lines.some((l) => l.includes('recall timed out'))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.lines.some((l) => l.includes('recall finished after the deadline'))).toBe(true);
  });

  it('a dependency that throws → nothing recalled, `threw` in degraded, no rejection', async () => {
    const h = harness();
    const deps: RecallDeps = {
      ...h.deps,
      facts: { ...h.deps.facts, currentFacts: () => Promise.reject(new Error('boom')) },
    };
    const out = await recallForTurn(deps, TURN);
    expect(out.belowBreakpoint).toBeNull();
    expect(out.summary.degraded).toEqual(['threw']);
  });

  it('topK 0 → no embedding call at all; maxFacts 0 → no facts', async () => {
    const embedder = fakeEmbedder();
    const h = harness({ embedder, config: { topK: 0, maxFacts: 0 } });
    const out = await recallForTurn(h.deps, TURN);
    expect(embedder.calls).toHaveLength(0);
    expect(out.belowBreakpoint).toBeNull();
  });

  it('a "remember that…" turn: the fact is captured first, appears in the list, and the block says it was saved', async () => {
    const h = harness({ facts: ok([]) });
    const out = await recallForTurn(h.deps, {
      ...TURN,
      message:
        "Remember that when I'm writing finance content, I want the Rule of One framework and a direct CTA.",
    });
    expect(h.claudeCalls).toHaveLength(1);
    expect(h.writes).toEqual(['writing:finance-content-framework']);
    expect(out.savedFactId).toBe('new-fact');
    expect(out.summary.savedFact).toEqual({
      key: 'writing:finance-content-framework',
      outcome: 'inserted',
    });
    expect(out.belowBreakpoint).toContain('- writing:finance-content-framework (saved');
    expect(out.belowBreakpoint).toContain('## Just now\nA standing note');
  });

  it('a "remember" turn the model declines → block says NOT saved, no write, nothing degraded', async () => {
    const h = harness({ claudeText: '{"kind":"none","reason":"a question"}' });
    const out = await recallForTurn(h.deps, { ...TURN, message: 'Remember when we did that ad?' });
    expect(h.writes).toEqual([]);
    expect(out.savedFactId).toBeNull();
    expect(out.belowBreakpoint).toContain('NOT saved');
    expect(out.summary.degraded).toEqual([]);
  });

  it('a "remember" turn where Haiku is down → block says it failed, `capture` in degraded, the turn still has its facts and chunks', async () => {
    const h = harness({ claudeText: null });
    const out = await recallForTurn(h.deps, {
      ...TURN,
      message: 'Remember that I like short posts.',
    });
    expect(out.summary.degraded).toEqual(['capture']);
    expect(out.belowBreakpoint).toContain('Do not claim to remember it');
    expect(out.belowBreakpoint).toContain('<memory_chunks>');
  });
});
