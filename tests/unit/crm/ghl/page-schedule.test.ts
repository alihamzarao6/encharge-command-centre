/**
 * The scheduled refresh (brief of 14 Oct 2026, "Keeping the data fresh"): the `scheduled-sync`
 * action of src/lib/crm/ghl/page.ts, which the database's scheduler calls every ten minutes.
 *
 * Wherever an edge case is about what a RUN does, the real `runGhlSync` is used over the fake
 * client and a store that keeps one running slot, so the handler, the sync and the lock's
 * contract are exercised together. The database's half of the same cases — the stale run
 * retired at 1,200 seconds and not at 600, a request that produced no run — is
 * tests/integration/ghl-schedule.test.ts, against the real SQL.
 *
 * What is proven:
 *   - who may call: the right secret and nobody else — not a signed-in member, not an
 *     administrator, not an unconfigured function, and the secret opens no other action;
 *   - the schedule and the button: the schedule never consults the cooldown, a scheduled run
 *     counts towards the button's, and whichever arrives second while the other holds the slot
 *     is told so (a skip, not a failure) — ordered by an explicit gate, not by timing;
 *   - 401 from GoHighLevel is loud, 429 is a failed or a partial run, an outage is a row per
 *     tick and then a success with nothing carried over, an empty pipeline is a success;
 *   - every scheduled request writes one structured line, and neither a line nor a reply
 *     carries the secret or anything about a person.
 */
import { describe, expect, it } from 'vitest';

import type { StaffRow } from '../../../../src/lib/auth/verify.js';
import {
  SCHEDULED_LOG_MESSAGE,
  handleCrmRequest,
  type CrmPageDeps,
  type CrmPageResult,
} from '../../../../src/lib/crm/ghl/page.js';
import {
  runGhlSync,
  type BeginRunInput,
  type GhlSyncStore,
  type RunOptions,
  type SyncReport,
} from '../../../../src/lib/crm/ghl/sync.js';
import { AppError, err, ok } from '../../../../src/lib/errors.js';
import { RateLimitedError } from '../../../../src/lib/llm/errors.js';
import { capturingLogger } from '../../llm/helpers.js';
import {
  FINANCE_PIPELINE_ID,
  RUN_ID,
  ZERO_APPLY,
  conflict,
  fakeGhlClient,
  fakeSyncStore,
  fixtureContact,
  fixtureOpportunities,
  ghlConfig,
  must,
  transport,
  unauthenticated,
  type FakeGhlClient,
} from './helpers.js';

// Fake by construction: repeated letters, the length of 32 random bytes in base64url.
const SECRET = 'S'.repeat(43);
const WRONG = 'W'.repeat(43);
const STAFF_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const TICK_AT = Date.parse('2026-10-14T00:03:00.000Z');

interface Harness {
  readonly deps: CrmPageDeps;
  readonly client: FakeGhlClient;
  readonly lines: string[];
  /** Tokens the staff verifier was asked about. Empty = it was never consulted. */
  readonly verified: string[];
  /** How many times the cooldown's "newest run" was read. */
  readonly cooldownReads: number[];
  readonly runs: RunOptions[];
}

interface HarnessOptions {
  readonly held?: string | null;
  readonly store?: GhlSyncStore;
  /** What the cooldown would see as the newest run: ended this many ms before the tick. */
  readonly lastRunEndedMsAgo?: number | null;
  readonly runSync?: (options: RunOptions) => Promise<SyncReport>;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const client = fakeGhlClient();
  const store = options.store ?? fakeSyncStore();
  const { log, lines } = capturingLogger();
  let tick = TICK_AT;
  const now = (): number => (tick += 250);
  const staff: StaffRow = {
    user_id: STAFF_ID,
    email: 'staff@x.com',
    role: 'staff',
    is_active: true,
    is_admin: true,
  };
  const verified: string[] = [];
  const cooldownReads: number[] = [];
  const runs: RunOptions[] = [];
  const endedAgo = options.lastRunEndedMsAgo ?? null;
  const deps: CrmPageDeps = {
    verify: {
      getUserFromToken: (token) => {
        verified.push(token);
        return Promise.resolve(
          ok(token === 'staff-token' ? { id: STAFF_ID, email: staff.email } : null),
        );
      },
      getStaffRow: (userId) => Promise.resolve(ok(userId === STAFF_ID ? staff : null)),
    },
    runSync: (runOptions) => {
      runs.push(runOptions);
      return options.runSync === undefined
        ? runGhlSync({ client, store, config: ghlConfig(), log, now }, runOptions)
        : options.runSync(runOptions);
    },
    latestRun: () => {
      cooldownReads.push(1);
      return Promise.resolve(
        ok(
          endedAgo === null
            ? null
            : {
                started_at: new Date(TICK_AT - endedAgo - 5_000).toISOString(),
                finished_at: new Date(TICK_AT - endedAgo).toISOString(),
              },
        ),
      );
    },
    move: () => Promise.reject(new Error('move is not part of this harness')),
    note: () => Promise.reject(new Error('note is not part of this harness')),
    log,
    scheduleSecret: options.held === undefined ? SECRET : options.held,
    now,
  };
  return { deps, client, lines, verified, cooldownReads, runs };
}

/** With no second argument the right secret is sent; an explicit `undefined` sends none. */
function scheduled(
  h: Harness,
  ...sent: [secret?: string | null, token?: string | null]
): Promise<CrmPageResult> {
  return handleCrmRequest(h.deps, {
    token: sent[1] ?? null,
    body: { action: 'scheduled-sync' },
    scheduleSecret: sent.length === 0 ? SECRET : sent[0],
  });
}

function pressed(h: Harness, secret?: string | null): Promise<CrmPageResult> {
  return handleCrmRequest(h.deps, {
    token: 'staff-token',
    body: { action: 'sync' },
    ...(secret === undefined ? {} : { scheduleSecret: secret }),
  });
}

interface ScheduledLine {
  readonly level: string;
  readonly msg: string;
  readonly outcome: string;
  readonly [field: string]: unknown;
}

function scheduledLines(h: Harness): ScheduledLine[] {
  return h.lines
    .map((line) => JSON.parse(line) as ScheduledLine)
    .filter((record) => record.msg === SCHEDULED_LOG_MESSAGE);
}

const UNAUTHORISED = {
  status: 401,
  body: { error: { code: 'UNAUTHENTICATED', message: 'Not authorised.', retryable: false } },
};

/**
 * A store with the database's one rule that matters here: one running slot. A second starter
 * gets CONFLICT — what store.ts makes of SQLSTATE 55006 — until the first finishes.
 */
function slotStore(): GhlSyncStore & {
  readonly begins: BeginRunInput[];
  readonly claimed: Promise<void>;
  applied: number;
} {
  let open = false;
  let announce: () => void = () => undefined;
  const claimed = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const store = {
    begins: [] as BeginRunInput[],
    claimed,
    applied: 0,
    beginRun: (input: BeginRunInput) => {
      store.begins.push(input);
      if (open) return Promise.resolve(err(conflict()));
      open = true;
      announce();
      return Promise.resolve(ok({ runId: RUN_ID, staleMarked: 0 }));
    },
    applySnapshot: () => {
      store.applied += 1;
      return Promise.resolve(ok({ ...ZERO_APPLY, opportunities_unchanged: 4 }));
    },
    finishRun: () => {
      open = false;
      return Promise.resolve(ok(undefined));
    },
  };
  return store;
}

/** Holds a run open at its first GoHighLevel call until the test lets it go. */
function gateFirstCall(client: FakeGhlClient): () => void {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getPipelines = client.getPipelines.bind(client);
  let first = true;
  client.getPipelines = async () => {
    if (first) {
      first = false;
      await gate;
    }
    return getPipelines();
  };
  return release;
}

describe('who may ask for a scheduled refresh', () => {
  it('the right secret → the sync runs as the schedule, for nobody, and no person is looked up', async () => {
    const h = makeHarness();
    const result = await scheduled(h);
    expect(result.status).toBe(200);
    expect(h.runs).toEqual([{ trigger: 'schedule', triggeredBy: null }]);
    expect(h.verified).toEqual([]);
  });

  it('no secret, an empty one or a wrong one → 401, one sentence for all three, and nothing runs', async () => {
    const h = makeHarness();
    expect(await scheduled(h, null)).toEqual(UNAUTHORISED);
    expect(await scheduled(h, undefined)).toEqual(UNAUTHORISED);
    expect(await scheduled(h, '')).toEqual(UNAUTHORISED);
    expect(await scheduled(h, WRONG)).toEqual(UNAUTHORISED);
    expect(await scheduled(h, SECRET.slice(0, -1))).toEqual(UNAUTHORISED);
    expect(h.runs).toEqual([]);
    expect(h.client.calls).toEqual([]);
  });

  it('a signed-in administrator without the secret is refused too: a session is not the credential', async () => {
    const h = makeHarness();
    expect(await scheduled(h, null, 'staff-token')).toEqual(UNAUTHORISED);
    expect(await scheduled(h, WRONG, 'staff-token')).toEqual(UNAUTHORISED);
    expect(h.runs).toEqual([]);
    // Refused before the session was even looked at.
    expect(h.verified).toEqual([]);
  });

  it('a function with no secret configured accepts nothing, whatever is sent', async () => {
    for (const held of [null, '', 'short']) {
      const h = makeHarness({ held });
      expect(await scheduled(h, '')).toEqual(UNAUTHORISED);
      expect(await scheduled(h, null)).toEqual(UNAUTHORISED);
      expect(await scheduled(h, held)).toEqual(UNAUTHORISED);
      expect(await scheduled(h, SECRET)).toEqual(UNAUTHORISED);
      expect(h.runs).toEqual([]);
    }
  });

  it('the log says which it was — not configured, nothing sent, or a mismatch — at error level', async () => {
    const reasonOf = (h: Harness): unknown =>
      h.lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record['msg'] === 'crm: scheduled refresh refused')
        .map((record) => [record['level'], record['reason'], record['alert']]);
    const unconfigured = makeHarness({ held: null });
    await scheduled(unconfigured, SECRET);
    expect(reasonOf(unconfigured)).toEqual([['error', 'not_configured', 'ghl_schedule_refused']]);
    const nothing = makeHarness();
    await scheduled(nothing, null);
    expect(reasonOf(nothing)).toEqual([['error', 'nothing_sent', 'ghl_schedule_refused']]);
    const wrong = makeHarness();
    await scheduled(wrong, WRONG);
    expect(reasonOf(wrong)).toEqual([['error', 'mismatch', 'ghl_schedule_refused']]);
  });

  it('the secret opens nothing else: sent with the action of the button and no session it is a 401', async () => {
    const h = makeHarness();
    const result = await handleCrmRequest(h.deps, {
      token: null,
      body: { action: 'sync' },
      scheduleSecret: SECRET,
    });
    expect(result).toMatchObject({ status: 401, body: { error: { code: 'UNAUTHENTICATED' } } });
    for (const action of ['move', 'note']) {
      const other = await handleCrmRequest(h.deps, {
        token: null,
        body: { action },
        scheduleSecret: SECRET,
      });
      expect(other.status).toBe(401);
    }
    expect(h.runs).toEqual([]);
  });

  it('a function that does not know the action answers 400 — what the scheduler reads as "redeployed underneath"', async () => {
    const h = makeHarness();
    const result = await handleCrmRequest(h.deps, {
      token: null,
      body: { action: 'scheduled-refresh' },
      scheduleSecret: SECRET,
    });
    expect(result).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
    expect(h.runs).toEqual([]);
  });
});

describe('the schedule, the button and the 60-second cooldown', () => {
  it('the schedule does not consult the cooldown: it runs one second after a refresh ended', async () => {
    const h = makeHarness({ lastRunEndedMsAgo: 1_000 });
    const result = await scheduled(h);
    expect(result.status).toBe(200);
    expect(h.cooldownReads).toEqual([]);
  });

  it('the button does: a press one second after a run of any kind is told how long to wait', async () => {
    const h = makeHarness({ lastRunEndedMsAgo: 1_000 });
    const result = await pressed(h);
    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({ error: { code: 'SYNC_COOLDOWN' }, retryAfterSeconds: 59 });
    expect(h.runs).toEqual([]);
  });

  it('a tick while a refresh someone pressed holds the slot is skipped, not failed, and the press completes', async () => {
    const store = slotStore();
    const h = makeHarness({ store });
    const release = gateFirstCall(h.client);

    const press = pressed(h);
    await store.claimed; // the press holds the slot and is waiting on GoHighLevel
    const tick = await scheduled(h);

    expect(tick).toEqual({
      status: 409,
      body: {
        error: { code: 'SYNC_RUNNING', message: 'A refresh is already running.', retryable: true },
      },
    });
    const lines = scheduledLines(h);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', outcome: 'skipped', runId: null });

    release();
    expect((await press).status).toBe(200);
    // Two starters, one run: the mirror was refreshed once, by the press.
    expect(store.begins.map((b) => b.trigger)).toEqual(['api', 'schedule']);
    expect(store.applied).toBe(1);
  });

  it('a press while a scheduled run holds the slot is told a refresh is running, and the tick completes', async () => {
    const store = slotStore();
    const h = makeHarness({ store });
    const release = gateFirstCall(h.client);

    const tick = scheduled(h);
    await store.claimed;
    const press = await pressed(h);

    expect(press).toMatchObject({ status: 409, body: { error: { code: 'SYNC_RUNNING' } } });
    release();
    expect((await tick).status).toBe(200);
    expect(store.begins.map((b) => b.trigger)).toEqual(['schedule', 'api']);
    expect(store.applied).toBe(1);
  });

  it('two scheduled runs overlapping because the first ran long: the second is skipped, the first completes', async () => {
    const store = slotStore();
    const h = makeHarness({ store });
    const release = gateFirstCall(h.client);

    const long = scheduled(h);
    await store.claimed;
    const next = await scheduled(h);

    expect(next.status).toBe(409);
    release();
    expect((await long).status).toBe(200);
    expect(store.applied).toBe(1);
    expect(scheduledLines(h).map((line) => line.outcome)).toEqual(['skipped', 'success']);
  });

  it('once the slot is free the next tick runs: a skip leaves nothing behind', async () => {
    const store = slotStore();
    const h = makeHarness({ store });
    const release = gateFirstCall(h.client);
    const first = scheduled(h);
    await store.claimed;
    expect((await scheduled(h)).status).toBe(409);
    release();
    await first;
    expect((await scheduled(h)).status).toBe(200);
    expect(store.applied).toBe(2);
  });
});

describe('GoHighLevel refusing or failing a scheduled run', () => {
  it('401: one request, nothing applied, a failed run, and the sentence and the line both name the key', async () => {
    const h = makeHarness();
    h.client.pipelines = err(unauthenticated());
    const result = await scheduled(h);

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      error: { code: 'UNAUTHENTICATED', retryable: false },
      runId: RUN_ID,
    });
    expect(JSON.stringify(result.body)).toContain('GoHighLevel rejected our access key');
    expect(h.client.calls).toEqual(['pipelines']);
    const lines = scheduledLines(h);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      outcome: 'failed',
      errorCode: 'UNAUTHENTICATED',
      changed: null,
    });
  });

  it('a dead key is asked again at the next tick, so a replaced key heals with nobody doing anything', async () => {
    const h = makeHarness();
    h.client.pipelines = err(unauthenticated());
    expect((await scheduled(h)).status).toBe(502);
    expect((await scheduled(h)).status).toBe(502);
    h.client.pipelines = fakeGhlClient().pipelines;
    expect((await scheduled(h)).status).toBe(200);
    expect(scheduledLines(h).map((line) => line.outcome)).toEqual(['failed', 'failed', 'success']);
  });

  it('429 on the first read, still refused after the retries: a failed run, nothing applied', async () => {
    const h = makeHarness();
    h.client.pipelines = err(new RateLimitedError(8_000, { context: { provider: 'ghl' } }));
    const result = await scheduled(h);
    expect(result).toMatchObject({ status: 502, body: { error: { code: 'RATE_LIMITED' } } });
    expect(h.client.calls).toEqual(['pipelines']);
    expect(scheduledLines(h)[0]).toMatchObject({ level: 'error', errorCode: 'RATE_LIMITED' });
  });

  it('429 on one contact: the run is partial, the rest is applied, and it is a warning', async () => {
    const h = makeHarness();
    h.client.contacts.set(
      'CONTACT000000000002',
      err(new RateLimitedError(8_000, { context: { provider: 'ghl' } })),
    );
    const result = await scheduled(h);
    expect(result).toMatchObject({
      status: 200,
      body: { action: 'scheduled-sync', status: 'partial', contactsUnread: 1 },
    });
    expect(scheduledLines(h)[0]).toMatchObject({ level: 'warn', outcome: 'partial' });
  });

  it('down for an hour, then back: a failed run per tick, then a success with nothing carried over', async () => {
    const store = fakeSyncStore();
    const h = makeHarness({ store });
    const healthy = h.client.pipelines;
    h.client.pipelines = err(transport());
    for (let tick = 0; tick < 6; tick += 1) {
      expect(await scheduled(h)).toMatchObject({
        status: 502,
        body: { error: { code: 'NETWORK', retryable: true } },
      });
    }
    expect(store.snapshots).toEqual([]);

    h.client.pipelines = healthy;
    const back = await scheduled(h);
    expect(back).toMatchObject({ status: 200, body: { status: 'success' } });
    // Seven attempts, each its own run; the one that worked is a whole sync, not a catch-up.
    expect(store.begins).toHaveLength(7);
    expect(store.finishes.map((f) => f.status)).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'success',
    ]);
    expect(store.snapshots).toHaveLength(1);
    expect(must(store.snapshots[0]).snapshot.opportunities).toHaveLength(4);
  });

  it('a run that could not even be recorded is a 502 with no run id', async () => {
    const store = fakeSyncStore();
    store.beginResult = err(new AppError('NETWORK', 'store unreachable', { retryable: true }));
    const h = makeHarness({ store });
    const result = await scheduled(h);
    expect(result.status).toBe(502);
    expect(result.body).not.toHaveProperty('runId');
    expect(scheduledLines(h)[0]).toMatchObject({ level: 'error', outcome: 'failed', runId: null });
  });

  it('a sync that throws is a 500, never an unhandled rejection', async () => {
    const h = makeHarness({ runSync: () => Promise.reject(new Error('the process is dying')) });
    expect(await scheduled(h)).toMatchObject({
      status: 500,
      body: { error: { code: 'INTERNAL' } },
    });
  });

  it('a success that somehow has no run id is a 500, not a 200 that names nothing', async () => {
    const report: SyncReport = {
      status: 'success',
      runId: null,
      pipelineId: FINANCE_PIPELINE_ID,
      durationMs: 1,
      staleMarked: 0,
      fetch: {
        requests: 0,
        pages_fetched: 0,
        opportunities_fetched: 0,
        opportunities_rejected: 0,
        contacts_fetched: 0,
        contacts_failed: 0,
        contacts_rejected: 0,
        contacts_missing: 0,
        custom_fields_fetched: 0,
      },
      apply: null,
      errors: [],
      error: null,
    };
    const h = makeHarness({ runSync: () => Promise.resolve(report) });
    expect((await scheduled(h)).status).toBe(500);
  });
});

describe('runs that are not failures', () => {
  it('an empty pipeline is a success with zero leads', async () => {
    const h = makeHarness();
    h.client.opportunities = ok(fixtureOpportunities('opportunities-empty'));
    const result = await scheduled(h);
    expect(result).toMatchObject({
      status: 200,
      body: {
        action: 'scheduled-sync',
        status: 'success',
        opportunitiesFetched: 0,
        contactsFetched: 0,
        contactsUnread: 0,
      },
    });
    expect(scheduledLines(h)[0]).toMatchObject({ level: 'info', outcome: 'success' });
  });

  it('the first run there has ever been needs nothing before it', async () => {
    const h = makeHarness({ lastRunEndedMsAgo: null });
    expect((await scheduled(h)).status).toBe(200);
  });

  it('a run that retired an interrupted one says so in its line', async () => {
    const store = fakeSyncStore();
    store.beginResult = ok({ runId: RUN_ID, staleMarked: 1 });
    const h = makeHarness({ store });
    expect((await scheduled(h)).status).toBe(200);
    expect(scheduledLines(h)[0]).toMatchObject({ outcome: 'success', staleMarked: 1 });
  });
});

describe('what a scheduled run records about itself', () => {
  it('one line: when it started, what it fetched, what it changed, how long it took, how it ended', async () => {
    const store = fakeSyncStore();
    store.applyResult = ok({
      ...ZERO_APPLY,
      stages_seen: 10,
      opportunities_inserted: 1,
      opportunities_updated: 2,
      opportunities_unchanged: 1,
      contacts_updated: 1,
      contacts_unchanged: 1,
    });
    const h = makeHarness({ store });
    const result = await scheduled(h);

    expect(result).toEqual({
      status: 200,
      body: {
        action: 'scheduled-sync',
        status: 'success',
        runId: RUN_ID,
        durationMs: expect.any(Number) as number,
        opportunitiesFetched: 4,
        contactsFetched: 2,
        contactsUnread: 0,
        changed: 4,
      },
    });
    const lines = scheduledLines(h);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      trigger: 'schedule',
      outcome: 'success',
      runId: RUN_ID,
      startedAt: '2026-10-14T00:03:00.250Z',
      durationMs: expect.any(Number) as number,
      staleMarked: 0,
      fetched: {
        requests: 5,
        pages_fetched: 1,
        opportunities_fetched: 4,
        contacts_fetched: 2,
        contacts_failed: 0,
        custom_fields_fetched: expect.any(Number) as number,
      },
      changed: {
        opportunities: { inserted: 1, updated: 2, removed: 0 },
        contacts: { inserted: 0, updated: 1, removed: 0 },
        stages: { added: 0, updated: 0, removed: 0 },
        customFieldsRemoved: 0,
        total: 4,
      },
      errorCode: null,
      errorCount: 0,
    });
  });

  it('nothing in any line or reply is a name, an email, a phone number — or the secret', async () => {
    const contact = fixtureContact('contact-1');
    const personal = [contact.firstName, contact.lastName, contact.email, contact.phone]
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .map((value) => value.toLowerCase());
    expect(personal.length).toBeGreaterThanOrEqual(3);

    const h = makeHarness();
    const replies = [
      await scheduled(h),
      await scheduled(h, WRONG),
      await scheduled(h, null),
      await pressed(h, SECRET),
    ];
    h.client.pipelines = err(unauthenticated());
    replies.push(await scheduled(h));

    const text = (JSON.stringify(replies) + h.lines.join('\n')).toLowerCase();
    for (const value of personal) expect(text).not.toContain(value);
    expect(text).not.toContain(SECRET.toLowerCase());
    expect(text).not.toContain(WRONG.toLowerCase());
    // And the lines are there to be checked: this is not an empty log passing by default.
    expect(h.lines.length).toBeGreaterThan(8);
  });
});
