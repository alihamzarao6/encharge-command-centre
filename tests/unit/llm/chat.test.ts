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
  readonly created: string[];
  readonly appended: unknown[];
  existing: ConversationRow | null;
  failCreate: AppError | null;
  failGet: AppError | null;
  failAppend: AppError | null;
}

function fakeStore(existing: ConversationRow | null = null): FakeStore {
  const store: FakeStore = {
    created: [],
    appended: [],
    existing,
    failCreate: null,
    failGet: null,
    failAppend: null,
    get: () => Promise.resolve(store.failGet === null ? ok(store.existing) : err(store.failGet)),
    create: (userId) => {
      store.created.push(userId);
      return Promise.resolve(
        store.failCreate === null
          ? ok({ id: CONV_ID, userId, scope: 'workspace' as const, deletedAt: null })
          : err(store.failCreate),
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
    expect(d.conversations.created).toEqual([USER_ID]);
    const call = d.claude.calls[0];
    expect(call?.userId).toBe(USER_ID);
    expect(call?.conversationId).toBe(CONV_ID);
    expect(call?.operation).toBe('chat.turn');
    expect(call?.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(call?.system[0]?.text).toContain(`v${VOICE_PROMPT_VERSION}`);
    expect(call?.system[0]?.cache).toBe(true);
    expect(d.conversations.appended).toEqual([
      {
        conversation: { id: CONV_ID, userId: USER_ID, scope: 'workspace', deletedAt: null },
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
      { id: CONV_ID, userId: OTHER_ID, scope: 'user' as const, deletedAt: null },
    ],
    [
      'a deleted conversation',
      {
        id: CONV_ID,
        userId: USER_ID,
        scope: 'workspace' as const,
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
      conversations: fakeStore({ id: CONV_ID, userId: USER_ID, scope: 'user', deletedAt: null }),
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
