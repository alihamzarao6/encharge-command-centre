/**
 * Every call that CHANGES something the workspace has stored: POST our memory endpoint.
 * Four for the Memory page (add, edit, forget, delete a conversation note) and, since
 * Stage 3 part 4, two for the conversations themselves (rename, delete) — the same endpoint
 * because a conversation is the container the other two live in and the rule about who may
 * remove one is literally the same function. Stage 3 part 5 adds the privacy toggle.
 *
 * Reading is a plain PostgREST select under RLS (see supabase.ts) and never comes through
 * here — the browser holds the anon key and a session, which grant SELECT and nothing else,
 * so a change has to be made by a server that has verified who is asking. THE ONE EXCEPTION
 * is an administrator opening a conversation that is private to somebody else: RLS refuses
 * it on purpose (so the promise holds against a stolen session), and the server path exists
 * so the read leaves an audit row. That is `admin_list_private` / `admin_read_conversation`,
 * and they are the only reads in this file.
 *
 * Pure where it can be — the request shape, the response reading, the plain-language
 * messages — so the parts that decide what the client sees are unit-tested without a
 * browser, exactly as chatApi.ts is. Same error envelope as the chat endpoint, so 401, 402
 * and 403 are handled once in the codebase rather than twice.
 */

export type MemoryRequest =
  | { readonly action: 'add'; readonly text: string }
  | { readonly action: 'edit'; readonly factId: string; readonly value: string }
  | { readonly action: 'forget'; readonly factId: string }
  | { readonly action: 'delete_chunk'; readonly chunkId: string }
  | {
      readonly action: 'rename_conversation';
      readonly conversationId: string;
      readonly title: string;
    }
  | { readonly action: 'delete_conversation'; readonly conversationId: string }
  /** Stage 3 part 5 (R27): the author's "Just me" toggle. */
  | {
      readonly action: 'set_conversation_privacy';
      readonly conversationId: string;
      readonly isPrivate: boolean;
    }
  /** Admin only. Metadata, never titles or messages — see src/lib/memory/page.ts. */
  | { readonly action: 'admin_list_private' }
  /** Admin only, and audited on the server every single time. */
  | { readonly action: 'admin_read_conversation'; readonly conversationId: string };

/** One row of the admin listing. Deliberately carries no title: a title is content. */
export interface PrivateConversationSummary {
  readonly id: string;
  readonly authorId: string;
  readonly authorEmail: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string;
}

export interface AdminConversationMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: string;
}

/** What the server did. `declined` is a normal answer, not a failure: it was understood. */
export type MemoryReply =
  | {
      readonly action: 'add' | 'edit';
      readonly outcome: 'saved';
      readonly factId: string;
      readonly key: string;
      readonly value: string;
      readonly replaced: boolean;
    }
  | {
      readonly action: 'add' | 'edit';
      readonly outcome: 'unchanged';
      readonly factId: string;
      readonly key: string;
      readonly value: string;
    }
  | { readonly action: 'add' | 'edit'; readonly outcome: 'declined'; readonly reason: string }
  | {
      readonly action: 'forget';
      readonly outcome: 'forgotten' | 'already';
      readonly factId: string;
    }
  | {
      readonly action: 'delete_chunk';
      readonly outcome: 'deleted' | 'already';
      readonly chunkId: string;
    }
  | {
      readonly action: 'rename_conversation';
      readonly outcome: 'renamed' | 'unchanged';
      readonly conversationId: string;
      readonly title: string;
    }
  | {
      readonly action: 'delete_conversation';
      readonly outcome: 'deleted' | 'already';
      readonly conversationId: string;
      readonly messagesDeleted: number;
      readonly chunksTombstoned: number;
    }
  | {
      readonly action: 'set_conversation_privacy';
      readonly outcome: 'changed' | 'unchanged';
      readonly conversationId: string;
      readonly isPrivate: boolean;
    }
  | {
      readonly action: 'admin_list_private';
      readonly outcome: 'listed';
      readonly conversations: readonly PrivateConversationSummary[];
    }
  | {
      readonly action: 'admin_read_conversation';
      readonly outcome: 'read';
      readonly conversationId: string;
      readonly title: string | null;
      readonly authorEmail: string | null;
      readonly messages: readonly AdminConversationMessage[];
    };

export interface MemorySuccess {
  readonly kind: 'ok';
  readonly reply: MemoryReply;
}

export type MemoryFailureKind =
  /** Sign in again. */
  | 'unauthenticated'
  /** The account is not allowed in (deactivated or not on the allowlist). */
  | 'forbidden'
  /** Allowed in, but not allowed to remove THIS. */
  | 'notYours'
  /** Someone else changed it first; the page is showing a stale copy. */
  | 'stale'
  /** The spend cap refused the extractor call before anything was sent. */
  | 'cap'
  /** Try again. */
  | 'retryable'
  /** Retrying will not help. */
  | 'fatal';

export interface MemoryFailure {
  readonly kind: 'error';
  readonly failure: MemoryFailureKind;
  /** Plain words, written for the person holding the phone. */
  readonly message: string;
  readonly code: string;
  readonly status: number | null;
}

export type MemoryOutcome = MemorySuccess | MemoryFailure;

export const MEMORY_CLIENT_TIMEOUT_MS = 45_000;

export const MEMORY_MESSAGES = {
  sessionExpired: 'Your session has expired. Sign in again.',
  forbidden: 'This account does not have access to memory.',
  network: "Couldn't reach the Command Centre. Check your connection and try again.",
  timeout: 'That took too long. Nothing was changed — try again.',
  unknown: 'Something went wrong on our side. Nothing was changed — try again.',
  gone: 'That note is no longer there. Refresh to see what memory holds now.',
  conversationGone: 'That conversation is no longer there.',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readReply(body: unknown): MemoryReply | null {
  if (!isRecord(body)) return null;
  const action = body['action'];
  const outcome = body['outcome'];
  if (typeof action !== 'string' || typeof outcome !== 'string') return null;
  const str = (name: string): string | null => {
    const value = body[name];
    return typeof value === 'string' ? value : null;
  };

  if (action === 'add' || action === 'edit') {
    if (outcome === 'declined') {
      const reason = str('reason');
      return reason === null ? null : { action, outcome, reason };
    }
    const factId = str('factId');
    const key = str('key');
    const value = str('value');
    if (factId === null || key === null || value === null) return null;
    if (outcome === 'saved') {
      return { action, outcome, factId, key, value, replaced: body['replaced'] === true };
    }
    if (outcome === 'unchanged') return { action, outcome, factId, key, value };
    return null;
  }
  if (action === 'forget' && (outcome === 'forgotten' || outcome === 'already')) {
    const factId = str('factId');
    return factId === null ? null : { action, outcome, factId };
  }
  if (action === 'delete_chunk' && (outcome === 'deleted' || outcome === 'already')) {
    const chunkId = str('chunkId');
    return chunkId === null ? null : { action, outcome, chunkId };
  }
  if (action === 'rename_conversation' && (outcome === 'renamed' || outcome === 'unchanged')) {
    const conversationId = str('conversationId');
    const title = str('title');
    return conversationId === null || title === null
      ? null
      : { action, outcome, conversationId, title };
  }
  if (action === 'delete_conversation' && (outcome === 'deleted' || outcome === 'already')) {
    const conversationId = str('conversationId');
    const messagesDeleted = body['messagesDeleted'];
    const chunksTombstoned = body['chunksTombstoned'];
    if (
      conversationId === null ||
      typeof messagesDeleted !== 'number' ||
      typeof chunksTombstoned !== 'number'
    ) {
      return null;
    }
    return { action, outcome, conversationId, messagesDeleted, chunksTombstoned };
  }
  if (action === 'set_conversation_privacy' && (outcome === 'changed' || outcome === 'unchanged')) {
    const conversationId = str('conversationId');
    if (conversationId === null || typeof body['isPrivate'] !== 'boolean') return null;
    return { action, outcome, conversationId, isPrivate: body['isPrivate'] };
  }
  if (action === 'admin_list_private' && outcome === 'listed') {
    const rows = body['conversations'];
    if (!Array.isArray(rows)) return null;
    const conversations: PrivateConversationSummary[] = [];
    for (const row of rows as unknown[]) {
      if (!isRecord(row)) return null;
      const id = row['id'];
      const authorId = row['authorId'];
      const createdAt = row['createdAt'];
      const lastActiveAt = row['lastActiveAt'];
      if (
        typeof id !== 'string' ||
        typeof authorId !== 'string' ||
        typeof createdAt !== 'string' ||
        typeof lastActiveAt !== 'string'
      ) {
        return null;
      }
      conversations.push({
        id,
        authorId,
        authorEmail: typeof row['authorEmail'] === 'string' ? row['authorEmail'] : null,
        createdAt,
        lastActiveAt,
      });
    }
    return { action, outcome, conversations };
  }
  if (action === 'admin_read_conversation' && outcome === 'read') {
    const conversationId = str('conversationId');
    const rows = body['messages'];
    if (conversationId === null || !Array.isArray(rows)) return null;
    const messages: AdminConversationMessage[] = [];
    for (const row of rows as unknown[]) {
      if (!isRecord(row)) return null;
      const id = row['id'];
      const role = row['role'];
      const content = row['content'];
      const createdAt = row['createdAt'];
      if (
        typeof id !== 'string' ||
        (role !== 'user' && role !== 'assistant') ||
        typeof content !== 'string' ||
        typeof createdAt !== 'string'
      ) {
        return null;
      }
      messages.push({ id, role, content, createdAt });
    }
    return {
      action,
      outcome,
      conversationId,
      title: str('title'),
      authorEmail: str('authorEmail'),
      messages,
    };
  }
  return null;
}

interface ErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

function readError(body: unknown): ErrorEnvelope | null {
  if (!isRecord(body) || !isRecord(body['error'])) return null;
  const error = body['error'];
  if (typeof error['code'] !== 'string' || typeof error['message'] !== 'string') return null;
  return {
    code: error['code'],
    message: error['message'],
    retryable: error['retryable'] === true,
  };
}

function failure(
  kind: MemoryFailureKind,
  message: string,
  code: string,
  status: number | null,
): MemoryFailure {
  return { kind: 'error', failure: kind, message, code, status };
}

/**
 * An HTTP status and body become what the interface should do and say. The server's own
 * message is precise and safe to show for the cases the client can act on (the cap, "not
 * yours", a note that moved under them); for everything else the wording is chosen here so
 * a 502 never reads as "502".
 */
export function interpretMemoryResponse(status: number, body: unknown): MemoryOutcome {
  if (status === 200) {
    const reply = readReply(body);
    if (reply !== null) return { kind: 'ok', reply };
    return failure('retryable', MEMORY_MESSAGES.unknown, 'BAD_RESPONSE', status);
  }
  const envelope = readError(body);
  const code = envelope?.code ?? `HTTP_${String(status)}`;
  switch (status) {
    case 401:
      return failure('unauthenticated', MEMORY_MESSAGES.sessionExpired, code, status);
    case 403:
      return code === 'NOT_YOURS'
        ? failure('notYours', envelope?.message ?? MEMORY_MESSAGES.forbidden, code, status)
        : failure('forbidden', MEMORY_MESSAGES.forbidden, code, status);
    case 402:
      return failure('cap', envelope?.message ?? MEMORY_MESSAGES.unknown, code, status);
    case 404:
      return failure('stale', MEMORY_MESSAGES.gone, code, status);
    case 409:
      return failure('stale', envelope?.message ?? MEMORY_MESSAGES.gone, code, status);
    case 400:
    case 422:
      // The server's wording here is about what was typed, so it is the useful thing to show.
      return failure('fatal', envelope?.message ?? MEMORY_MESSAGES.unknown, code, status);
    case 429:
    case 504:
      return failure('retryable', envelope?.message ?? MEMORY_MESSAGES.timeout, code, status);
    default:
      return failure(
        envelope?.retryable === true ? 'retryable' : 'fatal',
        MEMORY_MESSAGES.unknown,
        code,
        status,
      );
  }
}

export interface MemoryDeps {
  readonly memoryUrl: string;
  readonly anonKey: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * One memory change over the network. Never throws: a transport failure is a retryable
 * outcome, so the page always has something to show and nothing is silently dropped.
 */
export async function callMemory(
  deps: MemoryDeps,
  accessToken: string,
  request: MemoryRequest,
): Promise<MemoryOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs ?? MEMORY_CLIENT_TIMEOUT_MS);
  try {
    const response = await deps.fetch(deps.memoryUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        apikey: deps.anonKey,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return interpretMemoryResponse(response.status, parsed);
  } catch (caught: unknown) {
    const aborted = caught instanceof Error && caught.name === 'AbortError';
    return failure(
      'retryable',
      aborted ? MEMORY_MESSAGES.timeout : MEMORY_MESSAGES.network,
      aborted ? 'CLIENT_TIMEOUT' : 'NETWORK',
      null,
    );
  } finally {
    clearTimeout(timer);
  }
}
