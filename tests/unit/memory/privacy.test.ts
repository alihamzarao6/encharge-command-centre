/**
 * The privacy rules and the words that describe them (Stage 3 part 5, R27).
 *
 * Two kinds of assertion here, and the second is the one that matters.
 *
 * The first is the ordinary kind: `canSetConversationPrivacy` is the author's alone, and it
 * is NOT `canRemoveMemory` — a difference that is easy to lose in a refactor and expensive
 * to lose in production, so it is asserted directly against the other function.
 *
 * The second treats PRIVACY_EXPLANATION as a PROMISE, exactly as
 * `tests/unit/web/conversations.test.ts` treats the delete confirm. The sentence makes four
 * claims about four different mechanisms; each is checked against the migration or the code
 * that has to be true for the claim to be honest. If someone later changes the chunk trigger
 * back, or lets a fact inherit a private conversation's scope, this file fails and the
 * client is not told something untrue at the moment he taps.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { canRemoveMemory } from '../../../src/lib/memory/access.js';
import {
  ADMIN_ONLY_MESSAGE,
  ADMIN_PRIVATE_SECTION,
  CHUNK_PRIVATE_SOURCE,
  DEFAULT_CONVERSATION_SCOPE,
  isPrivateScope,
  PRIVACY_DENIED_MESSAGE,
  PRIVACY_EXPLANATION,
  PRIVACY_NOTICE,
  PRIVACY_STATE_LABEL,
  PRIVACY_TOGGLE_LABEL,
  SHARED_EXPLANATION,
  SHARED_MEMORY_SCOPE,
  canSetConversationPrivacy,
} from '../../../src/lib/memory/privacy.js';

const AUTHOR = { userId: 'a1111111-1111-4111-8111-111111111111', isAdmin: false };
const ADMIN = { userId: 'b2222222-2222-4222-8222-222222222222', isAdmin: true };
const OTHER = { userId: 'c3333333-3333-4333-8333-333333333333', isAdmin: false };
const OWNED = { authorId: AUTHOR.userId };

const MIGRATION = 'supabase/migrations/20260829010000_private_conversations.sql';

describe('who may change who sees a conversation', () => {
  it('the author may', () => {
    expect(canSetConversationPrivacy(OWNED, AUTHOR)).toStrictEqual({ allowed: true });
  });

  it('another member may not', () => {
    expect(canSetConversationPrivacy(OWNED, OTHER)).toStrictEqual({
      allowed: false,
      because: 'not_author',
    });
  });

  it('AN ADMIN MAY NOT — the one place admin is deliberately not the wider power', () => {
    // The contrast is the assertion: the same actor, the same row, opposite answers. An
    // admin may delete this conversation outright; they may not publish it to the team.
    expect(canRemoveMemory(OWNED, ADMIN).allowed).toBe(true);
    expect(canSetConversationPrivacy(OWNED, ADMIN)).toStrictEqual({
      allowed: false,
      because: 'not_author',
    });
  });

  it('an admin who is also the author may, because they are the author', () => {
    expect(canSetConversationPrivacy({ authorId: ADMIN.userId }, ADMIN)).toStrictEqual({
      allowed: true,
    });
  });
});

describe('the resting state', () => {
  it('is workspace — private is the exception, never the default', () => {
    expect(DEFAULT_CONVERSATION_SCOPE).toBe('workspace');
    expect(SHARED_MEMORY_SCOPE).toBe('workspace');
  });

  it("reads a conversation's scope the same way the database stores it", () => {
    expect(isPrivateScope('user')).toBe(true);
    expect(isPrivateScope('workspace')).toBe(false);
    // Anything else is not private: a value outside the check constraint must never fail
    // OPEN into "this is private", because a caller would then trust a promise nothing keeps.
    expect(isPrivateScope('')).toBe(false);
  });
});

describe('PRIVACY_EXPLANATION is a promise about four mechanisms', () => {
  it('claims the messages are the author’s and an administrator’s only', () => {
    expect(PRIVACY_EXPLANATION).toContain('Only you and an administrator');
    expect(PRIVACY_EXPLANATION).toContain('read what is said in it');
  });

  it('claims — in the same breath — that what it LEARNS is still shared', () => {
    expect(PRIVACY_EXPLANATION).toContain('still shared');
    expect(PRIVACY_EXPLANATION).toContain('the short note it writes');
    expect(PRIVACY_EXPLANATION).toContain('anything you ask it to remember');
    expect(PRIVACY_EXPLANATION).toContain('the whole team');
  });

  it('claim 1 is true of MESSAGES: the cascade still carries scope to them', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    // The messages half of the cascade is untouched — both columns still move.
    expect(sql).toContain(
      'update public.messages\n    set user_id = new.user_id, scope = new.scope',
    );
    // And the original per-row trigger, which copies the parent's scope, is not replaced.
    expect(sql).not.toContain('drop trigger messages_sync_ownership');
  });

  it('claim 2 is true of CHUNKS: the trigger forces workspace and a constraint backs it', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    expect(sql).toContain('create or replace function public.sync_chunk_ownership()');
    expect(sql).toContain("new.scope := 'workspace';");
    expect(sql).toContain(
      "add constraint memory_chunks_scope_workspace check (scope = 'workspace')",
    );
    // The cascade must no longer carry scope to chunks, or a flip would undo the above.
    expect(sql).toContain('update public.memory_chunks\n    set user_id = new.user_id');
  });

  it('claim 3 is true of FACTS: the turn writes them at the shared scope, not the conversation’s', async () => {
    const chat = await readFile('src/lib/llm/chat.ts', 'utf8');
    // The bug this replaced: the recall call passed the CONVERSATION's scope, which would
    // have made a private conversation's explicit notes private too — the option the client
    // did not choose. Asserted on the recall block specifically, because the summariser hook
    // below it legitimately still carries the conversation's own scope.
    const recallBlock = chat.slice(
      chat.indexOf('recall = await deps.memory.recall({'),
      chat.indexOf(
        '} catch (caught: unknown) {',
        chat.indexOf('recall = await deps.memory.recall({'),
      ),
    );
    expect(recallBlock).toContain('scope: SHARED_MEMORY_SCOPE');
    expect(recallBlock).not.toContain('scope: conversation.scope');
  });

  it('claim 3 is true of CHUNK WRITES too: the summariser states the shared scope', async () => {
    const trigger = await readFile('src/lib/memory/trigger.ts', 'utf8');
    const insert = trigger.slice(
      trigger.indexOf('deps.chunks.insertChunk({'),
      trigger.indexOf('});', trigger.indexOf('deps.chunks.insertChunk({')),
    );
    expect(insert).toContain('scope: SHARED_MEMORY_SCOPE');
    expect(insert).not.toContain('scope: conversation.scope');
  });

  it('claim 4 is true of ADMIN READS: they go through a path that writes an audit row', async () => {
    const page = await readFile('src/lib/memory/page.ts', 'utf8');
    expect(page).toContain("'CONVERSATION_ADMIN_READ'");
    const admin = await readFile('src/lib/auth/admin.ts', 'utf8');
    expect(admin).toContain("| 'CONVERSATION_ADMIN_READ'");
    // And the migration must NOT have widened the policy instead, which would have made the
    // audit row impossible.
    const sql = await readFile(MIGRATION, 'utf8');
    expect(sql).not.toContain('create policy');
    expect(sql).not.toContain('drop policy');
  });
});

describe('the rest of the words', () => {
  it('the shared state is stated too, so nobody has to infer the resting state', () => {
    expect(SHARED_EXPLANATION).toContain('Anyone on the team');
    expect(SHARED_EXPLANATION).toContain('normal setting');
  });

  it('the notice after a change repeats the half that is easy to forget', () => {
    expect(PRIVACY_NOTICE.nowPrivate).toContain('still shared');
    expect(PRIVACY_NOTICE.nowShared).toContain('visible to the team');
  });

  it('the toggle says what it will do, not what the state is', () => {
    expect(PRIVACY_TOGGLE_LABEL.makePrivate).toBe('Make it just mine');
    expect(PRIVACY_TOGGLE_LABEL.makeShared).toBe('Share with the team');
    expect(PRIVACY_STATE_LABEL.user).toBe('Just you');
  });

  it('the admin section explains why a list of conversations has no names in it', () => {
    expect(ADMIN_PRIVATE_SECTION.hint).toContain('recorded');
    expect(ADMIN_PRIVATE_SECTION.hint).toContain('Names are not shown');
  });

  it('the memory page says a note’s conversation is private, not that it was removed', () => {
    expect(CHUNK_PRIVATE_SOURCE.name).toBe('A private conversation');
    expect(CHUNK_PRIVATE_SOURCE.hint).toContain('shared with the team');
    expect(CHUNK_PRIVATE_SOURCE.hint).not.toContain('removed');
  });

  it('the two refusals are sentences a person can act on, not codes', () => {
    expect(PRIVACY_DENIED_MESSAGE).toContain('the person who started');
    expect(ADMIN_ONLY_MESSAGE).toContain('administrator');
  });
});

describe('the migration itself', () => {
  it('normalises existing rows BEFORE constraining them, so a stray row is not a deploy failure', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    const update = sql.indexOf('update public.memory_chunks\nset scope');
    const constraint = sql.indexOf('add constraint memory_chunks_scope_workspace');
    expect(update).toBeGreaterThan(-1);
    expect(constraint).toBeGreaterThan(update);
  });

  it('does not migrate any conversation to private — every existing one stays shared', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    expect(sql).not.toContain('update public.conversations');
  });

  it('carries its own reversal, like every other migration in this repo', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    expect(sql).toContain('Reversible:');
    expect(sql).toContain('drop constraint memory_chunks_scope_workspace');
    expect(sql).toContain('drop function public.sync_chunk_ownership()');
  });
});
