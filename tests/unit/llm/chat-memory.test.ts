/**
 * The memory seam in one chat turn (src/lib/llm/chat.ts, Stage 3 part 1) — Part C item 8:
 * the hook runs after the turn is saved, off the reply's path, and NOTHING it does or fails
 * to do changes the answer. Also: what the hook receives, and that `waitUntil` gets a
 * promise that never rejects.
 */
import { describe, expect, it } from 'vitest';

import type { AuthTokenUser, StaffRow, VerifyDeps } from '../../../src/lib/auth/verify.js';
import { ok, type Result } from '../../../src/lib/errors.js';
import {
  handleChatTurn,
  handleChatTurnStream,
  type ChatDeps,
  type ChatStreamEvent,
  type ConversationRow,
  type ConversationStore,
  type TurnSavedEvent,
} from '../../../src/lib/llm/chat.js';
import type { ClaudeClient, Completion } from '../../../src/lib/llm/client.js';
import { capturingLogger } from './helpers.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONV_ID = 'c0000000-0000-4000-8000-000000000001';

const verify: VerifyDeps = {
  getUserFromToken: (): Promise<Result<AuthTokenUser | null>> =>
    Promise.resolve(ok({ id: USER_ID, email: 'x@y.com' })),
  getStaffRow: (): Promise<Result<StaffRow | null>> =>
    Promise.resolve(
      ok({ user_id: USER_ID, email: 'x@y.com', role: 'staff', is_active: true, is_admin: false }),
    ),
};

const COMPLETION: Completion = {
  text: 'a reply',
  model: 'claude-sonnet-5',
  stopReason: 'end_turn',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0.0006,
  requestId: 'req_1',
  attempts: 1,
};

const claude: ClaudeClient = { complete: () => Promise.resolve(ok(COMPLETION)) };

const ROW: ConversationRow = {
  id: CONV_ID,
  userId: USER_ID,
  scope: 'user',
  title: 't',
  deletedAt: null,
};

function store(appendOk = true): ConversationStore & { appended: number } {
  const s = {
    appended: 0,
    get: () => Promise.resolve(ok(ROW)),
    create: () => Promise.resolve(ok(ROW)),
    recentMessages: () => Promise.resolve(ok([])),
    appendTurn: () => {
      s.appended += 1;
      return Promise.resolve(
        appendOk
          ? ok({ userMessageId: 'm-user', assistantMessageId: 'm-assistant' })
          : { ok: false as const, error: new (class extends Error {})('nope') as never },
      );
    },
  };
  return s;
}

function deps(overrides: Partial<ChatDeps>): ChatDeps & { lines: string[] } {
  const { log, lines } = capturingLogger();
  return { verify, claude, conversations: store(), log, lines, ...overrides };
}

describe('afterTurn — Part C item 8', () => {
  it('receives the saved turn with ids and the conversation scope, after appendTurn', async () => {
    const events: TurnSavedEvent[] = [];
    const scheduled: Promise<void>[] = [];
    const d = deps({
      afterTurn: (event) => {
        events.push(event);
        return Promise.resolve();
      },
      waitUntil: (work) => {
        scheduled.push(work);
      },
    });
    const result = await handleChatTurn(d, { token: 't', message: 'hi', conversationId: CONV_ID });
    expect(result.status).toBe(200);
    expect(events).toEqual([
      {
        conversation: { id: CONV_ID, userId: USER_ID, scope: 'user', title: 't' },
        userMessageId: 'm-user',
        assistantMessageId: 'm-assistant',
        messagesAppended: 2,
      },
    ]);
    expect(scheduled).toHaveLength(1);
    await expect(scheduled[0]).resolves.toBeUndefined();
  });

  it('a hook that rejects changes nothing about the 200, and the rejection is logged', async () => {
    const scheduled: Promise<void>[] = [];
    const d = deps({
      afterTurn: () => Promise.reject(new Error('voyage exploded')),
      waitUntil: (work) => {
        scheduled.push(work);
      },
    });
    const result = await handleChatTurn(d, { token: 't', message: 'hi' });
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.reply).toBe('a reply');
    await expect(scheduled[0]).resolves.toBeUndefined();
    expect(d.lines.some((l) => l.includes('afterTurn hook rejected'))).toBe(true);
  });

  it('a hook that throws synchronously changes nothing about the 200', async () => {
    const d = deps({
      afterTurn: () => {
        throw new Error('sync boom');
      },
    });
    const result = await handleChatTurn(d, { token: 't', message: 'hi' });
    expect(result.status).toBe(200);
    expect(d.lines.some((l) => l.includes('afterTurn hook threw'))).toBe(true);
  });

  it('a slow hook does not delay the reply', async () => {
    let release: () => void = () => undefined;
    const d = deps({
      afterTurn: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const result = await handleChatTurn(d, { token: 't', message: 'hi' });
    expect(result.status).toBe(200);
    release();
  });

  it('without waitUntil the hook still runs (Node keeps the promise alive)', async () => {
    let ran = false;
    const d = deps({
      afterTurn: () => {
        ran = true;
        return Promise.resolve();
      },
    });
    await handleChatTurn(d, { token: 't', message: 'hi' });
    expect(ran).toBe(true);
  });

  it('is not called when the turn was not saved', async () => {
    let calls = 0;
    const d = deps({
      conversations: store(false),
      afterTurn: () => {
        calls += 1;
        return Promise.resolve();
      },
    });
    const result = await handleChatTurn(d, { token: 't', message: 'hi' });
    expect(result.status).toBe(503);
    expect(calls).toBe(0);
  });

  it('runs on the streaming path too, after done', async () => {
    const events: ChatStreamEvent['type'][] = [];
    let hookAt: number | null = null;
    const d = deps({
      afterTurn: () => {
        hookAt = events.length;
        return Promise.resolve();
      },
    });
    await handleChatTurnStream(d, { token: 't', message: 'hi' }, (e) => {
      events.push(e.type);
    });
    expect(events).toEqual(['start', 'delta', 'done']);
    // Scheduled once the turn is saved: before `done` is emitted, and never awaited.
    expect(hookAt).toBe(2);
  });
});
