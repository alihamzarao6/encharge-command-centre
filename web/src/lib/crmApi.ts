/**
 * The one call the overview makes that CHANGES something: "refresh from GoHighLevel", a POST
 * to our crm endpoint (Milestone 4 part 2). Everything the screen READS is a PostgREST
 * select under RLS as the signed-in person (see supabase.ts) — the browser holds no
 * GoHighLevel token and never talks to GoHighLevel; the refresh runs on the server with the
 * one reader of that token, and the browser then re-reads the tables.
 *
 * Pure where it can be — request shape, response reading, plain-language messages — so what
 * the client sees when a refresh is refused or fails is unit-tested without a browser,
 * exactly as usersApi.ts and memoryApi.ts are. Same error envelope, so a 401 is handled the
 * way it is everywhere else in the app: sign in again.
 */

export interface CrmRequest {
  readonly action: 'sync';
}

export interface CrmSyncReply {
  readonly action: 'sync';
  readonly status: 'success' | 'partial';
  readonly runId: string;
  readonly durationMs: number;
  readonly opportunitiesFetched: number;
  readonly contactsFetched: number;
  readonly contactsUnread: number;
}

export interface CrmSuccess {
  readonly kind: 'ok';
  readonly reply: CrmSyncReply;
}

export type CrmFailureKind =
  /** Sign in again. */
  | 'unauthenticated'
  /** The account is not allowed in at all. */
  | 'forbidden'
  /** Another refresh is running; the screen will pick its result up. */
  | 'running'
  /** The server tried and GoHighLevel could not be read; the run row says why. */
  | 'failed'
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
}

export type CrmOutcome = CrmSuccess | CrmFailure;

/**
 * A full sync of ten opportunities is a dozen requests; the Part 1 caps keep a large one
 * under a few minutes. Longer than this and the server has almost certainly already
 * finished or failed, and the run row will say which.
 */
export const CRM_CLIENT_TIMEOUT_MS = 120_000;

export const CRM_MESSAGES = {
  sessionExpired: 'Your session has expired. Sign in again.',
  forbidden: 'This account does not have access.',
  running: 'A refresh is already running. The numbers will update when it finishes.',
  network: "Couldn't reach the Command Centre. Check your connection and try again.",
  timeout:
    'The refresh is taking longer than usual. The numbers will update on their own when it finishes.',
  unknown: 'The refresh could not be started. Try again in a moment.',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readReply(body: unknown): CrmSyncReply | null {
  if (!isRecord(body) || body['action'] !== 'sync') return null;
  const status = body['status'];
  if (status !== 'success' && status !== 'partial') return null;
  const runId = body['runId'];
  const durationMs = num(body['durationMs']);
  const opportunitiesFetched = num(body['opportunitiesFetched']);
  const contactsFetched = num(body['contactsFetched']);
  const contactsUnread = num(body['contactsUnread']);
  if (
    typeof runId !== 'string' ||
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
): CrmFailure {
  return { kind: 'error', failure: kind, message, code, status };
}

/**
 * An HTTP status and body become what the screen should do and say. A 502 is the one that
 * matters: the server ran the refresh and GoHighLevel could not be read, so the sentence the
 * server wrote (which names the cause, never a secret) is shown as written, and the screen
 * re-reads the run row so the failure is on the page, not only in a toast.
 */
export function interpretCrmResponse(status: number, body: unknown): CrmOutcome {
  if (status === 200) {
    const reply = readReply(body);
    if (reply !== null) return { kind: 'ok', reply };
    return failure('retryable', CRM_MESSAGES.unknown, 'BAD_RESPONSE', status);
  }
  const envelope = readError(body);
  const code = envelope?.code ?? `HTTP_${String(status)}`;
  switch (status) {
    case 401:
      return failure('unauthenticated', CRM_MESSAGES.sessionExpired, code, status);
    case 403:
      return failure('forbidden', CRM_MESSAGES.forbidden, code, status);
    case 409:
      return failure('running', CRM_MESSAGES.running, code, status);
    case 502:
      return failure('failed', envelope?.message ?? CRM_MESSAGES.unknown, code, status);
    case 504:
      return failure('retryable', CRM_MESSAGES.timeout, code, status);
    default:
      return failure(
        envelope?.retryable === true ? 'retryable' : 'fatal',
        CRM_MESSAGES.unknown,
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
 * One refresh over the network. Never throws: a transport failure is a retryable outcome.
 * A client-side timeout does NOT mean the refresh failed — the server may well finish after
 * the browser stopped waiting — so the message says the numbers will update, and the screen
 * keeps polling the run row until they do.
 */
export async function callCrm(
  deps: CrmDeps,
  accessToken: string,
  request: CrmRequest,
): Promise<CrmOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs ?? CRM_CLIENT_TIMEOUT_MS);
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
    return interpretCrmResponse(response.status, parsed);
  } catch (caught: unknown) {
    const aborted = caught instanceof Error && caught.name === 'AbortError';
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
