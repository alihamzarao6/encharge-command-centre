/**
 * Admin-only user management (Stage 2 part 3, FND-220 Part B).
 *
 * The whole feature, in the client's words: "admin adds an email, password gets generated,
 * they're in." Plus the reverse: deactivate — never delete — so a person leaving cannot
 * take the workspace's memory with them (app_users.is_active = false; RLS then returns
 * zero rows to their still-valid JWT; the auth account is additionally banned).
 *
 * Every operation here runs server-side with the service role, but NONE of them trusts the
 * process it runs in: each takes the CALLER's access token and refuses unless that token
 * resolves to an active admin (verify.ts). The one exception is attachSeededCredentials,
 * the bootstrap that gives the two seeded fixed-UUID identities their first password —
 * there is no admin to sign in before it has run. It is restricted to exactly those two
 * UUIDs and still audited.
 *
 * Generated passwords are returned to the caller once and exist nowhere else — never
 * logged (asserted by unit tests against a capturing sink), never stored (asserted against
 * every table by tests/security/auth.test.ts).
 *
 * Audit: the app_users trigger already records row images with actor 'service_role'; the
 * explicit rows written here carry the HUMAN actor (which admin did it), which the trigger
 * cannot know. Password events touch no audited table, so the explicit row is their only
 * trace — the password itself is never part of any audit payload.
 *
 * Dependencies are narrow injected interfaces (stubs in unit tests, supabase-js adapters
 * in clients.ts). Auth admin calls are deliberately NOT retried: creating a user is not
 * idempotent at the transport level, and rule 8 forbids blind retries of non-idempotent
 * writes. Idempotency is at the identity level instead — keyed on email, a re-run can
 * never mint a second identity (rule 9).
 */
import type { Logger } from '../logger.js';
import type { Result } from '../errors.js';
import { AppError, ValidationError, err, ok } from '../errors.js';
import { generateStaffPassword } from './password.js';
import type { AuthTokenUser, StaffIdentity, StaffRow, VerifyDeps } from './verify.js';
import { verifyStaffAccess } from './verify.js';

// ---------------------------------------------------------------------------------------
// Seeded identities — the fixed UUIDs from supabase/seed.sql. These are the stable
// identity that memory rows hang off; credentials attach to them, never to fresh UUIDs.
// ---------------------------------------------------------------------------------------

export const SEEDED_STAFF = {
  ross: {
    userId: 'a0000000-0000-4000-8000-000000000001',
    email: 'rossb@fundd.com.au',
  },
  developer: {
    userId: 'a0000000-0000-4000-8000-000000000002',
    email: 'alihamzarao14@gmail.com',
  },
} as const;

export type SeededStaffKey = keyof typeof SEEDED_STAFF;

// ---------------------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------------------

/** GoTrue admin surface, as these operations need it. Service role only; server-side only. */
export interface AuthAdminApi {
  /** Create a confirmed email+password user. Duplicate email must map to code CONFLICT. */
  readonly createUser: (email: string, password: string) => Promise<Result<AuthTokenUser>>;
  /** Set a (new) password on an existing auth user — also how seeded UUIDs get credentials. */
  readonly setPassword: (userId: string, password: string) => Promise<Result<void>>;
  /** Ban or unban the auth account (bans block sign-in and token refresh). */
  readonly setBanned: (userId: string, banned: boolean) => Promise<Result<void>>;
}

/** public.app_users, as these operations need it. Writes run as service role. */
export interface StaffStore {
  readonly getByEmail: (email: string) => Promise<Result<StaffRow | null>>;
  readonly getById: (userId: string) => Promise<Result<StaffRow | null>>;
  readonly insert: (row: StaffRow) => Promise<Result<void>>;
  readonly setActive: (userId: string, active: boolean) => Promise<Result<void>>;
}

/**
 * Every application-written audit action, closed so a typo cannot invent one and a reader
 * can see the whole set of things a person can be recorded as having done. The database
 * trigger writes its own rows with `INSERT` / `UPDATE` / `DELETE` as the action; these are
 * the ones code writes, and they name the HUMAN rather than the role the write used.
 */
export type AuditAction =
  // Staff administration (Stage 2 part 3, src/lib/auth/admin.ts)
  | 'USER_CREATED'
  | 'USER_DEACTIVATED'
  | 'PASSWORD_RESET'
  | 'CREDENTIALS_ATTACHED'
  // Memory page (Stage 3 part 3, src/lib/memory/page.ts)
  | 'MEMORY_FACT_ADDED'
  | 'MEMORY_FACT_REPLACED'
  | 'MEMORY_FACT_EDITED'
  | 'MEMORY_FACT_RESTORED'
  | 'MEMORY_FACT_FORGOTTEN'
  | 'MEMORY_CHUNK_DELETED';

export type AuditEntityType = 'app_users' | 'memory_facts' | 'memory_chunks';

export interface AuditEntry {
  readonly actor: string;
  readonly action: AuditAction;
  readonly entityType: AuditEntityType;
  readonly entityId: string;
}

export interface AuditWriter {
  readonly write: (entry: AuditEntry) => Promise<Result<void>>;
}

export interface AdminDeps {
  readonly verify: VerifyDeps;
  readonly authAdmin: AuthAdminApi;
  readonly staff: StaffStore;
  readonly audit: AuditWriter;
  readonly log: Logger;
}

// ---------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------

export interface CreatedStaffUser {
  readonly userId: string;
  readonly email: string;
  /** Returned exactly once. Show it, hand it over, forget it. Never persist or log it. */
  readonly generatedPassword: string;
}

export interface DeactivatedStaffUser {
  readonly userId: string;
  readonly email: string;
  readonly alreadyInactive: boolean;
}

// ---------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------

/** Admin adds an email → auth user + allowlist row + one-time password. */
export async function createStaffUser(
  deps: AdminDeps,
  callerToken: string | null | undefined,
  rawEmail: string,
): Promise<Result<CreatedStaffUser>> {
  const admin = await requireAdmin(deps, callerToken);
  if (!admin.ok) {
    return admin;
  }
  const email = normalizeEmail(rawEmail);
  if (!email.ok) {
    return email;
  }

  const existing = await deps.staff.getByEmail(email.value);
  if (!existing.ok) {
    return existing;
  }
  if (existing.value !== null) {
    // No email in the message: AppErrors end up in log lines, and rule 20 keeps PII out
    // of logs. The caller knows which email it asked about; context carries the id.
    return err(
      new AppError('CONFLICT', 'that email is already on the staff allowlist', {
        context: { userId: existing.value.user_id, isActive: existing.value.is_active },
      }),
    );
  }

  const password = generateStaffPassword();
  const created = await deps.authAdmin.createUser(email.value, password);
  if (!created.ok) {
    return created;
  }

  const inserted = await deps.staff.insert({
    user_id: created.value.id,
    email: email.value,
    role: 'staff',
    is_active: true,
    is_admin: false,
  });
  if (!inserted.ok) {
    // The auth account now exists without an allowlist row: it can read NOTHING (RLS) and
    // is exactly the state security test 3 proves harmless. Surface loudly; do not hide it.
    deps.log.error('auth user created but allowlist insert failed — orphan auth account', {
      userId: created.value.id,
    });
    return inserted;
  }

  const audited = await deps.audit.write({
    actor: admin.value.email,
    action: 'USER_CREATED',
    entityType: 'app_users',
    entityId: created.value.id,
  });
  if (!audited.ok) {
    return err(
      new AppError('INTERNAL', 'user was created but the audit write failed — investigate', {
        context: { userId: created.value.id },
        cause: audited.error,
      }),
    );
  }

  // Rule 20: ids only in log lines — the emails are in audit_log, an RLS-protected table.
  deps.log.info('staff user created', {
    userId: created.value.id,
    actorId: admin.value.userId,
  });
  return ok({ userId: created.value.id, email: email.value, generatedPassword: password });
}

/**
 * Deactivate, never delete. The allowlist row and every memory row survive; the person's
 * access ends at the database (RLS reads is_active) and their auth account is banned so no
 * new session can be minted. Idempotent: deactivating twice is a no-op, not an error.
 */
export async function deactivateStaffUser(
  deps: AdminDeps,
  callerToken: string | null | undefined,
  rawEmail: string,
): Promise<Result<DeactivatedStaffUser>> {
  const admin = await requireAdmin(deps, callerToken);
  if (!admin.ok) {
    return admin;
  }
  const email = normalizeEmail(rawEmail);
  if (!email.ok) {
    return email;
  }

  const row = await deps.staff.getByEmail(email.value);
  if (!row.ok) {
    return row;
  }
  if (row.value === null) {
    return err(new ValidationError('no staff allowlist row for that email'));
  }
  if (row.value.user_id === admin.value.userId) {
    // An admin can only be deactivated by ANOTHER admin, so the workspace can never
    // deactivate its way to zero admins.
    return err(
      new AppError('FORBIDDEN', 'refusing to deactivate the calling admin', {
        context: { reason: 'self_deactivation' },
      }),
    );
  }

  const alreadyInactive = !row.value.is_active;
  const flagged = await deps.staff.setActive(row.value.user_id, false);
  if (!flagged.ok) {
    return flagged;
  }
  const banned = await deps.authAdmin.setBanned(row.value.user_id, true);
  if (!banned.ok) {
    // The database refusal (is_active = false) is already in force; the ban is belt and
    // braces against new sign-ins. Report the failure, do not pretend it worked.
    return err(
      new AppError('INTERNAL', 'user deactivated in app_users but the auth ban failed', {
        context: { userId: row.value.user_id },
        cause: banned.error,
      }),
    );
  }

  const audited = await deps.audit.write({
    actor: admin.value.email,
    action: 'USER_DEACTIVATED',
    entityType: 'app_users',
    entityId: row.value.user_id,
  });
  if (!audited.ok) {
    return err(
      new AppError('INTERNAL', 'user was deactivated but the audit write failed — investigate', {
        context: { userId: row.value.user_id },
        cause: audited.error,
      }),
    );
  }

  deps.log.info('staff user deactivated', {
    userId: row.value.user_id,
    actorId: admin.value.userId,
    alreadyInactive,
  });
  return ok({ userId: row.value.user_id, email: email.value, alreadyInactive });
}

/** Generate a fresh password for an existing, active staff member. Shown once, as at creation. */
export async function resetStaffPassword(
  deps: AdminDeps,
  callerToken: string | null | undefined,
  rawEmail: string,
): Promise<Result<CreatedStaffUser>> {
  const admin = await requireAdmin(deps, callerToken);
  if (!admin.ok) {
    return admin;
  }
  const email = normalizeEmail(rawEmail);
  if (!email.ok) {
    return email;
  }

  const row = await deps.staff.getByEmail(email.value);
  if (!row.ok) {
    return row;
  }
  if (row.value === null) {
    return err(new ValidationError('no staff allowlist row for that email'));
  }
  if (!row.value.is_active) {
    return err(
      new AppError('FORBIDDEN', 'refusing to reset the password of a deactivated user', {
        context: { userId: row.value.user_id },
      }),
    );
  }

  const password = generateStaffPassword();
  const set = await deps.authAdmin.setPassword(row.value.user_id, password);
  if (!set.ok) {
    return set;
  }

  const audited = await deps.audit.write({
    actor: admin.value.email,
    action: 'PASSWORD_RESET',
    entityType: 'app_users',
    entityId: row.value.user_id,
  });
  if (!audited.ok) {
    return err(
      new AppError('INTERNAL', 'password was reset but the audit write failed — investigate', {
        context: { userId: row.value.user_id },
        cause: audited.error,
      }),
    );
  }

  deps.log.info('staff password reset', {
    userId: row.value.user_id,
    actorId: admin.value.userId,
  });
  return ok({ userId: row.value.user_id, email: email.value, generatedPassword: password });
}

/**
 * Bootstrap: attach first credentials to one of the two SEEDED fixed-UUID identities.
 * No admin gate — before this has run there is no admin who can sign in — so it is
 * restricted to exactly those UUIDs, refuses to run against an unseeded database, and
 * NEVER creates a user: it sets a password on the row the seed already made (proven by
 * the before/after auth-user count in tests/security/auth.test.ts).
 */
export async function attachSeededCredentials(
  deps: AdminDeps,
  who: SeededStaffKey,
): Promise<Result<CreatedStaffUser>> {
  const seeded = SEEDED_STAFF[who];

  const row = await deps.staff.getById(seeded.userId);
  if (!row.ok) {
    return row;
  }
  if (row.value?.email !== seeded.email) {
    return err(
      new AppError(
        'CONFIG',
        'seeded staff row missing or altered — run the migrations and seed first',
        {
          context: { userId: seeded.userId, expectedEmail: seeded.email },
        },
      ),
    );
  }

  const password = generateStaffPassword();
  const set = await deps.authAdmin.setPassword(seeded.userId, password);
  if (!set.ok) {
    return set;
  }

  const audited = await deps.audit.write({
    actor: 'bootstrap-cli',
    action: 'CREDENTIALS_ATTACHED',
    entityType: 'app_users',
    entityId: seeded.userId,
  });
  if (!audited.ok) {
    return err(
      new AppError('INTERNAL', 'credentials attached but the audit write failed — investigate', {
        context: { userId: seeded.userId },
        cause: audited.error,
      }),
    );
  }

  deps.log.info('seeded credentials attached', { userId: seeded.userId });
  return ok({ userId: seeded.userId, email: seeded.email, generatedPassword: password });
}

// ---------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------

async function requireAdmin(
  deps: AdminDeps,
  callerToken: string | null | undefined,
): Promise<Result<StaffIdentity>> {
  const access = await verifyStaffAccess(deps.verify, callerToken);
  if (!access.ok) {
    return access;
  }
  const decision = access.value;
  switch (decision.kind) {
    case 'unauthenticated':
      return err(
        new AppError('UNAUTHENTICATED', 'user management requires a signed-in admin', {
          context: { reason: decision.reason },
        }),
      );
    case 'forbidden':
      return err(
        new AppError('FORBIDDEN', 'caller is not an active staff member', {
          context: { reason: decision.reason },
        }),
      );
    case 'authorized':
      if (!decision.user.isAdmin) {
        return err(
          new AppError('FORBIDDEN', 'caller is staff but not an admin', {
            context: { reason: 'not_admin', userId: decision.user.userId },
          }),
        );
      }
      return ok(decision.user);
  }
}

function normalizeEmail(raw: string): Result<string> {
  const email = raw.trim().toLowerCase();
  // Deliberately loose: one @ with something either side and a dot in the domain. The
  // authority on deliverability is the mailbox, not a regex; this only rejects typos.
  // The value itself stays out of the message (rule 20 — messages become log lines).
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return err(new ValidationError('not a plausible email address'));
  }
  return ok(email);
}
