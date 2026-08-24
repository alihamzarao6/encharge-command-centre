/**
 * Server-side staff access verification (task 2.3.2 / 2.3.3).
 *
 * Given the bearer token a client presented, decide exactly one of:
 *
 *   unauthenticated (→ 401)  — no token, or a token GoTrue refuses (expired, tampered,
 *                              revoked, banned account);
 *   forbidden       (→ 403)  — a real Supabase Auth user who is not on the app_users
 *                              allowlist, or whose row is deactivated;
 *   authorized               — an active staff member, with is_admin resolved.
 *
 * The decision is a VALUE, not an exception: any endpoint maps `httpStatus` straight onto
 * its response. Infrastructure failures (network, timeout) are the Result error channel —
 * they mean "could not decide", which an endpoint must surface as 5xx, never as 403.
 *
 * RLS makes the same check at the database (app_users allowlist in every policy), so this
 * module is the polite refusal at the door; the locked door itself is in the migrations.
 * Both are tested independently — tests/unit/auth and tests/security.
 *
 * Dependencies are injected as two narrow functions so unit tests run with stubs and no
 * network (TESTING.md rule: external APIs are never called in unit tests); the production
 * adapters over supabase-js live in clients.ts.
 */
import type { Result } from '../errors.js';
import { err, ok } from '../errors.js';

/** The auth-server view of a token: who it belongs to, if it is valid at all. */
export interface AuthTokenUser {
  readonly id: string;
  readonly email: string | null;
}

/** One row of public.app_users, as the verifier needs it. */
export interface StaffRow {
  readonly user_id: string;
  readonly email: string;
  readonly role: string;
  readonly is_active: boolean;
  readonly is_admin: boolean;
}

export interface VerifyDeps {
  /**
   * Resolve a token to its user. `ok(null)` = the token is invalid/expired/tampered (an
   * auth decision); `err(...)` = the auth server could not be asked (infrastructure).
   */
  readonly getUserFromToken: (token: string) => Promise<Result<AuthTokenUser | null>>;
  /** Fetch the allowlist row for a user id; `ok(null)` = no row exists. */
  readonly getStaffRow: (userId: string) => Promise<Result<StaffRow | null>>;
}

export interface StaffIdentity {
  readonly userId: string;
  readonly email: string;
  readonly role: string;
  readonly isAdmin: boolean;
}

export type StaffAccess =
  | {
      readonly kind: 'unauthenticated';
      readonly httpStatus: 401;
      readonly reason: 'missing_token' | 'invalid_token';
    }
  | {
      readonly kind: 'forbidden';
      readonly httpStatus: 403;
      readonly reason: 'not_allowlisted' | 'deactivated';
    }
  | { readonly kind: 'authorized'; readonly httpStatus: 200; readonly user: StaffIdentity };

export async function verifyStaffAccess(
  deps: VerifyDeps,
  token: string | null | undefined,
): Promise<Result<StaffAccess>> {
  if (token === null || token === undefined || token.trim() === '') {
    return ok({ kind: 'unauthenticated', httpStatus: 401, reason: 'missing_token' });
  }

  const userResult = await deps.getUserFromToken(token);
  if (!userResult.ok) {
    return err(userResult.error);
  }
  const user = userResult.value;
  if (user === null) {
    return ok({ kind: 'unauthenticated', httpStatus: 401, reason: 'invalid_token' });
  }

  const rowResult = await deps.getStaffRow(user.id);
  if (!rowResult.ok) {
    return err(rowResult.error);
  }
  const row = rowResult.value;
  if (row === null) {
    return ok({ kind: 'forbidden', httpStatus: 403, reason: 'not_allowlisted' });
  }
  if (!row.is_active) {
    return ok({ kind: 'forbidden', httpStatus: 403, reason: 'deactivated' });
  }

  return ok({
    kind: 'authorized',
    httpStatus: 200,
    user: {
      userId: row.user_id,
      email: row.email,
      role: row.role,
      isAdmin: row.is_admin,
    },
  });
}
