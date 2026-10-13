/**
 * `npm run connector` — issuing, listing and revoking keys (MCP connector, stage 1): the
 * decisions in keyAdmin.ts and the words in cli.ts, over a store that is a plain object.
 *
 * The promise being tested is "shown once, never again": the key exists in the value `issue`
 * returns and in nothing else — not in what is stored, not in a list, not in a refusal.
 */
import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_CLI_USAGE,
  formatIssueRefusal,
  formatIssued,
  formatList,
  formatRevoke,
  parseConnectorCommand,
} from '../../../src/lib/connector/cli.js';
import {
  LABEL_MAX,
  MAX_LIVE_KEYS,
  issueKey,
  listKeys,
  revokeKey,
  type KeyAdminStore,
  type KeyRecord,
} from '../../../src/lib/connector/keyAdmin.js';
import { digestKey, mintKey, parseKey } from '../../../src/lib/connector/keys.js';
import { AppError, err, ok } from '../../../src/lib/errors.js';

interface Stored {
  readonly userId: string;
  readonly keyId: string;
  readonly digestHex: string;
  readonly label: string;
}

function memoryStore(
  over: Partial<KeyAdminStore> = {},
): KeyAdminStore & { stored: Stored[]; rows: KeyRecord[] } {
  const stored: Stored[] = [];
  const rows: KeyRecord[] = [];
  const staff = new Map([
    ['ross@example.test', { userId: 'user-ross', email: 'ross@example.test', isActive: true }],
    ['left@example.test', { userId: 'user-left', email: 'left@example.test', isActive: false }],
  ]);
  return {
    stored,
    rows,
    findStaffByEmail: (email) => Promise.resolve(ok(staff.get(email) ?? null)),
    issue: (input) => {
      stored.push(input);
      rows.unshift({
        keyId: input.keyId,
        userId: input.userId,
        label: input.label,
        createdAt: '2026-10-13T04:00:00+00:00',
        lastUsedAt: null,
        revokedAt: null,
      });
      return Promise.resolve(
        ok({ kind: 'issued', keyId: input.keyId, createdAt: '2026-10-13T04:00:00+00:00' }),
      );
    },
    list: (userId) =>
      Promise.resolve(ok(rows.filter((row) => userId === null || row.userId === userId))),
    revoke: (keyId) => {
      const row = rows.find((candidate) => candidate.keyId === keyId);
      if (row === undefined) return Promise.resolve(ok({ kind: 'not_found' }));
      return Promise.resolve(
        ok({ kind: 'revoked', keyId, revokedAt: '2026-10-13T05:00:00+00:00' }),
      );
    },
    emailsFor: () => Promise.resolve(ok(new Map([['user-ross', 'ross@example.test']]))),
    ...over,
  };
}

describe('issueKey', () => {
  it('mints a key for a member of staff, stores its digest and hands the key back once', async () => {
    const store = memoryStore();
    const result = await issueKey(store, { email: '  Ross@Example.test ', label: ' Grok ' });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'issued') throw new Error('expected a key');
    const issued = result.value;
    expect(parseKey(issued.key)).toEqual({ keyId: issued.keyId });
    expect(issued).toMatchObject({ email: 'ross@example.test', label: 'Grok' });
    // What was stored is the digest of exactly that key, and not the key.
    expect(store.stored).toEqual([
      {
        userId: 'user-ross',
        keyId: issued.keyId,
        digestHex: await digestKey(issued.key),
        label: 'Grok',
      },
    ]);
    expect(JSON.stringify(store.stored)).not.toContain(issued.key);
    expect(JSON.stringify(store.rows)).not.toContain(issued.key.slice(-43));
  });

  it('refuses — and mints nothing — for someone who is not staff, is deactivated, or has too many', async () => {
    const store = memoryStore();
    for (const [email, kind] of [
      ['nobody@example.test', 'no_such_user'],
      ['not an address', 'no_such_user'],
      ['left@example.test', 'inactive_user'],
    ] as const) {
      const result = await issueKey(store, { email, label: '' });
      expect(result.ok && result.value.kind, email).toBe(kind);
    }
    expect(store.stored).toHaveLength(0);
    for (const [answer, kind] of [
      ['too_many', 'too_many'],
      ['not_staff', 'inactive_user'],
    ] as const) {
      const full = memoryStore({
        issue: () => Promise.resolve(ok({ kind: answer })),
      });
      const result = await issueKey(full, { email: 'ross@example.test', label: '' });
      expect(result.ok && result.value.kind).toBe(kind);
    }
  });

  it('a label is one short line', async () => {
    const store = memoryStore();
    for (const label of ['x'.repeat(LABEL_MAX + 1), 'two\nlines', 'bell\u{7}']) {
      const result = await issueKey(store, { email: 'ross@example.test', label });
      expect(result.ok && result.value.kind).toBe('bad_label');
    }
    expect(store.stored).toHaveLength(0);
  });

  it('an id that is taken is tried again with a NEW key, never reported as a failure', async () => {
    let attempts = 0;
    const seen: string[] = [];
    const store = memoryStore({
      issue: (input) => {
        attempts += 1;
        seen.push(input.digestHex);
        return Promise.resolve(
          ok(
            attempts < 3
              ? { kind: 'id_taken' }
              : { kind: 'issued', keyId: input.keyId, createdAt: 'now' },
          ),
        );
      },
    });
    const result = await issueKey(store, { email: 'ross@example.test', label: '' });
    expect(result.ok && result.value.kind).toBe('issued');
    expect(new Set(seen).size).toBe(3);
    const never = memoryStore({ issue: () => Promise.resolve(ok({ kind: 'id_taken' })) });
    const failed = await issueKey(never, { email: 'ross@example.test', label: '' });
    expect(!failed.ok && failed.error.code).toBe('INTERNAL');
  });

  it('a store that cannot be reached is an error, and no key is handed over', async () => {
    const down = (): Promise<never> =>
      Promise.resolve(err(new AppError('NETWORK', 'down')) as never);
    const noStaff = await issueKey(memoryStore({ findStaffByEmail: down }), {
      email: 'ross@example.test',
      label: '',
    });
    expect(noStaff.ok).toBe(false);
    const noIssue = await issueKey(memoryStore({ issue: down }), {
      email: 'ross@example.test',
      label: '',
    });
    expect(noIssue.ok).toBe(false);
    expect(JSON.stringify(noIssue)).not.toMatch(/fcc_[a-z2-9]{12}_/);
  });
});

describe('listKeys and revokeKey', () => {
  it('a list shows the public id, whose it is and its state — and there is no key in it to show', async () => {
    const store = memoryStore();
    const issued = await issueKey(store, { email: 'ross@example.test', label: 'Grok' });
    if (!issued.ok || issued.value.kind !== 'issued') throw new Error('expected a key');
    store.rows.push({
      keyId: 'bbbbbbbbbbbb',
      userId: 'user-gone',
      label: '',
      createdAt: '2026-09-01T00:00:00+00:00',
      lastUsedAt: '2026-09-02T10:30:00+00:00',
      revokedAt: '2026-09-03T00:00:00+00:00',
    });
    const all = await listKeys(store, { email: null });
    if (!all.ok || all.value.kind !== 'listed') throw new Error('expected a list');
    expect(all.value.keys).toEqual([
      {
        keyId: issued.value.keyId,
        email: 'ross@example.test',
        label: 'Grok',
        state: 'live',
        createdAt: '2026-10-13T04:00:00+00:00',
        lastUsedAt: null,
        revokedAt: null,
      },
      {
        keyId: 'bbbbbbbbbbbb',
        email: '(no longer on the staff list)',
        label: '',
        state: 'revoked',
        createdAt: '2026-09-01T00:00:00+00:00',
        lastUsedAt: '2026-09-02T10:30:00+00:00',
        revokedAt: '2026-09-03T00:00:00+00:00',
      },
    ]);
    const text = formatList(all.value);
    expect(text).not.toContain(issued.value.key.slice(-43));
    expect(text).toContain(`${issued.value.keyId}  live   `);
    expect(text).toContain(
      'bbbbbbbbbbbb  revoked  (no longer on the staff list)  created 2026-09-01 00:00  last used 2026-09-02 10:30  revoked 2026-09-03 00:00',
    );
    expect(text).toContain('"Grok"');

    const mine = await listKeys(store, { email: 'ross@example.test' });
    expect(mine.ok && mine.value.kind === 'listed' && mine.value.keys).toHaveLength(1);
    const nobody = await listKeys(store, { email: 'nobody@example.test' });
    expect(nobody.ok && nobody.value).toEqual({
      kind: 'no_such_user',
      email: 'nobody@example.test',
    });
    expect(formatList({ kind: 'no_such_user', email: 'x@y.test' })).toContain('no member of staff');
    expect(formatList({ kind: 'listed', keys: [] })).toBe('no connector keys have been issued.\n');
    expect((await listKeys(store, { email: 'not an address' })).ok).toBe(true);
  });

  it('a list that cannot be read is an error at each step', async () => {
    const down = (): Promise<never> =>
      Promise.resolve(err(new AppError('NETWORK', 'down')) as never);
    expect((await listKeys(memoryStore({ list: down }), { email: null })).ok).toBe(false);
    expect((await listKeys(memoryStore({ emailsFor: down }), { email: null })).ok).toBe(false);
    expect(
      (await listKeys(memoryStore({ findStaffByEmail: down }), { email: 'ross@example.test' })).ok,
    ).toBe(false);
  });

  it('revoke takes the public id — and a whole key typed by mistake goes nowhere', async () => {
    const store = memoryStore();
    const issued = await issueKey(store, { email: 'ross@example.test', label: '' });
    if (!issued.ok || issued.value.kind !== 'issued') throw new Error('expected a key');
    let asked = 0;
    const counting = memoryStore({
      revoke: (keyId) => {
        asked += 1;
        return store.revoke(keyId);
      },
    });
    const byKey = await revokeKey(counting, { keyId: issued.value.key });
    expect(byKey.ok && byKey.value).toEqual({ kind: 'not_a_key_id' });
    expect(asked).toBe(0);
    const shown = formatRevoke({ kind: 'not_a_key_id' });
    expect(shown.ok).toBe(false);
    expect(shown.text).toContain('never a whole key');

    const revoked = await revokeKey(store, { keyId: ` ${issued.value.keyId} ` });
    expect(revoked.ok && revoked.value.kind).toBe('revoked');
    expect(formatRevoke({ kind: 'revoked', keyId: 'aaaaaaaaaaaa', revokedAt: 'x' })).toEqual({
      ok: true,
      text: 'revoked aaaaaaaaaaaa. Its next request is refused.\n',
    });
    expect(
      formatRevoke({
        kind: 'already_revoked',
        keyId: 'aaaaaaaaaaaa',
        revokedAt: '2026-10-13T05:00:00Z',
      }).text,
    ).toBe('already revoked: aaaaaaaaaaaa (2026-10-13 05:00 UTC). No change.\n');
    const missing = await revokeKey(store, { keyId: 'zzzzzzzzzzzz' });
    expect(missing.ok && formatRevoke(missing.value)).toMatchObject({ ok: false });
  });
});

describe('the command line', () => {
  it('issue | list | revoke | help', () => {
    const parse = (...argv: string[]) => parseConnectorCommand(argv);
    expect(parse()).toEqual(ok({ kind: 'help' }));
    expect(parse('--help')).toEqual(ok({ kind: 'help' }));
    expect(parse('issue', 'ross@example.test')).toEqual(
      ok({ kind: 'issue', email: 'ross@example.test', label: '' }),
    );
    expect(parse('issue', '--label', ' Grok ', 'ross@example.test')).toEqual(
      ok({ kind: 'issue', email: 'ross@example.test', label: 'Grok' }),
    );
    expect(parse('list')).toEqual(ok({ kind: 'list', email: null }));
    expect(parse('list', 'ross@example.test')).toEqual(
      ok({ kind: 'list', email: 'ross@example.test' }),
    );
    expect(parse('revoke', 'aaaaaaaaaaaa')).toEqual(ok({ kind: 'revoke', keyId: 'aaaaaaaaaaaa' }));
    for (const bad of [
      ['issue'],
      ['issue', ' '],
      ['issue', 'a@b.test', 'extra'],
      ['issue', 'a@b.test', '--label'],
      ['issue', 'a@b.test', '--force'],
      ['issue', 'a@b.test', '--label', 'x'.repeat(LABEL_MAX + 1)],
      ['list', 'a', 'b'],
      ['revoke'],
      ['revoke', 'a', 'b'],
      ['rotate', 'a'],
      ['delete-all'],
    ]) {
      expect(parse(...bad).ok, bad.join(' ')).toBe(false);
    }
  });

  it('the one-time display: the key once, its id, the address, and what to do if it is lost', async () => {
    const minted = await mintKey();
    const text = formatIssued(
      {
        kind: 'issued',
        key: minted.key,
        keyId: minted.keyId,
        email: 'ross@example.test',
        label: 'Grok',
        createdAt: 'now',
      },
      'https://app.example.test/mcp',
    );
    expect(text.split(minted.key)).toHaveLength(2);
    expect(text).toContain('shown ONCE, stored nowhere');
    expect(text).toContain(`what \`list\` and the logs show): ${minted.keyId}`);
    expect(text).toContain('https://app.example.test/mcp');
    expect(text).toContain('Label: Grok');
    expect(text).toContain('there is no way to read it back');
    const unlabelled = formatIssued(
      {
        kind: 'issued',
        key: minted.key,
        keyId: minted.keyId,
        email: 'a@b.test',
        label: '',
        createdAt: 'now',
      },
      'https://x.test/mcp',
    );
    expect(unlabelled).not.toContain('Label:');
  });

  it('a refusal says what to do next, and the usage says a key is never typed on the command line', () => {
    expect(formatIssueRefusal({ kind: 'no_such_user', email: 'x@y.test' })).toContain(
      'npm run staff -- add-user',
    );
    expect(formatIssueRefusal({ kind: 'inactive_user', email: 'x@y.test' })).toContain(
      'deactivated',
    );
    expect(formatIssueRefusal({ kind: 'too_many', email: 'x@y.test' })).toContain(
      `${String(MAX_LIVE_KEYS)} live keys`,
    );
    expect(formatIssueRefusal({ kind: 'bad_label' })).toContain(String(LABEL_MAX));
    expect(CONNECTOR_CLI_USAGE).toContain('Never type a whole key on the command line');
    for (const word of ['issue', 'list', 'revoke'])
      expect(CONNECTOR_CLI_USAGE).toContain(`npm run connector -- ${word}`);
  });
});
