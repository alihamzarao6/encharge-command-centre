/**
 * The schedule in front of the GoHighLevel sync, against the real SQL (brief of 14 Oct 2026,
 * "Keeping the data fresh"; migration 20261014010000).
 *
 * What the database does is proven here; what the `crm` function does with a scheduled
 * request is tests/unit/crm/ghl/page-schedule.test.ts. Together they are the brief's Part C.
 *
 *   1. the job is there, every ten minutes, and its stored command is the bare call;
 *   2. with nothing in Vault the dispatcher asks for nothing, and says so once;
 *   3. configured, it queues exactly one request — the address, the action, the secret in
 *      its own header, the function's own time limit — and the secret is in no table of ours;
 *   4. the next tick settles the one before: a request that became a scheduled run is left
 *      alone; "already running" is not a failure; anything else becomes a FAILED row in the
 *      run log with a code naming the cause, which is what the app and the connector read;
 *   5. the interval the decision rests on: a run left `running` is refused at 600 seconds and
 *      retired at 1,200 — by explicit timestamps, never by winning a race;
 *   6. the dispatcher's own history is kept to thirty days.
 *
 * Every test runs inside one transaction that is rolled back, so nothing is ever sent
 * (pg_net sends on commit), no secret is left in Vault, and nothing needs cleaning up. Each
 * takes a lock on the dispatch table first: the real job ticks in this database too, and a
 * tick landing between two statements must not be able to change what a test counts.
 *
 * No assertion counts a whole table: rows are found by this file's pipeline id, by the id a
 * statement returned, or by being newer than a mark taken inside the transaction.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SCHEDULED_SYNC_ACTION,
  SCHEDULE_SECRET_HEADER,
  SCHEDULE_SECRET_MIN_LENGTH,
} from '../../src/lib/crm/schedule.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);
const PIPELINE = `SCHEDTEST-${RUN}`;
// Fake by construction: a repeated letter, the length of 32 random bytes in base64url.
const SECRET = 'S'.repeat(43);
const ENDPOINT = 'https://schedule-test.invalid/functions/v1/crm';
/** A moment no real run can fall near: the settle tests are about this window and no other. */
const T = '2001-02-03T04:05:06.000Z';

interface DispatchRow {
  id: string;
  outcome: string;
  request_id: string | null;
  pipeline_ghl_id: string | null;
  http_status: number | null;
  error_code: string | null;
  run_id: string | null;
  settled: boolean;
}

interface RunRow {
  id: string;
  trigger: string;
  triggered_by: string | null;
  status: string;
  started_at: string;
  finished: boolean;
  applied: boolean;
  error_code: string | null;
  error: string | null;
  errors: unknown;
}

describe.skipIf(env === null)('the GoHighLevel sync schedule (requires a database)', () => {
  const db = new pg.Client({ connectionString: env?.dbUrl ?? 'postgresql://unset.invalid/x' });

  beforeAll(async () => {
    await db.connect();
  }, 60_000);

  afterAll(async () => {
    await db.end();
  }, 60_000);

  async function inTransaction(run: () => Promise<void>): Promise<void> {
    await db.query('begin');
    try {
      await db.query('lock table public.ghl_sync_dispatches in exclusive mode');
      await run();
    } finally {
      await db.query('rollback');
    }
  }

  async function mark(): Promise<string> {
    const res = await db.query<{ id: string }>(
      `select coalesce(max(id), 0)::text as id from public.ghl_sync_dispatches`,
    );
    return res.rows[0]?.id ?? '0';
  }

  async function dispatchesSince(since: string): Promise<DispatchRow[]> {
    const res = await db.query<DispatchRow>(
      `select id::text, outcome, request_id::text, pipeline_ghl_id, http_status, error_code,
              run_id::text, settled_at is not null as settled
       from public.ghl_sync_dispatches where id > $1::bigint order by id`,
      [since],
    );
    return res.rows;
  }

  async function dispatch(): Promise<string> {
    const res = await db.query<{ outcome: string }>(`select public.dispatch_ghl_sync() as outcome`);
    return res.rows[0]?.outcome ?? '';
  }

  async function configure(url = ENDPOINT, secret = SECRET): Promise<void> {
    await db.query(`select vault.create_secret($1, 'ghl_sync_schedule_url')`, [url]);
    await db.query(`select vault.create_secret($1, 'ghl_sync_schedule_secret')`, [secret]);
  }

  /** A request that was made at `at`, waiting to be settled. */
  async function pending(at: string, pipeline: string | null = PIPELINE): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into public.ghl_sync_dispatches (requested_at, outcome, request_id, pipeline_ghl_id)
       values ($1, 'requested', 1, $2) returning id::text`,
      [at, pipeline],
    );
    return res.rows[0]?.id ?? '';
  }

  async function run(row: {
    trigger: string;
    status: string;
    startedAt: string;
    errorCode?: string | null;
    pipeline?: string;
  }): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into public.ghl_sync_runs (pipeline_ghl_id, trigger, status, started_at, finished_at, error_code)
       values ($1, $2, $3, $4::timestamptz,
               case when $3 = 'running' then null else $4::timestamptz + interval '5 seconds' end, $5)
       returning id::text`,
      [row.pipeline ?? PIPELINE, row.trigger, row.status, row.startedAt, row.errorCode ?? null],
    );
    return res.rows[0]?.id ?? '';
  }

  async function settle(id: string, status: number | null): Promise<string | null> {
    const res = await db.query<{ outcome: string | null }>(
      `select public.settle_ghl_sync_dispatch($1::bigint, $2::integer) as outcome`,
      [id, status],
    );
    return res.rows[0]?.outcome ?? null;
  }

  async function dispatchRow(id: string): Promise<DispatchRow | undefined> {
    const res = await db.query<DispatchRow>(
      `select id::text, outcome, request_id::text, pipeline_ghl_id, http_status, error_code,
              run_id::text, settled_at is not null as settled
       from public.ghl_sync_dispatches where id = $1::bigint`,
      [id],
    );
    return res.rows[0];
  }

  async function runsOf(pipeline = PIPELINE): Promise<RunRow[]> {
    const res = await db.query<RunRow>(
      `select id::text, trigger, triggered_by::text, status,
              to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started_at,
              finished_at is not null as finished, applied_at is not null as applied,
              error_code, error, errors
       from public.ghl_sync_runs where pipeline_ghl_id = $1 order by started_at, id`,
      [pipeline],
    );
    return res.rows;
  }

  const plus = (seconds: number): string => new Date(Date.parse(T) + seconds * 1_000).toISOString();

  // -------------------------------------------------------------------------------------
  // 1. The job
  // -------------------------------------------------------------------------------------

  describe('the job', () => {
    it('is scheduled every ten minutes, active, and its stored command is the bare call', async () => {
      const job = await db.query<{ schedule: string; command: string; active: boolean }>(
        `select schedule, command, active from cron.job where jobname = 'ghl-sync'`,
      );
      expect(job.rows).toEqual([
        { schedule: '3-59/10 * * * *', command: 'select public.dispatch_ghl_sync()', active: true },
      ]);
    });

    it('has what it needs: an HTTP client in the database, and the index the new lookups use', async () => {
      const res = await db.query<{ http_post: boolean; index: string | null }>(
        `select to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null as http_post,
                (select indexdef from pg_indexes
                 where schemaname = 'public' and indexname = 'ghl_sync_runs_applied_idx') as index`,
      );
      expect(res.rows[0]?.http_post).toBe(true);
      expect(res.rows[0]?.index).toContain('(applied_at DESC) WHERE (applied_at IS NOT NULL)');
    });

    it('the purge job it sits beside is untouched', async () => {
      const job = await db.query<{ schedule: string; active: boolean }>(
        `select schedule, active from cron.job where jobname = 'purge-conversation-files'`,
      );
      // On a stack the purge job exists and must be as it was; a database without it has
      // nothing this migration could have changed.
      for (const row of job.rows) expect(row).toEqual({ schedule: '17 3 * * *', active: true });
    });
  });

  // -------------------------------------------------------------------------------------
  // 2. Not configured
  // -------------------------------------------------------------------------------------

  describe('with nothing in Vault', () => {
    it('asks for nothing, and records that once however often it ticks', async () => {
      await inTransaction(async () => {
        // Something else is the newest row, so "once" is counted from a known start.
        await db.query(
          `insert into public.ghl_sync_dispatches (outcome, settled_at) values ('started', now())`,
        );
        const since = await mark();
        const queue = await db.query<{ id: string }>(
          `select coalesce(max(id), 0)::text as id from net.http_request_queue`,
        );

        expect(await dispatch()).toBe('not_configured');
        expect(await dispatch()).toBe('not_configured');
        expect(await dispatch()).toBe('not_configured');

        const rows = await dispatchesSince(since);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          outcome: 'not_configured',
          request_id: null,
          run_id: null,
          settled: true,
        });
        const queued = await db.query<{ n: string }>(
          `select count(*)::text as n from net.http_request_queue where id > $1::bigint`,
          [queue.rows[0]?.id ?? '0'],
        );
        expect(queued.rows[0]?.n).toBe('0');
      });
    });

    it('half a configuration is no configuration: an address without a secret, a secret without an address', async () => {
      await inTransaction(async () => {
        await db.query(`select vault.create_secret($1, 'ghl_sync_schedule_url')`, [ENDPOINT]);
        expect(await dispatch()).toBe('not_configured');
      });
      await inTransaction(async () => {
        await db.query(`select vault.create_secret($1, 'ghl_sync_schedule_secret')`, [SECRET]);
        expect(await dispatch()).toBe('not_configured');
      });
    });

    it('an address that is not https is refused — the secret must not travel in the clear', async () => {
      await inTransaction(async () => {
        const since = await mark();
        await configure('http://schedule-test.invalid/functions/v1/crm');
        expect(await dispatch()).toBe('not_configured');
        expect((await dispatchesSince(since)).every((row) => row.request_id === null)).toBe(true);
      });
    });

    it('a secret too short to have been generated is refused, at the length the function also uses', async () => {
      await inTransaction(async () => {
        await configure(ENDPOINT, 'x'.repeat(SCHEDULE_SECRET_MIN_LENGTH - 1));
        expect(await dispatch()).toBe('not_configured');
      });
      await inTransaction(async () => {
        await configure(ENDPOINT, 'x'.repeat(SCHEDULE_SECRET_MIN_LENGTH));
        expect(await dispatch()).toBe('requested');
      });
    });
  });

  // -------------------------------------------------------------------------------------
  // 3. Configured
  // -------------------------------------------------------------------------------------

  describe('configured', () => {
    it('queues one request: the address, the action, the secret in its own header, 150 seconds', async () => {
      await inTransaction(async () => {
        await configure();
        const since = await mark();
        expect(await dispatch()).toBe('requested');

        const rows = await dispatchesSince(since);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ outcome: 'requested', http_status: null, settled: false });
        expect(rows[0]?.request_id).not.toBeNull();

        const queued = await db.query<{
          method: string;
          url: string;
          headers: Record<string, string>;
          body: unknown;
          timeout_milliseconds: number;
        }>(
          `select method::text, url, headers, convert_from(body, 'UTF8')::jsonb as body,
                  timeout_milliseconds
           from net.http_request_queue where id = $1::bigint`,
          [rows[0]?.request_id],
        );
        expect(queued.rows).toEqual([
          {
            method: 'POST',
            url: ENDPOINT,
            headers: { 'Content-Type': 'application/json', [SCHEDULE_SECRET_HEADER]: SECRET },
            body: { action: SCHEDULED_SYNC_ACTION },
            timeout_milliseconds: 150_000,
          },
        ]);
      });
    });

    it('the secret is in no table of ours and in nothing the scheduler stores', async () => {
      await inTransaction(async () => {
        await configure();
        await db.query(
          `insert into public.ghl_sync_runs (pipeline_ghl_id, trigger, status, started_at, finished_at)
           values ($1, 'api', 'success', now() + interval '1 day', now() + interval '1 day')`,
          [PIPELINE],
        );
        expect(await dispatch()).toBe('requested');
        const found = await db.query<{ dispatches: string; runs: string; jobs: string }>(
          `select
             (select count(*) from public.ghl_sync_dispatches d where d::text like $1)::text as dispatches,
             (select count(*) from public.ghl_sync_runs r where r::text like $1)::text as runs,
             (select count(*) from cron.job j where j::text like $1)::text as jobs`,
          [`%${SECRET}%`],
        );
        expect(found.rows[0]).toEqual({ dispatches: '0', runs: '0', jobs: '0' });
      });
    });

    it('a failure is recorded against the pipeline the newest run was for', async () => {
      await inTransaction(async () => {
        await configure();
        // Dated a day ahead: newer than any row another test could have committed.
        await db.query(
          `insert into public.ghl_sync_runs (pipeline_ghl_id, trigger, status, started_at, finished_at)
           values ($1, 'api', 'success', now() + interval '1 day', now() + interval '1 day')`,
          [PIPELINE],
        );
        const since = await mark();
        expect(await dispatch()).toBe('requested');
        expect((await dispatchesSince(since))[0]?.pipeline_ghl_id).toBe(PIPELINE);
      });
    });
  });

  // -------------------------------------------------------------------------------------
  // 4. One tick settles the one before
  // -------------------------------------------------------------------------------------

  describe('the next tick settles the one before', () => {
    it('a request that is seconds old is left alone: the function has three minutes to answer', async () => {
      await inTransaction(async () => {
        await configure();
        const since = await mark();
        expect(await dispatch()).toBe('requested');
        expect(await dispatch()).toBe('requested');
        expect((await dispatchesSince(since)).map((row) => row.outcome)).toEqual([
          'requested',
          'requested',
        ]);
      });
    });

    it('ten minutes on with no answer and no run: a failed row in the run log, and a fresh request', async () => {
      await inTransaction(async () => {
        await configure();
        await db.query(
          `insert into public.ghl_sync_runs (pipeline_ghl_id, trigger, status, started_at, finished_at)
           values ($1, 'api', 'success', now() + interval '1 day', now() + interval '1 day')`,
          [PIPELINE],
        );
        const since = await mark();
        expect(await dispatch()).toBe('requested');
        // Time passing, stated: the request is now ten minutes old. Nothing was ever sent —
        // the transaction has not committed — so pg_net holds no answer for it.
        await db.query(
          `update public.ghl_sync_dispatches set requested_at = now() - interval '10 minutes'
           where id > $1::bigint`,
          [since],
        );
        expect(await dispatch()).toBe('requested');

        const rows = await dispatchesSince(since);
        expect(rows.map((row) => row.outcome)).toEqual(['failed', 'requested']);
        expect(rows[0]).toMatchObject({
          error_code: 'SCHEDULE_UNREACHABLE',
          http_status: null,
          settled: true,
        });
        const failed = (await runsOf()).filter((row) => row.id === rows[0]?.run_id);
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({
          trigger: 'schedule',
          status: 'failed',
          error_code: 'SCHEDULE_UNREACHABLE',
          finished: true,
          applied: false,
        });
      });
    });
  });

  describe('what came of a request', () => {
    it('a scheduled run started within the window: the request worked, and nothing is added', async () => {
      await inTransaction(async () => {
        const id = await pending(T);
        const started = await run({ trigger: 'schedule', status: 'success', startedAt: plus(2) });
        expect(await settle(id, 200)).toBe('started');
        expect(await dispatchRow(id)).toMatchObject({
          outcome: 'started',
          http_status: 200,
          run_id: started,
          error_code: null,
          settled: true,
        });
        expect(await runsOf()).toHaveLength(1);
      });
    });

    it('the run itself failed (a rejected key, a rate limit): its own row says so, and no second row is written', async () => {
      await inTransaction(async () => {
        const id = await pending(T);
        const own = await run({
          trigger: 'schedule',
          status: 'failed',
          startedAt: plus(1),
          errorCode: 'UNAUTHENTICATED',
        });
        expect(await settle(id, 502)).toBe('started');
        expect((await dispatchRow(id))?.run_id).toBe(own);
        expect((await runsOf()).map((row) => row.error_code)).toEqual(['UNAUTHENTICATED']);
      });
    });

    it('the answer was lost but the run started: the run log is the truth, not the HTTP exchange', async () => {
      await inTransaction(async () => {
        const id = await pending(T);
        await run({ trigger: 'schedule', status: 'running', startedAt: plus(3) });
        expect(await settle(id, null)).toBe('started');
        expect(await runsOf()).toHaveLength(1);
      });
    });

    it('"already running" is not a failure: a person\'s refresh held the slot', async () => {
      await inTransaction(async () => {
        const id = await pending(T);
        expect(await settle(id, 409)).toBe('already_running');
        expect(await dispatchRow(id)).toMatchObject({
          outcome: 'already_running',
          http_status: 409,
          run_id: null,
          error_code: null,
          settled: true,
        });
        expect(await runsOf()).toEqual([]);
      });
    });

    it.each([
      [401, 'SCHEDULE_REJECTED', 'do not match'],
      [403, 'SCHEDULE_REJECTED', 'do not match'],
      [400, 'SCHEDULE_CONTRACT', 'deployed without the scheduled-sync action'],
      [404, 'SCHEDULE_FUNCTION_MISSING', 'not deployed'],
      [500, 'SCHEDULE_FUNCTION_ERROR', 'HTTP 500'],
      [502, 'SCHEDULE_FUNCTION_ERROR', 'HTTP 502'],
      [503, 'SCHEDULE_FUNCTION_ERROR', 'HTTP 503'],
      [200, 'SCHEDULE_NO_RUN', 'no run started'],
      [null, 'SCHEDULE_UNREACHABLE', 'nothing answered'],
    ])(
      'no run, and the function answered %s: a failed row with %s',
      async (status, code, words) => {
        await inTransaction(async () => {
          const id = await pending(T);
          expect(await settle(id, status)).toBe('failed');

          const dispatched = await dispatchRow(id);
          expect(dispatched).toMatchObject({
            outcome: 'failed',
            http_status: status,
            error_code: code,
            settled: true,
          });
          const runs = await runsOf();
          expect(runs).toHaveLength(1);
          expect(runs[0]).toMatchObject({
            id: dispatched?.run_id,
            trigger: 'schedule',
            triggered_by: null,
            status: 'failed',
            finished: true,
            applied: false,
            error_code: code,
            errors: [{ kind: 'schedule', id, code }],
          });
          expect(runs[0]?.error).toContain(words);
          expect(Date.parse(runs[0]?.started_at ?? '')).toBe(Date.parse(T));
        });
      },
    );

    it('the failed row is what the app and the connector read, and it never holds the slot', async () => {
      await inTransaction(async () => {
        // A good run two days before, then a request that came to nothing.
        await db.query(
          `insert into public.ghl_sync_runs (pipeline_ghl_id, trigger, status, started_at, finished_at, applied_at)
           values ($1, 'api', 'success', $2::timestamptz - interval '2 days',
                   $2::timestamptz - interval '2 days', $2::timestamptz - interval '2 days')`,
          [PIPELINE, T],
        );
        const id = await pending(T);
        await settle(id, 401);

        // The connector's own two lookups (connector_read), for this pipeline.
        const seen = await db.query<{
          last_status: string;
          applied_before: boolean;
          running: string;
        }>(
          `select
             (select r.status from public.ghl_sync_runs r
              where r.pipeline_ghl_id = $1 and r.status <> 'running'
              order by r.started_at desc limit 1) as last_status,
             (select r.applied_at < $2::timestamptz from public.ghl_sync_runs r
              where r.pipeline_ghl_id = $1 and r.applied_at is not null
              order by r.applied_at desc limit 1) as applied_before,
             (select count(*) from public.ghl_sync_runs r
              where r.pipeline_ghl_id = $1 and r.status = 'running')::text as running`,
          [PIPELINE, T],
        );
        expect(seen.rows[0]).toEqual({ last_status: 'failed', applied_before: true, running: '0' });

        // And a sync can start straight away: the failed row took nothing.
        const begun = await db.query<{ id: string; stale_marked: number }>(
          `select id::text, stale_marked from public.begin_ghl_sync_run($1, 'schedule', null, 900)`,
          [PIPELINE],
        );
        expect(begun.rows[0]?.stale_marked).toBe(0);
      });
    });

    it('a refresh somebody pressed is not the schedule having worked', async () => {
      await inTransaction(async () => {
        const id = await pending(T);
        await run({ trigger: 'api', status: 'success', startedAt: plus(2) });
        expect(await settle(id, 401)).toBe('failed');
        expect((await dispatchRow(id))?.error_code).toBe('SCHEDULE_REJECTED');
      });
    });

    it('a scheduled run six minutes later belongs to another request', async () => {
      await inTransaction(async () => {
        const id = await pending(T);
        await run({ trigger: 'schedule', status: 'success', startedAt: plus(360) });
        expect(await settle(id, null)).toBe('failed');
      });
    });

    it('a failed row this function wrote can never read as another request having worked', async () => {
      await inTransaction(async () => {
        const first = await pending(T);
        const second = await pending(plus(60));
        expect(await settle(second, 401)).toBe('failed');
        // The row just written is a schedule row inside the first request's window.
        expect(await settle(first, 401)).toBe('failed');
        expect((await runsOf()).map((row) => row.error_code)).toEqual([
          'SCHEDULE_REJECTED',
          'SCHEDULE_REJECTED',
        ]);
      });
    });

    it('a project that has never synced has no screen to tell: the dispatch says failed, no run row is invented', async () => {
      await inTransaction(async () => {
        const id = await pending(T, null);
        expect(await settle(id, 404)).toBe('failed');
        expect(await dispatchRow(id)).toMatchObject({
          outcome: 'failed',
          error_code: 'SCHEDULE_FUNCTION_MISSING',
          run_id: null,
        });
      });
    });

    it('settling twice changes nothing, and an unknown id is nothing', async () => {
      await inTransaction(async () => {
        const id = await pending(T);
        expect(await settle(id, 401)).toBe('failed');
        expect(await settle(id, 200)).toBeNull();
        expect(await settle(id, 409)).toBeNull();
        expect((await dispatchRow(id))?.error_code).toBe('SCHEDULE_REJECTED');
        expect(await runsOf()).toHaveLength(1);
        expect(await settle('9223372036854775807', 401)).toBeNull();
      });
    });
  });

  // -------------------------------------------------------------------------------------
  // 5. The lock, at the interval the decision rests on
  // -------------------------------------------------------------------------------------

  describe('a run left running, and a tick every 600 seconds', () => {
    async function begin(trigger: string): Promise<{ id: string; stale_marked: number }> {
      const res = await db.query<{ id: string; stale_marked: number }>(
        `select id::text, stale_marked from public.begin_ghl_sync_run($1, $2, null, 900)`,
        [PIPELINE, trigger],
      );
      const row = res.rows[0];
      if (row === undefined) throw new Error('begin_ghl_sync_run returned no row');
      return row;
    }

    async function refused(trigger: string): Promise<string | undefined> {
      await db.query('savepoint attempt');
      try {
        await begin(trigger);
        return undefined;
      } catch (caught: unknown) {
        await db.query('rollback to savepoint attempt');
        return (caught as { code?: string }).code;
      }
    }

    it('the next tick (600 s) is refused; the one after (1,200 s) retires it and runs', async () => {
      await inTransaction(async () => {
        const stuck = await run({
          trigger: 'schedule',
          status: 'running',
          startedAt: new Date(Date.now() - 600_000).toISOString(),
        });

        expect(await refused('schedule')).toBe('55006');
        expect((await runsOf()).map((row) => [row.id, row.status])).toEqual([[stuck, 'running']]);

        await db.query(
          `update public.ghl_sync_runs set started_at = now() - interval '1200 seconds' where id = $1::uuid`,
          [stuck],
        );
        const next = await begin('schedule');
        expect(next.stale_marked).toBe(1);

        const runs = await runsOf();
        expect(
          runs.map((row) => [row.status, row.error_code, row.trigger, row.triggered_by]),
        ).toEqual([
          ['failed', 'STALE', 'schedule', null],
          ['running', null, 'schedule', null],
        ]);
      });
    });

    it('a press while a scheduled run holds the slot is refused, and the other way round', async () => {
      await inTransaction(async () => {
        await begin('schedule');
        expect(await refused('api')).toBe('55006');
      });
      await inTransaction(async () => {
        await begin('api');
        expect(await refused('schedule')).toBe('55006');
      });
    });

    it('the first scheduled run there has ever been starts with nothing before it', async () => {
      await inTransaction(async () => {
        expect(await runsOf()).toEqual([]);
        expect((await begin('schedule')).stale_marked).toBe(0);
      });
    });
  });

  // -------------------------------------------------------------------------------------
  // 6. Its own history
  // -------------------------------------------------------------------------------------

  describe('the record of what each tick did', () => {
    it('is kept for thirty days', async () => {
      await inTransaction(async () => {
        const rows = await db.query<{ id: string }>(
          `insert into public.ghl_sync_dispatches (requested_at, outcome, settled_at)
           values (now() - interval '31 days', 'started', now() - interval '31 days'),
                  (now() - interval '29 days', 'started', now() - interval '29 days')
           returning id::text`,
        );
        const [old, recent] = rows.rows.map((row) => row.id);
        await dispatch();
        expect(await dispatchRow(old ?? '')).toBeUndefined();
        expect(await dispatchRow(recent ?? '')).toMatchObject({ outcome: 'started' });
      });
    });
  });
});
