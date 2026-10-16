/**
 * Spending the budget on what retrieval found (src/lib/knowledge/select.ts): best first, skip
 * what does not fit, neighbours inside the document's ends, overlap joined once, gaps marked,
 * this conversation's documents first and learned ones newest first.
 */
import { describe, expect, it } from 'vitest';

import {
  CHUNK_OVERHEAD_CHARS,
  DOCUMENT_OVERHEAD_CHARS,
  addNeighbours,
  describePages,
  groupDocuments,
  mergePassages,
  neighbourWants,
  pickChunks,
  type ExcerptChunk,
} from '../../../src/lib/knowledge/select.js';
import type { MatchedChunk } from '../../../src/lib/knowledge/store.js';

function chunk(
  overrides: Partial<MatchedChunk> & Pick<MatchedChunk, 'sourceId' | 'ordinal'>,
): MatchedChunk {
  return {
    chunkKind: 'passage',
    pageNo: 1,
    pageTo: null,
    pageLabel: 'Page 1',
    method: 'pdf_text_layer',
    legibility: 'full',
    section: null,
    charStart: 0,
    charEnd: 10,
    content: 'x'.repeat(10),
    similarity: 0.5,
    attached: false,
    sourceStatus: 'ready',
    fileId: null,
    conversationId: null,
    name: 'doc.pdf',
    kind: 'pdf',
    sourceHost: null,
    learnedAt: '2026-10-14T00:00:00Z',
    pageCount: 5,
    chunkCount: 10,
    embeddedCount: 10,
    newerTwinLearnedAt: null,
    named: false,
    ...overrides,
  };
}

describe('pickChunks', () => {
  it('takes the best first and skips what does not fit, so a smaller weaker one still can', () => {
    const big = chunk({ sourceId: 's', ordinal: 1, content: 'x'.repeat(900), similarity: 0.9 });
    const bigger = chunk({
      sourceId: 's',
      ordinal: 2,
      content: 'y'.repeat(2_000),
      similarity: 0.8,
    });
    const small = chunk({ sourceId: 's', ordinal: 3, content: 'z'.repeat(100), similarity: 0.6 });
    const budget = 900 + 100 + 2 * CHUNK_OVERHEAD_CHARS + DOCUMENT_OVERHEAD_CHARS;
    const picked = pickChunks([small, bigger, big], budget);
    expect(picked.chunks.map((c) => c.ordinal)).toEqual([1, 3]);
    expect(picked.used).toBe(budget);
  });

  it('charges each document’s header once', () => {
    const a = chunk({ sourceId: 'a', ordinal: 1, similarity: 0.9 });
    const b = chunk({ sourceId: 'b', ordinal: 1, similarity: 0.8 });
    expect(pickChunks([a, b], 10_000).used).toBe(
      2 * (10 + CHUNK_OVERHEAD_CHARS) + 2 * DOCUMENT_OVERHEAD_CHARS,
    );
    expect(pickChunks([a, b], 0).chunks).toEqual([]);
  });

  it('a chunk of the section the question named goes before a closer match that is not', () => {
    const close = chunk({ sourceId: 's', ordinal: 30, content: 'x'.repeat(500), similarity: 0.6 });
    const named = chunk({
      sourceId: 's',
      ordinal: 8,
      content: 'y'.repeat(500),
      similarity: 0.2,
      named: true,
    });
    const budget = 500 + CHUNK_OVERHEAD_CHARS + DOCUMENT_OVERHEAD_CHARS;
    expect(pickChunks([close, named], budget).chunks.map((c) => c.ordinal)).toEqual([8]);
  });

  it('when the named section is found, it is all that is taken: the budget is not filled with other weeks', () => {
    // 17 Oct, live: "break down weak one" in the transcript's own conversation took week one and
    // then nine more pages of other weeks at 0.2–0.29, doubling the cost and muddling the note.
    const named = [7, 8, 9].map((ordinal) =>
      chunk({ sourceId: 's', ordinal, similarity: 0.25, named: true }),
    );
    const others = [30, 31].map((ordinal) => chunk({ sourceId: 's', ordinal, similarity: 0.6 }));
    const elsewhere = chunk({ sourceId: 't', ordinal: 1, similarity: 0.7 });
    expect(
      pickChunks([...others, elsewhere, ...named], 100_000).chunks.map((c) => c.ordinal),
    ).toEqual([7, 8, 9]);
    // A question naming no section (or a section no document has) is ranked by meaning, as before.
    expect(
      pickChunks([...others, elsewhere], 100_000).chunks.map(
        (c) => `${c.sourceId}${String(c.ordinal)}`,
      ),
    ).toEqual(['t1', 's30', 's31']);
  });
});

describe('neighbours', () => {
  it('asks for the chunks either side, never past the ends, never one already chosen', () => {
    const wants = neighbourWants(
      [
        chunk({ sourceId: 's', ordinal: 1 }),
        chunk({ sourceId: 's', ordinal: 2 }),
        chunk({ sourceId: 't', ordinal: 10, chunkCount: 10 }),
      ],
      1,
    );
    expect(wants.get('s')).toEqual([3]);
    expect(wants.get('t')).toEqual([9]);
    expect(neighbourWants([chunk({ sourceId: 's', ordinal: 4 })], 0).size).toBe(0);
    expect(neighbourWants([chunk({ sourceId: 's', ordinal: 4 })], 2).get('s')).toEqual([
      2, 3, 5, 6,
    ]);
  });

  it('adds them nearest the best anchor first while the budget lasts', () => {
    const best = chunk({ sourceId: 's', ordinal: 5, similarity: 0.9 });
    const weak = chunk({ sourceId: 't', ordinal: 2, similarity: 0.3 });
    const picked = pickChunks([best, weak], 100_000);
    const fetched = [
      { ...chunk({ sourceId: 's', ordinal: 4 }), content: 'a'.repeat(50) },
      { ...chunk({ sourceId: 's', ordinal: 6 }), content: 'b'.repeat(50) },
      { ...chunk({ sourceId: 't', ordinal: 1 }), content: 'c'.repeat(50) },
    ];
    const room = picked.used + 2 * (50 + CHUNK_OVERHEAD_CHARS);
    const out = addNeighbours(picked, fetched, room);
    expect(out.map((c) => `${c.sourceId}${String(c.ordinal)}`)).toEqual(['s5', 't2', 's4', 's6']);
  });
});

describe('mergePassages', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz';
  const part = (ordinal: number, start: number, end: number, pageNo = 1): ExcerptChunk => ({
    sourceId: 's',
    ordinal,
    chunkKind: 'passage',
    pageTo: null,
    pageNo,
    pageLabel: `Page ${String(pageNo)}`,
    method: 'pdf_text_layer',
    legibility: 'full',
    section: null,
    charStart: start,
    charEnd: end,
    content: text.slice(start, end),
  });

  it('joins overlapping neighbours on a page without repeating the overlap', () => {
    expect(mergePassages([part(2, 8, 20), part(1, 0, 12)])).toEqual([
      expect.objectContaining({ text: 'abcdefghijklmnopqrst', firstOrdinal: 1, lastOrdinal: 2 }),
    ]);
  });

  it('a gap of whitespace between neighbours becomes a line break; a chunk wholly inside the last adds nothing', () => {
    expect(mergePassages([part(1, 0, 5), part(2, 7, 10)])[0]?.text).toBe('abcde\nhij');
    expect(mergePassages([part(1, 0, 10), part(2, 3, 8)])[0]?.text).toBe('abcdefghij');
  });

  it('keeps passages apart across a missing chunk and across a page', () => {
    expect(mergePassages([part(1, 0, 5), part(3, 10, 15)])).toHaveLength(2);
    expect(mergePassages([part(1, 0, 5), part(2, 0, 5, 2)])).toHaveLength(2);
  });
});

describe('groupDocuments', () => {
  it('this conversation’s documents first, then learned ones newest first; the newest twin date kept', () => {
    const older = chunk({
      sourceId: 'old',
      ordinal: 1,
      similarity: 0.95,
      learnedAt: '2026-09-01T00:00:00Z',
      newerTwinLearnedAt: '2026-10-01T00:00:00Z',
    });
    const newer = chunk({
      sourceId: 'new',
      ordinal: 1,
      similarity: 0.6,
      learnedAt: '2026-10-01T00:00:00Z',
    });
    const here = chunk({
      sourceId: 'here',
      ordinal: 3,
      similarity: 0.4,
      attached: true,
      fileId: 'f',
      pageNo: 2,
    });
    const docs = groupDocuments([older, newer, here], [older, newer, here]);
    expect(docs.map((d) => d.sourceId)).toEqual(['here', 'new', 'old']);
    expect(docs[2]?.newerTwinLearnedAt).toBe('2026-10-01T00:00:00Z');
    expect(docs[0]?.pagesShown).toEqual([2]);
    expect(docs[0]?.bestSimilarity).toBe(0.4);
  });

  it('a chunk retrieval did not return metadata for is dropped rather than guessed', () => {
    expect(groupDocuments([chunk({ sourceId: 'ghost', ordinal: 1 })], [])).toEqual([]);
  });
});

describe('describePages', () => {
  it('reads as a person writes page lists', () => {
    expect(describePages([5, 3, 4, 8, 14, 15, 3])).toBe('3–5, 8, 14–15');
    expect(describePages([7])).toBe('7');
    expect(describePages([])).toBe('');
  });
});
