/**
 * The seven calls the Users page makes that CHANGE something (plus the one read RLS cannot
 * serve): POST our admin endpoint. The ROSTER is a plain PostgREST select under RLS (see
 * supabase.ts) and never comes through here — the browser holds the anon key and a session,
 * which grant SELECT and nothing else, so a change has to be made by a server that has
 * verified who is asking.
 *
 * Pure where it can be — the request shape, the response reading, the plain-language
 * messages — so the parts that decide what the client sees are unit-tested without a
 * browser, exactly as chatApi.ts and memoryApi.ts are. Same error envelope as both, so 401
 * and 403 are handled once in the codebase rather than three times.
 *
 * THE ONE-TIME PASSWORD arrives in exactly one response and is held only in React state,
 * only until the admin dismisses it. It is never written to localStorage, sessionStorage,
 * the URL, or anywhere else that survives a refresh — if the page reloads it is gone, which
 * is the behaviour the promise on screen describes.
 */

export type UsersRequest =
  | { readonly action: 'create'; readonly email: string }
  | {
      readonly action: 'deactivate' | 'reactivate' | 'reset_password';
      readonly userId: string;
    }
  | { readonly action: 'sign_ins' };

export interface SignInRecord {
  readonly userId: string;
  readonly lastSignInAt: string | null;
}

/** What the server did. */
export type UsersReply =
  | {
      readonly action: 'create' | 'reset_password';
      readonly userId: string;
      readonly email: string;
      readonly oneTimePassword: string;
    }
  | {
      readonly action: 'deactivate' | 'reactivate';
      readonly outcome: 'changed' | 'unchanged';
      readonly userId: string;
      readonly email: string;
      readonly activeAdmins: number;
    }
  | { readonly action: 'sign_ins'; readonly signIns: readonly SignInRecord[] };

export interface UsersSuccess {
  readonly kind: 'ok';
  readonly reply: UsersReply;
}

export type UsersFailureKind =
  /** Sign in again. */
  | 'unauthenticated'
  /** The account is not allowed in at all (deactivated or not on the allowlist). */
  | 'forbidden'
  /** Allowed in, but not allowed to do THIS — not an admin, yourself, the last admin. */
  | 'refused'
  /** That email is already on the list. */
  | 'duplicate'
  /** Try again. */
  | 'retryable'
  /** Retrying will not help. */
  | 'fatal';

export interface UsersFailure {
  readonly kind: 'error';
  readonly failure: UsersFailureKind;
  /** Plain words, written for the person holding the phone. */
  readonly message: string;
  readonly code: string;
  readonly status: number | null;
}

export type UsersOutcome = UsersSuccess | UsersFailure;

export const USERS_CLIENT_TIMEOUT_MS = 30_000;

export const USERS_MESSAGES = {
  sessionExpired: 'Your session has expired. Sign in again.',
  forbidden: 'This account does not have access.',
  network: "Couldn't reach the Command Centre. Check your connection and try again.",
  timeout: 'That took too long. Check the list before trying again — it may have worked.',
  unknown: 'Something went wrong on our side. Check the list before trying again.',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readReply(body: unknown): UsersReply | null {
  if (!isRecord(body)) return null;
  const action = body['action'];
  if (typeof action !== 'string') return null;
  const str = (name: string): string | null => {
    const value = body[name];
    return typeof value === 'string' ? value : null;
  };

  if (action === 'create' || action === 'reset_password') {
    const userId = str('userId');
    const email = str('email');
    const oneTimePassword = str('oneTimePassword');
    if (userId === null || email === null || oneTimePassword === null) return null;
    return { action, userId, email, oneTimePassword };
  }
  if (action === 'deactivate' || action === 'reactivate') {
    const outcome = body['outcome'];
    const userId = str('userId');
    const email = str('email');
    const activeAdmins = body['activeAdmins'];
    if (outcome !== 'changed' && outcome !== 'unchanged') return null;
    if (userId === null || email === null || typeof activeAdmins !== 'number') return null;
    return { action, outcome, userId, email, activeAdmins };
  }
  if (action === 'sign_ins') {
    const rows = body['signIns'];
    if (!Array.isArray(rows)) return null;
    const signIns: SignInRecord[] = [];
    for (const row of rows) {
      if (!isRecord(row) || typeof row['userId'] !== 'string') return null;
      const seen = row['lastSignInAt'];
      signIns.push({ userId: row['userId'], lastSignInAt: typeof seen === 'string' ? seen : null });
    }
    return { action, signIns };
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
  kind: UsersFailureKind,
  message: string,
  code: string,
  status: number | null,
): UsersFailure {
  return { kind: 'error', failure: kind, message, code, status };
}

/**
 * An HTTP status and body become what the interface should do and say. A 403 is the
 * interesting one: `FORBIDDEN` means "not you, not here", while every other 403 code is a
 * refusal of THIS change with a sentence the person can act on — written once in
 * src/lib/auth/access.ts and shown verbatim, so the two sides cannot disagree about what
 * the rule is.
 */
export function interpretUsersResponse(status: number, body: unknown): UsersOutcome {
  if (status === 200) {
    const reply = readReply(body);
    if (reply !== null) return { kind: 'ok', reply };
    return failure('retryable', USERS_MESSAGES.unknown, 'BAD_RESPONSE', status);
  }
  const envelope = readError(body);
  const code = envelope?.code ?? `HTTP_${String(status)}`;
  switch (status) {
    case 401:
      return failure('unauthenticated', USERS_MESSAGES.sessionExpired, code, status);
    case 403:
      return code === 'FORBIDDEN'
        ? failure('forbidden', USERS_MESSAGES.forbidden, code, status)
        : failure('refused', envelope?.message ?? USERS_MESSAGES.forbidden, code, status);
    case 409:
      return failure('duplicate', envelope?.message ?? USERS_MESSAGES.unknown, code, status);
    case 400:
      // The server's wording here is about what was typed, so it is the useful thing to show.
      return failure('fatal', envelope?.message ?? USERS_MESSAGES.unknown, code, status);
    case 504:
      return failure('retryable', USERS_MESSAGES.timeout, code, status);
    default:
      return failure(
        envelope?.retryable === true ? 'retryable' : 'fatal',
        USERS_MESSAGES.unknown,
        code,
        status,
      );
  }
}

export interface UsersDeps {
  readonly adminUrl: string;
  readonly anonKey: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * One user-management change over the network. Never throws: a transport failure is a
 * retryable outcome, so the page always has something to show and nothing is silently
 * dropped. A timeout says "check the list" rather than "it failed", because creating a user
 * is not idempotent and we do not know which side of the write the connection dropped.
 */
export async function callUsers(
  deps: UsersDeps,
  accessToken: string,
  request: UsersRequest,
): Promise<UsersOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs ?? USERS_CLIENT_TIMEOUT_MS);
  try {
    const response = await deps.fetch(deps.adminUrl, {
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
    return interpretUsersResponse(response.status, parsed);
  } catch (caught: unknown) {
    const aborted = caught instanceof Error && caught.name === 'AbortError';
    return failure(
      'retryable',
      aborted ? USERS_MESSAGES.timeout : USERS_MESSAGES.network,
      aborted ? 'CLIENT_TIMEOUT' : 'NETWORK',
      null,
    );
  } finally {
    clearTimeout(timer);
  }
}
