/**
 * The conversations list's pure half (web/src/lib/conversationsView.ts) and the two new
 * requests the browser can send about a conversation (rename, delete).
 *
 * The confirm sentence is tested as a promise, not as a string: every clause in it names
 * something the delete actually does to a different table, and the migration that does it is
 * read here so the two cannot drift apart without a failing test.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_FILTER_THRESHOLD,
  DELETE_CONVERSATION_CONFIRM,
  MAKE_PRIVATE_CONFIRM,
  MAKE_SHARED_CONFIRM,
  PRIVACY_EXPLANATION,
  UNTITLED_CONVERSATION,
  buildConversationList,
  filterConversations,
  formatWhen,
  type ConversationListRow,
} from '../../../web/src/lib/conversationsView.js';
import { interpretMemoryResponse } from '../../../web/src/lib/memoryApi.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ZOE = '22222222-2222-4222-8222-222222222222';
const CONV = 'c0000000-0000-4000-8000-000000000001';

/** The roster the page reads under the policy part 4 widened (D56). */
const EMAILS = new Map([
  [USER, 'ross@fundd.com.au'],
  [ZOE, 'zoe@fundd.com.au'],
]);

function conversation(overrides: Partial<ConversationListRow> = {}): ConversationListRow {
  return {
    id: CONV,
    title: null,
    scope: 'workspace',
    user_id: USER,
    last_active_at: '2026-08-27T02:00:00Z',
    ...overrides,
  };
}

describe('formatWhen', () => {
  it('is Perth time, day and time — the two things that tell yesterday from last month', () => {
    expect(formatWhen('2026-08-27T02:00:00Z')).toBe('27 Aug, 10:00 am');
  });

  it('degrades to an empty string rather than showing "Invalid Date"', () => {
    expect(formatWhen('not-a-date')).toBe('');
  });
});

describe('buildConversationList', () => {
  it('names every row for its AUTHOR, whoever is looking', () => {
    const views = buildConversationList(
      [
        conversation({ id: 'a', title: 'Refinance ads for October' }),
        conversation({ id: 'b', title: 'Her thread', user_id: ZOE }),
      ],
      EMAILS,
    );
    expect(views.map((v) => v.displayName)).toStrictEqual([
      'ross — Refinance ads for October',
      'zoe — Her thread',
    ]);
    // The raw title is kept, because that — and only that — is what a rename edits.
    expect(views[0]?.title).toBe('Refinance ads for October');
    expect(views[0]?.prefix).toBe('ross');
  });

  it('names an unnamed conversation without losing whose it is', () => {
    const views = buildConversationList([conversation({ title: null })], EMAILS);
    expect(views[0]?.displayName).toBe(`ross — ${UNTITLED_CONVERSATION}`);
    expect(views[0]?.title).toBeNull();
  });

  it('degrades to a bare name when the author is not on the roster', () => {
    const views = buildConversationList([conversation({ title: 'Orphan' })], new Map());
    expect(views[0]?.displayName).toBe('Orphan');
    expect(views[0]?.prefix).toBeNull();
  });

  it('keeps a deactivated colleague named — their row is still readable', () => {
    // The roster policy returns every row regardless of is_active, so a conversation started
    // by someone who has since left is still attributed rather than going anonymous.
    const views = buildConversationList(
      [conversation({ user_id: ZOE, title: 'Old work' })],
      EMAILS,
    );
    expect(views[0]?.displayName).toBe('zoe — Old work');
  });
});

describe('filterConversations', () => {
  function views(rows: readonly ConversationListRow[]) {
    return buildConversationList(rows, EMAILS);
  }

  it('matches part of a name, case-insensitively, and ignores surrounding spaces', () => {
    const list = views([
      conversation({ id: 'a', title: 'Refinance ads for October' }),
      conversation({ id: 'b', title: 'First home buyer carousel' }),
      conversation({ id: 'c', title: null }),
    ]);
    expect(filterConversations(list, '  OCTOBER ').map((c) => c.id)).toStrictEqual(['a']);
  });

  it('matches the AUTHOR too, which is the first thing anyone tries on a long list', () => {
    const list = views([
      conversation({ id: 'a', title: 'Refinance ads' }),
      conversation({ id: 'b', title: 'Her thread', user_id: ZOE }),
    ]);
    expect(filterConversations(list, 'zoe').map((c) => c.id)).toStrictEqual(['b']);
    expect(filterConversations(list, 'ross').map((c) => c.id)).toStrictEqual(['a']);
  });

  it('an empty query is not a filter — the whole list comes back', () => {
    const list = views([conversation({ id: 'a' }), conversation({ id: 'b' })]);
    expect(filterConversations(list, '   ')).toStrictEqual(list);
  });

  it('an unnamed conversation is still found by its author', () => {
    const list = views([conversation({ title: null })]);
    expect(filterConversations(list, 'nothing-like-this')).toStrictEqual([]);
    expect(filterConversations(list, 'ross')).toHaveLength(1);
  });

  it('the filter appears before scanning becomes hopeless, not after', () => {
    expect(CONVERSATION_FILTER_THRESHOLD).toBeLessThanOrEqual(12);
    expect(CONVERSATION_FILTER_THRESHOLD).toBeGreaterThan(4);
  });
});

describe('the delete confirm', () => {
  it('states all three outcomes: messages gone, conversation notes gone, standing notes kept', () => {
    expect(DELETE_CONVERSATION_CONFIRM).toContain('messages');
    expect(DELETE_CONVERSATION_CONFIRM).toContain('cannot be brought back');
    expect(DELETE_CONVERSATION_CONFIRM).toContain('notes the assistant wrote');
    expect(DELETE_CONVERSATION_CONFIRM).toContain('kept');
    expect(DELETE_CONVERSATION_CONFIRM).toContain('Memory page');
  });

  it('says what the migration does — the promise and the transaction are checked together', async () => {
    const sql = await readFile('supabase/migrations/20260828010000_users_page.sql', 'utf8');
    // Messages: a hard delete, so "cannot be brought back" is true.
    expect(sql).toContain('delete from public.messages');
    // Conversation notes: tombstoned, so "and so are the notes the assistant wrote" is true.
    expect(sql).toContain('update public.memory_chunks');
    // Standing notes: only their source pointer is cleared, so "are kept" is true.
    expect(sql).toContain('set source_message_id = null');
    expect(sql).not.toContain('delete from public.memory_facts');
  });
});

describe('the two conversation replies the browser reads', () => {
  it('reads a rename, including the no-op the server reports as unchanged', () => {
    for (const outcome of ['renamed', 'unchanged'] as const) {
      const result = interpretMemoryResponse(200, {
        action: 'rename_conversation',
        outcome,
        conversationId: CONV,
        title: 'October ads',
      });
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') continue;
      expect(result.reply).toStrictEqual({
        action: 'rename_conversation',
        outcome,
        conversationId: CONV,
        title: 'October ads',
      });
    }
  });

  it('reads a delete with the counts it actually removed', () => {
    const result = interpretMemoryResponse(200, {
      action: 'delete_conversation',
      outcome: 'deleted',
      conversationId: CONV,
      messagesDeleted: 24,
      chunksTombstoned: 2,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok' || result.reply.action !== 'delete_conversation') return;
    expect(result.reply.messagesDeleted).toBe(24);
  });

  it('a delete reply missing its counts is not accepted as a success', () => {
    const result = interpretMemoryResponse(200, {
      action: 'delete_conversation',
      outcome: 'deleted',
      conversationId: CONV,
    });
    expect(result.kind).toBe('error');
  });

  it('a 403 on a delete shows the server sentence, so "whose is it" is answered once', () => {
    const result = interpretMemoryResponse(403, {
      error: {
        code: 'NOT_YOURS',
        message:
          'Only the person who started this conversation, or an administrator, can delete it.',
        retryable: false,
      },
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.failure).toBe('notYours');
    expect(result.message).toContain('started this conversation');
  });

  it('a 404 tells the page it is showing something that is no longer there', () => {
    const result = interpretMemoryResponse(404, {
      error: { code: 'NOT_FOUND', message: 'gone', retryable: false },
    });
    expect(result.kind === 'error' && result.failure).toBe('stale');
  });
});

describe('privacy on the list (Stage 3 part 5, R27)', () => {
  it('a workspace row is not private and a user-scoped row is', () => {
    const views = buildConversationList(
      [conversation({ id: 'shared' }), conversation({ id: 'mine', scope: 'user' })],
      EMAILS,
    );
    expect(views.map((v) => v.isPrivate)).toStrictEqual([false, true]);
  });

  it('a private row still carries its author prefix, so the list reads the same way throughout', () => {
    const [view] = buildConversationList(
      [conversation({ scope: 'user', title: 'Something personal' })],
      EMAILS,
    );
    expect(view?.displayName).toBe('ross — Something personal');
    expect(view?.isPrivate).toBe(true);
  });

  it('the confirm before going private carries the whole sentence, both halves', () => {
    expect(MAKE_PRIVATE_CONFIRM).toContain('Make this conversation just yours?');
    expect(MAKE_PRIVATE_CONFIRM).toContain(PRIVACY_EXPLANATION);
    // The half nobody would guess, and the reason this test exists.
    expect(MAKE_PRIVATE_CONFIRM).toContain('still shared');
  });

  it('the confirm before sharing again says what becomes visible, including the past', () => {
    expect(MAKE_SHARED_CONFIRM).toContain('Everyone will be able to open it');
    expect(MAKE_SHARED_CONFIRM).toContain('while it was private');
  });

  it('reads a privacy reply, including the no-op', () => {
    for (const outcome of ['changed', 'unchanged'] as const) {
      const result = interpretMemoryResponse(200, {
        action: 'set_conversation_privacy',
        outcome,
        conversationId: CONV,
        isPrivate: true,
      });
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') continue;
      expect(result.reply).toStrictEqual({
        action: 'set_conversation_privacy',
        outcome,
        conversationId: CONV,
        isPrivate: true,
      });
    }
  });

  it('a privacy reply that does not say which way it went is not a success', () => {
    const result = interpretMemoryResponse(200, {
      action: 'set_conversation_privacy',
      outcome: 'changed',
      conversationId: CONV,
    });
    expect(result.kind).toBe('error');
  });

  it('reads the admin listing, and tolerates an author whose email is unknown', () => {
    const result = interpretMemoryResponse(200, {
      action: 'admin_list_private',
      outcome: 'listed',
      conversations: [
        {
          id: CONV,
          authorId: ZOE,
          authorEmail: null,
          createdAt: '2026-08-28T01:00:00Z',
          lastActiveAt: '2026-08-29T01:00:00Z',
        },
      ],
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok' || result.reply.action !== 'admin_list_private') return;
    expect(result.reply.conversations[0]?.authorEmail).toBeNull();
    expect(result.reply.conversations[0]?.authorId).toBe(ZOE);
  });

  it('reads an admin read, and refuses one whose messages are malformed', () => {
    const good = interpretMemoryResponse(200, {
      action: 'admin_read_conversation',
      outcome: 'read',
      conversationId: CONV,
      title: 'Her thread',
      authorEmail: 'zoe@fundd.com.au',
      messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: '2026-08-28T01:00:00Z' }],
    });
    expect(good.kind).toBe('ok');
    if (good.kind === 'ok' && good.reply.action === 'admin_read_conversation') {
      expect(good.reply.messages).toHaveLength(1);
    }

    const bad = interpretMemoryResponse(200, {
      action: 'admin_read_conversation',
      outcome: 'read',
      conversationId: CONV,
      title: 'Her thread',
      authorEmail: 'zoe@fundd.com.au',
      messages: [{ id: 'm1', role: 'system', content: 'hello', createdAt: 'x' }],
    });
    expect(bad.kind).toBe('error');
  });

  it('a 403 from the admin actions shows the account is not allowed, not "not yours"', () => {
    const result = interpretMemoryResponse(403, {
      error: { code: 'NOT_ADMIN', message: 'Only an administrator can do that.', retryable: false },
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.failure).toBe('forbidden');
  });
});
