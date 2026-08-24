import { describe, expect, it } from 'vitest';

import {
  STAFF_CLI_USAGE,
  formatOneTimePassword,
  parseStaffCommand,
} from '../../../src/lib/auth/cli.js';

function expectOk<T>(result: { ok: boolean; value?: T }): T {
  expect(result.ok).toBe(true);
  return (result as { value: T }).value;
}

describe('parseStaffCommand', () => {
  it('parses the three email commands', () => {
    for (const kind of ['add-user', 'deactivate', 'reset-password'] as const) {
      const command = expectOk(parseStaffCommand([kind, 'x@y.com']));
      expect(command).toStrictEqual({ kind, email: 'x@y.com' });
    }
  });

  it('parses bootstrap for exactly the two seeded identities', () => {
    expect(expectOk(parseStaffCommand(['bootstrap', 'ross']))).toStrictEqual({
      kind: 'bootstrap',
      who: 'ross',
    });
    expect(expectOk(parseStaffCommand(['bootstrap', 'developer']))).toStrictEqual({
      kind: 'bootstrap',
      who: 'developer',
    });
    expect(parseStaffCommand(['bootstrap', 'someoneelse']).ok).toBe(false);
    expect(parseStaffCommand(['bootstrap']).ok).toBe(false);
  });

  it('treats no args and help variants as help', () => {
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      expect(expectOk(parseStaffCommand(argv))).toStrictEqual({ kind: 'help' });
    }
  });

  it('refuses a missing email, extra args and unknown commands', () => {
    expect(parseStaffCommand(['add-user']).ok).toBe(false);
    expect(parseStaffCommand(['add-user', '  ']).ok).toBe(false);
    expect(parseStaffCommand(['add-user', 'a@b.co', 'extra']).ok).toBe(false);
    expect(parseStaffCommand(['delete-user', 'a@b.co']).ok).toBe(false);
  });
});

describe('formatOneTimePassword', () => {
  it('shows the password once with the hand-over instructions', () => {
    const text = formatOneTimePassword('x@y.com', 'SECRETpw234');
    expect(text).toContain('x@y.com');
    expect(text).toContain('SECRETpw234');
    expect(text).toContain('ONCE');
    expect(text).toContain('reset-password');
  });

  it('usage documents every command and the env-var admin session', () => {
    for (const needle of [
      'add-user',
      'deactivate',
      'reset-password',
      'bootstrap',
      'STAFF_ADMIN_EMAIL',
      'STAFF_ADMIN_PASSWORD',
    ]) {
      expect(STAFF_CLI_USAGE).toContain(needle);
    }
  });
});
