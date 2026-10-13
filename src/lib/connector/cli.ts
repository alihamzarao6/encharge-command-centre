/**
 * Argument parsing and the words printed by `npm run connector` (MCP connector, stage 1).
 *
 * Lives in src/lib so it is unit-tested and coverage-gated; scripts/connector.ts is a thin
 * wire-up. Parsing returns a value, never exits or prints.
 */
import type { Result } from '../errors.js';
import { ValidationError, err, ok } from '../errors.js';
import type { IssueResult, ListResult, RevokeResult } from './keyAdmin.js';
import { LABEL_MAX, MAX_LIVE_KEYS } from './keyAdmin.js';

export type ConnectorCommand =
  | { readonly kind: 'issue'; readonly email: string; readonly label: string }
  | { readonly kind: 'list'; readonly email: string | null }
  | { readonly kind: 'revoke'; readonly keyId: string }
  | { readonly kind: 'help' };

export const CONNECTOR_CLI_USAGE = `Connector keys — runs server-side with the service role key from .env.

A key lets one person's AI read the Finance Pipeline through the Command Centre's connector,
as that person. It is shown ONCE, when it is issued, and stored nowhere: only its SHA-256 is
kept. Each person may hold ${String(MAX_LIVE_KEYS)} live keys.

Usage:
  npm run connector -- issue <email> [--label "<what it is for>"]
                                    make a key for that member of staff and print it ONCE
  npm run connector -- list [<email>]
                                    every key (or one person's): its public id, whose it is,
                                    when it was last used, whether it is live. Never the key
  npm run connector -- revoke <key-id>
                                    switch a key off, by the 12-character id that \`list\`
                                    shows. Takes effect on the key's next request
  npm run connector -- help

Never type a whole key on the command line: the shell keeps it. \`revoke\` takes the id.
`;

export function parseConnectorCommand(
  argv: readonly string[],
): Result<ConnectorCommand, ValidationError> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return ok({ kind: 'help' });
    case 'issue': {
      let email: string | null = null;
      let label = '';
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i] ?? '';
        if (arg === '--label') {
          const value = rest[i + 1];
          if (value === undefined) return err(new ValidationError('--label needs a value'));
          label = value;
          i += 1;
        } else if (arg.startsWith('--')) {
          return err(new ValidationError(`unknown option: ${arg}`));
        } else if (email === null) {
          email = arg;
        } else {
          return err(new ValidationError('too many arguments'));
        }
      }
      if (email === null || email.trim() === '') {
        return err(new ValidationError('issue requires an email argument'));
      }
      if (label.trim().length > LABEL_MAX) {
        return err(new ValidationError(`--label is at most ${String(LABEL_MAX)} characters`));
      }
      return ok({ kind: 'issue', email, label: label.trim() });
    }
    case 'list': {
      if (rest.length > 1) return err(new ValidationError('too many arguments'));
      const email = rest[0];
      return ok({ kind: 'list', email: email === undefined || email.trim() === '' ? null : email });
    }
    case 'revoke': {
      if (rest.length > 1) return err(new ValidationError('too many arguments'));
      const keyId = rest[0];
      if (keyId === undefined || keyId.trim() === '') {
        return err(
          new ValidationError('revoke requires a key id (the 12 characters `list` shows)'),
        );
      }
      return ok({ kind: 'revoke', keyId });
    }
    default:
      return err(new ValidationError(`unknown command: ${command}`));
  }
}

/** The one-time display of a key. A hand-over to the operator's terminal, not a log line. */
export function formatIssued(
  issued: Extract<IssueResult, { readonly kind: 'issued' }>,
  publicUrl: string,
): string {
  return [
    '',
    `Connector key for ${issued.email} — shown ONCE, stored nowhere:`,
    '',
    `    ${issued.key}`,
    '',
    `Key id (safe to quote; what \`list\` and the logs show): ${issued.keyId}`,
    ...(issued.label === '' ? [] : [`Label: ${issued.label}`]),
    `Address to give the AI:                               ${publicUrl}`,
    '',
    "It goes in the AI's connector settings as the bearer token (the Authorization header).",
    'Hand it over out of band — not by email. If it is lost or seen by anyone else, revoke it',
    'and issue another: there is no way to read it back.',
    '',
  ].join('\n');
}

export function formatIssueRefusal(
  result: Exclude<IssueResult, { readonly kind: 'issued' }>,
): string {
  switch (result.kind) {
    case 'no_such_user':
      return `no member of staff has the address ${result.email}. Add them first: npm run staff -- add-user`;
    case 'inactive_user':
      return `${result.email} is deactivated, so no key was made for them.`;
    case 'too_many':
      return `${result.email} already holds ${String(MAX_LIVE_KEYS)} live keys. Revoke one first: npm run connector -- list ${result.email}`;
    case 'bad_label':
      return `the label must be one line of at most ${String(LABEL_MAX)} characters.`;
  }
}

function when(iso: string | null): string {
  if (iso === null) return 'never';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 'unknown' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export function formatList(result: ListResult): string {
  if (result.kind === 'no_such_user') {
    return `no member of staff has the address ${result.email}.\n`;
  }
  if (result.keys.length === 0) return 'no connector keys have been issued.\n';
  const lines = result.keys.map((key) =>
    [
      key.keyId,
      key.state.padEnd(7),
      key.email,
      `created ${when(key.createdAt)}`,
      `last used ${when(key.lastUsedAt)}`,
      ...(key.revokedAt === null ? [] : [`revoked ${when(key.revokedAt)}`]),
      ...(key.label === '' ? [] : [`"${key.label}"`]),
    ].join('  '),
  );
  return `${lines.join('\n')}\n(times are UTC)\n`;
}

export function formatRevoke(result: RevokeResult): {
  readonly ok: boolean;
  readonly text: string;
} {
  switch (result.kind) {
    case 'revoked':
      return { ok: true, text: `revoked ${result.keyId}. Its next request is refused.\n` };
    case 'already_revoked':
      return {
        ok: true,
        text: `already revoked: ${result.keyId} (${when(result.revokedAt)} UTC). No change.\n`,
      };
    case 'not_found':
      return { ok: false, text: 'no key has that id. `npm run connector -- list` shows them.' };
    case 'not_a_key_id':
      return {
        ok: false,
        text: 'that is not a key id. Give the 12-character id that `list` shows — never a whole key: if you just typed one, it is now in your shell history and should be revoked.',
      };
  }
}
