/**
 * The Users page's server handler (src/lib/auth/page.ts) — the thing the `admin` Edge
 * Function is a five-line adapter over. Every dependency is faked, so there is no network
 * (TESTING.md rule) and no stack, and a capturing log sink is scanned after every test.
 *
 * Part C assertions proved here:
 *   2 — the generated password is in exactly ONE response body and in no log line, no audit
 *       entry and no stored row; asking again never returns it;
 *   3 — a non-admin is refused at the SERVER for every action, with nothing written;
 *   4 — no request the page can send leaves the workspace with zero administrators;
 *   8 — every action that changed something wrote one audit_log row naming the acting admin.
 */
import { describe, expect, it } from 'vitest';

import type { AdminDeps, AuditEntry } from '../../../src/lib/auth/admin.js';
import {
  handleUsersRequest,
  type UsersPageDeps,
  type UsersPageResult,
  type UsersRequestBody,
} from '../../../src/lib/auth/page.js';
import { STAFF_PASSWORD_LENGTH } from '../../../src/lib/auth/password.js';
import type { StaffRow } from '../../../src/lib/auth/verify.js';
import { ok } from '../../../src/lib/errors.js';
import { createLogger } from '../../../src/lib/logger.js';

const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const STAFF_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const NEW_ID = 'cccccccc-0000-4000-8000-000000000003';
const ADMIN_TOKEN = 'admin-token';
const STAFF_TOKEN = 'staff-token';

interface Harness {
  readonly deps: UsersPageDeps;
  readonly rows: Map<string, StaffRow>;
  readonly audit: AuditEntry[];
  readonly logLines: string[];
  readonly passwordsSet: string[];
}

/**
 * D74 removed promote/demote from this endpoint, so a test that needs two administrators can
 * no longer make one through the API. It seeds the row instead, which is closer to the truth
 * anyway: a second admin is appointed by `npm run staff -- promote`, not from the browser.
 */
function makeHarness(secondAdmin = false): Harness {
  const rows = new Map<string, StaffRow>([
    [
      ADMIN_ID,
      { user_id: ADMIN_ID, email: 'admin@x.com', role: 'owner', is_active: true, is_admin: true },
    ],
    [
      STAFF_ID,
      {
        user_id: STAFF_ID,
        email: 'staff@x.com',
        role: 'staff',
        is_active: true,
        is_admin: secondAdmin,
      },
    ],
  ]);
  const audit: AuditEntry[] = [];
  const logLines: string[] = [];
  const passwordsSet: string[] = [];
  const admins = (): number => [...rows.values()].filter((r) => r.is_active && r.is_admin).length;

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
        passwordsSet.push(password);
        return Promise.resolve(ok({ id: NEW_ID, email }));
      },
      setPassword: (_userId, password) => {
        passwordsSet.push(password);
        return Promise.resolve(ok(undefined));
      },
      setBanned: () => Promise.resolve(ok(undefined)),
      lastSignIns: () =>
        Promise.resolve(
          ok([
            { userId: ADMIN_ID, lastSignInAt: '2026-08-27T01:00:00Z' },
            { userId: STAFF_ID, lastSignInAt: null },
            // An auth account with no allowlist row: not this workspace's business.
            {
              userId: 'dddddddd-0000-4000-8000-000000000004',
              lastSignInAt: '2026-01-01T00:00:00Z',
            },
          ]),
        ),
    },
    staff: {
      getByEmail: (email) =>
        Promise.resolve(ok([...rows.values()].find((r) => r.email === email) ?? null)),
      getById: (userId) => Promise.resolve(ok(rows.get(userId) ?? null)),
      insert: (row) => {
        rows.set(row.user_id, row);
        return Promise.resolve(ok(undefined));
      },
      setActive: (userId, active) => {
        const row = rows.get(userId);
        const changed = row !== undefined && row.is_active !== active;
        if (row !== undefined) rows.set(userId, { ...row, is_active: active });
        return Promise.resolve(ok({ changed, activeAdmins: admins() }));
      },
      setAdmin: (userId, admin) => {
        const row = rows.get(userId);
        const changed = row !== undefined && row.is_admin !== admin;
        if (row !== undefined) rows.set(userId, { ...row, is_admin: admin });
        return Promise.resolve(ok({ changed, activeAdmins: admins() }));
      },
      list: () => Promise.resolve(ok([...rows.values()])),
    },
    audit: {
      write: (entry) => {
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

  return { deps: deps, rows, audit, logLines, passwordsSet };
}

function post(h: Harness, body: UsersRequestBody, token = ADMIN_TOKEN): Promise<UsersPageResult> {
  return handleUsersRequest(h.deps, { token, body });
}

/** The body of a 200, narrowed. Fails loudly rather than returning something optional. */
function reply(result: UsersPageResult): Record<string, unknown> {
  expect(result.status).toBe(200);
  return result.body as unknown as Record<string, unknown>;
}

function errorBody(result: UsersPageResult): { code: string; message: string } {
  const body = result.body as unknown as { error?: { code: string; message: string } };
  expect(body.error).toBeDefined();
  return body.error ?? { code: '', message: '' };
}

describe('create', () => {
  it('an admin adds an email and gets an account plus one password, once', async () => {
    const h = makeHarness();
    const result = await post(h, { action: 'create', email: ' New.Person@Fundd.COM.AU ' });
    const body = reply(result);
    expect(body['action']).toBe('create');
    expect(body['userId']).toBe(NEW_ID);
    expect(body['email']).toBe('new.person@fundd.com.au');
    expect(String(body['oneTimePassword'])).toHaveLength(STAFF_PASSWORD_LENGTH);
    expect(h.rows.get(NEW_ID)?.is_admin).toBe(false);
    expect(h.audit).toStrictEqual([
      { actor: 'admin@x.com', action: 'USER_CREATED', entityType: 'app_users', entityId: NEW_ID },
    ]);
  });

  it('Part C 2: the password is in that one body and nowhere else — ever', async () => {
    const h = makeHarness();
    const created = reply(await post(h, { action: 'create', email: 'new@x.com' }));
    const password = String(created['oneTimePassword']);

    // Not in any log line, not in the audit trail, not in any stored row.
    for (const line of h.logLines) expect(line).not.toContain(password);
    expect(JSON.stringify(h.audit)).not.toContain(password);
    expect(JSON.stringify([...h.rows.values()])).not.toContain(password);

    // And not in any LATER response: no action returns it a second time.
    const later = [
      await post(h, { action: 'sign_ins' }),
      await post(h, { action: 'promote', userId: NEW_ID }),
      await post(h, { action: 'demote', userId: NEW_ID }),
      await post(h, { action: 'deactivate', userId: NEW_ID }),
    ];
    for (const result of later) {
      expect(JSON.stringify(result.body)).not.toContain(password);
    }
  });

  it('409 when the email is already on the list, with wording that points at the fix', async () => {
    const h = makeHarness();
    const result = await post(h, { action: 'create', email: 'STAFF@x.com' });
    expect(result.status).toBe(409);
    expect(errorBody(result).code).toBe('ALREADY_EXISTS');
    expect(errorBody(result).message).toContain('restored');
  });

  it('400 for a missing, empty or absurdly long email', async () => {
    const h = makeHarness();
    expect((await post(h, { action: 'create' })).status).toBe(400);
    expect((await post(h, { action: 'create', email: '   ' })).status).toBe(400);
    const long = `${'a'.repeat(250)}@x.com`;
    expect((await post(h, { action: 'create', email: long })).status).toBe(400);
    expect(h.rows.size).toBe(2);
  });
});

describe('Part C 3: a non-admin is refused at the server, not merely unshown', () => {
  const attempts: readonly UsersRequestBody[] = [
    { action: 'create', email: 'sneaky@x.com' },
    { action: 'deactivate', userId: ADMIN_ID },
    { action: 'reactivate', userId: ADMIN_ID },
    { action: 'reset_password', userId: ADMIN_ID },
    { action: 'sign_ins' },
  ];

  it('every action answers 403 and changes nothing', async () => {
    const h = makeHarness();
    const before = JSON.stringify([...h.rows.values()]);
    for (const body of attempts) {
      const result = await post(h, body, STAFF_TOKEN);
      expect(result.status, String(body.action)).toBe(403);
      expect(errorBody(result).code).toBe('NOT_ADMIN');
    }
    expect(JSON.stringify([...h.rows.values()])).toBe(before);
    expect(h.audit).toStrictEqual([]);
    expect(h.passwordsSet).toStrictEqual([]);
  });

  it('no token at all is 401, and a token GoTrue rejects is 401', async () => {
    const h = makeHarness();
    expect(
      (await handleUsersRequest(h.deps, { token: null, body: { action: 'sign_ins' } })).status,
    ).toBe(401);
    expect((await post(h, { action: 'sign_ins' }, 'nonsense')).status).toBe(401);
  });

  it('a DEACTIVATED admin, whose session is still valid, is refused as "no access"', async () => {
    const h = makeHarness();
    const admin = h.rows.get(ADMIN_ID);
    if (admin === undefined) throw new Error('fixture missing');
    h.rows.set(ADMIN_ID, { ...admin, is_active: false });
    const result = await post(h, { action: 'create', email: 'x@y.co' });
    expect(result.status).toBe(403);
    expect(errorBody(result).code).toBe('FORBIDDEN');
    expect(errorBody(result).message).toBe('This account does not have access.');
  });
});

describe('the four flag actions', () => {
  it('deactivate and reactivate each report and audit exactly once', async () => {
    const h = makeHarness();
    const deactivated = reply(await post(h, { action: 'deactivate', userId: STAFF_ID }));
    expect(deactivated['outcome']).toBe('changed');
    expect(deactivated['activeAdmins']).toBe(1);

    const again = reply(await post(h, { action: 'deactivate', userId: STAFF_ID }));
    expect(again['outcome']).toBe('unchanged');

    const restored = reply(await post(h, { action: 'reactivate', userId: STAFF_ID }));
    expect(restored['activeAdmins']).toBe(1);

    // Part C 8: one row per change, naming the admin who asked — and an idempotent no-op
    // is still a change of record, because someone did ask for it.
    expect(h.audit.map((a) => a.action)).toStrictEqual([
      'USER_DEACTIVATED',
      'USER_DEACTIVATED',
      'USER_REACTIVATED',
    ]);
    for (const entry of h.audit) {
      expect(entry.actor).toBe('admin@x.com');
      expect(entry.entityType).toBe('app_users');
      expect(entry.entityId).toBe(STAFF_ID);
    }
  });

  it("D72: the SERVER refuses removing an active administrator's access, not just the page", async () => {
    // Two administrators, so the last-admin rule is not what is doing the refusing.
    const h = makeHarness(true);
    expect([...h.rows.values()].filter((r) => r.is_active && r.is_admin)).toHaveLength(2);

    const refused = await post(h, { action: 'deactivate', userId: STAFF_ID });
    expect(refused.status).toBe(403);
    expect(errorBody(refused).code).toBe('ADMIN_TARGET');
    expect(h.rows.get(STAFF_ID)?.is_active, 'nothing moved').toBe(true);
    expect(h.audit, 'and nothing was recorded either').toStrictEqual([]);
  });

  it('D74: promote and demote are not actions this endpoint has any more', async () => {
    // The workspace has one administrator in normal use, so appointing one is a rare,
    // deliberate act and belongs to `npm run staff -- promote`, not to a button. The endpoint
    // does not merely hide them — it does not know them.
    const h = makeHarness(true);
    for (const action of ['promote', 'demote'] as const) {
      const result = await post(h, { action, userId: STAFF_ID });
      expect(result.status, action).toBe(400);
      expect(errorBody(result).message).not.toContain(action);
    }
    expect(h.rows.get(STAFF_ID)?.is_admin, 'nothing moved').toBe(true);
    expect(h.audit).toStrictEqual([]);
  });

  it('Part C 4: nothing the page can send reaches zero administrators', async () => {
    // Narrower than it was, because the page is narrower (D74): demote is not an action any
    // more, so the only route to zero administrators the browser has is an admin removing
    // their own access — refused by name.
    const h = makeHarness();
    const result = await post(h, { action: 'deactivate', userId: ADMIN_ID });
    expect(result.status).toBe(403);
    expect(errorBody(result).code).toBe('SELF_DEACTIVATION');

    // And with a SECOND administrator it is still refused, now by D72: administrators do not
    // remove each other. Either way the count cannot fall to zero from this endpoint.
    const two = makeHarness(true);
    const other = await post(two, { action: 'deactivate', userId: STAFF_ID });
    expect(other.status).toBe(403);
    expect(errorBody(other).code).toBe('ADMIN_TARGET');
    expect([...two.rows.values()].filter((r) => r.is_active && r.is_admin)).toHaveLength(2);
  });

  it('400 when the target is not a UUID, so an email can never be used as a handle here', async () => {
    const h = makeHarness();
    const result = await post(h, { action: 'deactivate', userId: 'staff@x.com' });
    expect(result.status).toBe(400);
    expect(errorBody(result).message).toContain('UUID');
  });

  it('a target that is not on the allowlist is a 400, not a 500', async () => {
    const h = makeHarness();
    const result = await post(h, {
      action: 'promote',
      userId: 'eeeeeeee-0000-4000-8000-000000000009',
    });
    expect(result.status).toBe(400);
  });
});

describe('reset_password', () => {
  it('returns a fresh password once and audits it, without touching the allowlist row', async () => {
    const h = makeHarness();
    const before = JSON.stringify(h.rows.get(STAFF_ID));
    const body = reply(await post(h, { action: 'reset_password', userId: STAFF_ID }));
    const password = String(body['oneTimePassword']);
    expect(password).toHaveLength(STAFF_PASSWORD_LENGTH);
    expect(h.passwordsSet).toStrictEqual([password]);
    expect(JSON.stringify(h.rows.get(STAFF_ID))).toBe(before);
    expect(h.audit.map((a) => a.action)).toStrictEqual(['PASSWORD_RESET']);
    for (const line of h.logLines) expect(line).not.toContain(password);
  });

  it('refuses for someone who no longer has access, and says to restore it first', async () => {
    const h = makeHarness();
    reply(await post(h, { action: 'deactivate', userId: STAFF_ID }));
    const result = await post(h, { action: 'reset_password', userId: STAFF_ID });
    expect(result.status).toBe(403);
    expect(errorBody(result).message).toContain('Restore their access');
  });
});

describe('sign_ins', () => {
  it('answers for allowlisted people only, with null for someone who never signed in', async () => {
    const h = makeHarness();
    const body = reply(await post(h, { action: 'sign_ins' }));
    const rows = body['signIns'] as { userId: string; lastSignInAt: string | null }[];
    expect(rows.map((r) => r.userId).sort()).toStrictEqual([ADMIN_ID, STAFF_ID].sort());
    expect(rows.find((r) => r.userId === STAFF_ID)?.lastSignInAt).toBeNull();
    expect(JSON.stringify(rows)).not.toContain('dddddddd');
  });
});

describe('the request envelope', () => {
  it('an unknown or missing action is a 400 that names the actions there are', async () => {
    const h = makeHarness();
    for (const body of [{}, { action: 'delete' }, { action: 42 }]) {
      const result = await post(h, body);
      expect(result.status).toBe(400);
      expect(errorBody(result).message).toContain('create');
    }
  });

  it('never throws: a dependency that throws becomes a 500 with the cause logged', async () => {
    const h = makeHarness();
    const broken: UsersPageDeps = {
      ...h.deps,
      staff: {
        ...h.deps.staff,
        list: () => {
          throw new Error('boom');
        },
      },
    };
    const result = await handleUsersRequest(broken, {
      token: ADMIN_TOKEN,
      body: { action: 'deactivate', userId: STAFF_ID },
    });
    expect(result.status).toBe(500);
    expect(h.logLines.some((l) => l.includes('users request threw'))).toBe(true);
  });
});
