/**
 * The pure half of "a forgotten document must not speak from the history"
 * (src/lib/knowledge/withdrawn.ts): which replies a coverage record ties to which documents,
 * which of them are withdrawn once the database says what is gone, and what the model is shown
 * in their place — a sentence that names nothing.
 */
import { describe, expect, it } from 'vitest';

import {
  NOTHING_FORGOTTEN,
  WITHDRAWN_REPLY_STAND_IN,
  citedDocuments,
  isWithdrawn,
  needsLookup,
  withdrawHistory,
  type ForgottenDocuments,
  type HistoryRow,
} from '../../../src/lib/knowledge/withdrawn.js';

const SOURCE = 'a0000000-0000-4000-8000-000000000001';
const FILE = 'f0000000-0000-4000-8000-000000000001';
const OTHER = 'f0000000-0000-4000-8000-000000000002';

const coverage = (documents: readonly Record<string, unknown>[]): unknown => ({
  v: 1,
  documents,
});

const user: HistoryRow = {
  role: 'user',
  content: 'What is the comparison rate at 85%?',
  documentCoverage: null,
  documentContext: false,
};
const plain: HistoryRow = {
  role: 'assistant',
  content: 'Hello.',
  documentCoverage: null,
  documentContext: false,
};
const fromAttachment: HistoryRow = {
  role: 'assistant',
  content: 'The comparison rate is 6.47% p.a.',
  documentCoverage: coverage([{ file: FILE, origin: 'attached', mode: 'whole' }]),
  documentContext: true,
};
const fromLearned: HistoryRow = {
  role: 'assistant',
  content: 'Week one covers the plan.',
  documentCoverage: coverage([{ source: SOURCE, origin: 'learned', mode: 'part' }]),
  documentContext: true,
};
const nothingSent: HistoryRow = {
  role: 'assistant',
  content: 'Nothing in it matched.',
  documentCoverage: coverage([{ source: SOURCE, file: FILE, origin: 'attached', mode: 'none' }]),
  documentContext: false,
};
const beforeCoverage: HistoryRow = {
  role: 'assistant',
  content: 'The payslip shows 3,699.38 gross.',
  documentCoverage: null,
  documentContext: true,
};

const gone = (partial: Partial<ForgottenDocuments>): ForgottenDocuments => ({
  ...NOTHING_FORGOTTEN,
  ...partial,
});

describe('citedDocuments', () => {
  it('collects the sources and files replies drew on, sorted and unique, with mode none left out', () => {
    expect(
      citedDocuments([user, plain, fromAttachment, fromLearned, nothingSent, fromAttachment]),
    ).toEqual({ sources: [SOURCE], files: [FILE], unnamed: false });
  });

  it('a reply answered from a document before coverage existed is unnamed', () => {
    expect(citedDocuments([user, beforeCoverage])).toEqual({
      sources: [],
      files: [],
      unnamed: true,
    });
  });

  it('a user row never cites anything, whatever its columns say', () => {
    const odd: HistoryRow = {
      ...user,
      documentContext: true,
      documentCoverage: coverage([{ file: FILE, mode: 'whole' }]),
    };
    expect(citedDocuments([odd])).toEqual({ sources: [], files: [], unnamed: false });
  });

  it('an unreadable coverage record names nothing and, with document_context, counts as unnamed', () => {
    const broken: HistoryRow = { ...fromAttachment, documentCoverage: { v: 1, documents: 'x' } };
    expect(citedDocuments([broken])).toEqual({ sources: [], files: [], unnamed: true });
    expect(citedDocuments([{ ...broken, documentContext: false }]).unnamed).toBe(false);
  });

  it('needsLookup is false only for a history with no document behind any reply', () => {
    expect(needsLookup(citedDocuments([user, plain]))).toBe(false);
    expect(needsLookup(citedDocuments([user, nothingSent]))).toBe(false);
    expect(needsLookup(citedDocuments([user, fromLearned]))).toBe(true);
    expect(needsLookup(citedDocuments([user, beforeCoverage]))).toBe(true);
  });
});

describe('isWithdrawn', () => {
  it('a reply from a forgotten learned copy, or from an attachment that is gone, is withdrawn', () => {
    expect(isWithdrawn(fromLearned, gone({ sources: new Set([SOURCE]) }))).toBe(true);
    expect(isWithdrawn(fromAttachment, gone({ files: new Set([FILE]) }))).toBe(true);
  });

  it('a reply whose documents are all still there is not', () => {
    expect(isWithdrawn(fromLearned, NOTHING_FORGOTTEN)).toBe(false);
    expect(isWithdrawn(fromAttachment, gone({ files: new Set([OTHER]) }))).toBe(false);
    expect(isWithdrawn(fromAttachment, gone({ anyRemovedHere: true }))).toBe(false);
  });

  it('a document of which nothing was sent (mode none) does not withdraw the reply', () => {
    expect(
      isWithdrawn(nothingSent, gone({ sources: new Set([SOURCE]), files: new Set([FILE]) })),
    ).toBe(false);
  });

  it('a reply from before coverage existed is withdrawn only when this conversation had an attachment removed', () => {
    expect(isWithdrawn(beforeCoverage, gone({ anyRemovedHere: true }))).toBe(true);
    expect(isWithdrawn(beforeCoverage, gone({ sources: new Set([SOURCE]) }))).toBe(false);
    expect(isWithdrawn(plain, gone({ anyRemovedHere: true }))).toBe(false);
  });

  it('a user row is never withdrawn', () => {
    expect(isWithdrawn(user, gone({ anyRemovedHere: true, files: new Set([FILE]) }))).toBe(false);
  });
});

describe('withdrawHistory', () => {
  it('keeps every turn in its place and replaces only the withdrawn replies with the stand-in', () => {
    const shown = withdrawHistory(
      [user, fromAttachment, user, fromLearned, user, plain],
      gone({ files: new Set([FILE]) }),
    );
    expect(shown).toEqual([
      { role: 'user', content: user.content },
      { role: 'assistant', content: WITHDRAWN_REPLY_STAND_IN, withdrawn: true },
      { role: 'user', content: user.content },
      { role: 'assistant', content: fromLearned.content },
      { role: 'user', content: user.content },
      { role: 'assistant', content: plain.content },
    ]);
    expect(JSON.stringify(shown)).not.toContain('6.47');
  });

  it('a history with nothing forgotten is sent as said, with no flag on any turn', () => {
    const shown = withdrawHistory([user, fromAttachment], NOTHING_FORGOTTEN);
    expect(shown).toEqual([
      { role: 'user', content: user.content },
      { role: 'assistant', content: fromAttachment.content },
    ]);
    expect(shown.some((turn) => 'withdrawn' in turn)).toBe(false);
  });

  it('the stand-in names no document, no figure and no file: the tombstone rule', () => {
    expect(WITHDRAWN_REPLY_STAND_IN).not.toMatch(/\d/);
    expect(WITHDRAWN_REPLY_STAND_IN).not.toMatch(/\.pdf|\.xlsx|\.docx|http/i);
    expect(WITHDRAWN_REPLY_STAND_IN.startsWith('[This reply has been withdrawn.')).toBe(true);
  });
});
