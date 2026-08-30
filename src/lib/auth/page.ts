/**
 * The Users page's write path (Stage 3 part 4, FND-330) — server-side, runtime-agnostic,
 * never throws. The Supabase Edge Function `admin` is a thin adapter over
 * `handleUsersRequest`, exactly as the memory function is over `handleMemoryRequest`.
 *
 * THE ROSTER IS NOT READ THROUGH HERE. The browser selects `app_users` directly under RLS
 * as the signed-in user, the same way it reads memory: migration 20260828010000 widened that
 * policy from self-row-only to "every active allowlisted member may read every row", which
 * is exactly what a staff list needs and nothing more. A second server-side copy of that
 * rule would be a second place to get it wrong, and the page stays readable when this
 * function is down. Everything that CHANGES an account comes through here, because
 * `authenticated` holds SELECT and nothing else — the browser could not write if it tried.
 *
 * The ONE read that does come through here is `sign_ins`, and only for an admin: GoTrue's
 * `last_sign_in_at` lives in the `auth` schema, which the Data API does not expose at all,
 * so there is no RLS route to it. It is worth the extra call because it answers the only
 * question the add-user flow leaves open — did the person I handed a password to actually
 * get in — and because without it "Added 3 days ago" is the only thing the list can say.
 *
 * Five actions, all admin-only, all already built and tested in Stage 2 part 3 or added
 * beside them in `admin.ts`:
 *
 *   create          — email in, account + allowlist row out, password returned ONCE.
 *   deactivate      — never delete (D33: their memory contributions are the workspace's).
 *   reactivate      — the reverse; their existing password works again.
 *   reset_password  — a fresh password, returned ONCE.
 *   sign_ins        — when each account last signed in.
 *
 * PROMOTE AND DEMOTE ARE NOT HERE (D74, 30 Aug). They were, briefly. The workspace has ONE
 * administrator in normal use — the two in staging are an artefact of testing — so a control
 * for appointing and un-appointing administrators was a permanent surface for a decision that
 * is made roughly never, and it was the surface through which one admin could strip another.
 * Removing it removes both problems at once and leaves nothing to guard.
 *
 * `setStaffAdmin` SURVIVES in `admin.ts` and `npm run staff -- promote|demote` still works: a
 * second administrator is a rare, deliberate, developer-run act, which is exactly what the
 * break-glass CLI is for. What is gone is the browser's ability to ask.
 *
 * THE PASSWORD. It is in exactly one response body, once, and nowhere else — not in a log
 * line (asserted by unit tests against a capturing sink), not in a table (asserted against
 * every table by tests/security/auth.test.ts), not in `audit_log` (the audit row names the
 * event and the person, never the value), and not in any later response. If it is lost the
 * only path is a reset, which is the correct property and not a limitation.
 *
 * AUDIT: every action that changed something writes one `audit_log` row naming the acting
 * ADMIN — written inside `admin.ts` so the CLI and this endpoint cannot disagree about what
 * gets recorded. The `app_users` trigger writes its own before/after row with actor
 * `service_role`; this is the one that knows which human asked.
 */
import type { Result } from '../errors.js';
import { AppError, type ErrorCode } from '../errors.js';
import type { Logger } from '../logger.js';
import {
  createStaffUser,
  deactivateStaffUser,
  listStaffUsers,
  reactivateStaffUser,
  resetStaffPassword,
  type AdminDeps,
  type CreatedStaffUser,
  type StaffFlagResult,
  type StaffRef,
} from './admin.js';
import { STAFF_EMAIL_MAX_CHARS } from './access.js';

// ---------------------------------------------------------------------------------------
// The wire contract. Same error envelope as the chat and memory endpoints, so the browser's
// handling of 401 / 403 / 409 is one shape across the whole app, not three.
// ---------------------------------------------------------------------------------------

export type UsersActionName =
  'create' | 'deactivate' | 'reactivate' | 'reset_password' | 'sign_ins';

export interface UsersRequestBody {
  readonly action?: unknown;
  readonly email?: unknown;
  readonly userId?: unknown;
}

export interface UsersPageInput {
  readonly token: string | null | undefined;
  readonly body: UsersRequestBody;
}

/** One person's last sign-in, or null if they have never signed in. */
export interface SignInRecord {
  readonly userId: string;
  readonly lastSignInAt: string | null;
}

export type UsersPageReply =
  | {
      readonly action: 'create' | 'reset_password';
      readonly userId: string;
      readonly email: string;
      /**
       * Returned exactly once, by exactly these two actions. Show it, hand it over, forget
       * it. No other reply on this endpoint carries a field by this name.
       */
      readonly oneTimePassword: string;
    }
  | {
      readonly action: 'deactivate' | 'reactivate';
      readonly outcome: 'changed' | 'unchanged';
      readonly userId: string;
      readonly email: string;
      /** Active administrators remaining, counted under the lock that made the change. */
      readonly activeAdmins: number;
    }
  | { readonly action: 'sign_ins'; readonly signIns: readonly SignInRecord[] };

export interface UsersErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type UsersErrorStatus = 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503 | 504;

export type UsersPageResult =
  | { readonly status: 200; readonly body: UsersPageReply }
  | { readonly status: UsersErrorStatus; readonly body: UsersErrorBody };

export interface UsersPageDeps extends AdminDeps {
  readonly log: Logger;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure(
  status: UsersErrorStatus,
  code: string,
  message: string,
  retryable = false,
): UsersPageResult {
  return { status, body: { error: { code, message, retryable } } };
}

/**
 * An AppError from `admin.ts` becomes a status and a sentence. The refusals — not an admin,
 * yourself, the last administrator, a deactivated target — carry their own wording from
 * `access.ts`, because that wording is the same on both sides of the wire and the browser
 * shows it verbatim. Everything else is worded here so a 502 never reads as "502".
 */
export function mapUsersFailure(error: AppError): UsersPageResult {
  const reason = typeof error.context['reason'] === 'string' ? error.context['reason'] : null;
  const code: ErrorCode = error.code;
  switch (code) {
    case 'UNAUTHENTICATED':
      return failure(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    case 'FORBIDDEN':
      // `not_allowlisted` / `deactivated` mean the CALLER is not welcome at all; the rest
      // mean they are welcome but this particular change is refused, and the reason is
      // something they can act on, so it is shown as written.
      return reason === 'not_allowlisted' || reason === 'deactivated'
        ? failure(403, 'FORBIDDEN', 'This account does not have access.')
        : failure(403, (reason ?? 'forbidden').toUpperCase(), error.message);
    case 'CONFLICT':
      return failure(
        409,
        'ALREADY_EXISTS',
        'Someone with that email address is already on the list. Look for them below — they may just need their access restored.',
      );
    case 'VALIDATION':
      return failure(400, 'BAD_REQUEST', error.message);
    case 'CONFIG':
      return failure(500, 'CONFIG', 'User management is misconfigured.');
    case 'TIMEOUT':
      return failure(
        504,
        'TIMEOUT',
        'That took too long. Check the list before trying again.',
        true,
      );
    case 'NETWORK':
    case 'CIRCUIT_OPEN':
      return failure(503, code, 'User management is temporarily unavailable.', true);
    case 'HTTP_STATUS':
      return failure(502, 'UPSTREAM_ERROR', 'That could not be saved. Try again.', true);
    case 'SPEND_CAP':
    case 'RATE_LIMITED':
    case 'MODEL_REFUSAL':
    case 'UNKNOWN_THROWN':
    case 'INTERNAL':
      return failure(500, 'INTERNAL', 'Internal error.');
  }
}

// ---------------------------------------------------------------------------------------
// The handler.
// ---------------------------------------------------------------------------------------

export async function handleUsersRequest(
  deps: UsersPageDeps,
  input: UsersPageInput,
): Promise<UsersPageResult> {
  try {
    return await route(deps, input);
  } catch (caught: unknown) {
    // Belt and braces: nothing below is supposed to throw. If it does it is a 500 with the
    // cause logged, never an unhandled rejection in the runtime.
    deps.log.error('users request threw', { error: caught });
    return failure(500, 'INTERNAL', 'Internal error.');
  }
}

async function route(deps: UsersPageDeps, input: UsersPageInput): Promise<UsersPageResult> {
  const action = input.body.action;
  switch (action) {
    case 'create':
      return create(deps, input);
    case 'deactivate':
    case 'reactivate':
      return flag(deps, input, action);
    case 'reset_password':
      return reset(deps, input);
    case 'sign_ins':
      return signIns(deps, input);
    default:
      return failure(
        400,
        'BAD_REQUEST',
        'action must be one of create, deactivate, reactivate, reset_password, sign_ins.',
      );
  }
}

/** Every action but `create` names an existing account, and it names it by id. */
function targetOf(body: UsersRequestBody): Result<StaffRef> {
  const userId = body.userId;
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    return { ok: false, error: new AppError('VALIDATION', 'userId must be a UUID.') };
  }
  return { ok: true, value: { userId } };
}

function password(action: 'create' | 'reset_password', created: CreatedStaffUser): UsersPageResult {
  return {
    status: 200,
    body: {
      action,
      userId: created.userId,
      email: created.email,
      oneTimePassword: created.generatedPassword,
    },
  };
}

async function create(deps: UsersPageDeps, input: UsersPageInput): Promise<UsersPageResult> {
  const email = input.body.email;
  if (typeof email !== 'string' || email.trim() === '') {
    return failure(400, 'BAD_REQUEST', 'Enter their email address.');
  }
  if (email.length > STAFF_EMAIL_MAX_CHARS) {
    return failure(400, 'BAD_REQUEST', 'That email address is too long to be real.');
  }
  const created = await createStaffUser(deps, input.token, email);
  if (!created.ok) return mapUsersFailure(created.error);
  return password('create', created.value);
}

async function reset(deps: UsersPageDeps, input: UsersPageInput): Promise<UsersPageResult> {
  const target = targetOf(input.body);
  if (!target.ok) return mapUsersFailure(target.error);
  const done = await resetStaffPassword(deps, input.token, target.value);
  if (!done.ok) return mapUsersFailure(done.error);
  return password('reset_password', done.value);
}

async function flag(
  deps: UsersPageDeps,
  input: UsersPageInput,
  action: 'deactivate' | 'reactivate',
): Promise<UsersPageResult> {
  const target = targetOf(input.body);
  if (!target.ok) return mapUsersFailure(target.error);

  let done: Result<StaffFlagResult>;
  switch (action) {
    case 'deactivate':
      done = await deactivateStaffUser(deps, input.token, target.value);
      break;
    case 'reactivate':
      done = await reactivateStaffUser(deps, input.token, target.value);
      break;
  }
  if (!done.ok) return mapUsersFailure(done.error);
  return {
    status: 200,
    body: {
      action,
      outcome: done.value.changed ? 'changed' : 'unchanged',
      userId: done.value.userId,
      email: done.value.email,
      activeAdmins: done.value.activeAdmins,
    },
  };
}

async function signIns(deps: UsersPageDeps, input: UsersPageInput): Promise<UsersPageResult> {
  // listStaffUsers carries the admin gate, so an ordinary member asking who signed in when
  // is refused here rather than merely not shown it.
  const roster = await listStaffUsers(deps, input.token);
  if (!roster.ok) return mapUsersFailure(roster.error);
  const seen = await deps.authAdmin.lastSignIns();
  if (!seen.ok) return mapUsersFailure(seen.error);
  const known = new Map(seen.value.map((row) => [row.userId, row.lastSignInAt]));
  return {
    status: 200,
    body: {
      action: 'sign_ins',
      // Only for people on the allowlist: an auth account with no allowlist row is not a
      // member of this workspace and its existence is not this endpoint's to report.
      signIns: roster.value.map((row) => ({
        userId: row.userId,
        lastSignInAt: known.get(row.userId) ?? null,
      })),
    },
  };
}
