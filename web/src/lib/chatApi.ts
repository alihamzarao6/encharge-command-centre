/**
 * The one call the browser makes that costs money: POST our chat endpoint. Pure where it
 * can be (request shape, response parsing, plain-language errors) so the parts that decide
 * what the client sees are unit-tested without a browser.
 *
 * Two transports, one contract:
 *   - `streamTurn` asks for `text/event-stream` and delivers text as it is generated. If
 *     the answer is not an event stream (a proxy that rewrote it, a runtime without
 *     streams, a refusal before the first token, which the server answers as plain JSON),
 *     it reads the body as JSON and behaves exactly like `sendTurn`. Degrades to the
 *     non-streaming behaviour, never to nothing.
 *   - `sendTurn` is the plain JSON turn, kept as the fallback and for tests.
 *
 * The browser never calls api.anthropic.com. It sends the bearer token and the message to
 * the Edge Function; everything else — the voice prompt, the cap, the history — is
 * assembled server-side (SECURITY.md §2, TASKS 2.6.3).
 */
import { readSse } from '../../../src/lib/sse.js';

export interface ChatSuccess {
  readonly kind: 'ok';
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly reply: string;
}

export type ChatFailureKind =
  /** Sign in again. The draft must survive. */
  | 'unauthenticated'
  /** The account is not allowed in (deactivated or not on the allowlist). */
  | 'forbidden'
  /** The spend cap refused the call before anything was sent. */
  | 'cap'
  /** Try again without losing the message. */
  | 'retryable'
  /** Something the user cannot fix by retrying. */
  | 'fatal';

export interface ChatFailure {
  readonly kind: 'error';
  readonly failure: ChatFailureKind;
  /** Plain words, written for the person holding the phone. */
  readonly message: string;
  readonly code: string;
  readonly status: number | null;
  /** Text that had arrived before the failure. Shown, marked incomplete, never saved. */
  readonly partialText?: string;
}

export type ChatOutcome = ChatSuccess | ChatFailure;

export const CLIENT_TIMEOUT_MS = 90_000;
/** Between events while streaming: the server itself gives up on Claude after 60 s. */
export const STREAM_IDLE_TIMEOUT_MS = 75_000;

export const MESSAGES = {
  cap: 'The monthly Claude budget for the assistant has been used up, so this message was not sent. An admin can raise the cap in the server settings.',
  capDaily:
    "Today's Claude budget for the assistant has been used up, so this message was not sent. It resets at midnight UTC, or an admin can raise the cap.",
  sessionExpired: 'Your session has expired. Sign in again — your message has been kept.',
  forbidden: 'This account does not have access to the assistant.',
  network: "Couldn't reach the assistant. Check your connection and tap Retry.",
  timeout: 'The assistant took too long to answer. Nothing was saved — tap Retry.',
  emptyReply: 'The assistant returned an empty reply. Nothing was saved — tap Retry.',
  rateLimited: 'The assistant is busy right now. Wait a moment and tap Retry.',
  refusal: 'The assistant declined this request. Try rephrasing it.',
  notFound: 'That conversation is no longer available. Start a new one.',
  unknown: 'Something went wrong on our side. Nothing was saved — tap Retry.',
  interrupted:
    'The connection dropped part-way through the reply. What arrived is shown below but was not saved — tap Retry for the full reply.',
} as const;

export function buildChatRequest(input: {
  readonly message: string;
  readonly conversationId: string | null;
}): { readonly message: string; readonly conversationId?: string } {
  return input.conversationId === null
    ? { message: input.message }
    : { message: input.message, conversationId: input.conversationId };
}

interface ErrorEnvelope {
  error: { code: string; message: string; retryable: boolean; retryAfterMs?: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readErrorEnvelope(body: unknown): ErrorEnvelope | null {
  if (!isRecord(body) || !isRecord(body['error'])) return null;
  const error = body['error'];
  if (typeof error['code'] !== 'string' || typeof error['message'] !== 'string') return null;
  return {
    error: {
      code: error['code'],
      message: error['message'],
      retryable: error['retryable'] === true,
    },
  };
}

function readSuccess(body: unknown): ChatSuccess | null {
  if (
    isRecord(body) &&
    typeof body['conversationId'] === 'string' &&
    typeof body['userMessageId'] === 'string' &&
    typeof body['assistantMessageId'] === 'string' &&
    typeof body['reply'] === 'string'
  ) {
    return {
      kind: 'ok',
      conversationId: body['conversationId'],
      userMessageId: body['userMessageId'],
      assistantMessageId: body['assistantMessageId'],
      reply: body['reply'],
    };
  }
  return null;
}

/**
 * Turn an HTTP status and body into what the interface should do. The server's own message
 * is precise for an operator; the words shown to the client are chosen here so a 402 never
 * reads as "402".
 */
export function interpretChatResponse(
  status: number,
  body: unknown,
  partialText?: string,
): ChatOutcome {
  if (status === 200) {
    const success = readSuccess(body);
    if (success !== null) {
      // Belt and braces: the server refuses empty replies (chat.ts), and so do we.
      if (success.reply.trim() === '') {
        return failure('retryable', MESSAGES.emptyReply, 'EMPTY_REPLY', status);
      }
      return success;
    }
    return failure('retryable', MESSAGES.unknown, 'BAD_RESPONSE', status);
  }

  const envelope = readErrorEnvelope(body);
  const code = envelope?.error.code ?? 'HTTP_' + String(status);
  const partial = partialText !== undefined && partialText.trim() !== '' ? partialText : undefined;
  switch (status) {
    case 401:
      return failure('unauthenticated', MESSAGES.sessionExpired, code, status);
    case 403:
      return failure('forbidden', MESSAGES.forbidden, code, status);
    case 402: {
      const daily = envelope?.error.message.toLowerCase().includes('daily') ?? false;
      return failure('cap', daily ? MESSAGES.capDaily : MESSAGES.cap, code, status);
    }
    case 404:
      return failure('fatal', MESSAGES.notFound, code, status);
    case 422:
      return failure('fatal', MESSAGES.refusal, code, status);
    case 429:
      return failure('retryable', MESSAGES.rateLimited, code, status);
    case 504:
      return failure(
        'retryable',
        partial === undefined ? MESSAGES.timeout : MESSAGES.interrupted,
        code,
        status,
        partial,
      );
    case 502:
      if (code === 'EMPTY_REPLY') {
        return failure('retryable', MESSAGES.emptyReply, code, status);
      }
      return failure(
        'retryable',
        partial === undefined ? MESSAGES.unknown : MESSAGES.interrupted,
        code,
        status,
        partial,
      );
    case 503:
      return failure(
        'retryable',
        partial === undefined ? MESSAGES.unknown : MESSAGES.interrupted,
        code,
        status,
        partial,
      );
    default:
      return failure(
        envelope?.error.retryable === true ? 'retryable' : 'fatal',
        MESSAGES.unknown,
        code,
        status,
        partial,
      );
  }
}

function failure(
  kind: ChatFailureKind,
  message: string,
  code: string,
  status: number | null,
  partialText?: string,
): ChatFailure {
  return {
    kind: 'error',
    failure: kind,
    message,
    code,
    status,
    ...(partialText === undefined ? {} : { partialText }),
  };
}

export interface SendTurnDeps {
  readonly chatUrl: string;
  readonly anonKey: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

export interface TurnInput {
  readonly accessToken: string;
  readonly message: string;
  readonly conversationId: string | null;
}

function transportFailure(caught: unknown, partialText?: string): ChatFailure {
  const aborted = caught instanceof Error && caught.name === 'AbortError';
  return failure(
    'retryable',
    aborted ? MESSAGES.timeout : MESSAGES.network,
    aborted ? 'CLIENT_TIMEOUT' : 'NETWORK',
    null,
    partialText,
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * One turn over the network, plain JSON. Never throws: a transport failure is a retryable
 * outcome with the message left in the caller's hands.
 */
export async function sendTurn(deps: SendTurnDeps, input: TurnInput): Promise<ChatOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs ?? CLIENT_TIMEOUT_MS);
  try {
    const response = await deps.fetch(deps.chatUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.accessToken}`,
        apikey: deps.anonKey,
      },
      body: JSON.stringify(buildChatRequest(input)),
      signal: controller.signal,
    });
    return interpretChatResponse(response.status, await readJson(response));
  } catch (caught: unknown) {
    return transportFailure(caught);
  } finally {
    clearTimeout(timer);
  }
}

export interface StreamHandlers {
  /** The turn was admitted; the conversation it belongs to. */
  readonly onStart?: (conversationId: string) => void;
  readonly onDelta: (text: string) => void;
}

interface StreamEventPayload {
  type?: string;
  conversationId?: string;
  text?: string;
  reply?: unknown;
  status?: number;
  body?: unknown;
  partialText?: string;
}

function parseEvent(data: string): StreamEventPayload | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One turn, streamed. Same outcome type as `sendTurn`; text arrives through `onDelta` on
 * the way. Falls back to the JSON reading whenever the response is not an event stream.
 */
export async function streamTurn(
  deps: SendTurnDeps,
  input: TurnInput,
  handlers: StreamHandlers,
): Promise<ChatOutcome> {
  const controller = new AbortController();
  // The header timeout only; once events flow, the idle timeout in readSse takes over.
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs ?? CLIENT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await deps.fetch(deps.chatUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${input.accessToken}`,
        apikey: deps.anonKey,
      },
      body: JSON.stringify(buildChatRequest(input)),
      signal: controller.signal,
    });
  } catch (caught: unknown) {
    clearTimeout(timer);
    return transportFailure(caught);
  }
  clearTimeout(timer);

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/event-stream') || response.body === null) {
    // Not a stream: a refusal before the first token, or a proxy that would not pass one.
    return interpretChatResponse(response.status, await readJson(response));
  }

  let partial = '';
  // A holder, not a `let`: assignments inside the callback are invisible to narrowing.
  const verdict: { outcome: ChatOutcome | null } = { outcome: null };
  const outcome = await readSse(response.body, {
    idleTimeoutMs: deps.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
    onEvent: (event) => {
      const payload = parseEvent(event.data);
      if (payload === null) return undefined;
      switch (event.event) {
        case 'start':
          if (typeof payload.conversationId === 'string') {
            handlers.onStart?.(payload.conversationId);
          }
          return undefined;
        case 'delta':
          if (typeof payload.text === 'string') {
            partial += payload.text;
            handlers.onDelta(payload.text);
          }
          return undefined;
        case 'done':
          verdict.outcome = interpretChatResponse(200, payload.reply);
          return false;
        case 'error':
          verdict.outcome = interpretChatResponse(
            typeof payload.status === 'number' ? payload.status : 500,
            payload.body,
            typeof payload.partialText === 'string' ? payload.partialText : partial,
          );
          return false;
        default:
          return undefined;
      }
    },
  });
  if (verdict.outcome !== null) return verdict.outcome;
  // The stream ended without a verdict: the connection dropped.
  if (outcome.kind === 'idle_timeout') {
    return failure(
      'retryable',
      partial === '' ? MESSAGES.timeout : MESSAGES.interrupted,
      'CLIENT_TIMEOUT',
      null,
      partial === '' ? undefined : partial,
    );
  }
  return failure(
    'retryable',
    partial === '' ? MESSAGES.network : MESSAGES.interrupted,
    'STREAM_INTERRUPTED',
    null,
    partial === '' ? undefined : partial,
  );
}
