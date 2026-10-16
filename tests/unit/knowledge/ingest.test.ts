/**
 * Learning a document (src/lib/knowledge/ingest.ts) against the in-memory store and a scripted
 * embedder: capture, the twin copy, the paced batches, every way Voyage refuses (429, 401, 5xx,
 * timeout, network, the spend cap, unusable vectors), a run interrupted half way, the lease, and
 * logs that carry counts and never a word of text or a document's name. Part C "Ingestion".
 */
import { describe, expect, it } from 'vitest';

import { err, NetworkError, ok } from '../../../src/lib/errors.js';
import {
  KNOWLEDGE_DEFAULTS,
  type KnowledgeEmbedConfig,
} from '../../../src/lib/knowledge/config.js';
import {
  captureSource,
  classifyEmbedFailure,
  drainKnowledge,
  learnAttachment,
  type KnowledgeIngestDeps,
} from '../../../src/lib/knowledge/ingest.js';
import { createLocalKnowledgeStore, unwrap } from '../../../src/lib/knowledge/local-store.js';
import type { KnowledgeStore } from '../../../src/lib/knowledge/store.js';
import { completion, scriptedClaude } from '../files/helpers.js';
import { capturingLogger } from '../llm/helpers.js';
import {
  CONV_B,
  TEAMMATE,
  USER,
  attachment,
  bagOfWords,
  failureOf,
  fakeEmbedder,
  page,
  prose,
  type FakeEmbedder,
  type ScriptedFailure,
} from './helpers.js';

const SECRET_TEXT = 'CANARY-TEXT-week-one-4417';
const SECRET_NAME = 'Sample-Person-CANARY-NAME-9c1.pdf';

function longDocument(pages = 12): ReturnType<typeof attachment> {
  return attachment({
    name: SECRET_NAME,
    pages: Array.from({ length: pages }, (_, i) =>
      page(i + 1, `${SECRET_TEXT} ${prose(`week ${String(i + 1)}`, 40)}`),
    ),
  });
}

function harness(
  options: {
    readonly script?: (ScriptedFailure | 'ok')[];
    readonly config?: Partial<KnowledgeEmbedConfig>;
    readonly store?: KnowledgeStore;
  } = {},
): {
  deps: KnowledgeIngestDeps;
  store: ReturnType<typeof createLocalKnowledgeStore>;
  embedder: FakeEmbedder;
  lines: string[];
  sleeps: number[];
} {
  const store = createLocalKnowledgeStore({ activeStaff: [USER, TEAMMATE] });
  const embedder = fakeEmbedder(options.script);
  const { log, lines } = capturingLogger();
  const sleeps: number[] = [];
  let clock = 1_000_000;
  return {
    deps: {
      store: options.store ?? store,
      embedder,
      config: { ...KNOWLEDGE_DEFAULTS.embed, ...options.config },
      log,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    },
    store,
    embedder,
    lines,
    sleeps,
  };
}

const QUERY = bagOfWords('week 3 point 2');

describe('capture', () => {
  it('a pending document is cut into chunks and starts learning; nothing is sent to Voyage', async () => {
    const h = harness();
    const id = h.store.attach(longDocument());
    expect(
      await captureSource(h.deps, {
        id,
        fileId: h.store.status(id)?.fileId ?? null,
        name: 'doc.pdf',
      }),
    ).toBe('captured');
    const source = h.store.status(id);
    expect(source?.status).toBe('learning');
    expect(source?.chunkCount).toBeGreaterThan(12);
    expect(h.embedder.calls).toHaveLength(0);
  });

  it('the same bytes already learned with the same chunker are copied — chunks and vectors — with no Voyage call', async () => {
    const h = harness();
    const first = longDocument(3);
    h.store.attach(first);
    await drainKnowledge(h.deps);
    await drainKnowledge(h.deps);
    const calls = h.embedder.calls.length;
    const again = h.store.attach({
      ...first,
      fileId: 'f9000000-0000-4000-8000-000000000001',
      conversationId: CONV_B,
    });
    expect(
      await captureSource(h.deps, {
        id: again,
        fileId: 'f9000000-0000-4000-8000-000000000001',
        name: 'doc.pdf',
      }),
    ).toBe('copied');
    expect(h.store.status(again)?.status).toBe('ready');
    expect(h.embedder.calls).toHaveLength(calls);
  });

  it('text purged before it was learned: the source fails with a code, and nothing else happens', async () => {
    const h = harness();
    const doc = longDocument(2);
    const id = h.store.attach(doc);
    h.store.expire(doc.fileId);
    expect(await captureSource(h.deps, { id, fileId: doc.fileId, name: doc.name })).toBe(
      'text_gone',
    );
    expect(h.store.status(id)?.status).toBe('failed');
    expect(await captureSource(h.deps, { id, fileId: null, name: 'doc.pdf' })).toBe('text_gone');
  });

  it('almost no text: a document of blank pages is marked as having nothing to learn', async () => {
    const h = harness();
    const doc = attachment({ pages: [page(1, ' — '), page(2, '   ')] });
    const id = h.store.attach(doc);
    expect(await captureSource(h.deps, { id, fileId: doc.fileId, name: doc.name })).toBe('no_text');
    expect(h.store.status(id)?.status).toBe('failed');
  });

  it('a capture that cannot read the pages is reported as failed and changes nothing', async () => {
    const h = harness();
    const doc = longDocument(1);
    const id = h.store.attach(doc);
    const broken: KnowledgeStore = {
      ...h.store,
      pagesOfFile: () => Promise.resolve({ ok: false, error: failureOf('network') }),
    };
    expect(
      await captureSource({ ...h.deps, store: broken }, { id, fileId: doc.fileId, name: doc.name }),
    ).toBe('failed');
    expect(h.store.status(id)?.status).toBe('pending');
  });
});

describe('the drain', () => {
  it('embeds in batches no bigger than the limit, at most N a run, paused between', async () => {
    const h = harness({ config: { batchChars: 6_000, requestsPerRun: 2, gapMs: 25_000 } });
    const id = h.store.attach(longDocument());
    const report = unwrap(await drainKnowledge(h.deps));
    expect(report).toMatchObject({ outcome: 'more', captured: 1, requests: 2 });
    for (const call of h.embedder.calls) {
      expect(call.texts.reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(6_000);
      expect(call.inputType).toBe('document');
      expect(call.operation).toBe('knowledge.embed');
    }
    expect(h.sleeps).toEqual([25_000]);
    expect(h.store.status(id)?.status).toBe('learning');
  });

  it('the three-a-minute cap reached mid-document: stops at the 429, rests 65 s, and the half-learned document is NOT retrievable elsewhere', async () => {
    const h = harness({
      script: ['ok', 'rate_limited'],
      config: { batchChars: 4_000, requestsPerRun: 5 },
    });
    const doc = longDocument();
    const id = h.store.attach(doc);
    const report = unwrap(await drainKnowledge(h.deps));
    expect(report).toMatchObject({ outcome: 'rate_limited', requests: 2 });
    const source = h.store.status(id);
    expect(source?.status).toBe('learning');
    expect(source?.embeddedCount).toBeGreaterThan(0);
    expect(source?.embeddedCount).toBeLessThan(source?.chunkCount ?? 0);
    // Elsewhere: nothing. Here (its own conversation): what is embedded, flagged learning.
    expect(
      unwrap(
        await h.store.match(QUERY, {
          userId: TEAMMATE,
          attachedFileIds: [],
          excludeFileIds: [],
          includeLearned: true,
          sections: [],
          limit: 40,
          minSimilarity: 0,
          attachedMinSimilarity: 0,
        }),
      ),
    ).toEqual([]);
    const here = unwrap(
      await h.store.match(QUERY, {
        userId: USER,
        attachedFileIds: [doc.fileId],
        excludeFileIds: [],
        includeLearned: true,
        sections: [],
        limit: 40,
        minSimilarity: 0,
        attachedMinSimilarity: 0,
      }),
    );
    expect(here.length).toBeGreaterThan(0);
    expect(here.every((c) => c.sourceStatus === 'learning' && c.attached)).toBe(true);
    // The rest Voyage asked for (it gives no Retry-After): nobody drains for 65 seconds.
    expect(unwrap(await h.store.claimDrain('someone-else', 140))).toMatchObject({ claimed: false });
  });

  it('interrupted half way, it resumes on the next run where it stopped, and the last batch makes it whole', async () => {
    const h = harness({
      script: ['ok', 'timeout'],
      config: { batchChars: 4_000, requestsPerRun: 50, cooldownSeconds: 1 },
    });
    const doc = longDocument(4);
    const id = h.store.attach(doc);
    expect(unwrap(await drainKnowledge(h.deps)).outcome).toBe('unavailable');
    const halfway = h.store.status(id)?.embeddedCount ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = unwrap(await drainKnowledge(h.deps));
    expect(second.outcome).toBe('drained');
    expect(second.sourcesReady).toBe(1);
    const done = h.store.status(id);
    expect(done?.status).toBe('ready');
    expect(done?.embeddedCount).toBe(done?.chunkCount);
    // No chunk was embedded twice: the second run took up after the first. (Call 2 timed out;
    // its chunks were never stored, so sending them again is right.)
    const succeeded = [h.embedder.calls[0], ...h.embedder.calls.slice(2)].flatMap(
      (c) => c?.texts ?? [],
    );
    expect(new Set(succeeded).size).toBe(succeeded.length);
    expect(h.embedder.calls[2]?.texts).toEqual(h.embedder.calls[1]?.texts);
    expect(halfway).toBeGreaterThan(0);
  });

  it.each([
    ['unauthorised', 'unauthorised', KNOWLEDGE_DEFAULTS.embed.authCooldownSeconds],
    ['server_error', 'unavailable', KNOWLEDGE_DEFAULTS.embed.cooldownSeconds],
    ['timeout', 'unavailable', KNOWLEDGE_DEFAULTS.embed.cooldownSeconds],
    ['network', 'unavailable', KNOWLEDGE_DEFAULTS.embed.cooldownSeconds],
    ['spend_cap', 'spend_cap', 3_600],
    ['bad_vectors', 'invalid_response', KNOWLEDGE_DEFAULTS.embed.cooldownSeconds],
  ] as const)(
    'Voyage %s → outcome %s, the queue rests, nothing is stored',
    async (failure, outcome, cooldown) => {
      expect(classifyEmbedFailure(failureOf(failure), KNOWLEDGE_DEFAULTS.embed)).toEqual({
        outcome,
        cooldownSeconds: cooldown,
      });
      const h = harness({ script: [failure] });
      const id = h.store.attach(longDocument(2));
      const report = unwrap(await drainKnowledge(h.deps));
      expect(report).toMatchObject({ outcome, requests: 1, chunksEmbedded: 0 });
      expect(h.store.status(id)?.embeddedCount).toBe(0);
      // One request, never a retry inside the run.
      expect(h.embedder.calls).toHaveLength(1);
      if (outcome === 'unauthorised' || outcome === 'spend_cap') {
        expect(
          h.lines.some((l) => l.includes('"level":"error"') && l.includes('the queue is resting')),
        ).toBe(true);
      }
    },
  );

  it('another drain holding the lease: this one sends nothing and says how long to wait', async () => {
    const h = harness();
    h.store.attach(longDocument(2));
    unwrap(await h.store.claimDrain('the-cron', 140));
    const report = unwrap(await drainKnowledge(h.deps));
    expect(report.outcome).toBe('busy');
    expect(report.waitMs).toBeGreaterThan(0);
    expect(h.embedder.calls).toHaveLength(0);
  });

  it('gives the lease back even when the store throws mid-run', async () => {
    const h = harness();
    h.store.attach(longDocument(2));
    const throwing: KnowledgeStore = {
      ...h.store,
      nextBatch: () => Promise.reject(new Error('boom')),
    };
    const report = unwrap(await drainKnowledge({ ...h.deps, store: throwing }));
    expect(report.outcome).toBe('store_failed');
    expect(unwrap(await h.store.claimDrain('next', 140)).claimed).toBe(true);
  });

  it('stops before its lease would run out, rather than overrun it', async () => {
    const h = harness({
      config: {
        batchChars: 2_000,
        requestsPerRun: 100,
        gapMs: 30_000,
        leaseSeconds: 70,
        timeoutMs: 20_000,
      },
    });
    h.store.attach(longDocument());
    const report = unwrap(await drainKnowledge(h.deps));
    expect(report.outcome).toBe('more');
    expect(report.requests).toBeLessThanOrEqual(2);
  });

  it('nothing waiting: drained, no request', async () => {
    const h = harness();
    expect(unwrap(await drainKnowledge(h.deps))).toMatchObject({ outcome: 'drained', requests: 0 });
  });

  it('the database refusing the claim is an error, not a silent skip', async () => {
    const h = harness();
    const refusing: KnowledgeStore = {
      ...h.store,
      claimDrain: () => Promise.resolve({ ok: false, error: failureOf('network') }),
    };
    expect((await drainKnowledge({ ...h.deps, store: refusing })).ok).toBe(false);
  });

  it('a storage failure after a good embedding stops the run and is logged', async () => {
    const h = harness();
    h.store.attach(longDocument(2));
    const failing: KnowledgeStore = {
      ...h.store,
      attachEmbeddings: () => Promise.resolve({ ok: false, error: failureOf('network') }),
    };
    expect(unwrap(await drainKnowledge({ ...h.deps, store: failing })).outcome).toBe(
      'store_failed',
    );
  });

  it('logs ids, counts, sizes, timings and outcomes — never a word of the text, never the name', async () => {
    const h = harness({
      script: ['ok', 'rate_limited'],
      config: { batchChars: 4_000, requestsPerRun: 3 },
    });
    h.store.attach(longDocument());
    await drainKnowledge(h.deps);
    const all = h.lines.join('\n');
    expect(all).toContain('knowledge captured');
    expect(all).toContain('knowledge batch embedded');
    expect(all).toContain('"chunks":');
    expect(all).toContain('"tokens":');
    expect(all).toContain('knowledge drain run');
    expect(all).not.toContain(SECRET_TEXT);
    expect(all).not.toContain(SECRET_NAME);
    expect(all).not.toContain('point 2 of week');
  });
});

describe('learnAttachment — the files function’s fast path', () => {
  it('captures this attachment at once, then runs the queue; a full document gets learned', async () => {
    const h = harness({ config: { requestsPerRun: 50, batchChars: 100_000, gapMs: 0 } });
    const doc = longDocument(3);
    const id = h.store.attach(doc);
    await learnAttachment(h.deps, doc.fileId);
    expect(h.store.status(id)?.status).toBe('ready');
  });

  it('never rejects, whatever fails underneath', async () => {
    const h = harness();
    const broken: KnowledgeStore = {
      ...h.store,
      sourceForFile: () => Promise.reject(new Error('down')),
    };
    await expect(learnAttachment({ ...h.deps, store: broken }, 'f')).resolves.toBeUndefined();
    const unreadable: KnowledgeStore = {
      ...h.store,
      sourceForFile: () => Promise.resolve({ ok: false, error: failureOf('network') }),
    };
    await expect(learnAttachment({ ...h.deps, store: unreadable }, 'f')).resolves.toBeUndefined();
    await expect(learnAttachment(h.deps, 'no-such-file')).resolves.toBeUndefined();
  });
});

describe('the summary, between capture and embedding (17 Oct)', () => {
  const GOOD = 'The plan for week one (p. 1), then the call scripts and follow-ups (pp. 2–12).';
  const summaries = (claude = scriptedClaude(ok(completion(GOOD))), minChars = 10_000) => ({
    claude,
    config: { ...KNOWLEDGE_DEFAULTS.summary, minChars, blockChars: 20_000 },
  });

  it('a long document waits for its summary; nothing is embedded before it; it turns ready with it', async () => {
    const h = harness({ config: { requestsPerRun: 50, batchChars: 100_000, gapMs: 0 } });
    const deps = { ...h.deps, summaries: summaries() };
    const doc = longDocument(12);
    const id = h.store.attach(doc);
    await captureSource(deps, { id, fileId: doc.fileId, name: doc.name });
    expect(h.store.status(id)).toMatchObject({ status: 'learning', summaryStatus: 'pending' });
    // The queue will not embed a document whose summary is still to come.
    const blocked = unwrap(await h.store.nextBatch(100_000, 128, () => 'x'));
    expect(blocked).toBeNull();
    const report = unwrap(await drainKnowledge(deps));
    expect(report.summarised).toBe(1);
    expect(h.store.status(id)).toMatchObject({ status: 'ready', summaryStatus: 'done' });
    const stored = unwrap(await h.store.summariesOf(id));
    expect(stored.length).toBeGreaterThan(0);
    // Every summary was embedded with the rest: the ready flip came with the last of them.
    expect(h.store.status(id)?.embeddedCount).toBe(h.store.status(id)?.chunkCount);
  });

  it('a short document needs none, and no model is called', async () => {
    const h = harness({ config: { requestsPerRun: 50, batchChars: 100_000, gapMs: 0 } });
    const claude = scriptedClaude(ok(completion(GOOD)));
    const deps = { ...h.deps, summaries: summaries(claude, 1_000_000) };
    const doc = longDocument(2);
    const id = h.store.attach(doc);
    await drainKnowledge(deps);
    expect(h.store.status(id)).toMatchObject({ status: 'ready', summaryStatus: 'none' });
    expect(claude.calls).toHaveLength(0);
  });

  it('without a model, a document is never left waiting for a summary', async () => {
    const h = harness({ config: { requestsPerRun: 50, batchChars: 100_000, gapMs: 0 } });
    const doc = longDocument(12);
    const id = h.store.attach(doc);
    // Captured by a process that could write one, drained by one that cannot.
    await captureSource(
      { ...h.deps, summaries: summaries() },
      { id, fileId: doc.fileId, name: doc.name },
    );
    await drainKnowledge(h.deps);
    expect(h.store.status(id)).toMatchObject({ status: 'ready', summaryStatus: 'failed' });
  });

  it('a summary that keeps failing is given up on after the last attempt; learning goes on', async () => {
    const h = harness({ config: { requestsPerRun: 50, batchChars: 100_000, gapMs: 0 } });
    const down = scriptedClaude(err(new NetworkError('down')));
    const deps = {
      ...h.deps,
      summaries: { ...summaries(down), config: { ...summaries(down).config, maxAttempts: 2 } },
    };
    const doc = longDocument(12);
    const id = h.store.attach(doc);
    await drainKnowledge(deps);
    expect(h.store.status(id)).toMatchObject({ status: 'learning', summaryStatus: 'pending' });
    await drainKnowledge(deps);
    expect(h.store.status(id)).toMatchObject({ status: 'ready', summaryStatus: 'failed' });
  });

  it('the section the file name gives is on every passage when the text introduces none', async () => {
    const h = harness();
    const doc = attachment({
      name: 'Week_1_-_Transcript_Timestamps (1).pdf',
      pages: [page(1, prose('pipeline', 40)), page(2, prose('calls', 40))],
    });
    const id = h.store.attach(doc);
    await captureSource(h.deps, { id, fileId: doc.fileId, name: doc.name });
    const passages = unwrap(await h.store.passagesOf(id));
    expect(passages.length).toBeGreaterThan(1);
    expect(passages.every((p) => p.section === 'Week 1')).toBe(true);
  });
});
