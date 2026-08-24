import { describe, expect, it } from 'vitest';

import { NetworkError, err, ok } from '../../../src/lib/errors.js';
import type { Result } from '../../../src/lib/errors.js';
import type { AuthTokenUser, StaffRow, VerifyDeps } from '../../../src/lib/auth/verify.js';
import { verifyStaffAccess } from '../../../src/lib/auth/verify.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function staffRow(overrides: Partial<StaffRow> = {}): StaffRow {
  return {
    user_id: USER_ID,
    email: 'x@y.com',
    role: 'staff',
    is_active: true,
    is_admin: false,
    ...overrides,
  };
}

interface DepsSpec {
  readonly user?: Result<AuthTokenUser | null>;
  readonly row?: Result<StaffRow | null>;
}

function makeDeps(spec: DepsSpec): VerifyDeps & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getUserFromToken: (token) => {
      calls.push(`getUser:${token}`);
      return Promise.resolve(spec.user ?? ok({ id: USER_ID, email: 'x@y.com' }));
    },
    getStaffRow: (userId) => {
      calls.push(`getStaff:${userId}`);
      return Promise.resolve(spec.row ?? ok(null));
    },
  };
}

describe('verifyStaffAccess', () => {
  it('401 missing_token for null, undefined and blank tokens — without asking the auth server', async () => {
    for (const token of [null, undefined, '', '   ']) {
      const deps = makeDeps({});
      const result = await verifyStaffAccess(deps, token);
      expect(result).toStrictEqual(
        ok({ kind: 'unauthenticated', httpStatus: 401, reason: 'missing_token' }),
      );
      expect(deps.calls).toStrictEqual([]);
    }
  });

  it('401 invalid_token when the auth server refuses the token (expired, tampered, banned)', async () => {
    const deps = makeDeps({ user: ok(null) });
    const result = await verifyStaffAccess(deps, 'some-expired-or-tampered-jwt');
    expect(result).toStrictEqual(
      ok({ kind: 'unauthenticated', httpStatus: 401, reason: 'invalid_token' }),
    );
    // No allowlist lookup for a token that proves nothing.
    expect(deps.calls).toStrictEqual(['getUser:some-expired-or-tampered-jwt']);
  });

  it('403 not_allowlisted for a real auth user with no app_users row', async () => {
    const deps = makeDeps({ row: ok(null) });
    const result = await verifyStaffAccess(deps, 'valid');
    expect(result).toStrictEqual(
      ok({ kind: 'forbidden', httpStatus: 403, reason: 'not_allowlisted' }),
    );
    expect(deps.calls).toStrictEqual(['getUser:valid', `getStaff:${USER_ID}`]);
  });

  it('403 deactivated when the allowlist row exists but is_active = false', async () => {
    const deps = makeDeps({ row: ok(staffRow({ is_active: false })) });
    const result = await verifyStaffAccess(deps, 'valid');
    expect(result).toStrictEqual(ok({ kind: 'forbidden', httpStatus: 403, reason: 'deactivated' }));
  });

  it('authorized for an active staff member, carrying is_admin through', async () => {
    for (const isAdmin of [false, true]) {
      const deps = makeDeps({ row: ok(staffRow({ is_admin: isAdmin, role: 'owner' })) });
      const result = await verifyStaffAccess(deps, 'valid');
      expect(result).toStrictEqual(
        ok({
          kind: 'authorized',
          httpStatus: 200,
          user: { userId: USER_ID, email: 'x@y.com', role: 'owner', isAdmin },
        }),
      );
    }
  });

  it('infrastructure failure is the error channel, never a 403', async () => {
    const authDown = new NetworkError('auth server unreachable');
    const authResult = await verifyStaffAccess(makeDeps({ user: err(authDown) }), 'valid');
    expect(authResult).toStrictEqual(err(authDown));

    const dbDown = new NetworkError('database unreachable');
    const dbResult = await verifyStaffAccess(makeDeps({ row: err(dbDown) }), 'valid');
    expect(dbResult).toStrictEqual(err(dbDown));
  });
});
