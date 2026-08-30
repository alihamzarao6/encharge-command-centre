/**
 * Who may remove something from memory (src/lib/memory/access.ts) — the one rule the
 * browser and the Edge Function share, so this is the only place it is decided.
 * Part C item 5's authorisation half; the RLS half is tests/security/rls.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { FACT_VALUE_MAX_CHARS } from '../../../src/lib/memory/facts.js';
import {
  MEMORY_NOTE_MAX_INPUT_CHARS,
  MEMORY_NOTE_MAX_VALUE_CHARS,
  REMOVAL_DENIED_MESSAGE,
  canRemoveMemory,
  canRenameConversation,
  CONVERSATION_RENAME_DENIED_MESSAGE,
} from '../../../src/lib/memory/access.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

describe('canRemoveMemory', () => {
  it('the author may remove their own note, admin or not', () => {
    expect(canRemoveMemory({ authorId: ALICE }, { userId: ALICE, isAdmin: false })).toStrictEqual({
      allowed: true,
      because: 'author',
    });
    expect(canRemoveMemory({ authorId: ALICE }, { userId: ALICE, isAdmin: true })).toStrictEqual({
      allowed: true,
      because: 'author',
    });
  });

  it("an admin may remove anyone's", () => {
    expect(canRemoveMemory({ authorId: ALICE }, { userId: BOB, isAdmin: true })).toStrictEqual({
      allowed: true,
      because: 'admin',
    });
  });

  it("a non-admin may not remove someone else's — the shared brain is not one tap from empty", () => {
    expect(canRemoveMemory({ authorId: ALICE }, { userId: BOB, isAdmin: false })).toStrictEqual({
      allowed: false,
      because: 'not_author',
    });
  });

  it('says why in words a person can act on, not a code', () => {
    expect(REMOVAL_DENIED_MESSAGE).toBe(
      'Only the person who added this, or an administrator, can remove it.',
    );
  });
});

describe('limits shared with the browser', () => {
  it('the value limit MIRRORS the store, so the field cannot accept what the table refuses', () => {
    expect(MEMORY_NOTE_MAX_VALUE_CHARS).toBe(FACT_VALUE_MAX_CHARS);
  });

  it('what a person types to create a note is allowed to be longer than the stored note', () => {
    // They write a sentence; the extractor condenses it. A limit equal to the stored one
    // would refuse perfectly reasonable phrasing before anything had a chance to shorten it.
    expect(MEMORY_NOTE_MAX_INPUT_CHARS).toBeGreaterThan(MEMORY_NOTE_MAX_VALUE_CHARS);
  });
});

describe('canRenameConversation (D75)', () => {
  const AUTHOR = { userId: 'a-1', isAdmin: false };
  const OTHER = { userId: 'b-2', isAdmin: false };
  const ADMIN = { userId: 'c-3', isAdmin: true };
  const OWNED = { authorId: AUTHOR.userId };

  it('the author may rename their own conversation', () => {
    expect(canRenameConversation(OWNED, AUTHOR)).toStrictEqual({
      allowed: true,
      because: 'author',
    });
  });

  it('a colleague may not — a name is how its author finds their own thread', () => {
    expect(canRenameConversation(OWNED, OTHER)).toStrictEqual({
      allowed: false,
      because: 'not_author',
    });
  });

  it('AN ADMIN MAY NOT EITHER, and that is the one place it differs from removing', () => {
    // Deleting is a removal an admin may need to make on the workspace's behalf. Renaming
    // somebody else's conversation is never something the business needs an admin to do.
    expect(canRemoveMemory(OWNED, ADMIN).allowed).toBe(true);
    expect(canRenameConversation(OWNED, ADMIN)).toStrictEqual({
      allowed: false,
      because: 'not_author',
    });
  });

  it('the refusal is a sentence, and it does not blame an administrator for being one', () => {
    expect(CONVERSATION_RENAME_DENIED_MESSAGE).toContain('the person who started');
    expect(CONVERSATION_RENAME_DENIED_MESSAGE).not.toContain('administrator');
  });
});
