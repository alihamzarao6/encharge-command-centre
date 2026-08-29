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
import {
  canChangeStaff,
  countActiveAdmins,
  type StaffActor,
  type StaffChangeAction,
  type StaffTarget,
} from './access.js';
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
  /**
   * Stage 3 part 4. When each auth account last signed in — `null` for one that never has.
   * Only GoTrue knows this: `auth.users` is not exposed through the Data API, so there is no
   * RLS route to it and the users page has to ask a verified server.
   */
  readonly lastSignIns: () => Promise<Result<readonly SignInAt[]>>;
}

/** One account's last sign-in. Nothing else from `auth.users` is read, or wanted. */
export interface SignInAt {
  readonly userId: string;
  readonly lastSignInAt: string | null;
}

/**
 * The outcome of a flag write. `changed` is false when the flag already held that value —
 * these operations are idempotent, so "already deactivated" is a report, not an error.
 * `activeAdmins` is the count AFTER the write, read under the same lock, so a caller never
 * has to ask a second question to know where the workspace stands.
 */
export interface StaffFlagChange {
  readonly changed: boolean;
  readonly activeAdmins: number;
}

/** public.app_users, as these operations need it. Writes run as service role. */
export interface StaffStore {
  readonly getByEmail: (email: string) => Promise<Result<StaffRow | null>>;
  readonly getById: (userId: string) => Promise<Result<StaffRow | null>>;
  readonly insert: (row: StaffRow) => Promise<Result<void>>;
  /**
   * Stage 3 part 4: both flag writes go through the database functions that hold the
   * last-admin invariant under an advisory lock (migration 20260828010000). A refusal
   * arrives as a FORBIDDEN AppError with `reason: 'last_admin'`.
   */
  readonly setActive: (userId: string, active: boolean) => Promise<Result<StaffFlagChange>>;
  readonly setAdmin: (userId: string, admin: boolean) => Promise<Result<StaffFlagChange>>;
  /** The whole roster. Small by construction — one workspace, tens of people. */
  readonly list: () => Promise<Result<readonly StaffRow[]>>;
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
  // Users page (Stage 3 part 4, src/lib/auth/page.ts)
  | 'USER_REACTIVATED'
  | 'USER_PROMOTED'
  | 'USER_DEMOTED'
  // Conversation management (Stage 3 part 4, src/lib/memory/page.ts)
  | 'CONVERSATION_RENAMED'
  | 'CONVERSATION_DELETED'
  // Private conversations (Stage 3 part 5, R27, src/lib/memory/page.ts)
  | 'CONVERSATION_MADE_PRIVATE'
  | 'CONVERSATION_MADE_SHARED'
  /**
   * An administrator opened a conversation that is private to someone else. RLS was NOT
   * widened for this (migration 20260829010000 says why), so the read goes through the
   * verified server path — which is what makes it recordable at all. Postgres has no SELECT
   * trigger; without this row, an owner reading every private conversation in the workspace
   * would leave no trace anywhere.
   */
  | 'CONVERSATION_ADMIN_READ'
  // Memory page (Stage 3 part 3, src/lib/memory/page.ts)
  | 'MEMORY_FACT_ADDED'
  | 'MEMORY_FACT_REPLACED'
  | 'MEMORY_FACT_EDITED'
  | 'MEMORY_FACT_RESTORED'
  | 'MEMORY_FACT_FORGOTTEN'
  | 'MEMORY_CHUNK_DELETED';

export type AuditEntityType = 'app_users' | 'memory_facts' | 'memory_chunks' | 'conversations';

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

/**
 * How a caller names the account it means. The CLI has an email typed at a terminal; the
 * users page has the row it is looking at, so it sends the id — no email travels in a
 * request body that does not have to.
 */
export type StaffRef = { readonly email: string } | { readonly userId: string };

/** The result of flipping `is_active` or `is_admin`. Idempotent: `changed` may be false. */
export interface StaffFlagResult {
  readonly userId: string;
  readonly email: string;
  readonly changed: boolean;
  /** Active administrators remaining, counted under the lock that made the change. */
  readonly activeAdmins: number;
}

/** One roster row as the users page shows it. Never carries anything credential-shaped. */
export interface StaffListEntry {
  readonly userId: string;
  readonly email: string;
  readonly role: string;
  readonly isActive: boolean;
  readonly isAdmin: boolean;
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
 *
 * Two refusals, both from `access.ts` so the browser can state them before asking: the
 * calling admin cannot deactivate themselves, and nobody can deactivate the last active
 * administrator. The database holds the second one too, under a lock (migration
 * 20260828010000) — this is the sentence, that is the guarantee.
 */
export async function deactivateStaffUser(
  deps: AdminDeps,
  callerToken: string | null | undefined,
  ref: StaffRef,
): Promise<Result<StaffFlagResult>> {
  return changeFlag(deps, callerToken, ref, 'deactivate');
}

/**
 * The reverse. Someone who came back, or an account deactivated by mistake: the allowlist
 * row flips to active and the auth ban is lifted, so their EXISTING password works again.
 * Nothing about their memory contributions ever moved, so nothing needs restoring.
 *
 * Their admin flag is whatever it was — deactivating never cleared it — so reactivating a
 * former administrator returns an administrator. That is deliberate: the alternative is
 * silently demoting people, which is worse than visibly restoring them.
 */
export async function reactivateStaffUser(
  deps: AdminDeps,
  callerToken: string | null | undefined,
  ref: StaffRef,
): Promise<Result<StaffFlagResult>> {
  return changeFlag(deps, callerToken, ref, 'reactivate');
}

/**
 * Promote or demote. `is_admin` has existed since Stage 2 part 3 and until now nothing but
 * the seed could set it, which meant every new administrator was a developer's errand.
 *
 * This is not a roles system and does not become one: it flips the one boolean that already
 * existed. What it cannot do is leave the workspace without an administrator — you cannot
 * demote yourself (another admin does that), you cannot demote the last one, and you cannot
 * promote someone who no longer has access.
 */
export async function setStaffAdmin(
  deps: AdminDeps,
  callerToken: string | null | undefined,
  ref: StaffRef,
  isAdmin: boolean,
): Promise<Result<StaffFlagResult>> {
  return changeFlag(deps, callerToken, ref, isAdmin ? 'promote' : 'demote');
}

/**
 * The roster, service-side. The BROWSER does not call this — it selects `app_users` under
 * RLS like every other read (migration 20260828010000 widened that policy to the roster).
 * This exists for the server's own decisions and for the one thing RLS cannot reach:
 * `auth.users.last_sign_in_at`, which lives in a schema the Data API does not expose at all.
 */
export async function listStaffUsers(
  deps: AdminDeps,
  callerToken: string | null | undefined,
): Promise<Result<readonly StaffListEntry[]>> {
  const admin = await requireAdmin(deps, callerToken);
  if (!admin.ok) return admin;
  const rows = await deps.staff.list();
  if (!rows.ok) return rows;
  return ok(rows.value.map(toListEntry));
}

/**
 * Generate a fresh password for an existing, active staff member. Shown once, as at
 * creation — there is no way to read the old one back, and nothing ever stored it.
 */
export async function resetStaffPassword(
  deps: AdminDeps,
  callerToken: string | null | undefined,
  ref: StaffRef,
): Promise<Result<CreatedStaffUser>> {
  const context = await authorize(deps, callerToken, ref, 'reset_password');
  if (!context.ok) {
    return context;
  }
  const { admin, row } = context.value;

  const password = generateStaffPassword();
  const set = await deps.authAdmin.setPassword(row.user_id, password);
  if (!set.ok) {
    return set;
  }

  const audited = await deps.audit.write({
    actor: admin.email,
    action: 'PASSWORD_RESET',
    entityType: 'app_users',
    entityId: row.user_id,
  });
  if (!audited.ok) {
    return err(
      new AppError('INTERNAL', 'password was reset but the audit write failed — investigate', {
        context: { userId: row.user_id },
        cause: audited.error,
      }),
    );
  }

  deps.log.info('staff password reset', { userId: row.user_id, actorId: admin.userId });
  return ok({ userId: row.user_id, email: row.email, generatedPassword: password });
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

function toListEntry(row: StaffRow): StaffListEntry {
  return {
    userId: row.user_id,
    email: row.email,
    role: row.role,
    isActive: row.is_active,
    isAdmin: row.is_admin,
  };
}

/**
 * Everything the four change operations share: the caller is an active admin, the target
 * exists, and `access.ts` permits this action against it given how many administrators the
 * workspace currently has. The roster is read ONCE and used for both the target and the
 * count, so the decision is made against a single consistent picture.
 */
async function authorize(
  deps: AdminDeps,
  callerToken: string | null | undefined,
  ref: StaffRef,
  action: StaffChangeAction,
): Promise<Result<{ readonly admin: StaffIdentity; readonly row: StaffRow }>> {
  const admin = await requireAdmin(deps, callerToken);
  if (!admin.ok) {
    return admin;
  }

  let wanted: string;
  if ('email' in ref) {
    const email = normalizeEmail(ref.email);
    if (!email.ok) {
      return email;
    }
    wanted = email.value;
  } else {
    wanted = ref.userId;
  }

  const roster = await deps.staff.list();
  if (!roster.ok) {
    return roster;
  }
  const row = roster.value.find((candidate) =>
    'email' in ref ? candidate.email === wanted : candidate.user_id === wanted,
  );
  if (row === undefined) {
    return err(new ValidationError('no staff allowlist row for that person'));
  }

  const actor: StaffActor = { userId: admin.value.userId, isAdmin: admin.value.isAdmin };
  const target: StaffTarget = {
    userId: row.user_id,
    isActive: row.is_active,
    isAdmin: row.is_admin,
  };
  const verdict = canChangeStaff(
    action,
    target,
    actor,
    countActiveAdmins(roster.value.map(toListEntry)),
  );
  if (!verdict.allowed) {
    // The message is the one the person will read; the code and the reason are what an
    // operator greps for. No email in either — rule 20.
    return err(
      new AppError('FORBIDDEN', verdict.message, {
        context: { reason: verdict.because, action, userId: row.user_id },
      }),
    );
  }
  return ok({ admin: admin.value, row });
}

/**
 * The one write behind deactivate / reactivate / promote / demote. Each is a flag flip plus,
 * for the two that change whether a person can sign in, the matching GoTrue ban state — and
 * exactly one audit row naming the human who did it.
 */
async function changeFlag(
  deps: AdminDeps,
  callerToken: string | null | undefined,
  ref: StaffRef,
  action: Extract<StaffChangeAction, 'deactivate' | 'reactivate' | 'promote' | 'demote'>,
): Promise<Result<StaffFlagResult>> {
  const context = await authorize(deps, callerToken, ref, action);
  if (!context.ok) {
    return context;
  }
  const { admin, row } = context.value;
  const active = action === 'reactivate';
  const isAccess = action === 'deactivate' || action === 'reactivate';

  const flipped = isAccess
    ? await deps.staff.setActive(row.user_id, active)
    : await deps.staff.setAdmin(row.user_id, action === 'promote');
  if (!flipped.ok) {
    return flipped;
  }

  if (isAccess) {
    const banned = await deps.authAdmin.setBanned(row.user_id, !active);
    if (!banned.ok) {
      // For a deactivation the database refusal is already in force and the ban is belt and
      // braces; for a reactivation the opposite — the row says yes and the ban still says
      // no, so the person cannot sign in. Either way: report it, never pretend it worked.
      return err(
        new AppError(
          'INTERNAL',
          `app_users was updated but the auth ${active ? 'unban' : 'ban'} failed`,
          {
            context: { userId: row.user_id, action },
            cause: banned.error,
          },
        ),
      );
    }
  }

  const AUDIT: Readonly<Record<typeof action, AuditAction>> = {
    deactivate: 'USER_DEACTIVATED',
    reactivate: 'USER_REACTIVATED',
    promote: 'USER_PROMOTED',
    demote: 'USER_DEMOTED',
  };
  const audited = await deps.audit.write({
    actor: admin.email,
    action: AUDIT[action],
    entityType: 'app_users',
    entityId: row.user_id,
  });
  if (!audited.ok) {
    return err(
      new AppError('INTERNAL', 'the change was made but the audit write failed — investigate', {
        context: { userId: row.user_id, action },
        cause: audited.error,
      }),
    );
  }

  deps.log.info('staff account changed', {
    userId: row.user_id,
    actorId: admin.userId,
    action,
    changed: flipped.value.changed,
    activeAdmins: flipped.value.activeAdmins,
  });
  return ok({
    userId: row.user_id,
    email: row.email,
    changed: flipped.value.changed,
    activeAdmins: flipped.value.activeAdmins,
  });
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
