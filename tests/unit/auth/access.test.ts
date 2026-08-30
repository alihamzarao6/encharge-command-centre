/**
 * The one rule about who may change a staff account (src/lib/auth/access.ts) — the module
 * both the admin Edge Function and the browser import, so these assertions are assertions
 * about both sides at once.
 *
 * Part C item 4 lives here in its cheapest form: every path the users page offers is walked
 * against a workspace with one administrator, and none of them reaches zero. The same
 * property is proved again against a real database, under concurrency, in
 * tests/integration/users.test.ts — this file proves the interface never even asks.
 */
import { describe, expect, it } from 'vitest';

import {
  STAFF_EMAIL_MAX_CHARS,
  STAFF_REFUSAL_MESSAGES,
  canChangeStaff,
  canManageStaff,
  countActiveAdmins,
  type StaffActor,
  type StaffChangeAction,
  type StaffTarget,
} from '../../../src/lib/auth/access.js';

const ADMIN: StaffActor = { userId: 'admin', isAdmin: true };
const MEMBER: StaffActor = { userId: 'member', isAdmin: false };

function target(overrides: Partial<StaffTarget> = {}): StaffTarget {
  return { userId: 'other', isActive: true, isAdmin: false, ...overrides };
}

const EVERY_ACTION: readonly StaffChangeAction[] = [
  'deactivate',
  'reactivate',
  'promote',
  'demote',
  'reset_password',
];

describe('canManageStaff', () => {
  it('is the admin flag and nothing else — there is no third authorization fact', () => {
    expect(canManageStaff(ADMIN)).toBe(true);
    expect(canManageStaff(MEMBER)).toBe(false);
  });
});

describe('canChangeStaff', () => {
  it('refuses a non-admin every action, with the same sentence each time', () => {
    for (const action of EVERY_ACTION) {
      const verdict = canChangeStaff(action, target(), MEMBER, 5);
      expect(verdict.allowed, action).toBe(false);
      if (verdict.allowed) continue;
      expect(verdict.because).toBe('not_admin');
      expect(verdict.message).toBe(STAFF_REFUSAL_MESSAGES.not_admin);
    }
  });

  it('allows an admin the ordinary changes against an ordinary member', () => {
    for (const action of EVERY_ACTION) {
      expect(canChangeStaff(action, target(), ADMIN, 1).allowed, action).toBe(true);
    }
  });

  it('refuses self-deactivation and self-demotion — another admin has to do it', () => {
    const self = target({ userId: ADMIN.userId, isAdmin: true });
    const deactivate = canChangeStaff('deactivate', self, ADMIN, 3);
    const demote = canChangeStaff('demote', self, ADMIN, 3);
    expect(deactivate.allowed).toBe(false);
    expect(demote.allowed).toBe(false);
    if (!deactivate.allowed) expect(deactivate.because).toBe('self_deactivation');
    if (!demote.allowed) expect(demote.because).toBe('self_demotion');
    // Even with three administrators, which is the point: the rule is about WHO does it.
    expect(canChangeStaff('reset_password', self, ADMIN, 3).allowed).toBe(true);
  });

  it('Part C 4: DEMOTE cannot reach zero administrators when there is only one', () => {
    // CHANGED 30 Aug (D72). Deactivate no longer reaches this guard at all — removing an
    // active administrator's access is refused outright, at any count — so the last-admin
    // rule is now demote's alone. The half that matters is unchanged: the workspace can
    // never be left with nobody who can administer it.
    const lastAdmin = target({ userId: 'boss', isAdmin: true, isActive: true });
    const verdict = canChangeStaff('demote', lastAdmin, ADMIN, 1);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.because).toBe('last_admin');
      expect(verdict.message).toBe(STAFF_REFUSAL_MESSAGES.last_admin);
    }
    // With a second administrator, demoting is fine.
    expect(canChangeStaff('demote', lastAdmin, ADMIN, 2).allowed).toBe(true);
  });

  it('D72: an ACTIVE administrator’s access cannot be removed, at any admin count', () => {
    // The rule this file exists to state: one tap must not be able to take an administrator
    // out of the building. Demote them first, then remove their access.
    const otherAdmin = target({ userId: 'boss', isAdmin: true, isActive: true });
    for (const count of [1, 2, 5, 20]) {
      const verdict = canChangeStaff('deactivate', otherAdmin, ADMIN, count);
      expect(verdict.allowed, `with ${String(count)} admin(s)`).toBe(false);
      if (!verdict.allowed) {
        expect(verdict.because).toBe('admin_target');
        expect(verdict.message).toBe(STAFF_REFUSAL_MESSAGES.admin_target);
      }
    }
  });

  it('D72: the two-step actually works — demote, then the access can be removed', () => {
    // The rule adds friction, not a dead end. It must be possible to get there in two
    // deliberate steps, or it is not a rule, it is a wall.
    const before = target({ userId: 'boss', isAdmin: true, isActive: true });
    expect(canChangeStaff('deactivate', before, ADMIN, 2).allowed).toBe(false);
    expect(canChangeStaff('demote', before, ADMIN, 2).allowed).toBe(true);

    const afterDemotion = target({ userId: 'boss', isAdmin: false, isActive: true });
    expect(canChangeStaff('deactivate', afterDemotion, ADMIN, 1).allowed).toBe(true);
  });

  it('D72 does not touch the ordinary case: a non-admin’s access is removable as before', () => {
    const member = target({ userId: 'zoe', isAdmin: false, isActive: true });
    expect(canChangeStaff('deactivate', member, ADMIN, 1).allowed).toBe(true);
    expect(canChangeStaff('deactivate', member, ADMIN, 2).allowed).toBe(true);
  });

  it('D72 never masks the self-refusal, which is the more useful answer', () => {
    // An admin removing their own access hits BOTH rules. The self one is the one that tells
    // them what to do about it, so it must win.
    const self = target({ userId: ADMIN.userId, isAdmin: true, isActive: true });
    const verdict = canChangeStaff('deactivate', self, ADMIN, 3);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.because).toBe('self_deactivation');
  });

  it('D72 does not give a NON-admin any new power — they are still refused first', () => {
    const member: StaffActor = { userId: 'zoe', isAdmin: false };
    const anyone = target({ userId: 'boss', isAdmin: true, isActive: true });
    const verdict = canChangeStaff('deactivate', anyone, member, 2);
    expect(verdict.allowed).toBe(false);
    // `not_admin`, not `admin_target`: the reason they cannot is that they are not an admin.
    if (!verdict.allowed) expect(verdict.because).toBe('not_admin');
  });

  it('a count of zero — which should never happen — refuses rather than waves through', () => {
    const admin = target({ userId: 'boss', isAdmin: true });
    expect(canChangeStaff('demote', admin, ADMIN, 0).allowed).toBe(false);
  });

  it('deactivating an ALREADY deactivated admin does not trip the last-admin guard', () => {
    // They are not counted as an administrator any more, so refusing here would be a rule
    // protecting a state that does not exist.
    const dormant = target({ userId: 'gone', isAdmin: true, isActive: false });
    expect(canChangeStaff('deactivate', dormant, ADMIN, 1).allowed).toBe(true);
  });

  it('refuses promoting or resetting someone who no longer has access, and says why', () => {
    const gone = target({ isActive: false });
    for (const action of ['promote', 'reset_password'] as const) {
      const verdict = canChangeStaff(action, gone, ADMIN, 2);
      expect(verdict.allowed, action).toBe(false);
      if (!verdict.allowed) expect(verdict.because).toBe('inactive_target');
    }
    // Restoring their access is exactly the thing that IS allowed.
    expect(canChangeStaff('reactivate', gone, ADMIN, 2).allowed).toBe(true);
  });

  it('every refusal carries a sentence a person could act on, not a code', () => {
    for (const message of Object.values(STAFF_REFUSAL_MESSAGES)) {
      expect(message.length).toBeGreaterThan(20);
      expect(message).toMatch(/[.!]$/);
      expect(message).not.toMatch(/[A-Z_]{4,}/); // no FORBIDDEN / LAST_ADMIN leaking through
    }
  });
});

describe('countActiveAdmins', () => {
  it('counts only people who are BOTH active and flagged', () => {
    expect(
      countActiveAdmins([
        { isActive: true, isAdmin: true },
        { isActive: false, isAdmin: true }, // deactivated: administers nothing
        { isActive: true, isAdmin: false },
      ]),
    ).toBe(1);
    expect(countActiveAdmins([])).toBe(0);
  });
});

describe('limits', () => {
  it('the email cap is the RFC ceiling, so the field never refuses a real address', () => {
    expect(STAFF_EMAIL_MAX_CHARS).toBe(254);
  });
});
