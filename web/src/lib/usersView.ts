/**
 * Turning `app_users` rows into what the Users page shows. Pure, so the decisions that
 * matter — who is offered which button, what "never signed in" reads as, how the list is
 * ordered — are unit-tested without a browser.
 *
 * Nothing here decides anything the server does not decide again: `canChangeStaff` is the
 * SAME function the admin Edge Function enforces (src/lib/auth/access.ts), imported rather
 * than restated, so the interface can never offer an action the server will refuse and the
 * rule can never drift between the two.
 *
 * Ids are deliberately not part of any view: they travel only as the argument of a write.
 * Neither is `role` — it is a descriptive label with no permission meaning (migration
 * 20260824020000 says so in as many words), and showing it beside a real permission would
 * invite someone to read it as one.
 */
import {
  canChangeStaff,
  countActiveAdmins,
  type StaffActor,
  type StaffChangeAction,
} from '../../../src/lib/auth/access.js';
import type { SignInRecord } from './usersApi.js';

/**
 * One `app_users` row as the browser reads it under RLS. Declared HERE, and re-exported by
 * supabase.ts, for the same reason the two memory row shapes live in memoryView.ts: this
 * module has to be unit-testable under Node, and supabase.ts reaches `import.meta.env`.
 */
/* eslint-disable @typescript-eslint/consistent-type-definitions --
   A type alias, not an interface: supabase-js matches a schema structurally against
   Record<string, unknown>, which an interface fails (no implicit index signature) — every
   query result then collapses to `never`. Same reason as the block in supabase.ts. */
export type AppUserRow = {
  user_id: string;
  email: string;
  role: string;
  is_active: boolean;
  is_admin: boolean;
  /** Stage 3 part 4: the users page shows when someone was added. */
  created_at: string;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions */

/** What each row offers this viewer. A refused action is not rendered, not disabled. */
export interface StaffMemberView {
  readonly userId: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly isAdmin: boolean;
  readonly isYou: boolean;
  readonly addedOn: string;
  /** 'Never' until they have signed in once; '—' while it is unknown to this viewer. */
  readonly lastSeen: string;
  readonly can: Readonly<Record<StaffChangeAction, boolean>>;
}

export interface RosterView {
  readonly members: readonly StaffMemberView[];
  readonly activeAdmins: number;
  readonly activeCount: number;
  readonly inactiveCount: number;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Australia/Perth',
});

export function formatStaffDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : DATE_FORMAT.format(date);
}

/**
 * The one thing this page is FOR, at a glance: did the person I handed a password to
 * actually get in. "Never" is not a failure state and is not styled as one — a person added
 * an hour ago has not signed in yet either — but it is the difference between "they are set
 * up" and "they are set up and using it", and only this column can tell them apart.
 */
export function lastSeenLabel(record: SignInRecord | undefined, known: boolean): string {
  if (!known) return '—';
  if (record?.lastSignInAt === undefined || record.lastSignInAt === null) return 'Never';
  const formatted = formatStaffDate(record.lastSignInAt);
  return formatted === '' ? '—' : formatted;
}

/**
 * What the Team page offers. Promote and demote are NOT here (D74): the workspace has one
 * administrator in normal use, so a permanent control for appointing one was a surface for a
 * decision made roughly never — and the surface through which one admin could strip another.
 * `npm run staff -- promote|demote` remains the break-glass path.
 */
const ACTIONS: readonly StaffChangeAction[] = ['deactivate', 'reactivate', 'reset_password'];

/**
 * `signIns` is empty and `signInsKnown` false for a non-admin: they never ask for it and the
 * server would refuse them if they did, so their list simply has no such column rather than
 * a column full of dashes with an explanation nobody needs.
 *
 * Ordering: active before deactivated (the people you act on are the people who are here),
 * then by email. NOT admins first — a list that sorts by rank teaches the rank.
 */
export function buildRoster(
  rows: readonly AppUserRow[],
  actor: StaffActor,
  signIns: readonly SignInRecord[] = [],
  signInsKnown = false,
): RosterView {
  const seen = new Map(signIns.map((row) => [row.userId, row]));
  const asActor = rows.map((row) => ({ isActive: row.is_active, isAdmin: row.is_admin }));
  const activeAdmins = countActiveAdmins(asActor);

  const members = [...rows]
    .sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      return a.email.localeCompare(b.email);
    })
    .map((row): StaffMemberView => {
      const target = { userId: row.user_id, isActive: row.is_active, isAdmin: row.is_admin };
      const can = {} as Record<StaffChangeAction, boolean>;
      for (const action of ACTIONS) {
        // The verdict is the server's verdict. An action that is merely pointless — undoing
        // a state the row is already in — is filtered here as well, because a "Restore
        // access" button on somebody who has access is noise, not safety.
        const pointless =
          (action === 'deactivate' && !row.is_active) || (action === 'reactivate' && row.is_active);
        can[action] = !pointless && canChangeStaff(action, target, actor, activeAdmins).allowed;
      }
      return {
        userId: row.user_id,
        email: row.email,
        isActive: row.is_active,
        isAdmin: row.is_admin,
        isYou: row.user_id === actor.userId,
        addedOn: formatStaffDate(row.created_at),
        lastSeen: lastSeenLabel(seen.get(row.user_id), signInsKnown),
        can,
      };
    });

  return {
    members,
    activeAdmins,
    activeCount: members.filter((m) => m.isActive).length,
    inactiveCount: members.filter((m) => !m.isActive).length,
  };
}

/**
 * The sentence under a person's name. Deliberately not a badge soup: two facts, in the order
 * that matters to someone scanning a list — can they get in, and can they administer.
 */
export function statusLabel(member: StaffMemberView): string {
  if (!member.isActive) return 'No longer has access';
  return member.isAdmin ? 'Administrator' : 'Team member';
}
