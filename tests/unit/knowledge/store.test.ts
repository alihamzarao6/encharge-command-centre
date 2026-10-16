/**
 * supabase-js adapter for knowledge (src/lib/knowledge/store.ts) against a stubbed global fetch
 * serving PostgREST-shaped responses: each function with its arguments, each read with its
 * filters, the rows mapped, the malformed rows dropped, and errors that never carry text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createKnowledgeServiceClient,
  supabaseKnowledgeStore,
  type KnowledgeStore,
} from '../../../src/lib/knowledge/store.js';
import { embeddingText } from '../../../src/lib/knowledge/chunk.js';

const CONFIG = { url: 'http://stack.test', anonKey: 'anon', serviceRoleKey: 'service' };
const SECRET = 'CANARY-chunk-text-5512';

interface Seen {
  method: string;
  path: string;
  query: string;
  body: string;
}

const seen: Seen[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stub(handler: (req: Seen) => Response | undefined): void {
  vi.stubGlobal(
    'fetch',
    (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const req: Seen = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        query: decodeURIComponent(url.search),
        body: typeof init?.body === 'string' ? init.body : '',
      };
      seen.push(req);
      const response = handler(req);
      if (response === undefined) throw new Error(`unstubbed: ${req.method} ${req.path}`);
      return Promise.resolve(response);
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
});

const store = (): KnowledgeStore => supabaseKnowledgeStore(createKnowledgeServiceClient(CONFIG));

const MATCH_ROW = {
  source_id: 's1',
  ordinal: 2,
  chunk_kind: 'passage',
  page_no: 3,
  page_to: null,
  page_label: 'Page 3',
  extraction_method: 'pdf_text_layer',
  legibility: 'partial',
  char_start: 10,
  char_end: 50,
  content: 'Week one covers the plan.',
  section: 'Week one',
  similarity: 0.71,
  attached: false,
  source_status: 'ready',
  file_id: null,
  conversation_id: 'c1',
  name: 'Course transcript.pdf',
  kind: 'pdf',
  source_host: null,
  learned_at: '2026-10-14T03:00:00+00:00',
  page_count: 33,
  chunk_count: 120,
  embedded_count: 120,
  newer_twin_learned_at: null,
  named: false,
};

describe('retrieval calls', () => {
  it('match sends the vector as text and every parameter by name, and maps the rows', async () => {
    stub((req) =>
      req.path === '/rest/v1/rpc/match_knowledge_chunks' ? json([MATCH_ROW]) : undefined,
    );
    const result = await store().match([0.1, 0.2], {
      userId: 'u1',
      attachedFileIds: ['f1'],
      excludeFileIds: ['f2'],
      includeLearned: false,
      sections: [],
      limit: 40,
      minSimilarity: 0.3,
      attachedMinSimilarity: 0.2,
    });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_query: '[0.1,0.2]',
      p_user_id: 'u1',
      p_attached_file_ids: ['f1'],
      p_exclude_file_ids: ['f2'],
      p_include_learned: false,
      p_sections: [],
      p_limit: 40,
      p_min_similarity: 0.3,
      p_attached_min_similarity: 0.2,
    });
    expect(result.ok && result.value).toEqual([
      expect.objectContaining({
        sourceId: 's1',
        ordinal: 2,
        legibility: 'partial',
        sourceStatus: 'ready',
        name: 'Course transcript.pdf',
        pageCount: 33,
      }),
    ]);
  });

  it('a row outside the shapes the database promises is dropped, never guessed at', async () => {
    stub(() =>
      json([
        { ...MATCH_ROW, extraction_method: 'telepathy' },
        { ...MATCH_ROW, source_status: 'forgotten' },
        { ...MATCH_ROW, kind: 'exe' },
        { ...MATCH_ROW, chunk_kind: 'gossip' },
        { ...MATCH_ROW, name: null },
        MATCH_ROW,
      ]),
    );
    const result = await store().match([1], {
      userId: 'u',
      attachedFileIds: [],
      excludeFileIds: [],
      includeLearned: true,
      sections: [],
      limit: 5,
      minSimilarity: 0,
      attachedMinSimilarity: 0,
    });
    expect(result.ok && result.value).toHaveLength(1);
  });

  it('neighbours: one call per document with its ordinals; none asked, no call', async () => {
    stub(() =>
      json([
        {
          source_id: 's1',
          ordinal: 3,
          page_no: 1,
          page_label: 'P',
          extraction_method: 'plain_text',
          legibility: 'full',
          char_start: 0,
          char_end: 4,
          content: 'text',
        },
        { ...MATCH_ROW, extraction_method: '??' },
      ]),
    );
    expect(await store().neighbours('s1', [])).toEqual({ ok: true, value: [] });
    expect(seen).toHaveLength(0);
    const near = await store().neighbours('s1', [1, 3]);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ p_source_id: 's1', p_ordinals: [1, 3] });
    expect(near.ok && near.value.map((n) => n.ordinal)).toEqual([3]);
  });

  it('sourcesForFiles and anyReady read the right rows', async () => {
    stub((req) =>
      req.query.includes('file_id=in.')
        ? json([
            { id: 's1', file_id: 'f1', status: 'learning', chunk_count: 10, embedded_count: 4 },
            { id: 's2', file_id: 'f2', status: 'weird', chunk_count: 1, embedded_count: 0 },
          ])
        : json([{ id: 's9' }]),
    );
    expect(await store().sourcesForFiles([])).toEqual({ ok: true, value: [] });
    const states = await store().sourcesForFiles(['f1', 'f2']);
    expect(states.ok && states.value).toEqual([
      { fileId: 'f1', sourceId: 's1', status: 'learning', chunkCount: 10, embeddedCount: 4 },
    ]);
    expect(await store().anyReady()).toEqual({ ok: true, value: true });
    expect(seen.at(-1)?.query).toContain('status=eq.ready');
  });
});

describe('the names the search rewrite is given', () => {
  it('are the most recently read documents that are learned or learning, newest first; a tombstone names nothing', async () => {
    stub(() => json([{ name: 'Course transcript.pdf' }, { name: null }, { name: 'Rates' }]));
    expect(await store().recentNames(12)).toEqual({
      ok: true,
      value: ['Course transcript.pdf', 'Rates'],
    });
    expect(seen[0]?.query).toContain('status=in.(learning,ready)');
    expect(seen[0]?.query).toContain('order=learned_at.desc');
    expect(seen[0]?.query).toContain('limit=12');
  });

  it('a refusal is an error, not an empty list', async () => {
    stub(() => json({ code: '42501', message: 'denied', details: null, hint: null }, 400));
    const result = await store().recentNames(12);
    expect(result.ok).toBe(false);
  });
});

describe('learning calls', () => {
  it('capture sends the chunks in the database’s own field names and returns its state', async () => {
    stub(() => json([{ status: 'learning', chunk_count: 1 }]));
    const result = await store().capture(
      's1',
      'c1-1500-200',
      [
        {
          ordinal: 1,
          pageNo: 2,
          pageLabel: 'Page 2',
          method: 'pdf_text_layer',
          legibility: 'full',
          section: null,
          charStart: 0,
          charEnd: 5,
          content: 'hello',
        },
      ],
      false,
    );
    expect(result).toEqual({ ok: true, value: { status: 'learning', chunkCount: 1 } });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_source_id: 's1',
      p_chunker_version: 'c1-1500-200',
      p_chunks: [
        {
          ordinal: 1,
          page_no: 2,
          page_label: 'Page 2',
          extraction_method: 'pdf_text_layer',
          legibility: 'full',
          char_start: 0,
          char_end: 5,
          content: 'hello',
          section: null,
        },
      ],
      p_summarise: false,
    });
  });

  it('attachEmbeddings sends each vector as pgvector text; the state comes back', async () => {
    stub(() => json([{ status: 'ready', embedded_count: 2, chunk_count: 2 }]));
    const result = await store().attachEmbeddings('s1', [{ ordinal: 1, vector: [0.5, 0.25] }]);
    expect(result).toEqual({
      ok: true,
      value: { status: 'ready', embeddedCount: 2, chunkCount: 2 },
    });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_source_id: 's1',
      p_embeddings: [{ ordinal: 1, embedding: '[0.5,0.25]' }],
    });
  });

  it('nextBatch takes the oldest learning document’s waiting chunks, in order, within the size', async () => {
    stub((req) =>
      req.path === '/rest/v1/knowledge_sources'
        ? json([{ id: 's1', name: 'Doc.pdf', chunk_count: 5, embedded_count: 1 }])
        : json([
            { ordinal: 2, page_label: 'Page 1', section: null, content: 'a'.repeat(100) },
            { ordinal: 3, page_label: 'Page 1', section: null, content: 'b'.repeat(100) },
            { ordinal: 4, page_label: 'Page 2', section: null, content: 'c'.repeat(100) },
          ]),
    );
    const one = embeddingText('Doc.pdf', {
      section: null,
      pageLabel: 'Page 1',
      content: 'a'.repeat(100),
    }).length;
    const batch = await store().nextBatch(one * 2, 32, embeddingText);
    expect(batch.ok && batch.value).toEqual({
      sourceId: 's1',
      sourceName: 'Doc.pdf',
      chunks: [expect.objectContaining({ ordinal: 2 }), expect.objectContaining({ ordinal: 3 })],
      waiting: 4,
    });
    expect(seen[0]?.query).toContain('status=eq.learning');
    expect(seen[1]?.query).toContain('embedding=is.null');
  });

  it('nextBatch: nothing learning, nothing to do', async () => {
    stub(() => json([]));
    expect(await store().nextBatch(1000, 10, embeddingText)).toEqual({ ok: true, value: null });
  });

  it('pagesOfFile: only a READY attachment’s pages; a purged or missing one is null', async () => {
    stub((req) =>
      req.path === '/rest/v1/conversation_files'
        ? json({ id: 'f1', status: 'ready' })
        : json([
            {
              file_id: 'f1',
              page_no: 1,
              label: 'Page 1',
              content: 'one',
              extraction_method: 'pdf_text_layer',
              legibility: 'full',
            },
          ]),
    );
    const pages = await store().pagesOfFile('f1');
    expect(pages.ok && pages.value).toEqual([
      { pageNo: 1, label: 'Page 1', content: 'one', method: 'pdf_text_layer', legibility: 'full' },
    ]);
    vi.unstubAllGlobals();
    stub(() => json({ id: 'f1', status: 'removed' }));
    expect(await store().pagesOfFile('f1')).toEqual({ ok: true, value: null });
  });

  it('the lease, the twin copy, fail, forget and pending all call their functions', async () => {
    stub((req) => {
      if (req.path.endsWith('claim_knowledge_drain'))
        return json([{ claimed: false, wait_ms: 1200 }]);
      if (req.path.endsWith('release_knowledge_drain')) return json(true);
      if (req.path.endsWith('copy_knowledge_from_twin')) return json(true);
      if (req.path.endsWith('fail_knowledge_source')) return json(true);
      if (req.path.endsWith('forget_knowledge')) return json(2);
      if (req.path === '/rest/v1/knowledge_sources' && req.query.includes('status=eq.pending'))
        return json([{ id: 's1', file_id: 'f1', name: 'Week_1.pdf' }]);
      if (req.path === '/rest/v1/knowledge_sources')
        return json({
          content_hash: 'a'.repeat(64),
          id: 's1',
          file_id: 'f1',
          status: 'pending',
          name: 'Week_1.pdf',
        });
      return undefined;
    });
    const s = store();
    expect(await s.claimDrain('h', 140)).toEqual({
      ok: true,
      value: { claimed: false, waitMs: 1200 },
    });
    expect(await s.releaseDrain('h', 'drained', 0)).toEqual({ ok: true, value: true });
    expect(await s.copyFromTwin('s1', 'c1')).toEqual({ ok: true, value: true });
    expect(await s.fail('s1', 'text_gone')).toEqual({ ok: true, value: true });
    expect(await s.forget('s1', null)).toEqual({ ok: true, value: 2 });
    expect(JSON.parse(seen.find((r) => r.path.endsWith('forget_knowledge'))?.body ?? '{}')).toEqual(
      { p_source_id: 's1', p_content_hash: 'a'.repeat(64), p_actor: null, p_reason: 'operator' },
    );
    expect(await s.pendingSources(5)).toEqual({
      ok: true,
      value: [{ id: 's1', fileId: 'f1', name: 'Week_1.pdf' }],
    });
    expect(await s.sourceForFile('f1')).toEqual({
      ok: true,
      value: { id: 's1', fileId: 'f1', name: 'Week_1.pdf', status: 'pending' },
    });
  });
});

describe('failures', () => {
  it('a database refusal is a typed error naming the operation and code — never the text sent', async () => {
    stub(() =>
      json({ code: '23514', message: `violates check: ${SECRET}`, details: null, hint: null }, 400),
    );
    const result = await store().capture(
      's1',
      'c1',
      [
        {
          ordinal: 1,
          pageNo: 1,
          pageLabel: 'P',
          method: 'plain_text',
          legibility: 'full',
          section: null,
          charStart: 0,
          charEnd: 5,
          content: SECRET,
        },
      ],
      false,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('knowledge.capture: database refused');
      expect(JSON.stringify({ m: result.error.message, c: result.error.context })).not.toContain(
        SECRET,
      );
    }
  });

  it('a transport failure is a NetworkError, and every method returns one rather than throwing', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const s = store();
    const results = await Promise.all([
      s.match([1], {
        userId: 'u',
        attachedFileIds: [],
        excludeFileIds: [],
        includeLearned: true,
        sections: [],
        limit: 1,
        minSimilarity: 0,
        attachedMinSimilarity: 0,
      }),
      s.neighbours('s', [1]),
      s.sourcesForFiles(['f']),
      s.anyReady(),
      s.capture(
        's',
        'c',
        [
          {
            ordinal: 1,
            pageNo: 1,
            pageLabel: 'P',
            method: 'plain_text',
            legibility: 'full',
            section: null,
            charStart: 0,
            charEnd: 1,
            content: 'x',
          },
        ],
        false,
      ),
      s.attachEmbeddings('s', [{ ordinal: 1, vector: [1] }]),
      s.nextBatch(10, 1, embeddingText),
      s.pagesOfFile('f'),
      s.claimDrain('h', 1),
      s.releaseDrain('h', 'x', 0),
      s.copyFromTwin('s', 'c'),
      s.fail('s', 'x'),
      s.forget('s', null),
      s.pendingSources(1),
      s.sourceForFile('f'),
    ]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['NETWORK', 'HTTP_STATUS']).toContain(result.error.code);
    }
  });

  it('a function that answers with no row is an internal error, not a silent success', async () => {
    stub(() => json([]));
    const s = store();
    for (const result of [
      await s.capture(
        's',
        'c',
        [
          {
            ordinal: 1,
            pageNo: 1,
            pageLabel: 'P',
            method: 'plain_text',
            legibility: 'full',
            section: null,
            charStart: 0,
            charEnd: 1,
            content: 'x',
          },
        ],
        false,
      ),
      await s.attachEmbeddings('s', [{ ordinal: 1, vector: [1] }]),
      await s.claimDrain('h', 1),
    ]) {
      expect(result.ok).toBe(false);
    }
  });
});

describe('summary calls (17 Oct)', () => {
  it('pending summaries, passages, add, fail and read back — each its own call, each mapped', async () => {
    stub((req) => {
      if (
        req.path === '/rest/v1/knowledge_sources' &&
        req.query.includes('summary_status=eq.pending')
      )
        return json([
          { id: 's1', name: 'Week_1.pdf', kind: 'pdf', page_count: 33 },
          { id: 's2', name: null, kind: 'pdf', page_count: 3 },
          { id: 's3', name: 'x.exe', kind: 'exe', page_count: 1 },
        ]);
      if (req.path === '/rest/v1/knowledge_chunks')
        return json([
          {
            ordinal: 1,
            page_no: 1,
            page_label: 'Page 1',
            char_start: 0,
            char_end: 5,
            content: 'hello',
            section: 'Week 1',
          },
        ]);
      if (req.path.endsWith('add_knowledge_summaries'))
        return json([{ status: 'learning', chunk_count: 156, summary_status: 'done' }]);
      if (req.path.endsWith('fail_knowledge_summary')) return json('failed');
      if (req.path.endsWith('knowledge_summaries_of'))
        return json([
          {
            source_id: 's1',
            ordinal: 152,
            page_no: 1,
            page_to: 7,
            page_label: 'Summary of pages 1–7',
            content: 'Recap.',
            section: 'Week 1',
          },
        ]);
      return undefined;
    });
    const s = store();
    expect(await s.summaryPending(1)).toEqual({
      ok: true,
      value: [{ id: 's1', name: 'Week_1.pdf', kind: 'pdf', pageCount: 33 }],
    });
    expect(seen[0]?.query).toContain('status=eq.learning');
    expect(await s.passagesOf('s1')).toEqual({
      ok: true,
      value: [
        {
          ordinal: 1,
          pageNo: 1,
          pageLabel: 'Page 1',
          charStart: 0,
          charEnd: 5,
          content: 'hello',
          section: 'Week 1',
        },
      ],
    });
    expect(seen[1]?.query).toContain('kind=eq.passage');
    const added = await s.addSummaries('s1', [
      {
        position: 1,
        pageNo: 1,
        pageTo: 7,
        pageLabel: 'Summary of pages 1–7',
        content: 'Recap.',
        section: 'Week 1',
      },
    ]);
    expect(added).toEqual({
      ok: true,
      value: { status: 'learning', chunkCount: 156, summaryStatus: 'done' },
    });
    expect(JSON.parse(seen[2]?.body ?? '{}')).toEqual({
      p_source_id: 's1',
      p_summaries: [
        {
          position: 1,
          page_no: 1,
          page_to: 7,
          page_label: 'Summary of pages 1–7',
          content: 'Recap.',
          section: 'Week 1',
        },
      ],
    });
    expect(await s.failSummary('s1', 3)).toEqual({ ok: true, value: 'failed' });
    expect(JSON.parse(seen[3]?.body ?? '{}')).toEqual({ p_source_id: 's1', p_max_attempts: 3 });
    expect(await s.summariesOf('s1')).toEqual({
      ok: true,
      value: [
        {
          sourceId: 's1',
          ordinal: 152,
          chunkKind: 'summary',
          pageNo: 1,
          pageTo: 7,
          pageLabel: 'Summary of pages 1–7',
          method: 'model_summary',
          legibility: 'full',
          charStart: 0,
          charEnd: 6,
          content: 'Recap.',
          section: 'Week 1',
        },
      ],
    });
  });

  it('nothing is embedded while a summary is pending: the queue asks for those that are not', async () => {
    stub((req) => (req.path === '/rest/v1/knowledge_sources' ? json([]) : undefined));
    expect(await store().nextBatch(12_000, 32, () => 'x')).toEqual({ ok: true, value: null });
    expect(seen[0]?.query).toContain('summary_status=neq.pending');
  });

  it('a summary row comes back from the search as a summary', async () => {
    stub(() =>
      json([
        {
          ...MATCH_ROW,
          chunk_kind: 'summary',
          page_to: 7,
          extraction_method: 'model_summary',
          page_label: 'Summary of pages 1–7',
        },
      ]),
    );
    const result = await store().match([1], {
      userId: 'u',
      attachedFileIds: [],
      excludeFileIds: [],
      includeLearned: true,
      sections: ['Week 1'],
      limit: 5,
      minSimilarity: 0,
      attachedMinSimilarity: 0,
    });
    expect(result.ok && result.value[0]).toMatchObject({
      chunkKind: 'summary',
      pageTo: 7,
      method: 'model_summary',
    });
  });

  it('an answer outside the check constraint is an error, never a guess', async () => {
    stub((req) => {
      if (req.path.endsWith('fail_knowledge_summary')) return json('sideways');
      if (req.path.endsWith('add_knowledge_summaries')) return json([]);
      return undefined;
    });
    expect((await store().failSummary('s1', 3)).ok).toBe(false);
    expect((await store().addSummaries('s1', [])).ok).toBe(false);
  });
});
