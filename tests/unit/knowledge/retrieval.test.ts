/**
 * What a turn retrieves from what was learned (files/context.ts `createTurnDocuments` with
 * knowledge) — Part C "Retrieval" and "What he is told", case by case, through the in-memory
 * store and the deterministic embedder. The SQL that does the same eligibility in production
 * is held to the same cases by tests/integration/knowledge.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { err, ok, NetworkError } from '../../../src/lib/errors.js';
import {
  SEARCH_UNAVAILABLE_NOTE,
  createTurnDocuments,
  type TurnFile,
  type TurnKnowledge,
} from '../../../src/lib/files/context.js';
import { DOCUMENT_RULES } from '../../../src/lib/files/rules.js';
import {
  KNOWLEDGE_DEFAULTS,
  type KnowledgeRetrievalConfig,
} from '../../../src/lib/knowledge/config.js';
import { drainKnowledge } from '../../../src/lib/knowledge/ingest.js';
import {
  createLocalKnowledgeStore,
  type LocalAttachment,
  type LocalKnowledgeStore,
} from '../../../src/lib/knowledge/local-store.js';
import { completion, scriptedClaude } from '../files/helpers.js';
import { capturingLogger } from '../llm/helpers.js';
import {
  CONV_A,
  CONV_B,
  OUTSIDER,
  TEAMMATE,
  USER,
  attachment,
  bagOfWords,
  fakeEmbedder,
  page,
  prose,
} from './helpers.js';

const NOW = new Date('2026-10-16T02:00:00Z');

async function learned(docs: readonly LocalAttachment[]): Promise<LocalKnowledgeStore> {
  const store = createLocalKnowledgeStore({ activeStaff: [USER, TEAMMATE] });
  for (const doc of docs) store.attach(doc);
  const deps = {
    store,
    embedder: fakeEmbedder(),
    config: {
      ...KNOWLEDGE_DEFAULTS.embed,
      batchChars: 400_000,
      batchInputs: 128,
      requestsPerRun: 100,
      gapMs: 0,
    },
    log: capturingLogger().log,
  };
  for (let i = 0; i < 5; i += 1) await drainKnowledge(deps);
  return store;
}

function knowledgeOf(
  store: LocalKnowledgeStore,
  config: Partial<KnowledgeRetrievalConfig> = {},
): TurnKnowledge & { lines: string[] } {
  const { log, lines } = capturingLogger();
  return {
    sourcesForFiles: (ids) => store.sourcesForFiles(ids),
    match: (q, p) => store.match(q, p),
    neighbours: (s, o) => store.neighbours(s, o),
    summaries: (s) => store.summariesOf(s),
    anyReady: () => store.anyReady(),
    config: { ...KNOWLEDGE_DEFAULTS.retrieval, minSimilarity: 0.2, ...config },
    log,
    lines,
  };
}

function filesOf(files: readonly TurnFile[] = [], everHadFile = files.length > 0) {
  return { forTurn: () => Promise.resolve(ok({ files, everHadFile })) };
}

function ask(message: string, conversationId: string | null = null, userId = TEAMMATE) {
  return {
    conversationId,
    userId,
    message,
    previousUserMessage: null,
    search: () =>
      Promise.resolve(
        ok({ vector: bagOfWords(message), text: message, aboutDocuments: true, overview: false }),
      ),
  };
}

/** The shared body of two versions of one rate sheet: only the rate differs. */
const RATE_SHEET =
  'Owner occupier home loan rates. Principal and interest repayments. Offset account available. Fees: application fee nil, annual package fee 395 dollars. Valuation fee waived. Rates are per annum and subject to change without notice. Comparison rates are calculated on a secured loan of 150,000 dollars over 25 years.';

const TRANSCRIPT = attachment({
  name: 'Course transcript.pdf',
  pages: Array.from({ length: 10 }, (_, i) =>
    page(
      i + 1,
      prose(
        `week ${['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][i] ?? ''}`,
        40,
      ),
    ),
  ),
});

describe('a new, empty conversation answers from a document it never saw attached (Part D item 13, structurally)', () => {
  it('the passage comes back by meaning, fenced, from "another conversation", with the date it was added', async () => {
    const store = await learned([TRANSCRIPT]);
    const knowledge = knowledgeOf(store);
    const loaded = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledge).load(
      ask('break down week three for me'),
    );
    if (!loaded.ok) throw loaded.error;
    const excerpts = loaded.value.excerpts ?? '';
    expect(loaded.value.block).toBeNull();
    expect(excerpts).toContain('<document_excerpts');
    expect(excerpts).toContain('week three');
    expect(excerpts).toContain('from="learned earlier, in another conversation"');
    expect(excerpts).toContain('added="14 Oct 2026, 11:00 am Perth time"');
    expect(excerpts).toMatch(
      /shown="ONLY excerpts from \d+ of its 10 pages \(pages [^)]+\), chosen by meaning to match the question\. The rest of this document is NOT shown"/,
    );
    expect(loaded.value.rules).toBe(DOCUMENT_RULES);
    const doc = loaded.value.summary?.coverage.documents[0];
    expect(doc).toMatchObject({
      origin: 'learned',
      mode: 'part',
      total: 10,
      learnedAt: TRANSCRIPT.learnedAt,
    });
    expect(doc?.pages).toContain(3);
    expect(loaded.value.summary?.names[doc?.source ?? '']).toBe('Course transcript.pdf');
  });

  it('a passage chosen gets its neighbours when there is room, joined without repeating the overlap', async () => {
    const long = attachment({
      name: 'Long.pdf',
      contentHash: 'b'.repeat(64),
      pages: [
        page(1, `${prose('alpha', 40)} ${prose('zebra crossing rules', 6)} ${prose('omega', 40)}`),
      ],
    });
    const store = await learned([long]);
    const loaded = await createTurnDocuments(
      filesOf(),
      48_000,
      () => NOW,
      knowledgeOf(store, { minSimilarity: 0.25 }),
    ).load(ask('zebra crossing rules'));
    if (!loaded.ok) throw loaded.error;
    const text = loaded.value.excerpts ?? '';
    expect(text).toContain('zebra crossing rules');
    // Both neighbours score 0 on their own: they are here only as the matched passage's neighbours.
    expect(text).toContain('In alpha we cover point 1 of alpha in detail.');
    expect(text).toContain('In omega we cover point 40 of omega in detail.');
    expect(loaded.value.summary?.coverage.documents[0]?.pages).toEqual([1]);
    // The overlap between two joined chunks appears once.
    const sentence = 'In zebra crossing rules we cover point 1 of zebra crossing rules in detail.';
    expect(text.split(sentence)).toHaveLength(2);
  });
});

describe('Part C — retrieval', () => {
  it('a question that matches nothing: in a new conversation nothing is sent and nothing is shown', async () => {
    const store = await learned([TRANSCRIPT]);
    const loaded = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(store)).load(
      ask('xylophone quartz vortex'),
    );
    expect(loaded).toEqual({
      ok: true,
      value: { rules: null, block: null, excerpts: null, summary: null },
    });
  });

  it('a question that matches nothing about a long attachment HERE: shown="NOTHING", and the screen is told', async () => {
    const store = await learned([TRANSCRIPT]);
    const file: TurnFile = {
      id: TRANSCRIPT.fileId,
      name: TRANSCRIPT.name,
      kind: 'pdf',
      createdAt: '2026-10-14T03:00:00Z',
      pages: TRANSCRIPT.pages.map((p) => ({ ...p })),
    };
    const loaded = await createTurnDocuments(
      filesOf([file]),
      8_000,
      () => NOW,
      knowledgeOf(store),
    ).load(ask('xylophone quartz vortex', CONV_A, USER));
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.block).toBeNull();
    expect(loaded.value.excerpts).toContain(
      'shown="NOTHING: no part of this document matched the question closely enough to be shown"',
    );
    expect(loaded.value.excerpts).not.toContain('week one');
    expect(loaded.value.summary?.coverage.documents).toEqual([
      expect.objectContaining({
        file: file.id,
        origin: 'attached',
        mode: 'none',
        pages: [],
        total: 10,
      }),
    ]);
  });

  it('a question that matches hundreds of chunks: the budget holds, and the coverage says which pages of how many', async () => {
    const huge = attachment({
      name: 'Policy.pdf',
      contentHash: 'c'.repeat(64),
      pages: Array.from({ length: 300 }, (_, i) =>
        page(i + 1, prose(`lending policy section ${String(i)}`, 30)),
      ),
    });
    const store = await learned([huge]);
    const loaded = await createTurnDocuments(
      filesOf(),
      48_000,
      () => NOW,
      knowledgeOf(store, { minSimilarity: 0.1, candidates: 200 }),
    ).load(ask('lending policy section'));
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.summary?.chars).toBeLessThanOrEqual(48_000);
    expect((loaded.value.excerpts ?? '').length).toBeLessThan(52_000);
    const doc = loaded.value.summary?.coverage.documents[0];
    expect(doc?.total).toBe(300);
    expect(doc?.pages.length).toBeGreaterThan(5);
    expect(doc?.pages.length).toBeLessThan(300);
  });

  it('two documents that contradict: both are shown, each named and dated, the newer first', async () => {
    const sept = attachment({
      name: 'Rates September.pdf',
      contentHash: 'd'.repeat(64),
      learnedAt: '2026-09-15T01:00:00Z',
      pages: [
        page(
          1,
          `${RATE_SHEET} The two year fixed rate for owner occupiers is 6.29 percent per annum.`,
        ),
      ],
    });
    const oct = attachment({
      name: 'Rates October.pdf',
      contentHash: 'e'.repeat(64),
      learnedAt: '2026-10-15T01:00:00Z',
      conversationId: CONV_B,
      pages: [
        page(
          1,
          `${RATE_SHEET} The two year fixed rate for owner occupiers is 5.99 percent per annum.`,
        ),
      ],
    });
    const store = await learned([sept, oct]);
    const loaded = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(store)).load(
      ask('two year fixed rate owner occupiers'),
    );
    if (!loaded.ok) throw loaded.error;
    const text = loaded.value.excerpts ?? '';
    expect(text.indexOf('name="Rates October.pdf"')).toBeGreaterThan(-1);
    expect(text.indexOf('name="Rates October.pdf"')).toBeLessThan(
      text.indexOf('name="Rates September.pdf"'),
    );
    expect(text).toContain('added="15 Sep 2026');
    expect(text).toContain('added="15 Oct 2026');
    // Last month's sheet is a near-identical passage of this month's: it is marked as the older.
    expect(text).toMatch(
      /name="Rates September\.pdf"[^>]*newer_version="A document read on 15 Oct 2026 holds a near-identical passage, so this one is OLDER/,
    );
    expect(text).not.toMatch(/name="Rates October\.pdf"[^>]*newer_version=/);
    const docs = loaded.value.summary?.coverage.documents ?? [];
    expect(docs.find((d) => d.learnedAt === sept.learnedAt)?.newerVersionAt).toBe(oct.learnedAt);
  });

  it('a document ingested, then its conversation deleted: it is still known (decided 16 Oct)', async () => {
    const store = await learned([TRANSCRIPT]);
    store.deleteConversation(CONV_A);
    const loaded = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(store)).load(
      ask('week three'),
    );
    expect(loaded.ok && loaded.value.excerpts).toContain('week three');
  });

  it('a document removed by the client after ingestion: forgotten — every copy of its bytes — and never retrieved', async () => {
    const copy = {
      ...TRANSCRIPT,
      fileId: 'f7000000-0000-4000-8000-000000000001',
      conversationId: CONV_B,
    };
    const store = await learned([TRANSCRIPT, copy]);
    store.remove(TRANSCRIPT.fileId);
    const loaded = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(store)).load(
      ask('week three'),
    );
    expect(loaded).toEqual({
      ok: true,
      value: { rules: null, block: null, excerpts: null, summary: null },
    });
    expect(store.sources().every((s) => s.status === 'forgotten' && s.name === null)).toBe(true);
  });

  it('the same document uploaded twice is retrieved once; a page read twice answers with the newer reading', async () => {
    const twice = await learned([
      TRANSCRIPT,
      {
        ...TRANSCRIPT,
        fileId: 'f7000000-0000-4000-8000-000000000002',
        conversationId: CONV_B,
        learnedAt: '2026-10-15T03:00:00Z',
      },
    ]);
    const once = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(twice)).load(
      ask('week three'),
    );
    if (!once.ok) throw once.error;
    expect((once.value.excerpts ?? '').match(/<untrusted_document /g)).toHaveLength(1);

    const url = 'https://lender.example/rates';
    const first = attachment({
      name: 'Rates',
      kind: 'html',
      sourceUrl: url,
      sourceHost: 'lender.example',
      contentHash: '1'.repeat(64),
      learnedAt: '2026-10-01T00:00:00Z',
      pages: [page(1, 'Variable rate today is 6.40 percent.')],
    });
    const second = attachment({
      name: 'Rates',
      kind: 'html',
      sourceUrl: url,
      sourceHost: 'lender.example',
      contentHash: '2'.repeat(64),
      learnedAt: '2026-10-15T00:00:00Z',
      conversationId: CONV_B,
      pages: [page(1, 'Variable rate today is 6.15 percent.')],
    });
    const pages = await learned([first, second]);
    const loaded = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(pages)).load(
      ask('variable rate today'),
    );
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.excerpts).toContain('6.15');
    expect(loaded.value.excerpts).not.toContain('6.40');
    expect(loaded.value.excerpts).toContain('source="lender.example" read="15 Oct 2026');
    // A page brings the web rules, with the time now.
    expect(loaded.value.rules).toContain('# Pages read from a link');
  });

  it('retrieval when nothing has ever been ingested: nothing, and no word about it', async () => {
    const store = createLocalKnowledgeStore({ activeStaff: [TEAMMATE] });
    const loaded = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(store)).load(
      ask('week three'),
    );
    expect(loaded).toEqual({
      ok: true,
      value: { rules: null, block: null, excerpts: null, summary: null },
    });
  });

  it('nothing outside the staff list: a deactivated member or an outsider retrieves nothing', async () => {
    const store = await learned([TRANSCRIPT]);
    store.activate(TEAMMATE, false);
    for (const userId of [TEAMMATE, OUTSIDER]) {
      const loaded = await createTurnDocuments(
        filesOf(),
        48_000,
        () => NOW,
        knowledgeOf(store),
      ).load(ask('week three', null, userId));
      expect(loaded.ok && loaded.value.excerpts).toBeNull();
    }
  });

  it('an attachment that went in whole is not searched again here, nor its copy elsewhere', async () => {
    const small = attachment({
      name: 'Payslip.pdf',
      contentHash: '9'.repeat(64),
      pages: [page(1, 'Net pay this week three is 2,887.38 dollars.')],
    });
    const copyElsewhere = {
      ...small,
      fileId: 'f7000000-0000-4000-8000-000000000003',
      conversationId: CONV_B,
    };
    const store = await learned([small, copyElsewhere]);
    const file: TurnFile = {
      id: small.fileId,
      name: small.name,
      kind: 'pdf',
      createdAt: small.learnedAt,
      pages: small.pages.map((p) => ({ ...p })),
    };
    const loaded = await createTurnDocuments(
      filesOf([file]),
      48_000,
      () => NOW,
      knowledgeOf(store),
    ).load(ask('net pay week three', CONV_A, USER));
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.block).toContain('2,887.38');
    expect(loaded.value.excerpts).toBeNull();
    expect(loaded.value.summary?.coverage.documents).toEqual([
      expect.objectContaining({ mode: 'whole' }),
    ]);
  });
});

describe('a long attachment still being learned, and a search that could not run', () => {
  async function half(): Promise<LocalKnowledgeStore> {
    const store = createLocalKnowledgeStore({ activeStaff: [USER, TEAMMATE] });
    store.attach(TRANSCRIPT);
    await drainKnowledge({
      store,
      embedder: fakeEmbedder(['ok', 'rate_limited']),
      config: { ...KNOWLEDGE_DEFAULTS.embed, batchChars: 4_000, requestsPerRun: 5, gapMs: 0 },
      log: capturingLogger().log,
    });
    return store;
  }
  const file: TurnFile = {
    id: TRANSCRIPT.fileId,
    name: TRANSCRIPT.name,
    kind: 'pdf',
    createdAt: TRANSCRIPT.learnedAt,
    pages: TRANSCRIPT.pages.map((p) => ({ ...p })),
  };

  it('in its own conversation the learned part is searched and the rest is said to be still learning', async () => {
    const store = await half();
    const loaded = await createTurnDocuments(
      filesOf([file]),
      8_000,
      () => NOW,
      knowledgeOf(store, { minSimilarity: 0 }),
    ).load(ask('week one', CONV_A, USER));
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.excerpts).toMatch(
      /learning="STILL BEING LEARNED: \d+ of its \d+ sections can be searched so far/,
    );
    const doc = loaded.value.summary?.coverage.documents[0];
    expect(doc?.mode).toBe('part');
    expect(doc?.learning?.done).toBeLessThan(doc?.learning?.total ?? 0);
  });

  it('elsewhere it is not there at all until it is whole', async () => {
    const store = await half();
    const loaded = await createTurnDocuments(
      filesOf(),
      48_000,
      () => NOW,
      knowledgeOf(store, { minSimilarity: 0 }),
    ).load(ask('week one'));
    expect(loaded.ok && loaded.value.excerpts).toBeNull();
  });

  it('nothing learned yet: its opening pages, labelled as NOT chosen for the question, and why', async () => {
    const store = createLocalKnowledgeStore({ activeStaff: [USER] });
    store.attach(TRANSCRIPT);
    const loaded = await createTurnDocuments(
      filesOf([file]),
      8_000,
      () => NOW,
      knowledgeOf(store),
    ).load(ask('week seven', CONV_A, USER));
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.excerpts).toContain(
      'NOT chosen for this question: it is still being learned',
    );
    expect(loaded.value.summary?.coverage.documents[0]).toMatchObject({
      mode: 'opening',
      reason: 'learning',
    });
  });

  it('the search failing (Voyage 429) never refuses the turn: opening pages labelled, a note to the model, and the screen told', async () => {
    const store = await learned([TRANSCRIPT]);
    const loaded = await createTurnDocuments(
      filesOf([file]),
      8_000,
      () => NOW,
      knowledgeOf(store),
    ).load({
      ...ask('week seven', CONV_A, USER),
      search: () => Promise.resolve(err(new NetworkError('voyage 429'))),
    });
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.excerpts).toContain(SEARCH_UNAVAILABLE_NOTE);
    expect(loaded.value.excerpts).toContain(
      'NOT chosen for this question: the search that picks the relevant parts could not run',
    );
    expect(loaded.value.summary?.coverage).toMatchObject({ searchFailed: true });
    expect(loaded.value.summary?.coverage.documents[0]).toMatchObject({
      mode: 'opening',
      reason: 'search_failed',
    });
  });

  it('the search failing in a new conversation: told only when there was something learned to search', async () => {
    const store = await learned([TRANSCRIPT]);
    const failing = {
      ...ask('week seven'),
      search: () => Promise.resolve(err(new NetworkError('x'))),
    };
    const told = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(store)).load(
      failing,
    );
    expect(told.ok && told.value.summary?.coverage).toEqual({
      v: 1,
      documents: [],
      searchFailed: true,
    });
    expect(told.ok && told.value.rules).toBe(DOCUMENT_RULES);
    const empty = createLocalKnowledgeStore({ activeStaff: [TEAMMATE] });
    const silent = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(empty)).load(
      failing,
    );
    expect(silent.ok && silent.value.summary).toBeNull();
  });

  it('the database search failing is the same as Voyage failing: never a refusal', async () => {
    const store = await learned([TRANSCRIPT]);
    const knowledge = {
      ...knowledgeOf(store),
      match: () => Promise.resolve(err(new NetworkError('db'))),
    };
    const loaded = await createTurnDocuments(filesOf([file]), 8_000, () => NOW, knowledge).load(
      ask('week seven', CONV_A, USER),
    );
    expect(loaded.ok && loaded.value.summary?.coverage.searchFailed).toBe(true);
  });
});

describe('whether to search what was learned at all, and how close is close enough', () => {
  const asked = (
    message: string,
    aboutDocuments: boolean | null,
    conversationId: string | null = null,
  ) => ({
    ...ask(message, conversationId, USER),
    search: () =>
      Promise.resolve(
        ok({ vector: bagOfWords(message), text: message, aboutDocuments, overview: false }),
      ),
  });

  it('a request to write something (judged NOT about a document) does not pull in what was learned', async () => {
    const store = await learned([TRANSCRIPT]);
    const loaded = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(store)).load(
      asked('write a facebook post about week three', false),
    );
    expect(loaded).toEqual({
      ok: true,
      value: { rules: null, block: null, excerpts: null, summary: null },
    });
    // The same words, judged about the course, do.
    const about = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(store)).load(
      asked('write a facebook post about week three', true),
    );
    expect(about.ok && about.value.excerpts).toContain('week three');
    // And when nothing could judge it (the rewrite failed), the floor alone decides, as before.
    const unknown = await createTurnDocuments(
      filesOf(),
      48_000,
      () => NOW,
      knowledgeOf(store),
    ).load(asked('write a facebook post about week three', null));
    expect(unknown.ok && unknown.value.excerpts).toContain('week three');
  });

  it('this conversation’s own long attachment is still searched, whatever the judgement', async () => {
    const store = await learned([TRANSCRIPT]);
    const file: TurnFile = {
      id: TRANSCRIPT.fileId,
      name: TRANSCRIPT.name,
      kind: 'pdf',
      createdAt: TRANSCRIPT.learnedAt,
      pages: TRANSCRIPT.pages.map((p) => ({ ...p })),
    };
    const loaded = await createTurnDocuments(
      filesOf([file]),
      8_000,
      () => NOW,
      knowledgeOf(store),
    ).load(asked('write a facebook post about week three', false, CONV_A));
    expect(loaded.ok && loaded.value.excerpts).toContain('week three');
    expect(loaded.ok && loaded.value.summary?.coverage.documents[0]).toMatchObject({
      origin: 'attached',
      mode: 'part',
    });
  });

  it('the attached floor is lower than the learned one: the same weak match counts here and not elsewhere', async () => {
    const store = await learned([TRANSCRIPT]);
    const file: TurnFile = {
      id: TRANSCRIPT.fileId,
      name: TRANSCRIPT.name,
      kind: 'pdf',
      createdAt: TRANSCRIPT.learnedAt,
      pages: TRANSCRIPT.pages.map((p) => ({ ...p })),
    };
    const floors = { minSimilarity: 0.99, attachedMinSimilarity: 0.05 };
    const here = await createTurnDocuments(
      filesOf([file]),
      8_000,
      () => NOW,
      knowledgeOf(store, floors),
    ).load(asked('week three', true, CONV_A));
    expect(here.ok && here.value.summary?.coverage.documents[0]?.mode).toBe('part');
    const elsewhere = await createTurnDocuments(
      filesOf(),
      48_000,
      () => NOW,
      knowledgeOf(store, floors),
    ).load(asked('week three', true));
    expect(elsewhere.ok && elsewhere.value.excerpts).toBeNull();
  });

  it('a passage shows the section it belongs to in its heading, defanged like any document text', async () => {
    const course = attachment({
      name: 'Course.pdf',
      contentHash: 'f'.repeat(64),
      pages: [
        page(1, `Welcome to week two of the program. ${prose('discovery script', 30)}`),
        page(2, prose('discovery script continued', 30)),
      ],
    });
    const store = await learned([course]);
    const loaded = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(store)).load(
      ask('discovery script continued'),
    );
    expect(loaded.ok && loaded.value.excerpts).toContain('--- Page 2 · Week 2 ---');
  });

  it('a section the question names is brought in below the floor, and ahead of closer pages that are not it', async () => {
    const course = attachment({
      name: 'Course.pdf',
      contentHash: 'e'.repeat(64),
      pages: [
        page(1, `Welcome to week two of the program. ${prose('discovery script', 30)}`),
        page(2, `Week three is all about referrals. ${prose('referral partners', 30)}`),
        page(3, prose('partner follow up', 30)),
      ],
    });
    const store = await learned([course]);
    const unreachable = { minSimilarity: 0.99, attachedMinSimilarity: 0.99 };
    const named = await createTurnDocuments(
      filesOf(),
      48_000,
      () => NOW,
      knowledgeOf(store, unreachable),
    ).load(asked('what were the main points in week 3', true));
    expect(named.ok && named.value.excerpts).toContain('--- Page 2 · Week 3 ---');
    // Page 3 never says "week three"; it is in it because the section carries forward.
    expect(named.ok && named.value.excerpts).toContain('--- Page 3 · Week 3 ---');
    // The same question naming no section finds nothing over a floor it cannot reach.
    const unnamed = await createTurnDocuments(
      filesOf(),
      48_000,
      () => NOW,
      knowledgeOf(store, unreachable),
    ).load(asked('what were the main points about referrals', true));
    expect(unnamed.ok && unnamed.value.excerpts).toBeNull();
  });

  it('his question, with the rewrite timed out: the words as typed still find week one, and only week one', async () => {
    const course = attachment({
      name: 'Course.pdf',
      contentHash: 'd'.repeat(64),
      pages: [
        page(1, `Welcome to week one of the program. ${prose('pipeline setup', 30)}`),
        page(2, `Week two is all about discovery calls. ${prose('discovery script', 30)}`),
        page(3, `Welcome to week three. ${prose('referral partners', 30)}`),
      ],
    });
    const store = await learned([course]);
    const file: TurnFile = {
      id: course.fileId,
      name: course.name,
      kind: 'pdf',
      createdAt: course.learnedAt,
      pages: course.pages.map((p) => ({ ...p })),
    };
    // aboutDocuments null and the text as typed: what a timed-out rewrite hands on (query.ts).
    // A budget the three pages do not fit in whole, so they are searched.
    const loaded = await createTurnDocuments(
      filesOf([file]),
      4_000,
      () => NOW,
      knowledgeOf(store, { minSimilarity: 0.99, attachedMinSimilarity: 0.99 }),
    ).load(asked('break down weak one for me', null, CONV_A));
    const covered = loaded.ok ? loaded.value.summary?.coverage.documents[0] : undefined;
    expect(covered).toMatchObject({ origin: 'attached', mode: 'part' });
    expect(covered?.pages).toContain(1);
    expect(covered?.pages).not.toContain(3);
    expect(loaded.ok && loaded.value.excerpts).toContain('--- Page 1 · Week 1 ---');
    expect(loaded.ok && loaded.value.excerpts).not.toContain('Week 3');
    // Without the typo reading, the same words find nothing over that floor.
    const typed = await createTurnDocuments(
      filesOf([file]),
      4_000,
      () => NOW,
      knowledgeOf(store, { minSimilarity: 0.99, attachedMinSimilarity: 0.99 }),
    ).load(asked('break down this weak one for me', null, CONV_A));
    expect(typed.ok && typed.value.summary?.coverage.documents[0]?.mode).toBe('none');
  });
});

describe('logging', () => {
  it('one line per turn with counts, similarities and timings — never a word of text or a name', async () => {
    const store = await learned([TRANSCRIPT]);
    const knowledge = knowledgeOf(store);
    await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledge).load(ask('week three'));
    const all = knowledge.lines.join('\n');
    expect(all).toContain('documents for turn');
    expect(all).toContain('"bestSimilarity":');
    expect(all).toContain('"excerptChars":');
    expect(all).not.toContain('Course transcript');
    expect(all).not.toContain('week three');
  });
});

describe('an overview question is answered from the summary (17 Oct: "break down week one" is summarisation)', () => {
  const RECAP =
    'Week one: the pipeline (p. 1), the first fifty calls (pp. 2–4), follow-ups (pp. 5–8).';
  const COURSE = attachment({
    name: 'Week_1_-_Transcript_Timestamps (1).pdf',
    contentHash: 'b'.repeat(64),
    pages: Array.from({ length: 8 }, (_, i) => page(i + 1, prose(`call part ${String(i)}`, 60))),
  });

  async function learnedWithSummary(docs: readonly LocalAttachment[], text = RECAP) {
    const store = createLocalKnowledgeStore({ activeStaff: [USER, TEAMMATE] });
    for (const doc of docs) store.attach(doc);
    const deps = {
      store,
      embedder: fakeEmbedder(),
      config: {
        ...KNOWLEDGE_DEFAULTS.embed,
        batchChars: 400_000,
        batchInputs: 128,
        requestsPerRun: 100,
        gapMs: 0,
      },
      summaries: {
        claude: scriptedClaude(ok(completion(text))),
        config: { ...KNOWLEDGE_DEFAULTS.summary, minChars: 1_000, blockChars: 12_000 },
      },
      log: capturingLogger().log,
    };
    for (let i = 0; i < 5; i += 1) await drainKnowledge(deps);
    return store;
  }

  const overview = (message: string, conversationId: string | null = null) => ({
    ...ask(message, conversationId),
    search: () =>
      Promise.resolve(
        ok({ vector: bagOfWords(message), text: message, aboutDocuments: true, overview: true }),
      ),
  });

  it('in a new, empty conversation: the whole summary, a little of the text in full, and it says so', async () => {
    const store = await learnedWithSummary([COURSE]);
    // A floor no passage can clear: only the week the NAME gives brings the document in.
    const loaded = await createTurnDocuments(
      filesOf(),
      48_000,
      () => NOW,
      knowledgeOf(store, { minSimilarity: 0.99 }),
    ).load(overview('break down week one for me'));
    const excerpts = loaded.ok ? (loaded.value.excerpts ?? '') : '';
    expect(excerpts).toContain('--- Summary of pages 1–');
    expect(excerpts).toContain(RECAP);
    expect(excerpts).toContain('shown="A SUMMARY of pages 1–8 of its 8');
    const doc = loaded.ok ? loaded.value.summary?.coverage.documents[0] : undefined;
    expect(doc).toMatchObject({ origin: 'learned', mode: 'part', summary: [{ from: 1, to: 8 }] });
    // Detail beside it, within its allowance — far less than the budget.
    const chars = loaded.ok ? (loaded.value.summary?.chars ?? 0) : 0;
    expect(chars).toBeLessThan(KNOWLEDGE_DEFAULTS.retrieval.overviewDetailChars + 4 * 2_000);
  });

  it('in the conversation it is attached to, the same', async () => {
    const store = await learnedWithSummary([COURSE]);
    const file: TurnFile = {
      id: COURSE.fileId,
      name: COURSE.name,
      kind: 'pdf',
      createdAt: COURSE.learnedAt,
      pages: COURSE.pages.map((p) => ({ ...p })),
    };
    const loaded = await createTurnDocuments(
      filesOf([file]),
      8_000,
      () => NOW,
      knowledgeOf(store),
    ).load(overview('break down week one for me', CONV_A));
    const doc = loaded.ok ? loaded.value.summary?.coverage.documents[0] : undefined;
    expect(doc).toMatchObject({ origin: 'attached', summary: [{ from: 1, to: 8 }] });
  });

  it('a question about one fact is not an overview: passages, as before', async () => {
    const store = await learnedWithSummary([COURSE]);
    const loaded = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(store)).load(
      ask('call part 3'),
    );
    const doc = loaded.ok ? loaded.value.summary?.coverage.documents[0] : undefined;
    expect(doc?.pages.length).toBeGreaterThan(0);
  });

  it('no summary (too short, failed, or still being written): the passages, as for any question', async () => {
    const store = await learned([COURSE]);
    const loaded = await createTurnDocuments(filesOf(), 48_000, () => NOW, knowledgeOf(store)).load(
      overview('break down week one for me'),
    );
    const doc = loaded.ok ? loaded.value.summary?.coverage.documents[0] : undefined;
    expect(doc?.summary).toBeUndefined();
    expect(doc?.pages.length).toBeGreaterThan(0);
  });

  it('a summary bigger than the budget is not sent half; the passages are', async () => {
    const store = await learnedWithSummary([COURSE], `${RECAP} ${'x'.repeat(3_000)}`);
    const loaded = await createTurnDocuments(filesOf(), 2_500, () => NOW, knowledgeOf(store)).load(
      overview('break down week one for me'),
    );
    const doc = loaded.ok ? loaded.value.summary?.coverage.documents[0] : undefined;
    expect(doc?.summary).toBeUndefined();
  });
});
