/**
 * One chat turn (src/lib/llm/chat.ts) — Part C items 6 and 7 (no spend on an
 * unauthenticated or deactivated caller) plus the response mapping the UI will render.
 */
import { describe, expect, it } from 'vitest';

import type { AuthTokenUser, StaffRow, VerifyDeps } from '../../../src/lib/auth/verify.js';
import {
  AppError,
  ConfigError,
  HttpStatusError,
  NetworkError,
  TimeoutError,
  ValidationError,
  err,
  ok,
  type Result,
} from '../../../src/lib/errors.js';
import {
  handleChatTurn,
  mapLlmError,
  type ChatDeps,
  type ConversationRow,
  type ConversationStore,
  type HistoryMessage,
  boundHistory,
  handleChatTurnStream,
  type ChatStreamEvent,
} from '../../../src/lib/llm/chat.js';
import type {
  ClaudeClient,
  Completion,
  CompletionRequest,
  LlmError,
} from '../../../src/lib/llm/client.js';
import { ModelRefusalError, RateLimitedError, SpendCapError } from '../../../src/lib/llm/errors.js';
import { VOICE_PROMPT_VERSION } from '../../../src/lib/voice/prompt.js';
import { capturingLogger, infraError } from './helpers.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const CONV_ID = 'c0000000-0000-4000-8000-000000000001';

function verifyDeps(spec: {
  user?: Result<AuthTokenUser | null>;
  row?: Result<StaffRow | null>;
}): VerifyDeps {
  return {
    getUserFromToken: () => Promise.resolve(spec.user ?? ok({ id: USER_ID, email: 'x@y.com' })),
    getStaffRow: () =>
      Promise.resolve(
        spec.row ??
          ok({
            user_id: USER_ID,
            email: 'x@y.com',
            role: 'staff',
            is_active: true,
            is_admin: false,
          }),
      ),
  };
}

const COMPLETION: Completion = {
  text: 'a reply',
  model: 'claude-sonnet-5',
  stopReason: 'end_turn',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0.0006,
  requestId: 'req_1',
  attempts: 1,
};

function fakeClaude(
  outcome: Result<Completion, LlmError> = ok(COMPLETION),
): ClaudeClient & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    calls,
    complete: (request) => {
      calls.push(request);
      return Promise.resolve(outcome);
    },
  };
}

interface FakeStore extends ConversationStore {
  /** Every create, with the auto-title the chat path derived for it (part 4a). */
  readonly created: { userId: string; title: string | null }[];
  readonly appended: unknown[];
  readonly historyReads: { conversationId: string; limit: number }[];
  existing: ConversationRow | null;
  history: HistoryMessage[];
  failCreate: AppError | null;
  failGet: AppError | null;
  failHistory: AppError | null;
  failAppend: AppError | null;
}

function fakeStore(existing: ConversationRow | null = null): FakeStore {
  const store: FakeStore = {
    created: [],
    appended: [],
    historyReads: [],
    existing,
    history: [],
    failCreate: null,
    failGet: null,
    failHistory: null,
    failAppend: null,
    get: () => Promise.resolve(store.failGet === null ? ok(store.existing) : err(store.failGet)),
    create: (userId, title) => {
      store.created.push({ userId, title });
      return Promise.resolve(
        store.failCreate === null
          ? ok({ id: CONV_ID, userId, scope: 'workspace' as const, title, deletedAt: null })
          : err(store.failCreate),
      );
    },
    recentMessages: (conversationId, limit) => {
      store.historyReads.push({ conversationId, limit });
      return Promise.resolve(
        store.failHistory === null ? ok(store.history.slice(-limit)) : err(store.failHistory),
      );
    },
    appendTurn: (input) => {
      store.appended.push(input);
      return Promise.resolve(
        store.failAppend === null
          ? ok({ userMessageId: 'm-user', assistantMessageId: 'm-assistant' })
          : err(store.failAppend),
      );
    },
  };
  return store;
}

function deps(overrides: Partial<ChatDeps> = {}): ChatDeps & {
  claude: ReturnType<typeof fakeClaude>;
  conversations: FakeStore;
} {
  const { log } = capturingLogger();
  return {
    verify: verifyDeps({}),
    claude: fakeClaude(),
    conversations: fakeStore(),
    log,
    ...overrides,
  } as ChatDeps & { claude: ReturnType<typeof fakeClaude>; conversations: FakeStore };
}

describe('who may spend — Part C items 6 and 7', () => {
  it('no token → 401, Claude never called, nothing written', async () => {
    const d = deps();
    const result = await handleChatTurn(d, { token: null, message: 'hi' });
    expect(result.status).toBe(401);
    expect(d.claude.calls).toHaveLength(0);
    expect(d.conversations.created).toHaveLength(0);
  });

  it('invalid / expired token → 401, Claude never called', async () => {
    const d = deps({ verify: verifyDeps({ user: ok(null) }) });
    const result = await handleChatTurn(d, { token: 'stale', message: 'hi' });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', retryable: false },
    });
    expect(d.claude.calls).toHaveLength(0);
  });

  it('a real auth user not on the allowlist → 403, Claude never called', async () => {
    const d = deps({ verify: verifyDeps({ row: ok(null) }) });
    const result = await handleChatTurn(d, { token: 't', message: 'hi' });
    expect(result.status).toBe(403);
    expect(d.claude.calls).toHaveLength(0);
  });

  it('a deactivated user → 403, Claude never called, nothing written', async () => {
    const d = deps({
      verify: verifyDeps({
        row: ok({
          user_id: USER_ID,
          email: 'x@y.com',
          role: 'staff',
          is_active: false,
          is_admin: false,
        }),
      }),
    });
    const result = await handleChatTurn(d, { token: 't', message: 'hi' });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(d.claude.calls).toHaveLength(0);
    expect(d.conversations.created).toHaveLength(0);
  });

  it('auth infrastructure failure → 503 (never a 403), Claude never called', async () => {
    const d = deps({ verify: verifyDeps({ user: err(new NetworkError('gotrue down')) }) });
    const result = await handleChatTurn(d, { token: 't', message: 'hi' });
    expect(result.status).toBe(503);
    expect(d.claude.calls).toHaveLength(0);
  });
});

describe('input', () => {
  it.each([undefined, null, '', '   ', 42, {}])('rejects message %j with 400', async (message) => {
    const d = deps();
    const result = await handleChatTurn(d, { token: 't', message });
    expect(result.status).toBe(400);
    expect(d.claude.calls).toHaveLength(0);
  });

  it('rejects a message over the limit with 400', async () => {
    const d = deps({ maxMessageChars: 10 });
    const result = await handleChatTurn(d, { token: 't', message: 'x'.repeat(11) });
    expect(result.status).toBe(400);
  });

  it('rejects a non-UUID conversationId with 400', async () => {
    const d = deps();
    const result = await handleChatTurn(d, { token: 't', message: 'hi', conversationId: 'abc' });
    expect(result.status).toBe(400);
    expect(d.claude.calls).toHaveLength(0);
  });
});

describe('the turn', () => {
  it('auto-titles a new conversation from the first message, and never re-titles later', async () => {
    const d = deps();
    await handleChatTurn(d, {
      token: 't',
      message: 'Write me a Meta ad about offset accounts. Keep it punchy.',
    });
    expect(d.conversations.created).toEqual([
      { userId: USER_ID, title: 'Write me a Meta ad about offset accounts' },
    ]);

    // A second turn on an EXISTING conversation creates nothing and re-titles nothing: a
    // person's rename must never be overwritten by a later message.
    const d2 = deps({
      conversations: fakeStore({
        id: CONV_ID,
        userId: USER_ID,
        scope: 'workspace',
        title: 'Named by hand',
        deletedAt: null,
      }),
    });
    await handleChatTurn(d2, {
      token: 't',
      message: 'and now something else',
      conversationId: CONV_ID,
    });
    expect(d2.conversations.created).toHaveLength(0);
  });

  it('leaves a conversation untitled when the first message yields no usable name', async () => {
    const d = deps();
    await handleChatTurn(d, { token: 't', message: '...' });
    expect(d.conversations.created).toEqual([{ userId: USER_ID, title: null }]);
  });

  it('creates a conversation for the caller, calls Claude with the voice prompt cached, saves both turns, returns 200', async () => {
    const d = deps();
    const result = await handleChatTurn(d, { token: 't', message: 'hello' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      conversationId: CONV_ID,
      userMessageId: 'm-user',
      assistantMessageId: 'm-assistant',
      reply: 'a reply',
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: COMPLETION.usage,
      costUsd: 0.0006,
    });
    // Part 4a: a new conversation is named from the first thing he said, so the list is not
    // forty rows of "Untitled conversation" before anyone renames anything.
    expect(d.conversations.created).toEqual([{ userId: USER_ID, title: 'hello' }]);
    const call = d.claude.calls[0];
    expect(call?.userId).toBe(USER_ID);
    expect(call?.conversationId).toBe(CONV_ID);
    expect(call?.operation).toBe('chat.turn');
    expect(call?.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(call?.system[0]?.text).toContain(`v${VOICE_PROMPT_VERSION}`);
    expect(call?.system[0]?.cache).toBe(true);
    expect(d.conversations.appended).toEqual([
      {
        conversation: {
          id: CONV_ID,
          userId: USER_ID,
          scope: 'workspace',
          // Auto-titled from this very message on create (part 4a).
          title: 'hello',
          deletedAt: null,
        },
        userContent: 'hello',
        assistant: {
          content: 'a reply',
          model: 'claude-sonnet-5',
          inputTokens: 100,
          outputTokens: 20,
        },
      },
    ]);
  });

  it('continues a workspace conversation started by someone else', async () => {
    const d = deps({
      conversations: fakeStore({
        id: CONV_ID,
        userId: OTHER_ID,
        scope: 'workspace',
        title: null,
        deletedAt: null,
      }),
    });
    const result = await handleChatTurn(d, { token: 't', message: 'hi', conversationId: CONV_ID });
    expect(result.status).toBe(200);
    expect(d.conversations.created).toHaveLength(0);
  });

  it.each([
    [
      "another user's private conversation",
      { id: CONV_ID, userId: OTHER_ID, scope: 'user' as const, title: null, deletedAt: null },
    ],
    [
      'a deleted conversation',
      {
        id: CONV_ID,
        userId: USER_ID,
        scope: 'workspace' as const,
        title: null,
        deletedAt: '2026-08-01T00:00:00Z',
      },
    ],
    ['a missing conversation', null],
  ])('%s → 404 and no Claude call', async (_label, row) => {
    const d = deps({ conversations: fakeStore(row) });
    const result = await handleChatTurn(d, { token: 't', message: 'hi', conversationId: CONV_ID });
    expect(result.status).toBe(404);
    expect(d.claude.calls).toHaveLength(0);
  });

  it('own private conversation is fine', async () => {
    const d = deps({
      conversations: fakeStore({
        id: CONV_ID,
        userId: USER_ID,
        scope: 'user',
        title: null,
        deletedAt: null,
      }),
    });
    const result = await handleChatTurn(d, { token: 't', message: 'hi', conversationId: CONV_ID });
    expect(result.status).toBe(200);
  });

  it('conversation create / read failures → 503', async () => {
    const d1 = deps();
    d1.conversations.failCreate = infraError();
    expect((await handleChatTurn(d1, { token: 't', message: 'hi' })).status).toBe(503);
    const d2 = deps();
    d2.conversations.failGet = infraError();
    expect(
      (await handleChatTurn(d2, { token: 't', message: 'hi', conversationId: CONV_ID })).status,
    ).toBe(503);
    expect(d1.claude.calls).toHaveLength(0);
    expect(d2.claude.calls).toHaveLength(0);
  });

  it('a completion that cannot be saved → 503 TURN_NOT_SAVED, saying the reply was generated', async () => {
    const d = deps();
    d.conversations.failAppend = infraError();
    const result = await handleChatTurn(d, { token: 't', message: 'hi' });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: { code: 'TURN_NOT_SAVED', retryable: true } });
  });

  it('a thrown error anywhere → 500, never a rejection', async () => {
    const d = deps({
      verify: {
        getUserFromToken: () => Promise.reject(new Error('unexpected')),
        getStaffRow: () => Promise.resolve(ok(null)),
      },
    });
    await expect(handleChatTurn(d, { token: 't', message: 'hi' })).resolves.toMatchObject({
      status: 500,
      body: { error: { code: 'INTERNAL' } },
    });
  });
});

describe('Claude failures rendered for the caller', () => {
  it('spend cap → 402 SPEND_CAP naming the window; the turn is not saved', async () => {
    const d = deps({ claude: fakeClaude(err(new SpendCapError('day', 5, 5, 0.01))) });
    const result = await handleChatTurn(d, { token: 't', message: 'hi' });
    expect(result.status).toBe(402);
    expect(result.body).toEqual({
      error: {
        code: 'SPEND_CAP',
        message:
          'The daily Claude spend cap has been reached. No request was sent. An admin can raise the cap in configuration.',
        retryable: false,
      },
    });
    expect(d.conversations.appended).toHaveLength(0);
  });

  it.each<[string, LlmError, number, string]>([
    ['monthly cap', new SpendCapError('month', 50, 50, 0.01), 402, 'SPEND_CAP'],
    ['rate limit', new RateLimitedError(1500), 429, 'RATE_LIMITED'],
    ['model refusal', new ModelRefusalError('x'), 422, 'MODEL_REFUSAL'],
    ['timeout', new TimeoutError('slow', 60_000), 504, 'TIMEOUT'],
    ['network', new NetworkError('down'), 503, 'NETWORK'],
    ['upstream 4xx', new HttpStatusError('bad', 400), 502, 'UPSTREAM_ERROR'],
    ['unreadable response', new ValidationError('shape'), 502, 'BAD_UPSTREAM_RESPONSE'],
    ['config', new ConfigError('no pricing'), 500, 'CONFIG'],
    ['internal', new AppError('INTERNAL', 'x'), 500, 'INTERNAL'],
  ])('%s → %i', async (_label, error, status, code) => {
    const d = deps({ claude: fakeClaude(err(error)) });
    const result = await handleChatTurn(d, { token: 't', message: 'hi' });
    expect(result.status).toBe(status);
    expect(result.body).toMatchObject({ error: { code } });
    expect(d.conversations.appended).toHaveLength(0);
  });

  it('monthly cap message says monthly; rate limit carries retryAfterMs', () => {
    expect(mapLlmError(new SpendCapError('month', 50, 50, 0.01)).body).toMatchObject({
      error: { message: expect.stringContaining('monthly') as string },
    });
    expect(mapLlmError(new RateLimitedError(1500)).body).toMatchObject({
      error: { retryable: true, retryAfterMs: 1500 },
    });
    expect(mapLlmError(new RateLimitedError(null)).body).toMatchObject({
      error: { retryable: true },
    });
    expect(mapLlmError(new AppError('FORBIDDEN', 'x')).status).toBe(500);
  });
});

const EXISTING: ConversationRow = {
  id: CONV_ID,
  userId: USER_ID,
  scope: 'workspace',
  title: 'first',
  deletedAt: null,
};

describe('conversation history — TASKS 2.6.2a, Part C item 4', () => {
  it('a new conversation is not asked for history; the request is the one message', async () => {
    const d = deps();
    await handleChatTurn(d, { token: 't', message: 'first' });
    expect(d.conversations.historyReads).toHaveLength(0);
    expect(d.claude.calls[0]?.messages).toEqual([{ role: 'user', content: 'first' }]);
  });

  it('the second message carries the first turn, oldest first, then the new message', async () => {
    const d = deps({ conversations: fakeStore(EXISTING) });
    d.conversations.history = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a reply' },
    ];
    const result = await handleChatTurn(d, {
      token: 't',
      message: 'second',
      conversationId: CONV_ID,
    });
    expect(result.status).toBe(200);
    expect(d.conversations.historyReads).toEqual([{ conversationId: CONV_ID, limit: 20 }]);
    expect(d.claude.calls[0]?.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a reply' },
      { role: 'user', content: 'second' },
    ]);
    // Only the new message is written; history is read, never re-saved.
    expect(d.conversations.appended).toHaveLength(1);
  });

  it('the bound is passed to the store and applied to the request', async () => {
    const d = deps({
      conversations: fakeStore(EXISTING),
      history: { maxMessages: 2, maxChars: 1e6 },
    });
    d.conversations.history = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ];
    await handleChatTurn(d, { token: 't', message: 'u3', conversationId: CONV_ID });
    expect(d.conversations.historyReads[0]?.limit).toBe(2);
    expect(d.claude.calls[0]?.messages).toEqual([
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ]);
  });

  it('maxMessages 0 disables history without touching the store', async () => {
    const d = deps({
      conversations: fakeStore(EXISTING),
      history: { maxMessages: 0, maxChars: 0 },
    });
    d.conversations.history = [{ role: 'user', content: 'u1' }];
    await handleChatTurn(d, { token: 't', message: 'u2', conversationId: CONV_ID });
    expect(d.conversations.historyReads).toHaveLength(0);
    expect(d.claude.calls[0]?.messages).toEqual([{ role: 'user', content: 'u2' }]);
  });

  it('a history read failure → 503 and no Claude call', async () => {
    const d = deps({ conversations: fakeStore(EXISTING) });
    d.conversations.failHistory = infraError();
    const result = await handleChatTurn(d, { token: 't', message: 'x', conversationId: CONV_ID });
    expect(result.status).toBe(503);
    expect(d.claude.calls).toHaveLength(0);
  });
});

describe('boundHistory', () => {
  const h: HistoryMessage[] = [
    { role: 'user', content: 'aaaa' },
    { role: 'assistant', content: 'bbbb' },
    { role: 'user', content: 'cccc' },
    { role: 'assistant', content: 'dddd' },
  ];

  it('keeps the newest messages under the message bound', () => {
    expect(boundHistory(h, { maxMessages: 2, maxChars: 1e6 })).toEqual(h.slice(2));
    // An odd bound lands on an assistant message, which is then dropped from the front.
    expect(boundHistory(h, { maxMessages: 3, maxChars: 1e6 })).toEqual(h.slice(2));
  });

  it('keeps the newest messages under the character bound', () => {
    expect(boundHistory(h, { maxMessages: 100, maxChars: 8 })).toEqual(h.slice(2));
    expect(boundHistory(h, { maxMessages: 100, maxChars: 7 })).toEqual([]);
  });

  it('drops leading assistant messages so the request starts with a user turn', () => {
    expect(boundHistory(h, { maxMessages: 1, maxChars: 1e6 })).toEqual([]);
    expect(boundHistory(h.slice(1), { maxMessages: 100, maxChars: 1e6 })).toEqual(h.slice(2));
  });

  it('is identity when everything fits', () => {
    expect(boundHistory(h, { maxMessages: 4, maxChars: 16 })).toEqual(h);
    expect(boundHistory([], { maxMessages: 4, maxChars: 16 })).toEqual([]);
  });
});

describe('an empty reply — Part C item 6', () => {
  it.each(['', '   ', '\n\t'])(
    'reply %j → 502 EMPTY_REPLY, retryable, nothing saved',
    async (text) => {
      const d = deps({ claude: fakeClaude(ok({ ...COMPLETION, text })) });
      const result = await handleChatTurn(d, { token: 't', message: 'hi' });
      expect(result.status).toBe(502);
      expect(result.body).toEqual({
        error: {
          code: 'EMPTY_REPLY',
          message: 'The assistant returned an empty reply. Nothing was saved. Please try again.',
          retryable: true,
        },
      });
      expect(d.conversations.appended).toHaveLength(0);
    },
  );
});

describe('handleChatTurnStream — the streamed turn', () => {
  function streamingClaude(
    deltas: readonly string[],
    outcome: Result<Completion, LlmError> = ok({ ...COMPLETION, text: deltas.join('') }),
  ): ClaudeClient & { calls: CompletionRequest[] } {
    const calls: CompletionRequest[] = [];
    return {
      calls,
      complete: () => Promise.reject(new Error('complete must not be used when stream exists')),
      stream: (request, onText) => {
        calls.push(request);
        for (const d of deltas) onText(d);
        return Promise.resolve(outcome);
      },
    };
  }

  async function collect(
    d: ChatDeps,
    input: { token: string | null; message: unknown; conversationId?: unknown },
  ): Promise<ChatStreamEvent[]> {
    const events: ChatStreamEvent[] = [];
    await handleChatTurnStream(d, input, (e) => events.push(e));
    return events;
  }

  it('start → deltas → done, and the turn is saved once with the full text', async () => {
    const claude = streamingClaude(['Hel', 'lo']);
    const d = deps({ claude: claude as unknown as ChatDeps['claude'] });
    const events = await collect(d, { token: 't', message: 'hi' });
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'done']);
    expect(events[0]).toEqual({ type: 'start', conversationId: CONV_ID });
    expect(events[3]).toMatchObject({
      type: 'done',
      reply: { reply: 'Hello', conversationId: CONV_ID },
    });
    expect(d.conversations.appended).toHaveLength(1);
    expect(d.conversations.appended[0]).toMatchObject({ assistant: { content: 'Hello' } });
    expect(claude.calls[0]?.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('a refusal before Claude (401 / 403 / cap) is a single error event with its real status', async () => {
    const unauth = await collect(deps(), { token: null, message: 'hi' });
    expect(unauth).toEqual([
      {
        type: 'error',
        status: 401,
        body: {
          error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', retryable: false },
        },
        partialText: '',
      },
    ]);
    const capped = streamingClaude([], err(new SpendCapError('month', 50, 50, 0.01)));
    const d = deps({ claude: capped as unknown as ChatDeps['claude'] });
    const events = await collect(d, { token: 't', message: 'hi' });
    expect(events.map((e) => e.type)).toEqual(['start', 'error']);
    expect(events[1]).toMatchObject({
      type: 'error',
      status: 402,
      body: { error: { code: 'SPEND_CAP' } },
    });
    expect(d.conversations.appended).toHaveLength(0);
  });

  it('a stream that dies mid-reply → error with the partial text, nothing saved', async () => {
    const interrupted = streamingClaude(
      ['Half a ', 'post'],
      err(new NetworkError('Anthropic stream failed', { context: { partialText: 'Half a post' } })),
    );
    const d = deps({ claude: interrupted as unknown as ChatDeps['claude'] });
    const events = await collect(d, { token: 't', message: 'hi' });
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'error']);
    expect(events[3]).toMatchObject({
      type: 'error',
      status: 503,
      body: { error: { code: 'NETWORK', retryable: true } },
      partialText: 'Half a post',
    });
    expect(d.conversations.appended).toHaveLength(0);
  });

  it('an empty streamed reply → EMPTY_REPLY error, nothing saved', async () => {
    const empty = streamingClaude([], ok({ ...COMPLETION, text: '  ' }));
    const d = deps({ claude: empty as unknown as ChatDeps['claude'] });
    const events = await collect(d, { token: 't', message: 'hi' });
    expect(events.map((e) => e.type)).toEqual(['start', 'error']);
    expect(events[1]).toMatchObject({
      type: 'error',
      status: 502,
      body: { error: { code: 'EMPTY_REPLY' } },
    });
    expect(d.conversations.appended).toHaveLength(0);
  });

  it('a client without stream() falls back to complete(): one delta with the whole reply', async () => {
    const d = deps();
    const events = await collect(d, { token: 't', message: 'hi' });
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'done']);
    expect(events[1]).toEqual({ type: 'delta', text: 'a reply' });
    expect(d.claude.calls).toHaveLength(1);
  });

  it('a save failure after a complete stream → TURN_NOT_SAVED with the full text as partial', async () => {
    const d = deps({ claude: streamingClaude(['done text']) as unknown as ChatDeps['claude'] });
    d.conversations.failAppend = infraError();
    const events = await collect(d, { token: 't', message: 'hi' });
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      status: 503,
      body: { error: { code: 'TURN_NOT_SAVED' } },
      partialText: 'done text',
    });
  });

  it('never throws: a sink that throws becomes an error event', async () => {
    const d = deps({ claude: streamingClaude(['x']) as unknown as ChatDeps['claude'] });
    const events: ChatStreamEvent[] = [];
    let first = true;
    await handleChatTurnStream(d, { token: 't', message: 'hi' }, (e) => {
      events.push(e);
      if (first && e.type === 'delta') {
        first = false;
        throw new Error('sink broke');
      }
    });
    expect(events.at(-1)).toMatchObject({ type: 'error', status: 500 });
  });
});
