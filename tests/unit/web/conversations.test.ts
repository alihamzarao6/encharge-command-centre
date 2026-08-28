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
  UNTITLED_CONVERSATION,
  filterConversations,
  formatWhen,
  type ConversationListRow,
} from '../../../web/src/lib/conversationsView.js';
import { interpretMemoryResponse } from '../../../web/src/lib/memoryApi.js';

const USER = '11111111-1111-4111-8111-111111111111';
const CONV = 'c0000000-0000-4000-8000-000000000001';

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

describe('filterConversations', () => {
  it('matches part of a name, case-insensitively, and ignores surrounding spaces', () => {
    const rows = [
      conversation({ id: 'a', title: 'Refinance ads for October' }),
      conversation({ id: 'b', title: 'First home buyer carousel' }),
      conversation({ id: 'c', title: null }),
    ];
    expect(filterConversations(rows, '  OCTOBER ').map((c) => c.id)).toStrictEqual(['a']);
    expect(filterConversations(rows, 'r').map((c) => c.id)).toStrictEqual(['a', 'b']);
  });

  it('an empty query is not a filter — the whole list comes back, same array contents', () => {
    const rows = [conversation({ id: 'a' }), conversation({ id: 'b' })];
    expect(filterConversations(rows, '   ')).toStrictEqual(rows);
  });

  it('an unnamed conversation matches nothing, which is why the empty state says so', () => {
    expect(filterConversations([conversation()], 'anything')).toStrictEqual([]);
    expect(UNTITLED_CONVERSATION).toBe('Untitled conversation');
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
