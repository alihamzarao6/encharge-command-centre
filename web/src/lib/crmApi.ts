/**
 * The calls the screens make that CHANGE something: "refresh from GoHighLevel" (Milestone 4
 * part 2), and — part 4 — "move this lead to that stage" and "add a note", all POSTs to our
 * crm endpoint. Everything the screen READS is a PostgREST select under RLS as the signed-in
 * person (see supabase.ts) — the browser holds no GoHighLevel token and never talks to
 * GoHighLevel; the writes run on the server with the one reader of that token, and the
 * browser then re-reads the tables.
 *
 * Pure where it can be — request shape, response reading, plain-language messages — so what
 * the client sees when a write is refused or fails is unit-tested without a browser, exactly
 * as usersApi.ts and memoryApi.ts are. Same error envelope, so a 401 is handled the way it is
 * everywhere else in the app: sign in again.
 *
 * A move carries a `requestId` minted per gesture (crypto.randomUUID): the server keys the
 * write on it, so a replay — Try again after the connection dropped — is answered from the
 * record and never sent to GoHighLevel twice. A NEW gesture mints a new id.
 */

export interface CrmSyncRequest {
  readonly action: 'sync';
}

export interface CrmMoveRequest {
  readonly action: 'move';
  readonly requestId: string;
  readonly opportunityId: string;
  readonly toStageId: string;
  /** The stage the screen showed when the person acted, so the server can say if it changed. */
  readonly fromStageId: string | null;
}

export interface CrmNoteRequest {
  readonly action: 'note';
  readonly requestId: string;
  readonly opportunityId: string;
  readonly body: string;
}

export type CrmRequest = CrmSyncRequest | CrmMoveRequest | CrmNoteRequest;

export interface CrmSyncReply {
  readonly action: 'sync';
  readonly status: 'success' | 'partial';
  readonly runId: string;
  readonly durationMs: number;
  readonly opportunitiesFetched: number;
  readonly contactsFetched: number;
  readonly contactsUnread: number;
}

export interface CrmMoveReply {
  readonly action: 'move';
  readonly opportunityId: string;
  /** The stage GoHighLevel held before — the real one, not necessarily what the screen showed. */
  readonly fromStageId: string;
  readonly toStageId: string;
  /** False: the lead was already there and nothing was written. */
  readonly changed: boolean;
  /** Someone else had moved this lead since the screen loaded (last write wins, visibly). */
  readonly movedByOther: boolean;
  readonly replay: boolean;
  readonly landedAfterTimeout: boolean;
  /** False: GoHighLevel changed but our copy could not be updated; the next refresh will. */
  readonly mirrored: boolean;
  readonly writeId: string;
  readonly durationMs: number;
}

export interface CrmNoteReply {
  readonly action: 'note';
  readonly opportunityId: string;
  readonly noteId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly authorUserId: string;
  readonly mirrored: boolean;
  readonly writeId: string;
  readonly durationMs: number;
}

export type CrmReply = CrmSyncReply | CrmMoveReply | CrmNoteReply;

export interface CrmSuccess {
  readonly kind: 'ok';
  readonly reply: CrmReply;
}

export type CrmFailureKind =
  /** Sign in again. */
  | 'unauthenticated'
  /** The account is not allowed in at all. */
  | 'forbidden'
  /** Another refresh is running; the screen will pick its result up. */
  | 'running'
  /** The last refresh ended too recently (Milestone 4 part 3, item 10); wait, then try. */
  | 'cooldown'
  /** The server tried and GoHighLevel could not be read or written; the sentence says why. */
  | 'failed'
  /**
   * Part 4: a definite "no" before or from GoHighLevel — the lead is gone, closed, in another
   * pipeline, the stage no longer exists, the note was refused. Nothing was changed; the
   * sentence says so and usually says to refresh.
   */
  | 'refused'
  /** Part 4: GoHighLevel did not confirm and the server could not check. Refresh before retrying. */
  | 'unknown'
  /** Try again. */
  | 'retryable'
  /** Retrying will not help. */
  | 'fatal';

export interface CrmFailure {
  readonly kind: 'error';
  readonly failure: CrmFailureKind;
  /** Plain words, written for the person holding the phone. */
  readonly message: string;
  readonly code: string;
  readonly status: number | null;
  /** Set on a cooldown refusal: how long the server says to wait. */
  readonly retryAfterSeconds?: number;
}

export type CrmOutcome = CrmSuccess | CrmFailure;

/**
 * A full sync of ten opportunities is a dozen requests; the Part 1 caps keep a large one
 * under a few minutes. Longer than this and the server has almost certainly already
 * finished or failed, and the run row will say which.
 */
export const CRM_CLIENT_TIMEOUT_MS = 120_000;
/** A move is three GoHighLevel requests at most, each under the server's 20 s timeout. */
export const CRM_WRITE_TIMEOUT_MS = 75_000;

export const CRM_MESSAGES = {
  sessionExpired: 'Your session has expired. Sign in again.',
  forbidden: 'This account does not have access.',
  running: 'A refresh is already running. The numbers will update when it finishes.',
  cooldown: 'The pipeline was refreshed a moment ago. Wait a minute, then try again.',
  network: "Couldn't reach the Command Centre. Check your connection and try again.",
  timeout:
    'The refresh is taking longer than usual. The numbers will update on their own when it finishes.',
  unknown: 'The refresh could not be started. Try again in a moment.',
  // Part 4: the write versions. The server's own sentence is preferred whenever it sent one.
  moveNetwork:
    "Couldn't reach the Command Centre, so the lead was not moved. Check your connection and try again.",
  moveTimeout:
    "The Command Centre didn't answer in time. The lead may or may not have moved — refresh to see where it is before trying again.",
  moveUnknown: 'The move could not be made. Nothing was changed. Try again in a moment.',
  noteNetwork:
    "Couldn't reach the Command Centre, so the note was not saved. Your text is still here — check your connection and try again.",
  noteTimeout:
    "The Command Centre didn't answer in time. Check the contact in GoHighLevel before saving the note again — your text is still here.",
  noteUnknown: 'The note could not be saved. Your text is still here — try again in a moment.',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readSyncReply(body: Record<string, unknown>): CrmSyncReply | null {
  const status = body['status'];
  if (status !== 'success' && status !== 'partial') return null;
  const runId = str(body['runId']);
  const durationMs = num(body['durationMs']);
  const opportunitiesFetched = num(body['opportunitiesFetched']);
  const contactsFetched = num(body['contactsFetched']);
  const contactsUnread = num(body['contactsUnread']);
  if (
    runId === null ||
    durationMs === null ||
    opportunitiesFetched === null ||
    contactsFetched === null ||
    contactsUnread === null
  ) {
    return null;
  }
  return {
    action: 'sync',
    status,
    runId,
    durationMs,
    opportunitiesFetched,
    contactsFetched,
    contactsUnread,
  };
}

function readMoveReply(body: Record<string, unknown>): CrmMoveReply | null {
  const opportunityId = str(body['opportunityId']);
  const fromStageId = str(body['fromStageId']);
  const toStageId = str(body['toStageId']);
  const changed = bool(body['changed']);
  const movedByOther = bool(body['movedByOther']);
  const replay = bool(body['replay']);
  const landedAfterTimeout = bool(body['landedAfterTimeout']);
  const mirrored = bool(body['mirrored']);
  const writeId = str(body['writeId']);
  const durationMs = num(body['durationMs']);
  if (
    opportunityId === null ||
    fromStageId === null ||
    toStageId === null ||
    changed === null ||
    movedByOther === null ||
    replay === null ||
    landedAfterTimeout === null ||
    mirrored === null ||
    writeId === null ||
    durationMs === null
  ) {
    return null;
  }
  return {
    action: 'move',
    opportunityId,
    fromStageId,
    toStageId,
    changed,
    movedByOther,
    replay,
    landedAfterTimeout,
    mirrored,
    writeId,
    durationMs,
  };
}

function readNoteReply(body: Record<string, unknown>): CrmNoteReply | null {
  const opportunityId = str(body['opportunityId']);
  const noteId = str(body['noteId']);
  const text = str(body['body']);
  const createdAt = str(body['createdAt']);
  const authorUserId = str(body['authorUserId']);
  const mirrored = bool(body['mirrored']);
  const writeId = str(body['writeId']);
  const durationMs = num(body['durationMs']);
  if (
    opportunityId === null ||
    noteId === null ||
    text === null ||
    createdAt === null ||
    authorUserId === null ||
    mirrored === null ||
    writeId === null ||
    durationMs === null
  ) {
    return null;
  }
  return {
    action: 'note',
    opportunityId,
    noteId,
    body: text,
    createdAt,
    authorUserId,
    mirrored,
    writeId,
    durationMs,
  };
}

function readReply(body: unknown, expected: CrmRequest['action']): CrmReply | null {
  if (!isRecord(body) || body['action'] !== expected) return null;
  switch (expected) {
    case 'sync':
      return readSyncReply(body);
    case 'move':
      return readMoveReply(body);
    case 'note':
      return readNoteReply(body);
  }
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
  kind: CrmFailureKind,
  message: string,
  code: string,
  status: number | null,
  retryAfterSeconds?: number,
): CrmFailure {
  return retryAfterSeconds === undefined
    ? { kind: 'error', failure: kind, message, code, status }
    : { kind: 'error', failure: kind, message, code, status, retryAfterSeconds };
}

/**
 * An HTTP status and body become what the screen should do and say. The server's sentence is
 * shown as written wherever it sent one: it names the cause, never a secret, and for a write
 * it says whether the lead moved. A 502 on a refresh is the one that matters most: the server
 * ran the refresh and GoHighLevel could not be read, so the run row is re-read too.
 */
export function interpretCrmResponse(
  status: number,
  body: unknown,
  action: CrmRequest['action'] = 'sync',
): CrmOutcome {
  const write = action !== 'sync';
  const unknownMessage = write
    ? action === 'move'
      ? CRM_MESSAGES.moveUnknown
      : CRM_MESSAGES.noteUnknown
    : CRM_MESSAGES.unknown;
  if (status === 200) {
    const reply = readReply(body, action);
    if (reply !== null) return { kind: 'ok', reply };
    return failure('retryable', unknownMessage, 'BAD_RESPONSE', status);
  }
  const envelope = readError(body);
  const code = envelope?.code ?? `HTTP_${String(status)}`;
  const said = envelope?.message ?? unknownMessage;
  switch (status) {
    case 401:
      return failure('unauthenticated', CRM_MESSAGES.sessionExpired, code, status);
    case 403:
      // The account boundary (FORBIDDEN) reads one way; a lead outside the pipeline another.
      return code === 'FORBIDDEN'
        ? failure('forbidden', CRM_MESSAGES.forbidden, code, status)
        : failure('refused', said, code, status);
    case 409:
      return code === 'SYNC_RUNNING'
        ? failure('running', CRM_MESSAGES.running, code, status)
        : failure('refused', said, code, status);
    case 410:
    case 422:
      return failure('refused', said, code, status);
    case 429: {
      // The server's sentence says how long ago and how long to wait; shown as written.
      const retryAfter = isRecord(body) ? num(body['retryAfterSeconds']) : null;
      return failure(
        'cooldown',
        envelope?.message ?? CRM_MESSAGES.cooldown,
        code,
        status,
        retryAfter ?? undefined,
      );
    }
    case 400:
      return failure('refused', said, code, status);
    case 502:
      return failure('failed', said, code, status);
    case 503:
      return failure('retryable', said, code, status);
    case 504:
      return write
        ? failure('unknown', said, code, status)
        : failure('retryable', CRM_MESSAGES.timeout, code, status);
    default:
      return failure(
        envelope?.retryable === true ? 'retryable' : 'fatal',
        unknownMessage,
        code,
        status,
      );
  }
}

export interface CrmDeps {
  readonly crmUrl: string;
  readonly anonKey: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * One request over the network. Never throws: a transport failure is an outcome. A
 * client-side timeout does NOT mean the write failed — the server may well finish after the
 * browser stopped waiting — so for a move the message says to refresh before trying again,
 * and for a refresh it says the numbers will update; the screens re-read either way.
 */
export async function callCrm(
  deps: CrmDeps,
  accessToken: string,
  request: CrmRequest,
): Promise<CrmOutcome> {
  const controller = new AbortController();
  const write = request.action !== 'sync';
  const timer = setTimeout(
    () => {
      controller.abort();
    },
    deps.timeoutMs ?? (write ? CRM_WRITE_TIMEOUT_MS : CRM_CLIENT_TIMEOUT_MS),
  );
  try {
    const response = await deps.fetch(deps.crmUrl, {
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
    return interpretCrmResponse(response.status, parsed, request.action);
  } catch (caught: unknown) {
    const aborted = caught instanceof Error && caught.name === 'AbortError';
    if (request.action === 'move') {
      return aborted
        ? failure('unknown', CRM_MESSAGES.moveTimeout, 'CLIENT_TIMEOUT', null)
        : failure('retryable', CRM_MESSAGES.moveNetwork, 'NETWORK', null);
    }
    if (request.action === 'note') {
      return aborted
        ? failure('unknown', CRM_MESSAGES.noteTimeout, 'CLIENT_TIMEOUT', null)
        : failure('retryable', CRM_MESSAGES.noteNetwork, 'NETWORK', null);
    }
    return failure(
      'retryable',
      aborted ? CRM_MESSAGES.timeout : CRM_MESSAGES.network,
      aborted ? 'CLIENT_TIMEOUT' : 'NETWORK',
      null,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** A request id per gesture; falls back to a random string where crypto.randomUUID is absent. */
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const hex = (n: number): string =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}
