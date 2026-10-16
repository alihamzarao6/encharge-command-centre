/**
 * The note under an answer (web/src/lib/coverage.ts) — Milestone 5 part 5, fixed decisions 7
 * and 8 on screen. Every sentence the client can be shown is pinned here word for word: when only
 * part of a document reached the model, when none of it did, when it is still being learned,
 * when the search could not run, and when a remembered document was used — and that nothing at
 * all is said when every document went in whole. No sentence blames him, names a setting, or
 * tells him to attach the file again.
 */
import { describe, expect, it } from 'vitest';

import { interpretChatResponse } from '../../../web/src/lib/chatApi.js';
import {
  REMOVED_DOCUMENT_NAME,
  SEARCH_FAILED_TEXT,
  coverageIds,
  coverageLines,
  pageRanges,
  parseCoverage,
  parseNames,
  perthDay,
  type DocumentCoverage,
} from '../../../web/src/lib/coverage.js';
import type { CoverageDocument } from '../../../src/lib/knowledge/coverage.js';

const FILE = 'f0000000-0000-4000-8000-000000000001';
const SOURCE = 'a0000000-0000-4000-8000-000000000001';
const NAMES = { [FILE]: 'Course transcript.pdf', [SOURCE]: 'Rates October.pdf' };

function cov(...documents: CoverageDocument[]): DocumentCoverage {
  return { v: 1, documents };
}

const attachedPart: CoverageDocument = {
  file: FILE,
  source: SOURCE,
  origin: 'attached',
  kind: 'pdf',
  mode: 'part',
  pages: [3, 4, 5, 8],
  total: 33,
};

describe('the sentences, word for word', () => {
  it('only part of a document reached the model: said plainly, with the real reason and what to do', () => {
    expect(coverageLines(cov(attachedPart), NAMES)).toEqual([
      'Only part of “Course transcript.pdf” reached the assistant for this answer: pages 3–5, 8 of its 33 pages. Each question gets the parts that best match it, up to a fixed amount — ask about the specific topic you need to bring other parts in.',
    ]);
  });

  it('the whole document reached the model: nothing is said at all', () => {
    expect(
      coverageLines(
        cov({
          file: FILE,
          origin: 'attached',
          kind: 'pdf',
          mode: 'whole',
          pages: [1, 2],
          total: 2,
        }),
        NAMES,
      ),
    ).toEqual([]);
    expect(coverageLines(null, NAMES)).toEqual([]);
    expect(coverageLines(undefined, NAMES)).toEqual([]);
  });

  it('an answer from a summary says so: what it covered, what was seen in full, and that the summary is the app’s (17 Oct)', () => {
    const summary = [{ from: 1, to: 33 }];
    expect(coverageLines(cov({ ...attachedPart, pages: [2, 3], summary }), NAMES)).toEqual([
      'This answer drew on a summary of all 33 pages of “Course transcript.pdf”, written by the app when it was learned, and on pages 2–3 in full.',
    ]);
    expect(coverageLines(cov({ ...attachedPart, pages: [], summary }), NAMES)).toEqual([
      'This answer drew on a summary of all 33 pages of “Course transcript.pdf”, written by the app when it was learned, not on its full text. Ask about a specific part to see it in full.',
    ]);
    // Part of it summarised: the runs are named.
    expect(
      coverageLines(cov({ ...attachedPart, pages: [], summary: [{ from: 1, to: 7 }] }), NAMES),
    ).toEqual([
      'This answer drew on a summary of pages 1–7 of “Course transcript.pdf”, written by the app when it was learned, not on its full text. Ask about a specific part to see it in full.',
    ]);
    // Learned elsewhere, from a summary.
    expect(
      coverageLines(
        cov({
          source: SOURCE,
          origin: 'learned',
          kind: 'pdf',
          mode: 'part',
          pages: [4],
          total: 33,
          learnedAt: '2026-10-15T05:42:51Z',
          summary,
        }),
        NAMES,
      ),
    ).toEqual([
      'Also drew on “Rates October.pdf”, added 15 Oct 2026 in another conversation: a summary of all 33 pages, written by the app when it was learned, and page 4 in full.',
    ]);
  });

  it('nothing in it matched the question', () => {
    expect(coverageLines(cov({ ...attachedPart, mode: 'none', pages: [] }), NAMES)).toEqual([
      'Nothing in “Course transcript.pdf” matched this question closely enough, so none of it reached the assistant for this answer. Ask about the specific topic you need from it to bring that part in.',
    ]);
  });

  it('still being learned: how far, what it saw, and when to ask again', () => {
    expect(
      coverageLines(cov({ ...attachedPart, learning: { done: 40, total: 165 } }), NAMES),
    ).toEqual([
      '“Course transcript.pdf” is still being learned (40 of 165 sections so far), so this answer drew only on pages 3–5, 8 of its 33 pages. Ask again in a few minutes for an answer drawn from all of it.',
    ]);
    expect(
      coverageLines(
        cov({ ...attachedPart, mode: 'opening', pages: [1, 2, 3, 4], reason: 'learning' }),
        NAMES,
      ),
    ).toEqual([
      'This answer saw only the opening pages of “Course transcript.pdf” (pages 1–4 of its 33 pages), not the parts that match your question: it is still being learned. Ask again in a few minutes for an answer drawn from all of it.',
    ]);
  });

  // On the free Voyage plan this is the common case, not the rare one (17 Oct: 5 of 9 rapid
  // follow-ups): the note leads with what was seen, then why.
  it('the search could not run: the opening pages, said to be exactly that', () => {
    expect(
      coverageLines(
        {
          ...cov({ ...attachedPart, mode: 'opening', pages: [1, 2], reason: 'search_failed' }),
          searchFailed: true,
        },
        NAMES,
      ),
    ).toEqual([
      "This answer saw only the opening pages of “Course transcript.pdf” (pages 1–2 of its 33 pages), not the parts that match your question: the search that picks those wasn't available just now. Ask again in a minute.",
    ]);
    expect(coverageLines({ v: 1, documents: [], searchFailed: true }, NAMES)).toEqual([
      SEARCH_FAILED_TEXT,
    ]);
    expect(
      coverageLines(
        cov({ ...attachedPart, mode: 'opening', pages: [1], reason: 'not_learned' }),
        NAMES,
      ),
    ).toEqual([
      "This answer saw only the opening page of “Course transcript.pdf” (page 1 of its 33 pages), not the parts that match your question: it couldn't be searched.",
    ]);
  });

  it('a remembered document says where and when it came from, and that a newer one exists', () => {
    const learned: CoverageDocument = {
      source: SOURCE,
      origin: 'learned',
      kind: 'pdf',
      mode: 'part',
      pages: [2],
      total: 4,
      learnedAt: '2026-10-14T03:00:00Z',
    };
    expect(coverageLines(cov(learned), NAMES)).toEqual([
      'Also drew on “Rates October.pdf”, added 14 Oct 2026 in another conversation: page 2 of its 4 pages.',
    ]);
    expect(
      coverageLines(
        cov({ ...learned, sameConversation: true, newerVersionAt: '2026-10-16T01:00:00Z' }),
        NAMES,
      ),
    ).toEqual([
      'Also drew on “Rates October.pdf”, added 14 Oct 2026 earlier in this conversation: page 2 of its 4 pages. A newer document, from 16 Oct 2026, covers the same ground.',
    ]);
  });

  it('a spreadsheet or Word file has parts, not pages; a long list says there is more', () => {
    const sheet: CoverageDocument = {
      file: FILE,
      origin: 'attached',
      kind: 'xlsx',
      mode: 'part',
      pages: [2],
      total: 3,
    };
    expect(coverageLines(cov(sheet), NAMES)[0]).toContain('part 2 of its 3 parts');
    const long: CoverageDocument = {
      ...attachedPart,
      pages: Array.from({ length: 120 }, (_, i) => i + 1),
      shownCount: 150,
      total: 300,
    };
    expect(coverageLines(cov(long), NAMES)[0]).toContain('pages 1–120 and more of its 300 pages');
  });

  it('a document removed since names nothing', () => {
    expect(coverageLines(cov(attachedPart), {})[0]).toContain(
      `Only part of ${REMOVED_DOCUMENT_NAME} reached`,
    );
  });

  it('no sentence the client can see blames him, names a setting or plan, or asks for the file again', () => {
    const every = [
      ...coverageLines(
        cov(
          attachedPart,
          { ...attachedPart, mode: 'none', pages: [] },
          { ...attachedPart, learning: { done: 1, total: 9 } },
        ),
        NAMES,
      ),
      ...coverageLines(
        {
          ...cov(
            { ...attachedPart, mode: 'opening', reason: 'search_failed' },
            { ...attachedPart, mode: 'opening', reason: 'learning' },
            { ...attachedPart, mode: 'opening', reason: 'not_learned' },
          ),
          searchFailed: true,
        },
        NAMES,
      ),
      SEARCH_FAILED_TEXT,
    ];
    expect(every.length).toBeGreaterThan(6);
    for (const line of every) {
      expect(line).not.toMatch(
        /\b(setting|settings|option|plan|upgrade|whoever|prepared|extract|upload|re-?attach|attach (it|the file) again|your fault)\b/i,
      );
    }
  });
});

describe('parsing and lookups', () => {
  it('the record is parsed, never trusted: anything else is no note', () => {
    expect(parseCoverage(cov(attachedPart))).toEqual(cov(attachedPart));
    expect(parseCoverage({ v: 1, documents: 'x' })).toBeNull();
    expect(parseCoverage(null)).toBeNull();
    expect(parseNames({ a: 'A', b: 3, c: ' ' })).toEqual({ a: 'A' });
    expect(parseNames(['x'])).toEqual({});
    expect(parseNames(null)).toEqual({});
  });

  it('only the documents the note will mention are looked up', () => {
    const learned: CoverageDocument = {
      source: SOURCE,
      origin: 'learned',
      kind: 'pdf',
      mode: 'part',
      pages: [1],
      total: 1,
    };
    const whole: CoverageDocument = {
      file: 'f-whole',
      origin: 'attached',
      kind: 'pdf',
      mode: 'whole',
      pages: [1],
      total: 1,
    };
    expect(coverageIds(cov(attachedPart, learned, whole))).toEqual({
      sources: [SOURCE],
      files: [FILE],
    });
    expect(coverageIds(null)).toEqual({ sources: [], files: [] });
  });

  it('pages and dates read as a person writes them, in Perth', () => {
    expect(pageRanges([9, 1, 2, 3, 5, 9])).toBe('1–3, 5, 9');
    expect(pageRanges([])).toBe('');
    expect(perthDay('2026-10-13T17:30:00Z')).toBe('14 Oct 2026');
    expect(perthDay('not a date')).toBe('an unknown date');
  });

  it('the chat reply carries the record and the names through to the thread', () => {
    const outcome = interpretChatResponse(200, {
      conversationId: 'c',
      userMessageId: 'u',
      assistantMessageId: 'a',
      reply: 'The plan for week one is…',
      documents: { coverage: cov(attachedPart), chars: 9000, names: NAMES },
    });
    expect(outcome).toMatchObject({ kind: 'ok', coverage: cov(attachedPart), names: NAMES });
    const plain = interpretChatResponse(200, {
      conversationId: 'c',
      userMessageId: 'u',
      assistantMessageId: 'a',
      reply: 'Hi.',
    });
    expect(plain).not.toHaveProperty('coverage');
    const garbled = interpretChatResponse(200, {
      conversationId: 'c',
      userMessageId: 'u',
      assistantMessageId: 'a',
      reply: 'Hi.',
      documents: { coverage: 'x' },
    });
    expect(garbled).not.toHaveProperty('coverage');
  });
});
