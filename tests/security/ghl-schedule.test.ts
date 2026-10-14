/**
 * The sync schedule's security (brief of 14 Oct 2026, "Keeping the data fresh", decision A1):
 * the scheduler's secret is never readable from a browser, never sent, never stored where a
 * job's text is stored, and the schedule can be started by nobody but the scheduler.
 *
 * Static — runs everywhere, no stack:
 *   - CRM_SCHEDULE_SECRET has exactly one reader, and the header that carries the token
 *     exactly one namer (the rule ghl.test.ts enforces for the GoHighLevel token);
 *   - nothing under web/src knows the schedule exists, and the function's CORS allow-list
 *     does not admit the header;
 *   - the migration and the TypeScript agree on the header, the action and the minimum
 *     length, since each is written out on both sides; the migration signs a token with the
 *     secret and never puts the secret itself in a request;
 *   - the SQL the migration runs holds no credential of any shape, sends the HTTP request
 *     from one place, stores the bare call as the job's command, and never writes a
 *     `running` row (it must not be able to take the sync's slot).
 *
 * Stack-backed:
 *   - catalog (pg only): the two functions are executable by no API role — not even the
 *     service role; no browser role holds anything on Vault.
 *     NOT asserted, and why (14 Oct 2026): the first version of this file also required that
 *     no browser role could read pg_net's request queue. CI's real Supabase stack showed they
 *     can — a platform grant on the extension's tables, which this project's migrations
 *     cannot revoke. The answer was not to loosen the check but to take the secret out of the
 *     queue: the request now carries a token that expires in two minutes, and
 *     tests/integration/ghl-schedule.test.ts proves the queued request holds no secret;
 *   - through the API, as an attacker holds it: a session and the service key cannot start a
 *     tick or settle one; the dispatch table is read-only to staff and empty to an outsider;
 *     and neither `net` nor `vault` is a schema the API will answer for.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative as relativePath, resolve, sep } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SCHEDULED_SYNC_ACTION,
  SCHEDULE_SECRET_ENV,
  SCHEDULE_SECRET_MIN_LENGTH,
  SCHEDULE_TOKEN_HEADER,
} from '../../src/lib/crm/schedule.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'supabase', 'migrations');
const MIGRATION = '20261014010000_ghl_sync_schedule.sql';

function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const full = join(root, entry);
    if (statSync(full).isFile()) out.push(full);
  }
  return out;
}

const relative = (file: string): string => relativePath(REPO_ROOT, file).split(sep).join('/');

/** The migration as the database runs it: no `--` comments. */
function sqlOf(name: string): string {
  return readFileSync(join(MIGRATIONS, name), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('the schedule secret has exactly one reader', () => {
  const srcFiles = listFiles(join(REPO_ROOT, 'src'));
  const webFiles = listFiles(join(REPO_ROOT, 'web', 'src'));
  const naming = (files: string[], needle: string): string[] =>
    files.filter((f) => readFileSync(f, 'utf8').includes(needle)).map(relative);

  it('CRM_SCHEDULE_SECRET is referenced only by src/lib/crm/schedule.ts', () => {
    expect(SCHEDULE_SECRET_ENV).toBe('CRM_SCHEDULE_SECRET');
    expect(naming(srcFiles, 'CRM_SCHEDULE_SECRET')).toEqual(['src/lib/crm/schedule.ts']);
  });

  it('the header is spelt out in one module; everything else imports the constant', () => {
    expect(naming(srcFiles, SCHEDULE_TOKEN_HEADER)).toEqual(['src/lib/crm/schedule.ts']);
  });

  it('nothing under web/src knows the schedule exists', () => {
    const pattern = /CRM_SCHEDULE_SECRET|x-crm-schedule-|scheduled-sync|ghl_sync_schedule_/;
    expect(webFiles.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map(relative)).toEqual([]);
  });

  it('the crm function does not let a page send the header', () => {
    const adapter = readFileSync(join(REPO_ROOT, 'src', 'functions', 'crm', 'index.ts'), 'utf8');
    const allowed = /'access-control-allow-headers':\s*'([^']*)'/.exec(adapter)?.[1] ?? '';
    expect(allowed).not.toBe('');
    expect(allowed.toLowerCase()).not.toContain('schedule');
    expect(allowed.toLowerCase()).not.toContain('x-crm');
  });
});

describe('the migration', () => {
  const sql = sqlOf(MIGRATION);

  it('agrees with the function on the header, the action and the shortest secret it will sign with', () => {
    expect(sql).toContain(`'${SCHEDULE_TOKEN_HEADER}', v_token`);
    expect(sql).toContain(`jsonb_build_object('action', '${SCHEDULED_SYNC_ACTION}')`);
    expect(sql).toContain(`char_length(coalesce(v_secret, '')) < ${SCHEDULE_SECRET_MIN_LENGTH}`);
    // The message signed is the one the function checks: "<action>:<second>".
    expect(sql).toContain(`convert_to('${SCHEDULED_SYNC_ACTION}:' || v_at::text, 'UTF8')`);
  });

  it('signs a token with the secret and never puts the secret itself in a request', () => {
    expect(sql).toContain(
      "extensions.hmac(convert_to('scheduled-sync:' || v_at::text, 'UTF8'), convert_to(v_secret, 'UTF8'), 'sha256')",
    );
    // The request is built in one call; the secret is not among its arguments.
    const post = /net\.http_post\(([\s\S]*?)\n {2}\);/.exec(sql)?.[1] ?? '';
    expect(post).toContain('v_token');
    expect(post).not.toContain('v_secret');
    expect(sql).not.toMatch(/'x-crm-schedule-[a-z]+',\s*v_secret/);
  });

  it('stores the bare call as the job command — the one place a platform guide would put a key', () => {
    const call = /select cron\.schedule\(\s*'ghl-sync',\s*'([^']+)',\s*\$\$([^$]+)\$\$\s*\);/.exec(
      sql,
    );
    expect(call?.[1]).toBe('3-59/10 * * * *');
    expect(call?.[2]).toBe('select public.dispatch_ghl_sync()');
    expect(sql.match(/cron\.schedule\(/g)).toHaveLength(1);
  });

  it('holds no credential of any shape, and no word a credential would sit beside', () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/);
    expect(sql).not.toMatch(/\bBearer\b/i);
    expect(sql).not.toMatch(/authorization/i);
    expect(sql).not.toMatch(/apikey/i);
    expect(sql).not.toMatch(/service_role_key|sb_secret_|pit-[0-9a-f]{8}/i);
    // The address is in Vault, so the file names no project.
    expect(sql).not.toMatch(/supabase\.co/);
    // Every quoted string of 32 characters or more is a sentence, never a secret.
    for (const literal of sql.match(/'[^'\n]{32,}'/g) ?? []) {
      expect(literal, literal).toMatch(/\s/);
    }
  });

  it('reads the secret from Vault at call time and from nowhere else', () => {
    expect(sql.match(/vault\.decrypted_secrets/g)).toHaveLength(2);
    expect(sql).toContain("s.name = 'ghl_sync_schedule_secret'");
    expect(sql).toContain("s.name = 'ghl_sync_schedule_url'");
    expect(sql).not.toMatch(/vault\.create_secret|vault\.update_secret/);
  });

  it('is the only migration that sends an HTTP request, and sends it from one place', () => {
    const senders = readdirSync(MIGRATIONS).filter((name) =>
      /net\.http_(post|get|delete)\(/.test(sqlOf(name)),
    );
    expect(senders).toEqual([MIGRATION]);
    expect(sql.match(/net\.http_post\(/g)).toHaveLength(1);
    expect(sql).toMatch(/\^https:\/\//);
  });

  it('never writes a running row: it cannot take the slot the lock is for', () => {
    expect(sql).not.toContain("'running'");
    expect(sql).not.toMatch(/pg_advisory/);
    expect(sql).not.toMatch(/begin_ghl_sync_run|apply_ghl_snapshot|finish_ghl_sync_run/);
  });

  it('revokes both functions from every API role, the service role included', () => {
    for (const fn of ['settle_ghl_sync_dispatch(bigint, integer)', 'dispatch_ghl_sync()']) {
      const escaped = fn.replace(/[()]/g, '\\$&');
      expect(sql).toMatch(
        new RegExp(
          `revoke all on function public\\.${escaped}\\s+from public, anon, authenticated, service_role;`,
        ),
      );
    }
    expect(sql).not.toMatch(/grant execute/i);
    expect(sql).not.toMatch(/security definer/i);
  });
});

// ---------------------------------------------------------------------------------------
// Stack-backed
// ---------------------------------------------------------------------------------------

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);
const PIPELINE = `SCHEDSEC-${RUN}`;
const FUNCTIONS = ['public.dispatch_ghl_sync()', 'public.settle_ghl_sync_dispatch(bigint,integer)'];
const cfg = env ?? {
  url: 'http://stack-not-running.invalid',
  anonKey: 'unset',
  serviceRoleKey: 'unset',
  dbUrl: 'postgresql://stack-not-running.invalid/postgres',
};

describe.skipIf(env === null)('the schedule in the catalog (requires a database)', () => {
  const db = new pg.Client({ connectionString: cfg.dbUrl });

  beforeAll(async () => {
    await db.connect();
  }, 60_000);

  afterAll(async () => {
    await db.end();
  }, 60_000);

  it('neither function is executable by anon, authenticated or the service role', async () => {
    const res = await db.query<{ fn: string; role: string; can: boolean }>(
      `select fn, role, has_function_privilege(role, fn, 'execute') as can
       from unnest($1::text[]) fn cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)`,
      [FUNCTIONS],
    );
    expect(res.rows).toHaveLength(6);
    for (const row of res.rows) expect(row.can, `${row.role} on ${row.fn}`).toBe(false);
  });

  it('both run as their caller: nothing here lends the rights of its owner to anyone', async () => {
    const res = await db.query<{ proname: string; prosecdef: boolean }>(
      `select proname, prosecdef from pg_proc
       where pronamespace = 'public'::regnamespace
         and proname in ('dispatch_ghl_sync', 'settle_ghl_sync_dispatch') order by proname`,
    );
    expect(res.rows).toEqual([
      { proname: 'dispatch_ghl_sync', prosecdef: false },
      { proname: 'settle_ghl_sync_dispatch', prosecdef: false },
    ]);
  });

  it('no browser role can read Vault, or use its schema at all', async () => {
    const res = await db.query<{ role: string; secrets: boolean; schema: boolean }>(
      `select role,
              has_table_privilege(role, 'vault.decrypted_secrets', 'select') as secrets,
              has_schema_privilege(role, 'vault', 'usage') as schema
       from (values ('anon'), ('authenticated')) r(role)`,
    );
    expect(res.rows).toEqual([
      { role: 'anon', secrets: false, schema: false },
      { role: 'authenticated', secrets: false, schema: false },
    ]);
    // pg_net's queue is deliberately absent from this list: see the header of this file.
  });

  it('the dispatch table: RLS enabled and forced, one policy, SELECT for staff only', async () => {
    const flags = await db.query<{ rls: boolean; force: boolean }>(
      `select c.relrowsecurity as rls, c.relforcerowsecurity as force
       from pg_class c where c.oid = 'public.ghl_sync_dispatches'::regclass`,
    );
    expect(flags.rows).toEqual([{ rls: true, force: true }]);
    const policies = await db.query<{ cmd: string; roles: string[]; qual: string }>(
      `select cmd, roles::text[] as roles, qual from pg_policies
       where schemaname = 'public' and tablename = 'ghl_sync_dispatches'`,
    );
    expect(policies.rows).toHaveLength(1);
    expect(policies.rows[0]).toMatchObject({ cmd: 'SELECT', roles: ['authenticated'] });
    expect(policies.rows[0]?.qual).toContain('is_active_staff()');
  });
});

interface TestUser {
  readonly id: string;
  readonly client: SupabaseClient;
}

describe.skipIf(env === null)(
  'the schedule through the API (requires a running Supabase stack)',
  () => {
    const db = new pg.Client({ connectionString: cfg.dbUrl });
    const admin = createClient(cfg.url, cfg.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anon = createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    let staff: TestUser;
    let outsider: TestUser;
    let dispatchId = '';
    const created: string[] = [];

    async function createUser(label: string, allowlisted: boolean): Promise<TestUser> {
      const email = `sched-${label}-${RUN}@example.com`;
      const password = crypto.randomUUID();
      const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (result.error !== null) throw new Error(result.error.message);
      const id = result.data.user.id;
      created.push(id);
      if (allowlisted) {
        await db.query(
          `insert into public.app_users (user_id, email, role, is_active) values ($1, $2, 'staff', true)`,
          [id, email],
        );
      }
      const signIn = await anon.auth.signInWithPassword({ email, password });
      if (signIn.error !== null) throw new Error(signIn.error.message);
      const client = createClient(cfg.url, cfg.anonKey, {
        global: { headers: { Authorization: `Bearer ${signIn.data.session.access_token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      return { id, client };
    }

    beforeAll(async () => {
      await db.connect();
      staff = await createUser('staff', true);
      outsider = await createUser('outsider', false);
      // A settled row from long ago: nothing the real job would touch or settle.
      const row = await db.query<{ id: string }>(
        `insert into public.ghl_sync_dispatches (requested_at, outcome, pipeline_ghl_id, settled_at)
         values (now() - interval '1 day', 'already_running', $1, now() - interval '1 day')
         returning id::text`,
        [PIPELINE],
      );
      dispatchId = row.rows[0]?.id ?? '';
    }, 60_000);

    afterAll(async () => {
      await db.query(`delete from public.ghl_sync_dispatches where pipeline_ghl_id = $1`, [
        PIPELINE,
      ]);
      await db.query(`delete from public.ghl_sync_runs where pipeline_ghl_id = $1`, [PIPELINE]);
      for (const id of created) {
        await db.query(`delete from public.app_users where user_id = $1`, [id]);
        await admin.auth.admin.deleteUser(id);
      }
      await db.end();
    }, 60_000);

    it('a member reads what the schedule did; an outsider and anon read nothing', async () => {
      const asStaff = await staff.client
        .from('ghl_sync_dispatches')
        .select('id, outcome')
        .eq('pipeline_ghl_id', PIPELINE);
      expect(asStaff.error).toBeNull();
      expect(asStaff.data).toEqual([{ id: Number(dispatchId), outcome: 'already_running' }]);
      for (const client of [outsider.client, anon]) {
        const rows = await client
          .from('ghl_sync_dispatches')
          .select('id')
          .eq('pipeline_ghl_id', PIPELINE);
        expect(rows.data ?? []).toEqual([]);
      }
    });

    it('a member cannot write it, and the row is as it was', async () => {
      const insert = await staff.client
        .from('ghl_sync_dispatches')
        .insert({ outcome: 'requested', pipeline_ghl_id: PIPELINE });
      expect(insert.error).not.toBeNull();
      const update = await staff.client
        .from('ghl_sync_dispatches')
        .update({ outcome: 'started' })
        .eq('id', dispatchId);
      expect(update.error).not.toBeNull();
      const remove = await staff.client.from('ghl_sync_dispatches').delete().eq('id', dispatchId);
      expect(remove.error).not.toBeNull();

      const after = await db.query<{ id: string; outcome: string }>(
        `select id::text, outcome from public.ghl_sync_dispatches where pipeline_ghl_id = $1`,
        [PIPELINE],
      );
      expect(after.rows).toEqual([{ id: dispatchId, outcome: 'already_running' }]);
    });

    it('nobody can start a tick or settle one through the API — a session, anon, or the service key', async () => {
      for (const [who, client] of [
        ['a member', staff.client],
        ['anon', anon],
        ['the service key', admin],
      ] as const) {
        const tick = await client.rpc('dispatch_ghl_sync');
        expect(tick.error, `${who} started a tick`).not.toBeNull();
        const settled = await client.rpc('settle_ghl_sync_dispatch', {
          p_dispatch_id: Number(dispatchId),
          p_http_status: 401,
        });
        expect(settled.error, `${who} settled a dispatch`).not.toBeNull();
      }
      // Nothing was settled into a failure and no failed run was written for it.
      const after = await db.query<{ outcome: string; runs: string }>(
        `select d.outcome,
                (select count(*) from public.ghl_sync_runs r where r.pipeline_ghl_id = $1)::text as runs
         from public.ghl_sync_dispatches d where d.id = $2::bigint`,
        [PIPELINE, dispatchId],
      );
      expect(after.rows).toEqual([{ outcome: 'already_running', runs: '0' }]);
    });

    it('the API answers for neither `net` nor `vault`: the queue, the responses and the secrets are not there to ask for', async () => {
      const targets: readonly (readonly [string, string])[] = [
        ['net', 'http_request_queue'],
        ['net', '_http_response'],
        ['vault', 'decrypted_secrets'],
        ['vault', 'secrets'],
      ];
      for (const client of [anon, staff.client, outsider.client]) {
        for (const [schema, table] of targets) {
          const answer = await client.schema(schema).from(table).select('*').limit(1);
          expect(answer.error, `${schema}.${table}`).not.toBeNull();
          expect(answer.data, `${schema}.${table}`).toBeNull();
        }
      }
    });
  },
);
