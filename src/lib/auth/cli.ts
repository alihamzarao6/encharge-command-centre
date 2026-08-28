/**
 * Argument parsing for the staff admin CLI (scripts/staff.ts).
 *
 * Lives in src/lib so it is unit-tested and coverage-gated like everything else; the
 * script itself is a thin wire-up. Parsing returns a value, never exits or prints.
 */
import type { Result } from '../errors.js';
import { ValidationError, err, ok } from '../errors.js';
import type { SeededStaffKey } from './admin.js';

export type StaffCommand =
  | { readonly kind: 'add-user'; readonly email: string }
  | { readonly kind: 'deactivate'; readonly email: string }
  | { readonly kind: 'reactivate'; readonly email: string }
  | { readonly kind: 'promote'; readonly email: string }
  | { readonly kind: 'demote'; readonly email: string }
  | { readonly kind: 'reset-password'; readonly email: string }
  | { readonly kind: 'bootstrap'; readonly who: SeededStaffKey }
  | { readonly kind: 'help' };

export const STAFF_CLI_USAGE = `Staff user management — runs server-side with the service role key from .env.

Usage:
  npm run staff -- add-user <email>        create auth user + allowlist row, print the
                                           generated password ONCE (admin session required)
  npm run staff -- deactivate <email>      is_active = false + auth ban; memory rows survive
                                           (admin session required; never deletes)
  npm run staff -- reactivate <email>      is_active = true + unban; their existing password
                                           works again (admin session required)
  npm run staff -- promote <email>         is_admin = true (admin session required)
  npm run staff -- demote <email>          is_admin = false — refused for your own account
                                           and for the last active admin
  npm run staff -- reset-password <email>  generate + set a new password, print it ONCE
                                           (admin session required)
  npm run staff -- bootstrap <ross|developer>
                                           attach first credentials to a seeded fixed-UUID
                                           account (no admin exists before this has run)
  npm run staff -- help

Everything the Users page in the dashboard does, this does too — it is the break-glass
path when the browser cannot be used, and the two share every check (src/lib/auth).

Admin session (everything except bootstrap):
  Set STAFF_ADMIN_EMAIL and STAFF_ADMIN_PASSWORD in the environment (not on the command
  line — argv leaks into shell history and process listings). The CLI signs in as that
  admin and every operation is authorized against THEIR account, then audited under it.
`;

export function parseStaffCommand(argv: readonly string[]): Result<StaffCommand, ValidationError> {
  const [command, arg, ...rest] = argv;
  if (rest.length > 0) {
    return err(new ValidationError('too many arguments'));
  }
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return ok({ kind: 'help' });
    case 'add-user':
    case 'deactivate':
    case 'reactivate':
    case 'promote':
    case 'demote':
    case 'reset-password': {
      if (arg === undefined || arg.trim() === '') {
        return err(new ValidationError(`${command} requires an email argument`));
      }
      return ok({ kind: command, email: arg });
    }
    case 'bootstrap': {
      if (arg !== 'ross' && arg !== 'developer') {
        return err(new ValidationError("bootstrap requires 'ross' or 'developer'"));
      }
      return ok({ kind: 'bootstrap', who: arg });
    }
    default:
      return err(new ValidationError(`unknown command: ${command}`));
  }
}

/** The one-time password display. A deliberate hand-over to the admin's terminal, not a log. */
export function formatOneTimePassword(email: string, password: string): string {
  return [
    '',
    `One-time password for ${email} — shown ONCE, stored nowhere:`,
    '',
    `    ${password}`,
    '',
    'Hand it over out of band (not email). If it is lost, run reset-password;',
    'there is no way to read it back.',
    '',
  ].join('\n');
}
