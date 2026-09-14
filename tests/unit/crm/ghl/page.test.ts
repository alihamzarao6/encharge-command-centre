/**
 * The overview's refresh handler (src/lib/crm/ghl/page.ts) — the thing the `crm` Edge
 * Function is a thin adapter over. Every dependency is faked: the verifier answers from a
 * table of tokens, the sync returns a canned report, and a capturing log sink is scanned
 * after every test for anything that is not an id or a count.
 *
 * What is proven:
 *   - no token / a bad token → 401; not on the allowlist / deactivated → 403; the auth
 *     server being unreachable → 503, never a 500 and never a run;
 *   - a member (not only an admin) may refresh, and the run records who asked;
 *   - success and partial are 200 with counts and ids; refused is 409; failed is 502 with a
 *     sentence that names the cause — a rejected token says so in words;
 *   - a sync that throws is a 500, not an unhandled rejection;
 *   - nothing in any reply or log line is a name, an email or a phone number.
 */
import { describe, expect, it } from 'vitest';

import type { StaffRow } from '../../../../src/lib/auth/verify.js';
import {
  describeSyncFailure,
  handleCrmRequest,
  type CrmPageDeps,
  type CrmPageResult,
} from '../../../../src/lib/crm/ghl/page.js';
import type { RunOptions, SyncReport } from '../../../../src/lib/crm/ghl/sync.js';
import { NetworkError, err, ok } from '../../../../src/lib/errors.js';
import { createLogger } from '../../../../src/lib/logger.js';

const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const STAFF_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const GONE_ID = 'cccccccc-0000-4000-8000-000000000003';
const OUTSIDER_ID = 'dddddddd-0000-4000-8000-000000000004';
const RUN_ID = 'e0000000-0000-4000-8000-000000000001';

const FETCH = {
  requests: 13,
  pages_fetched: 1,
  opportunities_fetched: 10,
  opportunities_rejected: 0,
  contacts_fetched: 9,
  contacts_failed: 1,
  contacts_rejected: 0,
  contacts_missing: 0,
  custom_fields_fetched: 57,
};

const APPLY = {
  stages_seen: 10,
  stages_added: 0,
  stages_updated: 0,
  stages_removed: 0,
  opportunities_inserted: 0,
  opportunities_updated: 2,
  opportunities_unchanged: 8,
  opportunities_removed: 0,
  contacts_inserted: 0,
  contacts_updated: 1,
  contacts_unchanged: 8,
  contacts_removed: 0,
  custom_fields_seen: 13,
  custom_fields_removed: 0,
};

function report(overrides: Partial<SyncReport>): SyncReport {
  return {
    status: 'success',
    runId: RUN_ID,
    pipelineId: 'M4unnMKBy0TgwCwOA6wS',
    durationMs: 2_400,
    staleMarked: 0,
    fetch: { ...FETCH, contacts_failed: 0, contacts_fetched: 10 },
    apply: APPLY,
    errors: [],
    error: null,
    ...overrides,
  };
}

interface Harness {
  readonly deps: CrmPageDeps;
  readonly runs: RunOptions[];
  readonly logLines: string[];
}

function makeHarness(
  answer: (options: RunOptions) => Promise<SyncReport>,
  authDown = false,
): Harness {
  const rows = new Map<string, StaffRow>([
    [
      ADMIN_ID,
      { user_id: ADMIN_ID, email: 'admin@x.com', role: 'owner', is_active: true, is_admin: true },
    ],
    [
      STAFF_ID,
      { user_id: STAFF_ID, email: 'staff@x.com', role: 'staff', is_active: true, is_admin: false },
    ],
    [
      GONE_ID,
      { user_id: GONE_ID, email: 'gone@x.com', role: 'staff', is_active: false, is_admin: false },
    ],
  ]);
  const tokens = new Map<string, string>([
    ['admin-token', ADMIN_ID],
    ['staff-token', STAFF_ID],
    ['gone-token', GONE_ID],
    ['outsider-token', OUTSIDER_ID],
  ]);
  const runs: RunOptions[] = [];
  const logLines: string[] = [];
  const deps: CrmPageDeps = {
    verify: {
      getUserFromToken: (token) => {
        if (authDown) return Promise.resolve(err(new NetworkError('auth unreachable')));
        const id = tokens.get(token);
        return Promise.resolve(ok(id === undefined ? null : { id, email: `${id}@x.com` }));
      },
      getStaffRow: (userId) => Promise.resolve(ok(rows.get(userId) ?? null)),
    },
    runSync: (options) => {
      runs.push(options);
      return answer(options);
    },
    // No run has ever started: the cooldown (part 3) never applies in this harness. The
    // cooldown's own tests build their harness with a run row.
    latestRun: () => Promise.resolve(ok(null)),
    log: createLogger({
      level: 'debug',
      sink: (line) => {
        logLines.push(line);
      },
    }),
  };
  return { deps, runs, logLines };
}

function call(
  h: Harness,
  token: string | null,
  body: unknown = { action: 'sync' },
): Promise<CrmPageResult> {
  return handleCrmRequest(h.deps, { token, body: body as { action?: unknown } });
}

function expectNoPersonalDetails(h: Harness, result: CrmPageResult): void {
  const text = JSON.stringify(result.body) + h.logLines.join('\n');
  expect(text).not.toMatch(/@x\.com/);
  expect(text).not.toMatch(/\+61/);
  expect(text).not.toContain('Alex');
}

describe('who may refresh', () => {
  it('no token → 401, and no sync is attempted', async () => {
    const h = makeHarness(() => Promise.resolve(report({})));
    expect(await call(h, null)).toEqual({
      status: 401,
      body: {
        error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', retryable: false },
      },
    });
    expect(await call(h, '   ')).toMatchObject({ status: 401 });
    expect(h.runs).toEqual([]);
  });

  it('an unknown token → 401', async () => {
    const h = makeHarness(() => Promise.resolve(report({})));
    expect(await call(h, 'nope')).toMatchObject({ status: 401 });
    expect(h.runs).toEqual([]);
  });

  it('a valid account that is not on the allowlist, or is deactivated → 403 FORBIDDEN', async () => {
    const h = makeHarness(() => Promise.resolve(report({})));
    expect(await call(h, 'outsider-token')).toEqual({
      status: 403,
      body: {
        error: {
          code: 'FORBIDDEN',
          message: 'This account does not have access.',
          retryable: false,
        },
      },
    });
    expect(await call(h, 'gone-token')).toMatchObject({
      status: 403,
      body: { error: { code: 'FORBIDDEN' } },
    });
    expect(h.runs).toEqual([]);
  });

  it('the auth server being unreachable → 503, retryable, and no sync', async () => {
    const h = makeHarness(() => Promise.resolve(report({})), true);
    expect(await call(h, 'admin-token')).toMatchObject({
      status: 503,
      body: { error: { code: 'AUTH_UNAVAILABLE', retryable: true } },
    });
    expect(h.runs).toEqual([]);
  });

  it('a member who is not an administrator may refresh, and the run records who asked', async () => {
    const h = makeHarness(() => Promise.resolve(report({})));
    const result = await call(h, 'staff-token');
    expect(result.status).toBe(200);
    expect(h.runs).toEqual([{ trigger: 'api', triggeredBy: STAFF_ID }]);
  });

  it('an action other than sync → 400, before any verification', async () => {
    const h = makeHarness(() => Promise.resolve(report({})));
    expect(await call(h, 'admin-token', { action: 'delete_everything' })).toMatchObject({
      status: 400,
      body: { error: { code: 'BAD_REQUEST' } },
    });
    expect(await call(h, 'admin-token', {})).toMatchObject({ status: 400 });
    expect(h.runs).toEqual([]);
  });
});

describe('what comes back', () => {
  it('success → 200 with the counts the screen shows and nothing personal', async () => {
    const h = makeHarness(() => Promise.resolve(report({})));
    const result = await call(h, 'admin-token');
    expect(result).toEqual({
      status: 200,
      body: {
        action: 'sync',
        status: 'success',
        runId: RUN_ID,
        durationMs: 2_400,
        opportunitiesFetched: 10,
        contactsFetched: 10,
        contactsUnread: 0,
        errors: [],
      },
    });
    expectNoPersonalDetails(h, result);
  });

  it('partial → 200 with the unread contacts counted and listed by id', async () => {
    const h = makeHarness(() =>
      Promise.resolve(
        report({
          status: 'partial',
          fetch: { ...FETCH, contacts_missing: 1 },
          errors: [
            { kind: 'contact', id: 'CONTACT000000000002', code: 'NETWORK' },
            { kind: 'contact', id: 'CONTACT000000000003', code: 'NOT_FOUND' },
          ],
        }),
      ),
    );
    const result = await call(h, 'admin-token');
    expect(result).toMatchObject({
      status: 200,
      body: {
        status: 'partial',
        contactsFetched: 9,
        contactsUnread: 2,
        errors: [
          { kind: 'contact', id: 'CONTACT000000000002', code: 'NETWORK' },
          { kind: 'contact', id: 'CONTACT000000000003', code: 'NOT_FOUND' },
        ],
      },
    });
    expectNoPersonalDetails(h, result);
  });

  it('refused (another run in progress) → 409, retryable, with no run id', async () => {
    const h = makeHarness(() =>
      Promise.resolve(
        report({
          status: 'refused',
          runId: null,
          apply: null,
          error: { code: 'CONFLICT', message: 'begin_ghl_sync_run: already running' },
        }),
      ),
    );
    expect(await call(h, 'admin-token')).toEqual({
      status: 409,
      body: {
        error: { code: 'SYNC_RUNNING', message: 'A refresh is already running.', retryable: true },
      },
    });
  });

  it('a rejected GoHighLevel token → 502 that says so in words, with the run id', async () => {
    const h = makeHarness(() =>
      Promise.resolve(
        report({
          status: 'failed',
          apply: null,
          errors: [{ kind: 'contact', id: null, code: 'UNAUTHENTICATED' }],
          error: {
            code: 'UNAUTHENTICATED',
            message:
              'GoHighLevel rejected the token (401): it is revoked, expired or wrong. This is NOT an empty pipeline — no data was read.',
          },
        }),
      ),
    );
    const result = await call(h, 'admin-token');
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      error: { code: 'UNAUTHENTICATED', retryable: false },
      runId: RUN_ID,
    });
    const message = (result.body as { error: { message: string } }).error.message;
    expect(message).toContain('rejected our access key');
    expect(message).toContain('last successful refresh');
    expectNoPersonalDetails(h, result);
  });

  it('GoHighLevel not answering → 502, retryable; a wrong pipeline id → 502, not retryable', async () => {
    const down = makeHarness(() =>
      Promise.resolve(
        report({ status: 'failed', apply: null, error: { code: 'TIMEOUT', message: 'timed out' } }),
      ),
    );
    expect(await call(down, 'admin-token')).toMatchObject({
      status: 502,
      body: { error: { code: 'TIMEOUT', retryable: true } },
    });
    const wrong = makeHarness(() =>
      Promise.resolve(
        report({
          status: 'failed',
          apply: null,
          error: { code: 'CONFIG', message: 'not a pipeline' },
        }),
      ),
    );
    expect(await call(wrong, 'admin-token')).toMatchObject({
      status: 502,
      body: { error: { code: 'CONFIG', retryable: false } },
    });
  });

  it('a sync that throws → 500, logged, never an unhandled rejection', async () => {
    const h = makeHarness(() => Promise.reject(new Error('store exploded')));
    expect(await call(h, 'admin-token')).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'Internal error.', retryable: false } },
    });
    expect(h.logLines.some((l) => l.includes('crm request threw'))).toBe(true);
  });

  it('a success without a run id is a 500, not a reply the screen would trust', async () => {
    const h = makeHarness(() => Promise.resolve(report({ runId: null })));
    expect(await call(h, 'admin-token')).toMatchObject({ status: 500 });
  });
});

/**
 * Part 3 item 13: the cooldown is enforced by the ENDPOINT, not only by a disabled button.
 * Every test here would fail without the check in page.ts — the assertion is that the sync
 * was never started, which is the whole point of a rate limit.
 */
describe('the cooldown, enforced server-side', () => {
  const NOW = Date.parse('2026-09-14T02:00:00Z');
  const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

  function withLastRun(
    lastRun: { started_at: string; finished_at: string | null } | null,
    extra: Partial<CrmPageDeps> = {},
  ): Harness {
    const h = makeHarness(() => Promise.resolve(report({})));
    const deps: CrmPageDeps = {
      ...h.deps,
      latestRun: () => Promise.resolve(ok(lastRun)),
      now: () => NOW,
      ...extra,
    };
    return { ...h, deps };
  }

  it('a run that ended 20 seconds ago → 429, how long to wait, and NO sync started', async () => {
    const h = withLastRun({ started_at: at(25_000), finished_at: at(20_000) });
    const result = await call(h, 'staff-token');
    expect(result.status).toBe(429);
    expect(result.body).toEqual({
      error: {
        code: 'SYNC_COOLDOWN',
        message: 'The pipeline was refreshed 20 seconds ago. You can refresh again in 40 seconds.',
        retryable: true,
      },
      retryAfterSeconds: 40,
    });
    expect(h.runs).toHaveLength(0);
    expectNoPersonalDetails(h, result);
  });

  it('a run that FAILED 20 seconds ago counts just the same — hammering a failing GoHighLevel is the case to prevent', async () => {
    const h = withLastRun({ started_at: at(21_000), finished_at: at(20_000) });
    const result = await call(h, 'admin-token');
    expect(result.status).toBe(429);
    expect(h.runs).toHaveLength(0);
  });

  it('a run that ended a minute ago → the sync starts', async () => {
    const h = withLastRun({ started_at: at(70_000), finished_at: at(60_000) });
    const result = await call(h, 'staff-token');
    expect(result.status).toBe(200);
    expect(h.runs).toHaveLength(1);
  });

  it('no run ever → the sync starts', async () => {
    const h = withLastRun(null);
    expect((await call(h, 'staff-token')).status).toBe(200);
    expect(h.runs).toHaveLength(1);
  });

  it('a run still in progress from 10 seconds ago → 429 here, before the database would say 409', async () => {
    const h = withLastRun({ started_at: at(10_000), finished_at: null });
    expect((await call(h, 'staff-token')).status).toBe(429);
    expect(h.runs).toHaveLength(0);
  });

  it('a run stalled 20 minutes ago has aged out: the sync starts and the database retires it', async () => {
    const h = withLastRun({ started_at: at(20 * 60_000), finished_at: null });
    expect((await call(h, 'staff-token')).status).toBe(200);
    expect(h.runs).toHaveLength(1);
  });

  it('the window is configurable: a 5-second window lets a 20-second-old run through', async () => {
    const h = withLastRun(
      { started_at: at(25_000), finished_at: at(20_000) },
      { cooldownMs: 5_000 },
    );
    expect((await call(h, 'staff-token')).status).toBe(200);
  });

  it('the check comes AFTER authentication: an outsider inside the window is 401/403, not 429', async () => {
    const h = withLastRun({ started_at: at(25_000), finished_at: at(20_000) });
    expect((await call(h, null)).status).toBe(401);
    expect((await call(h, 'outsider-token')).status).toBe(403);
    expect((await call(h, 'gone-token')).status).toBe(403);
    expect(h.runs).toHaveLength(0);
  });

  it('the last run cannot be read → 503, retryable, and no sync: the limit fails closed', async () => {
    const h = withLastRun(null, {
      latestRun: () => Promise.resolve(err(new NetworkError('database unreachable'))),
    });
    const result = await call(h, 'staff-token');
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: { code: 'COOLDOWN_UNKNOWN', retryable: true } });
    expect(h.runs).toHaveLength(0);
  });
});

describe('describeSyncFailure', () => {
  it('names the cause for the codes that matter and falls back to the code itself', () => {
    expect(describeSyncFailure('UNAUTHENTICATED').message).toMatch(/access key/);
    expect(describeSyncFailure('FORBIDDEN').message).toMatch(/refused/);
    expect(describeSyncFailure('CONFIG').message).toMatch(/not configured/);
    for (const code of ['TIMEOUT', 'NETWORK', 'CIRCUIT_OPEN']) {
      expect(describeSyncFailure(code)).toMatchObject({ retryable: true });
      expect(describeSyncFailure(code).message).toMatch(/didn't answer/);
    }
    expect(describeSyncFailure('HTTP_STATUS')).toEqual({
      message:
        'The refresh failed (HTTP_STATUS), so nothing was refreshed. The numbers on screen are from the last successful refresh.',
      retryable: false,
    });
  });
});
