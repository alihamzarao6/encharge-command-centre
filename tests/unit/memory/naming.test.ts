/**
 * How a conversation is named (src/lib/memory/naming.ts) — the module the server and the
 * browser both import, so these are assertions about both at once.
 *
 * The property that matters most is the round trip: whatever is DISPLAYED, feeding it back
 * through a rename must never store the prefix. That is what stops "ross — ross — …".
 */
import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_PREFIX_SEPARATOR,
  CONVERSATION_TITLE_MAX_CHARS,
  UNTITLED_CONVERSATION,
  conversationDisplayName,
  conversationPrefix,
  stripConversationPrefix,
  titleFromFirstMessage,
} from '../../../src/lib/memory/naming.js';

describe('conversationPrefix', () => {
  it('is the email local part', () => {
    expect(conversationPrefix('rossb@fundd.com.au')).toBe('rossb');
    expect(conversationPrefix('  Zoe@Fundd.com.au ')).toBe('Zoe');
  });

  it('is null for anything unusable, so the name degrades rather than breaking', () => {
    for (const value of [null, undefined, '', '   ', '@fundd.com.au']) {
      expect(conversationPrefix(value)).toBeNull();
    }
  });
});

describe('conversationDisplayName', () => {
  it('is author then name', () => {
    expect(conversationDisplayName('Meta ad about offsets', 'ross@fundd.com.au')).toBe(
      'ross — Meta ad about offsets',
    );
  });

  it('names an unnamed conversation without losing the author', () => {
    expect(conversationDisplayName(null, 'ross@fundd.com.au')).toBe(
      `ross — ${UNTITLED_CONVERSATION}`,
    );
    expect(conversationDisplayName('   ', 'ross@fundd.com.au')).toBe(
      `ross — ${UNTITLED_CONVERSATION}`,
    );
  });

  it('falls back to the bare name when the author cannot be resolved', () => {
    expect(conversationDisplayName('Meta ad', null)).toBe('Meta ad');
    expect(conversationDisplayName(null, null)).toBe(UNTITLED_CONVERSATION);
  });

  it('is the AUTHOR, never the viewer — the same row reads the same to everyone', () => {
    // There is no viewer argument at all. This test exists to make that deliberate.
    expect(conversationDisplayName.length).toBe(2);
  });
});

describe('stripConversationPrefix', () => {
  it('removes the author own prefix, so the stored title never contains it', () => {
    expect(stripConversationPrefix('ross — Meta ad', 'ross@fundd.com.au')).toBe('Meta ad');
  });

  it('removes it however many times it was pasted back in', () => {
    expect(stripConversationPrefix('ross — ross — ross — Meta ad', 'ross@fundd.com.au')).toBe(
      'Meta ad',
    );
  });

  it('is case-insensitive on the prefix', () => {
    expect(stripConversationPrefix('ROSS — Meta ad', 'ross@fundd.com.au')).toBe('Meta ad');
  });

  it('leaves a title that merely begins with some other word and a dash', () => {
    expect(stripConversationPrefix('Bank — offsets', 'ross@fundd.com.au')).toBe('Bank — offsets');
    expect(stripConversationPrefix('zoe — her thread', 'ross@fundd.com.au')).toBe(
      'zoe — her thread',
    );
  });

  it('leaves everything alone when the author cannot be resolved', () => {
    expect(stripConversationPrefix('ross — Meta ad', null)).toBe('ross — Meta ad');
  });

  it('empties a title that was nothing but the prefix, so the server can refuse it', () => {
    expect(stripConversationPrefix('ross — ', 'ross@fundd.com.au')).toBe('');
  });

  it('round-trips: displaying then renaming stores the name, never the prefix', () => {
    const email = 'rossb@fundd.com.au';
    const shown = conversationDisplayName('Refinance ads for October', email);
    expect(stripConversationPrefix(shown, email)).toBe('Refinance ads for October');
  });
});

describe('titleFromFirstMessage', () => {
  it('takes a first sentence that fits', () => {
    expect(titleFromFirstMessage('Write me a Meta ad about offset accounts. Keep it short.')).toBe(
      'Write me a Meta ad about offset accounts',
    );
  });

  it('collapses whitespace and keeps a short message whole', () => {
    expect(titleFromFirstMessage('  hey\n\n  there  ')).toBe('hey there');
  });

  it('cuts a long message on a word boundary, never mid-word', () => {
    const long =
      'I need a long piece of copy about refinancing for young couples in Perth who are ' +
      'currently renting and worried about rates going up again next year';
    const title = titleFromFirstMessage(long);
    expect(title).not.toBeNull();
    expect(title?.length).toBeLessThanOrEqual(CONVERSATION_TITLE_MAX_CHARS);
    expect(long.startsWith(title ?? '')).toBe(true);
    expect(title?.endsWith(' ')).toBe(false);
  });

  it('never leaves trailing punctuation from the clause it cut into', () => {
    const title = titleFromFirstMessage(`${'word '.repeat(30)}, and then more`);
    expect(title).not.toMatch(/[\s.,;:!?-]$/);
  });

  it('is null when there is nothing usable, so the conversation stays honestly untitled', () => {
    for (const value of ['', '   ', '...', '!!!']) {
      expect(titleFromFirstMessage(value)).toBeNull();
    }
  });

  it('produces something that survives its own rename path', () => {
    const email = 'ross@fundd.com.au';
    const title = titleFromFirstMessage('Draft a carousel about first home buyer grants.');
    expect(title).toBe('Draft a carousel about first home buyer grants');
    // Auto-titled, then displayed, then edited: still no prefix in what would be stored.
    expect(stripConversationPrefix(conversationDisplayName(title, email), email)).toBe(title);
  });
});

describe('the separator', () => {
  it('is an em dash with spaces — an attribution, not a label', () => {
    expect(CONVERSATION_PREFIX_SEPARATOR).toBe(' — ');
  });
});
