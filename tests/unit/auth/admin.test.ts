/**
 * Unit tests for the admin-only user management operations, with every dependency faked
 * (no network — TESTING.md rule) and a capturing log sink so the "generated password never
 * appears in a log line" claim is asserted here at the unit level, and again against a
 * real stack in tests/security/auth.test.ts.
 */
import { describe, expect, it } from 'vitest';

import type { AdminDeps, AuditEntry, CreatedStaffUser } from '../../../src/lib/auth/admin.js';
import {
  SEEDED_STAFF,
  attachSeededCredentials,
  createStaffUser,
  deactivateStaffUser,
  listStaffUsers,
  reactivateStaffUser,
  resetStaffPassword,
  setStaffAdmin,
} from '../../../src/lib/auth/admin.js';
import { STAFF_PASSWORD_LENGTH } from '../../../src/lib/auth/password.js';
import type { StaffRow } from '../../../src/lib/auth/verify.js';
import type { Result } from '../../../src/lib/errors.js';
import { AppError, NetworkError, err, isAppError, ok } from '../../../src/lib/errors.js';
import { createLogger } from '../../../src/lib/logger.js';

const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const STAFF_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const NEW_ID = 'cccccccc-0000-4000-8000-000000000003';

const ADMIN_TOKEN = 'admin-token';
const STAFF_TOKEN = 'staff-token';
const BAD_TOKEN = 'bad-token';

interface Harness {
  readonly deps: AdminDeps;
  readonly rows: Map<string, StaffRow>; // keyed by user_id
  readonly audit: AuditEntry[];
  readonly logLines: string[];
  readonly authCalls: string[];
  failures: {
    insert?: AppError;
    audit?: AppError;
    setBanned?: AppError;
    createUser?: AppError;
    /** What the database function raises when the write would leave zero admins. */
    setFlag?: AppError;
  };
}

/** Active administrators, as the database function counts them. */
function activeAdmins(rows: Map<string, StaffRow>): number {
  return [...rows.values()].filter((r) => r.is_active && r.is_admin).length;
}

function makeHarness(): Harness {
  const rows = new Map<string, StaffRow>([
    [
      ADMIN_ID,
      { user_id: ADMIN_ID, email: 'admin@x.com', role: 'owner', is_active: true, is_admin: true },
    ],
    [
      STAFF_ID,
      { user_id: STAFF_ID, email: 'staff@x.com', role: 'staff', is_active: true, is_admin: false },
    ],
  ]);
  const audit: AuditEntry[] = [];
  const logLines: string[] = [];
  const authCalls: string[] = [];
  const failures: Harness['failures'] = {};

  const byEmail = (email: string): StaffRow | null =>
    [...rows.values()].find((r) => r.email === email) ?? null;

  const deps: AdminDeps = {
    verify: {
      getUserFromToken: (token) => {
        if (token === ADMIN_TOKEN)
          return Promise.resolve(ok({ id: ADMIN_ID, email: 'admin@x.com' }));
        if (token === STAFF_TOKEN)
          return Promise.resolve(ok({ id: STAFF_ID, email: 'staff@x.com' }));
        return Promise.resolve(ok(null));
      },
      getStaffRow: (userId) => Promise.resolve(ok(rows.get(userId) ?? null)),
    },
    authAdmin: {
      createUser: (email, password) => {
        authCalls.push(`createUser:${email}:${password}`);
        if (failures.createUser !== undefined) return Promise.resolve(err(failures.createUser));
        return Promise.resolve(ok({ id: NEW_ID, email }));
      },
      setPassword: (userId, password) => {
        authCalls.push(`setPassword:${userId}:${password}`);
        return Promise.resolve(ok(undefined));
      },
      setBanned: (userId, banned) => {
        authCalls.push(`setBanned:${userId}:${String(banned)}`);
        if (failures.setBanned !== undefined) return Promise.resolve(err(failures.setBanned));
        return Promise.resolve(ok(undefined));
      },
      lastSignIns: () =>
        Promise.resolve(
          ok([
            { userId: ADMIN_ID, lastSignInAt: '2026-08-27T01:00:00Z' },
            { userId: STAFF_ID, lastSignInAt: null },
          ]),
        ),
    },
    staff: {
      getByEmail: (email) => Promise.resolve(ok(byEmail(email))),
      getById: (userId) => Promise.resolve(ok(rows.get(userId) ?? null)),
      insert: (row) => {
        if (failures.insert !== undefined) return Promise.resolve(err(failures.insert));
        rows.set(row.user_id, row);
        return Promise.resolve(ok(undefined));
      },
      setActive: (userId, active) => {
        if (failures.setFlag !== undefined) return Promise.resolve(err(failures.setFlag));
        const row = rows.get(userId);
        const changed = row !== undefined && row.is_active !== active;
        if (row !== undefined) rows.set(userId, { ...row, is_active: active });
        return Promise.resolve(ok({ changed, activeAdmins: activeAdmins(rows) }));
      },
      setAdmin: (userId, admin) => {
        if (failures.setFlag !== undefined) return Promise.resolve(err(failures.setFlag));
        const row = rows.get(userId);
        const changed = row !== undefined && row.is_admin !== admin;
        if (row !== undefined) rows.set(userId, { ...row, is_admin: admin });
        return Promise.resolve(ok({ changed, activeAdmins: activeAdmins(rows) }));
      },
      list: () => Promise.resolve(ok([...rows.values()])),
    },
    audit: {
      write: (entry) => {
        if (failures.audit !== undefined) return Promise.resolve(err(failures.audit));
        audit.push(entry);
        return Promise.resolve(ok(undefined));
      },
    },
    log: createLogger({
      level: 'debug',
      sink: (line) => {
        logLines.push(line);
      },
    }),
  };

  return { deps, rows, audit, logLines, authCalls, failures };
}

function expectErrCode<T>(result: Result<T>, code: string): AppError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected err');
  expect(isAppError(result.error)).toBe(true);
  expect(result.error.code).toBe(code);
  return result.error;
}

function expectOk<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function expectNoPasswordAnywhere(h: Harness, password: string): void {
  expect(password).toHaveLength(STAFF_PASSWORD_LENGTH);
  for (const line of h.logLines) {
    expect(line).not.toContain(password);
  }
  for (const entry of h.audit) {
    expect(JSON.stringify(entry)).not.toContain(password);
  }
  for (const row of h.rows.values()) {
    expect(JSON.stringify(row)).not.toContain(password);
  }
}

describe('createStaffUser', () => {
  it('admin adds an email → auth user + allowlist row + one-time password', async () => {
    const h = makeHarness();
    const created = expectOk(
      await createStaffUser(h.deps, ADMIN_TOKEN, '  New.Person@Fundd.COM.AU '),
    );

    expect(created.userId).toBe(NEW_ID);
    expect(created.email).toBe('new.person@fundd.com.au');
    expect(h.rows.get(NEW_ID)).toStrictEqual({
      user_id: NEW_ID,
      email: 'new.person@fundd.com.au',
      role: 'staff',
      is_active: true,
      is_admin: false, // never an admin by default
    });
    expect(h.audit).toStrictEqual([
      { actor: 'admin@x.com', action: 'USER_CREATED', entityType: 'app_users', entityId: NEW_ID },
    ]);
    expectNoPasswordAnywhere(h, created.generatedPassword);
  });

  it('refuses a caller who is staff but not admin, before touching the auth server', async () => {
    const h = makeHarness();
    const error = expectErrCode(await createStaffUser(h.deps, STAFF_TOKEN, 'a@b.co'), 'FORBIDDEN');
    expect(error.context['reason']).toBe('not_admin');
    expect(h.authCalls).toStrictEqual([]);
    expect(h.audit).toStrictEqual([]);
  });

  it('refuses an unauthenticated caller and a caller with an invalid token', async () => {
    const h = makeHarness();
    expectErrCode(await createStaffUser(h.deps, undefined, 'a@b.co'), 'UNAUTHENTICATED');
    expectErrCode(await createStaffUser(h.deps, BAD_TOKEN, 'a@b.co'), 'UNAUTHENTICATED');
    expect(h.authCalls).toStrictEqual([]);
  });

  it('refuses an implausible email without leaking the value into the error message', async () => {
    const h = makeHarness();
    const error = expectErrCode(
      await createStaffUser(h.deps, ADMIN_TOKEN, 'not-an-email'),
      'VALIDATION',
    );
    expect(error.message).not.toContain('not-an-email');
  });

  it('CONFLICT when the email is already on the allowlist — a re-run cannot mint a second identity', async () => {
    const h = makeHarness();
    const error = expectErrCode(
      await createStaffUser(h.deps, ADMIN_TOKEN, 'STAFF@x.com'),
      'CONFLICT',
    );
    expect(error.context['userId']).toBe(STAFF_ID);
    expect(h.authCalls).toStrictEqual([]);
  });

  it('propagates CONFLICT from the auth server (auth account exists without allowlist row)', async () => {
    const h = makeHarness();
    h.failures.createUser = new AppError(
      'CONFLICT',
      'auth.admin.createUser: identity already exists',
    );
    const result = await createStaffUser(h.deps, ADMIN_TOKEN, 'orphan@x.com');
    expectErrCode(result, 'CONFLICT');
  });

  it('surfaces an allowlist-insert failure loudly and logs the orphan auth account by id only', async () => {
    const h = makeHarness();
    h.failures.insert = new NetworkError('db down');
    const result = await createStaffUser(h.deps, ADMIN_TOKEN, 'x@y.co');
    expectErrCode(result, 'NETWORK');
    const orphanLine = h.logLines.find((l) => l.includes('orphan auth account'));
    expect(orphanLine).toBeDefined();
    expect(orphanLine).toContain(NEW_ID);
    expect(orphanLine).not.toContain('x@y.co'); // rule 20: no emails in log lines
  });

  it('an audit failure after creation is an INTERNAL error naming the created user', async () => {
    const h = makeHarness();
    h.failures.audit = new NetworkError('db down');
    const error = expectErrCode(await createStaffUser(h.deps, ADMIN_TOKEN, 'x@y.co'), 'INTERNAL');
    expect(error.context['userId']).toBe(NEW_ID);
  });
});

describe('deactivateStaffUser', () => {
  it('flips is_active, bans the auth account, audits, and never deletes', async () => {
    const h = makeHarness();
    const result = expectOk(
      await deactivateStaffUser(h.deps, ADMIN_TOKEN, { email: 'staff@x.com' }),
    );
    expect(result).toStrictEqual({
      userId: STAFF_ID,
      email: 'staff@x.com',
      changed: true,
      activeAdmins: 1,
    });
    expect(h.rows.get(STAFF_ID)?.is_active).toBe(false);
    expect(h.rows.has(STAFF_ID)).toBe(true); // the row survives
    expect(h.authCalls).toStrictEqual([`setBanned:${STAFF_ID}:true`]);
    expect(h.audit).toStrictEqual([
      {
        actor: 'admin@x.com',
        action: 'USER_DEACTIVATED',
        entityType: 'app_users',
        entityId: STAFF_ID,
      },
    ]);
  });

  it('is idempotent: deactivating an already-inactive user reports it and does not error', async () => {
    const h = makeHarness();
    expectOk(await deactivateStaffUser(h.deps, ADMIN_TOKEN, { email: 'staff@x.com' }));
    const second = expectOk(
      await deactivateStaffUser(h.deps, ADMIN_TOKEN, { email: 'staff@x.com' }),
    );
    expect(second.changed).toBe(false);
  });

  it('refuses self-deactivation, so the workspace can never reach zero active admins', async () => {
    const h = makeHarness();
    const error = expectErrCode(
      await deactivateStaffUser(h.deps, ADMIN_TOKEN, { email: 'admin@x.com' }),
      'FORBIDDEN',
    );
    expect(error.context['reason']).toBe('self_deactivation');
    expect(h.rows.get(ADMIN_ID)?.is_active).toBe(true);
    expect(h.authCalls).toStrictEqual([]);
  });

  it('refuses a non-admin caller and an unknown email', async () => {
    const h = makeHarness();
    expectErrCode(
      await deactivateStaffUser(h.deps, STAFF_TOKEN, { email: 'admin@x.com' }),
      'FORBIDDEN',
    );
    expectErrCode(
      await deactivateStaffUser(h.deps, ADMIN_TOKEN, { email: 'nobody@x.com' }),
      'VALIDATION',
    );
  });

  it('reports a ban failure instead of pretending, with the DB refusal already in force', async () => {
    const h = makeHarness();
    h.failures.setBanned = new NetworkError('auth down');
    const error = expectErrCode(
      await deactivateStaffUser(h.deps, ADMIN_TOKEN, { email: 'staff@x.com' }),
      'INTERNAL',
    );
    expect(error.context['userId']).toBe(STAFF_ID);
    expect(h.rows.get(STAFF_ID)?.is_active).toBe(false); // DB layer already flipped
  });
});

describe('resetStaffPassword', () => {
  it('sets a fresh generated password on an active user and audits it', async () => {
    const h = makeHarness();
    const reset = expectOk(await resetStaffPassword(h.deps, ADMIN_TOKEN, { email: 'staff@x.com' }));
    expect(reset.userId).toBe(STAFF_ID);
    expect(h.authCalls).toStrictEqual([`setPassword:${STAFF_ID}:${reset.generatedPassword}`]);
    expect(h.audit.map((a) => a.action)).toStrictEqual(['PASSWORD_RESET']);
    expectNoPasswordAnywhere(h, reset.generatedPassword);
  });

  it('refuses for a deactivated user and for a non-admin caller', async () => {
    const h = makeHarness();
    expectOk(await deactivateStaffUser(h.deps, ADMIN_TOKEN, { email: 'staff@x.com' }));
    expectErrCode(
      await resetStaffPassword(h.deps, ADMIN_TOKEN, { email: 'staff@x.com' }),
      'FORBIDDEN',
    );
    expectErrCode(
      await resetStaffPassword(h.deps, STAFF_TOKEN, { email: 'admin@x.com' }),
      'FORBIDDEN',
    );
  });
});

describe('attachSeededCredentials', () => {
  function seedRows(h: Harness): void {
    for (const seeded of Object.values(SEEDED_STAFF)) {
      h.rows.set(seeded.userId, {
        user_id: seeded.userId,
        email: seeded.email,
        role: 'owner',
        is_active: true,
        is_admin: true,
      });
    }
  }

  it('sets a password on the seeded fixed UUID without creating any user', async () => {
    const h = makeHarness();
    seedRows(h);
    const attached: CreatedStaffUser = expectOk(await attachSeededCredentials(h.deps, 'ross'));
    expect(attached.userId).toBe(SEEDED_STAFF.ross.userId);
    expect(attached.email).toBe(SEEDED_STAFF.ross.email);
    expect(h.authCalls).toStrictEqual([
      `setPassword:${SEEDED_STAFF.ross.userId}:${attached.generatedPassword}`,
    ]);
    expect(h.authCalls.some((c) => c.startsWith('createUser'))).toBe(false);
    expect(h.audit).toStrictEqual([
      {
        actor: 'bootstrap-cli',
        action: 'CREDENTIALS_ATTACHED',
        entityType: 'app_users',
        entityId: SEEDED_STAFF.ross.userId,
      },
    ]);
    expectNoPasswordAnywhere(h, attached.generatedPassword);
  });

  it('refuses to run against a database without the seeded row, or with an altered email', async () => {
    const h = makeHarness();
    expectErrCode(await attachSeededCredentials(h.deps, 'developer'), 'CONFIG');

    seedRows(h);
    const seeded = h.rows.get(SEEDED_STAFF.developer.userId);
    if (seeded === undefined) throw new Error('unreachable');
    h.rows.set(seeded.user_id, { ...seeded, email: 'attacker@evil.com' });
    expectErrCode(await attachSeededCredentials(h.deps, 'developer'), 'CONFIG');
    expect(h.authCalls).toStrictEqual([]);
  });
});

describe('reactivateStaffUser', () => {
  it('flips is_active back, lifts the ban, audits, and reports the admin count', async () => {
    const h = makeHarness();
    expectOk(await deactivateStaffUser(h.deps, ADMIN_TOKEN, { email: 'staff@x.com' }));
    const result = expectOk(await reactivateStaffUser(h.deps, ADMIN_TOKEN, { userId: STAFF_ID }));
    expect(result).toStrictEqual({
      userId: STAFF_ID,
      email: 'staff@x.com',
      changed: true,
      activeAdmins: 1,
    });
    expect(h.rows.get(STAFF_ID)?.is_active).toBe(true);
    expect(h.authCalls).toContain(`setBanned:${STAFF_ID}:false`);
    expect(h.audit.map((a) => a.action)).toStrictEqual(['USER_DEACTIVATED', 'USER_REACTIVATED']);
  });

  it('is idempotent on someone who already has access, and refuses a non-admin caller', async () => {
    const h = makeHarness();
    const again = expectOk(await reactivateStaffUser(h.deps, ADMIN_TOKEN, { userId: STAFF_ID }));
    expect(again.changed).toBe(false);
    expectErrCode(
      await reactivateStaffUser(h.deps, STAFF_TOKEN, { userId: ADMIN_ID }),
      'FORBIDDEN',
    );
  });

  it('reports a failed unban rather than pretending the person can sign in', async () => {
    const h = makeHarness();
    expectOk(await deactivateStaffUser(h.deps, ADMIN_TOKEN, { email: 'staff@x.com' }));
    h.failures.setBanned = new NetworkError('auth down');
    const error = expectErrCode(
      await reactivateStaffUser(h.deps, ADMIN_TOKEN, { userId: STAFF_ID }),
      'INTERNAL',
    );
    expect(error.message).toContain('unban');
  });
});

describe('setStaffAdmin — and the last-admin invariant', () => {
  it('promotes, audits as USER_PROMOTED, and reports two administrators', async () => {
    const h = makeHarness();
    const result = expectOk(await setStaffAdmin(h.deps, ADMIN_TOKEN, { userId: STAFF_ID }, true));
    expect(result.changed).toBe(true);
    expect(result.activeAdmins).toBe(2);
    expect(h.rows.get(STAFF_ID)?.is_admin).toBe(true);
    expect(h.audit.map((a) => a.action)).toStrictEqual(['USER_PROMOTED']);
    // Promotion changes exactly one flag: it is not a roles system by another name.
    expect(h.rows.get(STAFF_ID)?.role).toBe('staff');
    expect(h.authCalls).toStrictEqual([]); // no GoTrue involvement at all
  });

  it('demotes ANOTHER admin once there are two, and audits as USER_DEMOTED', async () => {
    const h = makeHarness();
    expectOk(await setStaffAdmin(h.deps, ADMIN_TOKEN, { userId: STAFF_ID }, true));
    const demoted = expectOk(await setStaffAdmin(h.deps, ADMIN_TOKEN, { userId: STAFF_ID }, false));
    expect(demoted.changed).toBe(true);
    expect(demoted.activeAdmins).toBe(1);
    expect(h.audit.map((a) => a.action)).toStrictEqual(['USER_PROMOTED', 'USER_DEMOTED']);
  });

  it('Part C 4: refuses self-demotion, so an admin cannot remove their own rights', async () => {
    const h = makeHarness();
    const error = expectErrCode(
      await setStaffAdmin(h.deps, ADMIN_TOKEN, { userId: ADMIN_ID }, false),
      'FORBIDDEN',
    );
    expect(error.context['reason']).toBe('self_demotion');
    expect(h.rows.get(ADMIN_ID)?.is_admin).toBe(true);
    expect(h.audit).toStrictEqual([]);
  });

  it('Part C 4: refuses to demote the last active admin even from another admin account', async () => {
    // Two admins; one is then deactivated, so only one ACTIVE admin remains. The other
    // admin's token is still valid (a session outlives the row it came from), and it is
    // exactly this path — a stale admin session — that could otherwise reach zero.
    const h = makeHarness();
    h.rows.set(STAFF_ID, {
      user_id: STAFF_ID,
      email: 'staff@x.com',
      role: 'staff',
      is_active: false,
      is_admin: true,
    });
    const error = expectErrCode(
      await setStaffAdmin(h.deps, STAFF_TOKEN, { userId: ADMIN_ID }, false),
      'FORBIDDEN',
    );
    // The caller is deactivated, so they never get as far as the count — refused at the door.
    expect(error.context['reason']).toBe('deactivated');
    expect(h.rows.get(ADMIN_ID)?.is_admin).toBe(true);
  });

  it('refuses to promote someone who no longer has access', async () => {
    const h = makeHarness();
    expectOk(await deactivateStaffUser(h.deps, ADMIN_TOKEN, { email: 'staff@x.com' }));
    const error = expectErrCode(
      await setStaffAdmin(h.deps, ADMIN_TOKEN, { userId: STAFF_ID }, true),
      'FORBIDDEN',
    );
    expect(error.context['reason']).toBe('inactive_target');
  });

  it("surfaces the database's own last-admin refusal rather than swallowing it", async () => {
    // The application check passes and the DATABASE refuses — the concurrent case the
    // advisory lock exists for. The error reaches the caller intact.
    const h = makeHarness();
    expectOk(await setStaffAdmin(h.deps, ADMIN_TOKEN, { userId: STAFF_ID }, true));
    h.audit.length = 0;
    h.failures.setFlag = new AppError('FORBIDDEN', 'at least one active administrator', {
      context: { reason: 'last_admin' },
    });
    const error = expectErrCode(
      await setStaffAdmin(h.deps, ADMIN_TOKEN, { userId: STAFF_ID }, false),
      'FORBIDDEN',
    );
    expect(error.context['reason']).toBe('last_admin');
    expect(h.audit).toStrictEqual([]); // nothing changed, so nothing is recorded
  });

  it('refuses a non-admin caller before reading the roster', async () => {
    const h = makeHarness();
    const error = expectErrCode(
      await setStaffAdmin(h.deps, STAFF_TOKEN, { userId: ADMIN_ID }, false),
      'FORBIDDEN',
    );
    expect(error.context['reason']).toBe('not_admin');
  });
});

describe('listStaffUsers', () => {
  it('returns the roster to an admin and nothing credential-shaped with it', async () => {
    const h = makeHarness();
    const rows = expectOk(await listStaffUsers(h.deps, ADMIN_TOKEN));
    expect(rows.map((r) => r.email).sort()).toStrictEqual(['admin@x.com', 'staff@x.com']);
    expect(JSON.stringify(rows)).not.toContain('password');
  });

  it('refuses a non-admin caller', async () => {
    const h = makeHarness();
    expectErrCode(await listStaffUsers(h.deps, STAFF_TOKEN), 'FORBIDDEN');
  });
});
