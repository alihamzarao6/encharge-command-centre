/**
 * Who may change a staff account, and what the refusal says (Stage 3 part 4, FND-330).
 *
 * The same shape as `src/lib/memory/access.ts`, for the same reason: the Edge Function
 * enforces this and the browser calls it to decide whether to render a button, so the
 * interface can never offer an action the server will refuse, and the rule cannot drift
 * between the two. It therefore has NO imports at all — nothing from here may drag a store,
 * a key or a prompt into the client bundle.
 *
 * There are still exactly two authorization facts (Stage 2 part 3): allowlisted
 * (`is_active`) and admin (`is_admin`). This module adds no third. It answers one question —
 * "may THIS person do THIS to THAT account right now" — and the answers are:
 *
 *   * only an admin may create, deactivate, reactivate, promote, demote or reset a password;
 *   * nobody may deactivate themselves, and nobody may demote themselves. Both are refused
 *     for one reason: an administrator removing their own access is the one mistake that
 *     cannot be undone from inside the product. Another admin does it, or it does not happen;
 *   * **an ADMINISTRATOR's access cannot be removed while they are still an administrator**
 *     (30 Aug, D72). Demote them first, then remove their access. One tap should not be able
 *     to take an administrator out of the building: the two-step forces the person doing it
 *     to state, separately, that this account should stop being an admin and that it should
 *     stop having access. It also makes the destructive half reversible on its own —
 *     a demotion is undone by promoting, whereas access removed in one tap from an admin
 *     account is two things to put back and easy to get half-right. Scoped to an ACTIVE
 *     admin: someone already deactivated has no access left to protect;
 *   * no action may leave the workspace with zero active administrators. Self-refusal alone
 *     nearly gets there — A can demote B, but not itself — so the count is checked as well,
 *     because "nearly" is a lockout that needs a developer with a service key to unpick;
 *   * a deactivated member cannot be promoted or have their password reset. Both would put
 *     a credential or an authority on an account that cannot sign in, which reads to the
 *     admin as though something happened. Reactivate first; the message says so.
 *
 * THIS IS THE POLITE REFUSAL, not the guarantee. Two admins demoting each other at the same
 * instant both read "two admins" and both pass — so the last-admin invariant is ALSO held in
 * the database, under an advisory lock shared by both writes (migration 20260828010000). The
 * check here exists so the person gets a sentence instead of a constraint violation.
 */

/** The signed-in person, as both sides know them. */
export interface StaffActor {
  readonly userId: string;
  readonly isAdmin: boolean;
}

/** The account being acted on. */
export interface StaffTarget {
  readonly userId: string;
  readonly isActive: boolean;
  readonly isAdmin: boolean;
}

/** Everything the users page can do to an account that already exists. */
export type StaffChangeAction =
  'deactivate' | 'reactivate' | 'promote' | 'demote' | 'reset_password';

export type StaffRefusal =
  | 'not_admin'
  | 'self_deactivation'
  | 'self_demotion'
  | 'last_admin'
  | 'inactive_target'
  | 'admin_target';

export type StaffVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly because: StaffRefusal; readonly message: string };

/** One sentence each, written for the person holding the phone, not for a log. */
export const STAFF_REFUSAL_MESSAGES: Readonly<Record<StaffRefusal, string>> = {
  not_admin: 'Only an administrator can add or change people.',
  self_deactivation:
    'You cannot remove your own access. Ask another administrator to do it for you.',
  self_demotion:
    'You cannot remove your own administrator rights. Ask another administrator to do it.',
  last_admin:
    'The Command Centre must always have at least one administrator. Make someone else an administrator first.',
  inactive_target: 'This person no longer has access. Restore their access first.',
  admin_target:
    'This person is an administrator. Remove their administrator rights first, then you can remove their access.',
};

function refuse(because: StaffRefusal): StaffVerdict {
  return { allowed: false, because, message: STAFF_REFUSAL_MESSAGES[because] };
}

const ALLOWED: StaffVerdict = { allowed: true };

/** Creating an account, and seeing the management controls at all. */
export function canManageStaff(actor: StaffActor): boolean {
  return actor.isAdmin;
}

/**
 * `activeAdmins` is how many active admins the workspace has RIGHT NOW, including both the
 * actor and the target where they qualify. The browser counts the roster it just read; the
 * server counts under the lock. Same function, same answer.
 */
export function canChangeStaff(
  action: StaffChangeAction,
  target: StaffTarget,
  actor: StaffActor,
  activeAdmins: number,
): StaffVerdict {
  if (!canManageStaff(actor)) return refuse('not_admin');

  // Removing the LAST active administrator. Only DEMOTE can reach this now: deactivating an
  // administrator is refused outright below, whoever they are and however many there are.
  // `activeAdmins <= 1` rather than `=== 1` so a miscount can only ever refuse, never wave
  // something through.
  const wouldRemoveAnAdmin = action === 'demote' && target.isAdmin && target.isActive;

  switch (action) {
    case 'deactivate':
      // Self first: it is the more specific answer, and the one the person needs.
      if (target.userId === actor.userId) return refuse('self_deactivation');
      // D72. Not gated on the admin COUNT — this holds with two administrators or twenty.
      // The last-admin case cannot reach here anyway: the only administrator a lone admin
      // could target is themselves, which the line above already refused.
      //
      // `isActive` because the rule protects ACCESS, and someone already deactivated has
      // none left to protect — refusing there would guard a state that does not exist.
      if (target.isAdmin && target.isActive) return refuse('admin_target');
      break;
    case 'demote':
      if (target.userId === actor.userId) return refuse('self_demotion');
      break;
    case 'promote':
    case 'reset_password':
      if (!target.isActive) return refuse('inactive_target');
      break;
    case 'reactivate':
      break;
  }

  if (wouldRemoveAnAdmin && activeAdmins <= 1) return refuse('last_admin');
  return ALLOWED;
}

/**
 * The count both sides feed into `canChangeStaff`. Pure, and deliberately here rather than
 * in a view module, so the browser and the server agree on what "an administrator" counts as
 * (active AND flagged — a deactivated admin administers nothing).
 */
export function countActiveAdmins(
  rows: readonly { readonly isActive: boolean; readonly isAdmin: boolean }[],
): number {
  return rows.filter((row) => row.isActive && row.isAdmin).length;
}

// ---------------------------------------------------------------------------------------
// The one-time password. The rule is Stage 2 part 3's and has not moved: it is returned
// once, shown once, handed over out of band, and exists nowhere else. These two strings are
// here rather than in the component because they are the promise being made, and the promise
// is the server's, not the interface's.
// ---------------------------------------------------------------------------------------

export const ONE_TIME_PASSWORD_PROMISE =
  'Shown once. It is not saved anywhere and cannot be shown again — if it is lost, reset it.';

export const ONE_TIME_PASSWORD_HANDOVER =
  'Give it to them the way you would a door code: in person, or by a message you would be comfortable with. Not by email.';

/** What a person may type into the email field before it is not an email address. */
export const STAFF_EMAIL_MAX_CHARS = 254;
