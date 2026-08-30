/**
 * The Users page's browser half, without a browser: the request/response client
 * (web/src/lib/usersApi.ts) and the view logic over the roster (web/src/lib/usersView.ts).
 *
 * The point of the view tests is Part C item 3 from the interface's side: the buttons a
 * person is offered come from `canChangeStaff` — the same function the server enforces — so
 * the page cannot offer an action that would be refused, and cannot hide one that would be
 * allowed. The server-side half is tests/unit/auth/page.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import type { StaffActor } from '../../../src/lib/auth/access.js';
import {
  USERS_MESSAGES,
  callUsers,
  interpretUsersResponse,
  type UsersOutcome,
} from '../../../web/src/lib/usersApi.js';
import { canManageStaff } from '../../../src/lib/auth/access.js';
import {
  buildRoster,
  lastSeenLabel,
  statusLabel,
  type AppUserRow,
} from '../../../web/src/lib/usersView.js';

const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const STAFF_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const GONE_ID = 'cccccccc-0000-4000-8000-000000000003';

// Shaped like a generated password, not one: built by concatenation so the secret scanner
// reads no literal here (the same convention as tests/unit/logger.test.ts).
const FAKE_PASSWORD = ['AbCd', '2345', 'EfGh', '6789', 'JkLm'].join('');

const ADMIN: StaffActor = { userId: ADMIN_ID, isAdmin: true };
const MEMBER: StaffActor = { userId: STAFF_ID, isAdmin: false };

function row(overrides: Partial<AppUserRow> & { user_id: string; email: string }): AppUserRow {
  return {
    role: 'staff',
    is_active: true,
    is_admin: false,
    created_at: '2026-08-01T02:00:00Z',
    ...overrides,
  };
}

const ROSTER: readonly AppUserRow[] = [
  row({ user_id: STAFF_ID, email: 'zoe@fundd.com.au' }),
  row({ user_id: ADMIN_ID, email: 'ross@fundd.com.au', is_admin: true, role: 'owner' }),
  row({ user_id: GONE_ID, email: 'alex@fundd.com.au', is_active: false }),
];

// ---------------------------------------------------------------------------------------
// usersView
// ---------------------------------------------------------------------------------------

describe('buildRoster', () => {
  it('puts the people who have access first, then orders by email — never by rank', () => {
    const roster = buildRoster(ROSTER, ADMIN);
    expect(roster.members.map((m) => m.email)).toStrictEqual([
      'ross@fundd.com.au',
      'zoe@fundd.com.au',
      'alex@fundd.com.au',
    ]);
    expect(roster.activeCount).toBe(2);
    expect(roster.inactiveCount).toBe(1);
    expect(roster.activeAdmins).toBe(1);
  });

  it('offers an admin exactly the actions the server would allow, and no others', () => {
    const roster = buildRoster(ROSTER, ADMIN);
    const zoe = roster.members.find((m) => m.email === 'zoe@fundd.com.au');
    const alex = roster.members.find((m) => m.email === 'alex@fundd.com.au');
    const ross = roster.members.find((m) => m.email === 'ross@fundd.com.au');

    // An ordinary active member: everything except the two that would undo a state she is
    // not in (there is no "restore access" for someone who has it).
    expect(zoe?.can).toStrictEqual({
      deactivate: true,
      reactivate: false,
      reset_password: true,
    });
    // Someone deactivated: only restoring their access is on offer. Not a reset — that
    // would put a live password on an account that cannot sign in.
    expect(alex?.can).toStrictEqual({
      deactivate: false,
      reactivate: true,
      reset_password: false,
    });
    // Yourself, and the only administrator: you may reset your own password and nothing else.
    expect(ross?.can).toStrictEqual({
      deactivate: false,
      reactivate: false,
      reset_password: true,
    });
    expect(ross?.isYou).toBe(true);
  });

  it('offers a non-admin nothing at all, on every row including their own', () => {
    const roster = buildRoster(ROSTER, MEMBER);
    for (const member of roster.members) {
      expect(
        Object.values(member.can).every((allowed) => !allowed),
        member.email,
      ).toBe(true);
    }
  });

  it('D74: with two administrators, neither is offered anything on the other but a reset', () => {
    const two = [
      ...ROSTER,
      row({
        user_id: 'dddddddd-0000-4000-8000-000000000004',
        email: 'sam@fundd.com.au',
        is_admin: true,
      }),
    ];
    const roster = buildRoster(two, ADMIN);
    const sam = roster.members.find((m) => m.email === 'sam@fundd.com.au');
    expect(roster.activeAdmins).toBe(2);
    // D72 took away Remove access on another admin; D74 took away the promote/demote pair
    // from the page entirely. What is left between two administrators is a password reset,
    // which hands over nothing and takes nothing away.
    expect(sam?.can).toStrictEqual({
      deactivate: false,
      reactivate: false,
      reset_password: true,
    });
  });

  it('D72/D74: an admin is protected, an ordinary member is not', () => {
    // The same row, the one difference being the admin flag. Admin: nothing destructive.
    // Member: access can be removed, as it always could.
    const asAdmin = row({
      user_id: 'dddddddd-0000-4000-8000-000000000004',
      email: 'sam@fundd.com.au',
      is_admin: true,
    });
    const protectedRow = buildRoster([...ROSTER, asAdmin], ADMIN).members.find(
      (m) => m.email === 'sam@fundd.com.au',
    );
    expect(protectedRow?.can.deactivate).toBe(false);

    const ordinary = buildRoster([...ROSTER, { ...asAdmin, is_admin: false }], ADMIN).members.find(
      (m) => m.email === 'sam@fundd.com.au',
    );
    expect(ordinary?.can.deactivate).toBe(true);
  });

  it('D74: the page has no promote or demote to offer anyone', () => {
    // Appointing an administrator is a rare, deliberate act and belongs to the break-glass
    // CLI. The keys are not merely false here — they are gone.
    const roster = buildRoster(ROSTER, ADMIN);
    for (const member of roster.members) {
      expect(Object.keys(member.can).sort(), member.email).toStrictEqual([
        'deactivate',
        'reactivate',
        'reset_password',
      ]);
    }
  });

  it('D72: a NON-admin is still offered nothing at all on anybody', () => {
    // The rule tightens what an admin may do. It must not accidentally hand a member
    // anything — they see the roster and no controls, exactly as before (D56).
    const two = [
      ...ROSTER,
      row({
        user_id: 'dddddddd-0000-4000-8000-000000000004',
        email: 'sam@fundd.com.au',
        is_admin: true,
      }),
    ];
    expect(canManageStaff(MEMBER)).toBe(false);
    const roster = buildRoster(two, MEMBER);
    for (const member of roster.members) {
      expect(Object.values(member.can).some(Boolean), member.email).toBe(false);
    }
  });

  it('shows the date someone was added, and never their id or their role label', () => {
    const roster = buildRoster(ROSTER, ADMIN);
    const view = roster.members[0];
    expect(view?.addedOn).toBe('1 Aug 2026');
    expect(JSON.stringify(view)).not.toContain('owner');
  });

  it('a malformed created_at degrades to an empty date rather than "Invalid Date"', () => {
    const roster = buildRoster(
      [row({ user_id: STAFF_ID, email: 'a@b.co', created_at: 'nope' })],
      ADMIN,
    );
    expect(roster.members[0]?.addedOn).toBe('');
  });
});

describe('lastSeenLabel', () => {
  it('is a dash when this viewer cannot know, "Never" when they have not signed in', () => {
    expect(lastSeenLabel(undefined, false)).toBe('—');
    expect(lastSeenLabel({ userId: STAFF_ID, lastSignInAt: '2026-08-27T01:00:00Z' }, false)).toBe(
      '—',
    );
    expect(lastSeenLabel(undefined, true)).toBe('Never');
    expect(lastSeenLabel({ userId: STAFF_ID, lastSignInAt: null }, true)).toBe('Never');
  });

  it('is the date, in Perth time, once they have', () => {
    expect(lastSeenLabel({ userId: STAFF_ID, lastSignInAt: '2026-08-27T01:00:00Z' }, true)).toBe(
      '27 Aug 2026',
    );
  });

  it('a sign-in timestamp the server could not parse degrades to a dash', () => {
    expect(lastSeenLabel({ userId: STAFF_ID, lastSignInAt: 'not-a-date' }, true)).toBe('—');
  });

  it('the roster carries the label through, and only for an admin who asked', () => {
    const seen = [{ userId: STAFF_ID, lastSignInAt: '2026-08-27T01:00:00Z' }];
    expect(buildRoster(ROSTER, ADMIN, seen, true).members[1]?.lastSeen).toBe('27 Aug 2026');
    expect(buildRoster(ROSTER, MEMBER).members[1]?.lastSeen).toBe('—');
  });
});

describe('statusLabel', () => {
  it('says the two things a person scanning a list needs, in that order', () => {
    const roster = buildRoster(ROSTER, ADMIN);
    expect(roster.members.map(statusLabel)).toStrictEqual([
      'Administrator',
      'Team member',
      'No longer has access',
    ]);
  });
});

// ---------------------------------------------------------------------------------------
// usersApi
// ---------------------------------------------------------------------------------------

describe('interpretUsersResponse', () => {
  it('reads a created account and its one-time password', () => {
    const outcome = interpretUsersResponse(200, {
      action: 'create',
      userId: STAFF_ID,
      email: 'new@fundd.com.au',
      oneTimePassword: FAKE_PASSWORD,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.reply).toStrictEqual({
      action: 'create',
      userId: STAFF_ID,
      email: 'new@fundd.com.au',
      oneTimePassword: FAKE_PASSWORD,
    });
  });

  it('reads a flag change, including the administrator count it reports back', () => {
    const outcome = interpretUsersResponse(200, {
      action: 'reactivate',
      outcome: 'changed',
      userId: STAFF_ID,
      email: 'zoe@fundd.com.au',
      activeAdmins: 1,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok' || !('outcome' in outcome.reply)) return;
    expect(outcome.reply.activeAdmins).toBe(1);
  });

  it('reads sign-ins, treating a missing timestamp as never', () => {
    const outcome = interpretUsersResponse(200, {
      action: 'sign_ins',
      signIns: [{ userId: STAFF_ID }, { userId: ADMIN_ID, lastSignInAt: '2026-08-27T01:00:00Z' }],
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok' || outcome.reply.action !== 'sign_ins') return;
    expect(outcome.reply.signIns[0]?.lastSignInAt).toBeNull();
  });

  it('a 200 whose body is not a reply we understand is retryable, never treated as success', () => {
    for (const body of [null, {}, { action: 'create' }, { action: 'demote', outcome: 'maybe' }]) {
      const outcome = interpretUsersResponse(200, body);
      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') continue;
      expect(outcome.failure).toBe('retryable');
    }
  });

  it('separates "not you, not here" from "not this change" on a 403', () => {
    const notHere = interpretUsersResponse(403, {
      error: { code: 'FORBIDDEN', message: 'This account does not have access.', retryable: false },
    });
    const notThis = interpretUsersResponse(403, {
      error: {
        code: 'LAST_ADMIN',
        message: 'The Command Centre must always have at least one administrator.',
        retryable: false,
      },
    });
    expect(notHere.kind === 'error' && notHere.failure).toBe('forbidden');
    expect(notThis.kind === 'error' && notThis.failure).toBe('refused');
    // The server's own sentence is what the person reads, because access.ts wrote it for them.
    expect(notThis.kind === 'error' && notThis.message).toContain('at least one administrator');
  });

  it('maps 401, 409, 400 and an unknown status to what the page should do', () => {
    const cases: readonly [number, unknown, string][] = [
      [401, null, 'unauthenticated'],
      [
        409,
        { error: { code: 'ALREADY_EXISTS', message: 'already on the list', retryable: false } },
        'duplicate',
      ],
      [
        400,
        { error: { code: 'BAD_REQUEST', message: 'Enter their email address.', retryable: false } },
        'fatal',
      ],
      [504, null, 'retryable'],
      [500, { error: { code: 'INTERNAL', message: 'Internal error.', retryable: false } }, 'fatal'],
      [503, { error: { code: 'NETWORK', message: 'x', retryable: true } }, 'retryable'],
    ];
    for (const [status, body, expected] of cases) {
      const outcome = interpretUsersResponse(status, body);
      expect(outcome.kind, String(status)).toBe('error');
      if (outcome.kind !== 'error') continue;
      expect(outcome.failure, String(status)).toBe(expected);
    }
  });

  it('never shows a raw status code to the person', () => {
    const outcome = interpretUsersResponse(502, null);
    expect(outcome.kind === 'error' && outcome.message).toBe(USERS_MESSAGES.unknown);
  });
});

describe('callUsers', () => {
  function deps(fetchImpl: typeof fetch): Parameters<typeof callUsers>[0] {
    return {
      adminUrl: 'https://stack.test/functions/v1/admin',
      anonKey: 'anon-key-not-a-secret',
      fetch: fetchImpl,
      timeoutMs: 50,
    };
  }

  it('posts the request with the caller session and the anon key, and reads the reply', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      seen.push({ url, init: init ?? {} });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            action: 'reactivate',
            outcome: 'changed',
            userId: STAFF_ID,
            email: 'zoe@fundd.com.au',
            activeAdmins: 2,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as unknown as typeof fetch;

    const outcome = await callUsers(deps(fetchImpl), 'session-token', {
      action: 'reactivate',
      userId: STAFF_ID,
    });
    expect(outcome.kind).toBe('ok');
    expect(seen[0]?.url).toBe('https://stack.test/functions/v1/admin');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer session-token');
    expect(headers['apikey']).toBe('anon-key-not-a-secret');
    expect(seen[0]?.init.body).toBe(JSON.stringify({ action: 'reactivate', userId: STAFF_ID }));
  });

  it('a transport failure is an outcome, never a throw', async () => {
    const fetchImpl = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const outcome: UsersOutcome = await callUsers(deps(fetchImpl), 'token', { action: 'sign_ins' });
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.code).toBe('NETWORK');
    expect(outcome.message).toBe(USERS_MESSAGES.network);
  });

  it('a timeout says "check the list", because creating a user is not idempotent', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })) as unknown as typeof fetch;
    const outcome = await callUsers(deps(fetchImpl), 'token', {
      action: 'create',
      email: 'a@b.co',
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.code).toBe('CLIENT_TIMEOUT');
    expect(outcome.message).toContain('Check the list');
  });

  it('a body that is not JSON is still an outcome the page can show', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response('<html>gateway</html>', { status: 502 }),
      )) as unknown as typeof fetch;
    const outcome = await callUsers(deps(fetchImpl), 'token', { action: 'sign_ins' });
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.status).toBe(502);
  });
});
