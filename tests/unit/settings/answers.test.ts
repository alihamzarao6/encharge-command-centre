/**
 * Which conversations still hold an answer given from a document (Milestone 5 part 4, the
 * reviewer's follow-up): the rule over the coverage record each answer was saved with.
 */
import { describe, expect, it } from 'vitest';

import { conversationsHolding, heldTheDocument } from '../../../src/lib/settings/answers.js';

const IDS = { sources: ['src-a', 'src-b'], files: ['file-a'] };

/** A coverage record; entries are `unknown` so a malformed one can be written on purpose. */
function coverage(...documents: unknown[]): unknown {
  return { v: 1, documents };
}

describe('heldTheDocument', () => {
  it('an answer that had it in front of the model — whole, excerpts or opening pages, by either id', () => {
    expect(
      heldTheDocument(coverage({ file: 'file-a', origin: 'attached', mode: 'whole' }), IDS),
    ).toBe(true);
    expect(
      heldTheDocument(coverage({ source: 'src-b', origin: 'learned', mode: 'part' }), IDS),
    ).toBe(true);
    expect(
      heldTheDocument(
        coverage({ file: 'other', source: 'src-a', origin: 'attached', mode: 'opening' }),
        IDS,
      ),
    ).toBe(true);
  });

  it('"none" means nothing of it was sent: that answer does not hold it', () => {
    expect(
      heldTheDocument(coverage({ source: 'src-a', origin: 'learned', mode: 'none' }), IDS),
    ).toBe(false);
    expect(
      heldTheDocument(
        coverage(
          { source: 'src-a', origin: 'learned', mode: 'none' },
          { source: 'unrelated', origin: 'learned', mode: 'part' },
        ),
        IDS,
      ),
    ).toBe(false);
  });

  it('another document entirely does not count; a record it cannot read is counted, not dropped', () => {
    expect(
      heldTheDocument(coverage({ source: 'zzz', origin: 'learned', mode: 'whole' }), IDS),
    ).toBe(false);
    expect(heldTheDocument(coverage('not an entry', null), IDS)).toBe(false);
    expect(heldTheDocument(null, IDS)).toBe(true);
    expect(heldTheDocument({ v: 1 }, IDS)).toBe(true);
  });
});

describe('conversationsHolding', () => {
  it('counts conversations, not answers, and only those still there', () => {
    const answers = [
      {
        conversationId: 'c1',
        coverage: coverage({ source: 'src-a', mode: 'part', origin: 'learned' }),
      },
      {
        conversationId: 'c1',
        coverage: coverage({ file: 'file-a', mode: 'whole', origin: 'attached' }),
      },
      {
        conversationId: 'c2',
        coverage: coverage({ source: 'src-b', mode: 'part', origin: 'learned' }),
      },
      {
        conversationId: 'c3',
        coverage: coverage({ source: 'src-a', mode: 'none', origin: 'learned' }),
      },
      {
        conversationId: 'gone',
        coverage: coverage({ source: 'src-a', mode: 'part', origin: 'learned' }),
      },
    ];
    expect(conversationsHolding(answers, IDS, new Set(['c1', 'c2', 'c3']))).toBe(2);
    expect(conversationsHolding([], IDS, new Set())).toBe(0);
  });
});
