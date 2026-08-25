/**
 * The browser's view of a chat turn (web/src/lib/chatApi.ts): what the interface shows for
 * each status the server can answer with — Part C items 5 (cap) and 6 (empty reply) at the
 * pure-function level, plus the transport failures the phone will actually hit.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  MESSAGES,
  buildChatRequest,
  interpretChatResponse,
  sendTurn,
} from '../../../web/src/lib/chatApi.js';

const OK_BODY = {
  conversationId: 'c0000000-0000-4000-8000-000000000001',
  userMessageId: 'm-user',
  assistantMessageId: 'm-assistant',
  reply: 'Here is your post.',
  model: 'claude-sonnet-5',
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0.001,
};

function envelope(code: string, message: string, retryable = false): unknown {
  return { error: { code, message, retryable } };
}

describe('buildChatRequest', () => {
  it('omits conversationId for a new conversation and includes it otherwise', () => {
    expect(buildChatRequest({ message: 'hi', conversationId: null })).toEqual({ message: 'hi' });
    expect(buildChatRequest({ message: 'hi', conversationId: 'abc' })).toEqual({
      message: 'hi',
      conversationId: 'abc',
    });
  });
});

describe('interpretChatResponse', () => {
  it('200 with a reply → ok', () => {
    expect(interpretChatResponse(200, OK_BODY)).toEqual({
      kind: 'ok',
      conversationId: OK_BODY.conversationId,
      userMessageId: 'm-user',
      assistantMessageId: 'm-assistant',
      reply: 'Here is your post.',
    });
  });

  it.each(['', '   ', '\n'])('200 with an empty reply %j → retryable error, never ok', (reply) => {
    const outcome = interpretChatResponse(200, { ...OK_BODY, reply });
    expect(outcome).toMatchObject({
      kind: 'error',
      failure: 'retryable',
      code: 'EMPTY_REPLY',
      message: MESSAGES.emptyReply,
    });
  });

  it('200 with a malformed body → retryable error', () => {
    expect(interpretChatResponse(200, { reply: 1 })).toMatchObject({
      kind: 'error',
      code: 'BAD_RESPONSE',
    });
    expect(interpretChatResponse(200, null)).toMatchObject({ kind: 'error' });
  });

  it('402 cap → plain words, monthly vs daily from the server message, never the code', () => {
    const monthly = interpretChatResponse(
      402,
      envelope('SPEND_CAP', 'The monthly Claude spend cap has been reached. No request was sent.'),
    );
    expect(monthly).toMatchObject({ kind: 'error', failure: 'cap', message: MESSAGES.cap });
    const daily = interpretChatResponse(
      402,
      envelope('SPEND_CAP', 'The daily Claude spend cap has been reached. No request was sent.'),
    );
    expect(daily).toMatchObject({ failure: 'cap', message: MESSAGES.capDaily });
    for (const outcome of [monthly, daily]) {
      expect(outcome.kind === 'error' && outcome.message).not.toMatch(/402|SPEND_CAP/);
    }
  });

  it('401 → unauthenticated with the draft-kept message; 403 → forbidden', () => {
    expect(interpretChatResponse(401, envelope('UNAUTHENTICATED', 'Sign in.'))).toMatchObject({
      failure: 'unauthenticated',
      message: MESSAGES.sessionExpired,
    });
    expect(interpretChatResponse(403, envelope('FORBIDDEN', 'No.'))).toMatchObject({
      failure: 'forbidden',
      message: MESSAGES.forbidden,
    });
  });

  it('502 EMPTY_REPLY from the server → the empty-reply message, retryable', () => {
    expect(interpretChatResponse(502, envelope('EMPTY_REPLY', 'Empty.', true))).toMatchObject({
      failure: 'retryable',
      code: 'EMPTY_REPLY',
      message: MESSAGES.emptyReply,
    });
  });

  it.each([
    [504, 'TIMEOUT', 'retryable', MESSAGES.timeout],
    [429, 'RATE_LIMITED', 'retryable', MESSAGES.rateLimited],
    [503, 'NETWORK', 'retryable', MESSAGES.unknown],
    [502, 'UPSTREAM_ERROR', 'retryable', MESSAGES.unknown],
    [404, 'NOT_FOUND', 'fatal', MESSAGES.notFound],
    [422, 'MODEL_REFUSAL', 'fatal', MESSAGES.refusal],
    [500, 'INTERNAL', 'fatal', MESSAGES.unknown],
    [400, 'BAD_REQUEST', 'fatal', MESSAGES.unknown],
  ] as const)('%d %s → %s', (status, code, failure, message) => {
    expect(interpretChatResponse(status, envelope(code, 'x'))).toMatchObject({
      kind: 'error',
      failure,
      code,
      message,
      status,
    });
  });

  it('a non-JSON error body still maps by status', () => {
    expect(interpretChatResponse(503, null)).toMatchObject({
      failure: 'retryable',
      code: 'HTTP_503',
    });
  });
});

describe('sendTurn', () => {
  const deps = (fetchImpl: typeof fetch, timeoutMs?: number) => ({
    chatUrl: 'https://stack.test/functions/v1/chat',
    anonKey: 'anon-key',
    fetch: fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  it('POSTs the bearer token, the anon key and the request body to our endpoint only', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      calls.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        init,
      });
      return Promise.resolve(
        new Response(JSON.stringify(OK_BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const outcome = await sendTurn(deps(fetchImpl), {
      accessToken: 'jwt-token',
      message: 'hello',
      conversationId: null,
    });
    expect(outcome.kind).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://stack.test/functions/v1/chat');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer jwt-token');
    expect(headers.get('apikey')).toBe('anon-key');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ message: 'hello' }));
  });

  it('a network failure → retryable, NETWORK, never a throw', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const outcome = await sendTurn(deps(fetchImpl), {
      accessToken: 't',
      message: 'hello',
      conversationId: null,
    });
    expect(outcome).toMatchObject({
      kind: 'error',
      failure: 'retryable',
      code: 'NETWORK',
      message: MESSAGES.network,
      status: null,
    });
  });

  it('a client-side timeout aborts and → retryable, CLIENT_TIMEOUT', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      const pending = sendTurn(deps(fetchImpl, 50), {
        accessToken: 't',
        message: 'hello',
        conversationId: null,
      });
      await vi.advanceTimersByTimeAsync(60);
      expect(await pending).toMatchObject({
        failure: 'retryable',
        code: 'CLIENT_TIMEOUT',
        message: MESSAGES.timeout,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a non-JSON success body → error, not a crash', async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response('<html>', { status: 200 }));
    const outcome = await sendTurn(deps(fetchImpl), {
      accessToken: 't',
      message: 'x',
      conversationId: null,
    });
    expect(outcome).toMatchObject({ kind: 'error', code: 'BAD_RESPONSE' });
  });
});
