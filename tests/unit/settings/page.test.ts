/**
 * The settings page's endpoint (Milestone 5 part 4): who may ask, what each action answers, and
 * what reaches a log line — over a store that is a plain object and a log sink that keeps every
 * line, so "never a key, never a label, never a name" is asserted against everything written.
 */
import { describe, expect, it } from 'vitest';

import type { VerifyDeps } from '../../../src/lib/auth/verify.js';
import { parseKey } from '../../../src/lib/connector/keys.js';
import { AppError, ConfigError, NetworkError, err, ok } from '../../../src/lib/errors.js';
import { createLogger } from '../../../src/lib/logger.js';
import { FORGET_REFUSED_MESSAGE, KEY_LABEL_MAX } from '../../../src/lib/settings/access.js';
import {
  handleSettingsRequest,
  SETTINGS_MESSAGES,
  type SettingsPageDeps,
  type SettingsPageResult,
} from '../../../src/lib/settings/page.js';
import type { DocumentIds } from '../../../src/lib/settings/answers.js';
import type {
  ForgetOutcome,
  IssueOutcome,
  RevokeOutcome,
  SettingsStore,
} from '../../../src/lib/settings/store.js';

const ROSS = 'a0000000-0000-4000-8000-000000000001';
const SOURCE = '5b4c3d2e-1f00-4a00-8b00-000000000abc';
const NOW = new Date('2026-10-17T05:30:00.000Z');
const COPIES: DocumentIds = {
  sources: [SOURCE, '5b4c3d2e-1f00-4a00-8b00-000000000def'],
  files: ['f1000000-0000-4000-8000-000000000001'],
};

function verify(
  row: { is_active: boolean; is_admin: boolean } | null = { is_active: true, is_admin: false },
): VerifyDeps {
  return {
    getUserFromToken: (token) =>
      Promise.resolve(ok(token === 'good' ? { id: ROSS, email: 'ross@example.test' } : null)),
    getStaffRow: () =>
      Promise.resolve(
        ok(
          row === null
            ? null
            : { user_id: ROSS, email: 'ross@example.test', role: 'staff', ...row },
        ),
      ),
  };
}

interface Calls {
  /** Every store call in order, so "copies before the forget" can be asserted. */
  order: string[];
  counted: DocumentIds[];
  forgets: { sourceId: string; actor: string }[];
  issues: { userId: string; keyId: string; digestHex: string; label: string }[];
  revokes: { userId: string; keyId: string }[];
}

function store(
  over: {
    forget?: ForgetOutcome | AppError;
    issue?: (IssueOutcome | AppError)[];
    revoke?: RevokeOutcome | AppError;
    copies?: DocumentIds | null | AppError;
    held?: number | AppError;
  } = {},
): SettingsStore & { calls: Calls } {
  const calls: Calls = { order: [], counted: [], forgets: [], issues: [], revokes: [] };
  const issues = [...(over.issue ?? [])];
  return {
    calls,
    copiesOf: () => {
      calls.order.push('copiesOf');
      const answer = over.copies === undefined ? COPIES : over.copies;
      return Promise.resolve(answer instanceof AppError ? err(answer) : ok(answer));
    },
    conversationsWithAnswers: (ids) => {
      calls.order.push('conversationsWithAnswers');
      calls.counted.push(ids);
      const answer = over.held ?? 3;
      return Promise.resolve(answer instanceof AppError ? err(answer) : ok(answer));
    },
    forgetDocument: (sourceId, actor) => {
      calls.order.push('forgetDocument');
      calls.forgets.push({ sourceId, actor });
      const answer = over.forget ?? { kind: 'forgotten', sources: 2, files: 1, chunks: 14 };
      return Promise.resolve(answer instanceof AppError ? err(answer) : ok(answer));
    },
    issueKey: (input) => {
      calls.issues.push(input);
      const answer: IssueOutcome | AppError = issues.shift() ?? {
        kind: 'issued',
        keyId: input.keyId,
        createdAt: '2026-10-17T05:30:00+00:00',
      };
      return Promise.resolve(answer instanceof AppError ? err(answer) : ok(answer));
    },
    revokeKey: (userId, keyId) => {
      calls.revokes.push({ userId, keyId });
      const answer = over.revoke ?? {
        kind: 'revoked',
        keyId,
        revokedAt: '2026-10-17T05:30:01+00:00',
      };
      return Promise.resolve(answer instanceof AppError ? err(answer) : ok(answer));
    },
  };
}

function setup(
  over: {
    store?: SettingsStore & { calls: Calls };
    verify?: VerifyDeps;
    caps?: SettingsPageDeps['caps'];
    spent?: (since: Date) => ReturnType<SettingsPageDeps['usage']['spentSince']>;
  } = {},
): { deps: SettingsPageDeps; lines: string[]; calls: Calls; asked: Date[] } {
  const lines: string[] = [];
  const asked: Date[] = [];
  const s = over.store ?? store();
  return {
    lines,
    asked,
    calls: s.calls,
    deps: {
      verify: over.verify ?? verify(),
      store: s,
      usage: {
        spentSince: (_provider, since) => {
          asked.push(since);
          return (
            over.spent?.(since) ??
            Promise.resolve(ok(since.getUTCDate() === 1 ? 12.3456789 : 0.4321))
          );
        },
      },
      caps: over.caps ?? ok({ dailyUsd: 5, monthlyUsd: 80, warnFraction: 0.8 }),
      log: createLogger({ level: 'debug', sink: (line) => lines.push(line) }),
      now: () => NOW,
    },
  };
}

function bodyOf(result: SettingsPageResult): Record<string, unknown> {
  return result.body as unknown as Record<string, unknown>;
}

function errorOf(result: SettingsPageResult): {
  code: string;
  message: string;
  retryable: boolean;
} {
  return (result.body as { error: { code: string; message: string; retryable: boolean } }).error;
}

describe('who may ask', () => {
  it('no token is 401 and does no work', async () => {
    const t = setup();
    const result = await handleSettingsRequest(t.deps, { token: null, body: { action: 'spend' } });
    expect(result.status).toBe(401);
    expect(errorOf(result).code).toBe('UNAUTHENTICATED');
    expect(t.asked).toHaveLength(0);
  });

  it('a token the auth server refuses is 401', async () => {
    const t = setup();
    const result = await handleSettingsRequest(t.deps, {
      token: 'stale',
      body: { action: 'forget_document', sourceId: SOURCE },
    });
    expect(result.status).toBe(401);
    expect(t.calls.forgets).toHaveLength(0);
  });

  it('an account that is not on the staff list, or is switched off, is 403 and forgets nothing', async () => {
    for (const row of [null, { is_active: false, is_admin: true }]) {
      const t = setup({ verify: verify(row) });
      const result = await handleSettingsRequest(t.deps, {
        token: 'good',
        body: { action: 'forget_document', sourceId: SOURCE },
      });
      expect(result.status).toBe(403);
      expect(errorOf(result).code).toBe('FORBIDDEN');
      expect(t.calls.forgets).toHaveLength(0);
    }
  });

  it('"could not decide" is a 503 to try again, never a 403', async () => {
    const t = setup({
      verify: {
        getUserFromToken: () => Promise.resolve(err(new NetworkError('auth unreachable'))),
        getStaffRow: () => Promise.resolve(ok(null)),
      },
    });
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'spend' },
    });
    expect(result.status).toBe(503);
    expect(errorOf(result).retryable).toBe(true);
  });

  it('a body that is not one of the four actions is 400, after the caller is known', async () => {
    const t = setup();
    for (const body of [
      null,
      {},
      { action: 'delete_everything' },
      { action: 'forget_document', sourceId: 'not-a-uuid' },
      { action: 'forget_document', sourceId: SOURCE, extra: true },
      { action: 'create_key' },
      { action: 'revoke_key' },
    ]) {
      const result = await handleSettingsRequest(t.deps, { token: 'good', body });
      expect(result.status).toBe(400);
      expect(errorOf(result).code).toBe('BAD_REQUEST');
    }
    expect(t.calls.forgets).toHaveLength(0);
  });

  it('a store that throws is a 500 with words, never an unhandled rejection', async () => {
    const t = setup();
    const throwing: SettingsPageDeps = {
      ...t.deps,
      store: { ...t.deps.store, forgetDocument: () => Promise.reject(new Error('boom')) },
    };
    const result = await handleSettingsRequest(throwing, {
      token: 'good',
      body: { action: 'forget_document', sourceId: SOURCE },
    });
    expect(result.status).toBe(500);
    expect(errorOf(result).message).toBe(SETTINGS_MESSAGES.internal);
  });
});

describe('forget_document', () => {
  it('forgets as the signed-in person and says how much went', async () => {
    const t = setup();
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'forget_document', sourceId: SOURCE.toUpperCase() },
    });
    expect(result).toEqual({
      status: 200,
      body: {
        action: 'forget_document',
        outcome: 'forgotten',
        sourceId: SOURCE,
        sources: 2,
        files: 1,
        chunks: 14,
        conversationsWithAnswers: 3,
      },
    });
    expect(t.calls.forgets).toEqual([{ sourceId: SOURCE, actor: ROSS }]);
  });

  it('reads every copy BEFORE the forget (it clears the hash that finds them), and counts after', async () => {
    const t = setup();
    await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'forget_document', sourceId: SOURCE },
    });
    expect(t.calls.order).toEqual(['copiesOf', 'forgetDocument', 'conversationsWithAnswers']);
    expect(t.calls.counted).toEqual([COPIES]);
  });

  it('a count that cannot be made is null — the forget still succeeded, and says so', async () => {
    for (const store_ of [
      store({ copies: new NetworkError('reset') }),
      store({ held: new NetworkError('reset') }),
      store({ copies: null }),
    ]) {
      const t = setup({ store: store_ });
      const result = await handleSettingsRequest(t.deps, {
        token: 'good',
        body: { action: 'forget_document', sourceId: SOURCE },
      });
      expect(result.status).toBe(200);
      expect(bodyOf(result)).toMatchObject({
        outcome: 'forgotten',
        conversationsWithAnswers: null,
      });
    }
  });

  it('a refused forget counts nothing; the second tab is not given a count', async () => {
    const refused = setup({ store: store({ forget: { kind: 'not_allowed' } }) });
    await handleSettingsRequest(refused.deps, {
      token: 'good',
      body: { action: 'forget_document', sourceId: SOURCE },
    });
    expect(refused.calls.counted).toEqual([]);
    const already = setup({ store: store({ forget: { kind: 'already' } }) });
    const result = await handleSettingsRequest(already.deps, {
      token: 'good',
      body: { action: 'forget_document', sourceId: SOURCE },
    });
    expect(bodyOf(result)).toMatchObject({ outcome: 'already', conversationsWithAnswers: null });
    expect(already.calls.counted).toEqual([]);
  });

  it('the second press — another tab got there first — is a calm 200 "already"', async () => {
    const t = setup({ store: store({ forget: { kind: 'already' } }) });
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'forget_document', sourceId: SOURCE },
    });
    expect(result.status).toBe(200);
    expect(bodyOf(result)).toMatchObject({ outcome: 'already', sources: 0, files: 0, chunks: 0 });
  });

  const refusals: [ForgetOutcome, number, string, string][] = [
    [{ kind: 'not_found' }, 404, 'NOT_FOUND', SETTINGS_MESSAGES.documentGone],
    [{ kind: 'not_allowed' }, 403, 'NOT_YOURS', FORGET_REFUSED_MESSAGE],
    [{ kind: 'not_staff' }, 403, 'FORBIDDEN', SETTINGS_MESSAGES.forbidden],
  ];
  it.each(refusals)('%o → %i %s', async (outcome, status, code, message) => {
    const t = setup({ store: store({ forget: outcome }) });
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'forget_document', sourceId: SOURCE },
    });
    expect(result.status).toBe(status);
    expect(errorOf(result)).toEqual({ code, message, retryable: false });
  });

  it('a lost answer says to refresh and look, because it may have gone through', async () => {
    const t = setup({ store: store({ forget: new NetworkError('reset') }) });
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'forget_document', sourceId: SOURCE },
    });
    expect(result.status).toBe(503);
    expect(errorOf(result)).toEqual({
      code: 'UNAVAILABLE',
      message: SETTINGS_MESSAGES.forgetUnconfirmed,
      retryable: true,
    });
  });

  it('a database refusal is a 500, and its words stay in the log as a code', async () => {
    const t = setup({
      store: store({ forget: new AppError('HTTP_STATUS', 'forget_document: database error') }),
    });
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'forget_document', sourceId: SOURCE },
    });
    expect(result.status).toBe(500);
    expect(t.lines.some((line) => line.includes('settings: forget failed'))).toBe(true);
  });

  it('logs who, which document by id, the outcome and the counts — nothing else', async () => {
    const t = setup();
    await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'forget_document', sourceId: SOURCE },
    });
    const line = t.lines.find((l) => l.includes('settings: forget'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(parsed).toMatchObject({
      userId: ROSS,
      sourceId: SOURCE,
      outcome: 'forgotten',
      sources: 2,
      files: 1,
      chunks: 14,
    });
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'chunks',
        'conversationsWithAnswers',
        'durationMs',
        'files',
        'level',
        'msg',
        'outcome',
        'sourceId',
        'sources',
        'ts',
        'userId',
      ].sort(),
    );
  });
});

describe('create_key — shown once', () => {
  it('mints, stores only the digest, and returns the whole key once', async () => {
    const t = setup();
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'create_key', label: '  Claude on my laptop  ' },
    });
    expect(result.status).toBe(200);
    const body = bodyOf(result);
    expect(body['action']).toBe('create_key');
    expect(body['label']).toBe('Claude on my laptop');
    const key = String(body['key']);
    expect(parseKey(key)?.keyId).toBe(body['keyId']);
    const issued = t.calls.issues[0];
    expect(issued?.userId).toBe(ROSS);
    expect(issued?.keyId).toBe(body['keyId']);
    expect(issued?.digestHex).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(t.calls.issues)).not.toContain(key);
  });

  it('never writes the key — not whole, not its secret half, not its digest — nor the label, to a log', async () => {
    const t = setup();
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'create_key', label: 'Secret-sounding label 42' },
    });
    const key = String(bodyOf(result)['key']);
    const secret = key.slice(key.lastIndexOf('_') + 1);
    const all = t.lines.join('\n');
    expect(all).toContain('settings: connector key created');
    expect(all).not.toContain(key);
    expect(all).not.toContain(secret);
    expect(all).not.toContain(t.calls.issues[0]?.digestHex ?? 'missing');
    expect(all).not.toContain('Secret-sounding');
    // The public id is what links a log line to the list row, under a field that is not redacted.
    expect(all).toContain(`"connector":"${String(bodyOf(result)['keyId'])}"`);
  });

  it.each([
    ['', SETTINGS_MESSAGES.labelRequired],
    ['    ', SETTINGS_MESSAGES.labelRequired],
    ['x'.repeat(KEY_LABEL_MAX + 1), SETTINGS_MESSAGES.labelTooLong],
    ['two\nlines', SETTINGS_MESSAGES.labelBadCharacter],
  ])('refuses the label %j in words, and mints nothing', async (label, message) => {
    const t = setup();
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'create_key', label },
    });
    expect(result.status).toBe(400);
    expect(errorOf(result)).toEqual({ code: 'BAD_LABEL', message, retryable: false });
    expect(t.calls.issues).toHaveLength(0);
  });

  it('counts a label in characters as the database does: 80 non-Latin characters are allowed', async () => {
    const t = setup();
    const label = 'ک'.repeat(KEY_LABEL_MAX);
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'create_key', label },
    });
    expect(result.status).toBe(200);
    expect(t.calls.issues[0]?.label).toBe(label);
  });

  it('a second key while one exists is simply another key; at the limit it says what to do', async () => {
    const t = setup({ store: store({ issue: [{ kind: 'too_many' }] }) });
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'create_key', label: 'Sixth' },
    });
    expect(result.status).toBe(409);
    expect(errorOf(result)).toEqual({
      code: 'TOO_MANY_KEYS',
      message: SETTINGS_MESSAGES.tooManyKeys,
      retryable: false,
    });
  });

  it('an id collision is tried again with a new key; three in a row is a 500', async () => {
    const once = setup({ store: store({ issue: [{ kind: 'id_taken' }] }) });
    const first = await handleSettingsRequest(once.deps, {
      token: 'good',
      body: { action: 'create_key', label: 'Retry' },
    });
    expect(first.status).toBe(200);
    expect(once.calls.issues).toHaveLength(2);
    expect(once.calls.issues[0]?.keyId).not.toBe(once.calls.issues[1]?.keyId);

    const always = setup({
      store: store({ issue: [{ kind: 'id_taken' }, { kind: 'id_taken' }, { kind: 'id_taken' }] }),
    });
    const failed = await handleSettingsRequest(always.deps, {
      token: 'good',
      body: { action: 'create_key', label: 'Retry' },
    });
    expect(failed.status).toBe(500);
    expect(always.calls.issues).toHaveLength(3);
  });

  it('the database saying the person is not staff is a 403; a lost answer says to check the list', async () => {
    const notStaff = setup({ store: store({ issue: [{ kind: 'not_staff' }] }) });
    expect(
      (
        await handleSettingsRequest(notStaff.deps, {
          token: 'good',
          body: { action: 'create_key', label: 'x' },
        })
      ).status,
    ).toBe(403);
    const lost = setup({ store: store({ issue: [new NetworkError('reset')] }) });
    const result = await handleSettingsRequest(lost.deps, {
      token: 'good',
      body: { action: 'create_key', label: 'x' },
    });
    expect(result.status).toBe(503);
    expect(errorOf(result).message).toBe(SETTINGS_MESSAGES.createUnconfirmed);
  });
});

describe('revoke_key', () => {
  it('switches off the person’s own key by its public id', async () => {
    const t = setup();
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'revoke_key', keyId: 'abcdefghjkmn' },
    });
    expect(result).toEqual({
      status: 200,
      body: {
        action: 'revoke_key',
        outcome: 'revoked',
        keyId: 'abcdefghjkmn',
        revokedAt: '2026-10-17T05:30:01+00:00',
      },
    });
    expect(t.calls.revokes).toEqual([{ userId: ROSS, keyId: 'abcdefghjkmn' }]);
  });

  it('a key already switched off says so and changes nothing', async () => {
    const t = setup({
      store: store({
        revoke: {
          kind: 'already_revoked',
          keyId: 'abcdefghjkmn',
          revokedAt: '2026-10-16T00:00:00Z',
        },
      }),
    });
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'revoke_key', keyId: 'abcdefghjkmn' },
    });
    expect(bodyOf(result)).toMatchObject({ outcome: 'already', revokedAt: '2026-10-16T00:00:00Z' });
  });

  it('somebody else’s key, or none, is "not yours, or gone" — the same answer', async () => {
    const t = setup({ store: store({ revoke: { kind: 'not_found' } }) });
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'revoke_key', keyId: 'abcdefghjkmn' },
    });
    expect(result.status).toBe(404);
    expect(errorOf(result).message).toBe(SETTINGS_MESSAGES.keyGone);
  });

  it('a whole key pasted where an id goes is refused before it reaches the database or a log', async () => {
    const t = setup();
    const whole = `fcc_abcdefghjkmn_${'A'.repeat(43)}`;
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'revoke_key', keyId: whole },
    });
    expect(result.status).toBe(400);
    expect(t.calls.revokes).toHaveLength(0);
    expect(t.lines.join('\n')).not.toContain(whole);
  });

  it('a lost answer is a 503 that says switching off again is safe', async () => {
    const t = setup({ store: store({ revoke: new NetworkError('reset') }) });
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'revoke_key', keyId: 'abcdefghjkmn' },
    });
    expect(result.status).toBe(503);
    expect(errorOf(result).message).toBe(SETTINGS_MESSAGES.revokeUnconfirmed);
  });
});

describe('spend — read-only, the cap’s own numbers', () => {
  it('reads today and this month from the cap’s own UTC windows', async () => {
    const t = setup();
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'spend' },
    });
    expect(result).toEqual({
      status: 200,
      body: {
        action: 'spend',
        outcome: 'read',
        capDailyUsd: 5,
        capMonthlyUsd: 80,
        warnFraction: 0.8,
        todayUsd: 0.4321,
        monthUsd: 12.345679,
        dayStartedAt: '2026-10-17T00:00:00.000Z',
        monthStartedAt: '2026-10-01T00:00:00.000Z',
        asOf: NOW.toISOString(),
      },
    });
  });

  it('a cap that is not configured is said, not guessed at — and forgetting still works', async () => {
    const t = setup({ caps: err(new ConfigError('ANTHROPIC_DAILY_SPEND_CAP_USD is required')) });
    const spend = await handleSettingsRequest(t.deps, { token: 'good', body: { action: 'spend' } });
    expect(spend.status).toBe(503);
    expect(errorOf(spend)).toMatchObject({
      code: 'NOT_CONFIGURED',
      message: SETTINGS_MESSAGES.spendNotConfigured,
    });
    const forget = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'forget_document', sourceId: SOURCE },
    });
    expect(forget.status).toBe(200);
  });

  it('a sum that cannot be read is a 503 to try again', async () => {
    const t = setup({ spent: () => Promise.resolve(err(new NetworkError('down'))) });
    const result = await handleSettingsRequest(t.deps, {
      token: 'good',
      body: { action: 'spend' },
    });
    expect(result.status).toBe(503);
    expect(errorOf(result).retryable).toBe(true);
  });
});
