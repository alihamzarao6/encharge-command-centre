/**
 * GoHighLevel layer security (Milestone 4 part 1).
 *
 * Static — runs everywhere, no stack:
 *   - the GHL token has exactly one reader and the GHL origin exactly one namer (the
 *     rule tests/security/secrets.test.ts enforces for Anthropic and voyage-key.test.ts
 *     for Voyage);
 *   - the client module issues GETs and nothing else — no write verb anywhere in it;
 *   - part 4: exactly ONE module writes to GoHighLevel (write.ts), every stage write it sends
 *     carries the configured pipeline id, and no other module under src/ builds a PUT / POST
 *     / PATCH / DELETE to the GoHighLevel origin;
 *   - no real `pit-` token shape in any source, script or fixture;
 *   - nothing under web/src mentions the GHL client or its token.
 *
 * Stack-backed — the RLS half, through the surfaces an attacker holds:
 *   - the six new tables are there with RLS forced (rls.test.ts iterates every table for
 *     the flags and grants; this asserts the names so a dropped table cannot pass);
 *   - an allowlisted session reads the mirror, an outsider reads nothing;
 *   - a session cannot insert, update or delete a mirrored row or a run;
 *   - the three sync functions are executable by service_role only, from the catalog and
 *     behaviourally through PostgREST;
 *   - part 4: the two write tables (ghl_writes, ghl_notes) have the same posture, the three
 *     write functions are service_role only, and a session cannot insert a write record or
 *     a note through PostgREST.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const full = join(root, entry);
    if (statSync(full).isFile()) out.push(full);
  }
  return out;
}

describe('the GoHighLevel token has exactly one reader', () => {
  const srcFiles = listFiles(join(REPO_ROOT, 'src')).map((f) => f.split(sep).join('/'));
  const webFiles = listFiles(join(REPO_ROOT, 'web', 'src')).map((f) => f.split(sep).join('/'));

  it('GHL_PRIVATE_INTEGRATION_TOKEN is referenced only by src/lib/crm/ghl/config.ts', () => {
    const readers = srcFiles.filter((f) =>
      readFileSync(f, 'utf8').includes('GHL_PRIVATE_INTEGRATION_TOKEN'),
    );
    expect(readers.map((f) => f.slice(f.indexOf('src/')))).toEqual(['src/lib/crm/ghl/config.ts']);
  });

  it('services.leadconnectorhq.com is named only by src/lib/crm/ghl/config.ts', () => {
    const callers = srcFiles.filter((f) =>
      readFileSync(f, 'utf8').includes('services.leadconnectorhq.com'),
    );
    expect(callers.map((f) => f.slice(f.indexOf('src/')))).toEqual(['src/lib/crm/ghl/config.ts']);
  });

  it('the client module issues GETs and nothing else', () => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'lib', 'crm', 'ghl', 'client.ts'), 'utf8');
    expect(source).toContain("method: 'GET'");
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(source, `write verb ${verb} in client.ts`).not.toMatch(new RegExp(`['"]${verb}['"]`));
    }
    expect(source).not.toMatch(/body:\s*JSON\.stringify/);
  });

  it('part 4: write.ts is the one module that sends a write verb to GoHighLevel, always with the pipeline id', () => {
    const writeVerb = /['"](PUT|POST|PATCH|DELETE)['"]/;
    const ghlPath = /\/opportunities\/|\/contacts\//;
    const writers = srcFiles.filter((f) => {
      if (f.endsWith('/src/lib/crm/ghl/write.ts')) return false;
      const source = readFileSync(f, 'utf8');
      // A module that names a GoHighLevel resource path AND sends a write verb.
      return ghlPath.test(source) && writeVerb.test(source);
    });
    expect(writers.map((f) => f.slice(f.indexOf('src/')))).toEqual([]);
    const write = readFileSync(join(REPO_ROOT, 'src', 'lib', 'crm', 'ghl', 'write.ts'), 'utf8');
    // The stage write names the configured pipeline, never a pipeline from the request.
    expect(write).toMatch(/pipelineId:\s*config\.pipelineId/);
    expect(write).not.toMatch(/pipelineId:\s*(request|body|input)\./);
    // No DELETE anywhere: nothing in this system removes a record from the client's CRM.
    expect(write).not.toMatch(/['"]DELETE['"]/);
  });

  it('nothing under web/src mentions the GHL client, its token or its origin', () => {
    const offenders = webFiles.filter((f) =>
      /crm\/ghl|GHL_PRIVATE_INTEGRATION_TOKEN|leadconnectorhq/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no real Private Integration token shape appears in any source, script or fixture', () => {
    const files = [
      ...srcFiles,
      ...listFiles(join(REPO_ROOT, 'scripts')),
      ...listFiles(join(REPO_ROOT, 'tests')),
      ...listFiles(join(REPO_ROOT, 'supabase', 'migrations')),
    ];
    // The unit-test fake is all zeros and excluded by construction; anything else that
    // matches the pit-<uuid> shape is a real token.
    const real =
      /\bpit-(?!00000000-0000-4000-8000-000000000000)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
    const hits = files.filter((f) => real.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// Stack-backed
// ---------------------------------------------------------------------------------------

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);
const PIPELINE = `SECTEST-${RUN}`;
const GHL_TABLES = [
  'ghl_contacts',
  'ghl_custom_fields',
  'ghl_notes',
  'ghl_opportunities',
  'ghl_pipelines',
  'ghl_stages',
  'ghl_sync_runs',
  'ghl_writes',
];

const cfg = env ?? {
  url: 'http://stack-not-running.invalid',
  anonKey: 'unset',
  serviceRoleKey: 'unset',
  dbUrl: 'postgresql://stack-not-running.invalid/postgres',
};

interface TestUser {
  readonly id: string;
  readonly client: SupabaseClient;
}

describe.skipIf(env === null)('GHL mirror RLS (requires a running Supabase stack)', () => {
  const db = new pg.Client({ connectionString: cfg.dbUrl });
  const admin = createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let staff: TestUser;
  let outsider: TestUser;
  const created: string[] = [];

  async function createUser(label: string, allowlisted: boolean): Promise<TestUser> {
    const email = `ghl-${label}-${RUN}@example.com`;
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
    await db.query(
      `insert into public.ghl_pipelines (ghl_id, name, location_id) values ($1, 'SECTEST pipeline', 'loc')`,
      [PIPELINE],
    );
    await db.query(
      `insert into public.ghl_stages (ghl_id, pipeline_ghl_id, name, position) values ($1, $2, 'Stage', 0)`,
      [`${PIPELINE}-stage`, PIPELINE],
    );
    await db.query(
      `insert into public.ghl_opportunities (ghl_id, pipeline_ghl_id, stage_ghl_id, name, status, content_hash)
       values ($1, $2, $3, 'SECTEST opp', 'open', 'hash')`,
      [`${PIPELINE}-opp`, PIPELINE, `${PIPELINE}-stage`],
    );
  }, 60_000);

  afterAll(async () => {
    await db.query(`delete from public.ghl_notes where opportunity_ghl_id like $1`, [
      `${PIPELINE}%`,
    ]);
    await db.query(`delete from public.ghl_writes where pipeline_ghl_id = $1`, [PIPELINE]);
    await db.query(`delete from public.ghl_opportunities where pipeline_ghl_id = $1`, [PIPELINE]);
    await db.query(`delete from public.ghl_stages where pipeline_ghl_id = $1`, [PIPELINE]);
    await db.query(`delete from public.ghl_sync_runs where pipeline_ghl_id = $1`, [PIPELINE]);
    await db.query(`delete from public.ghl_pipelines where ghl_id = $1`, [PIPELINE]);
    for (const id of created) {
      await db.query(`delete from public.app_users where user_id = $1`, [id]);
      await admin.auth.admin.deleteUser(id);
    }
    await db.end();
  }, 60_000);

  it('the eight tables exist with RLS enabled AND forced', async () => {
    const res = await db.query<{ relname: string; rls: boolean; force: boolean }>(
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any($1) order by c.relname`,
      [GHL_TABLES],
    );
    expect(res.rows.map((r) => r.relname)).toEqual(GHL_TABLES);
    expect(res.rows.every((r) => r.rls && r.force)).toBe(true);
  });

  it('an allowlisted session reads the mirror; an outsider and anon read nothing', async () => {
    const asStaff = await staff.client
      .from('ghl_opportunities')
      .select('ghl_id')
      .eq('pipeline_ghl_id', PIPELINE);
    expect(asStaff.error).toBeNull();
    expect(asStaff.data).toEqual([{ ghl_id: `${PIPELINE}-opp` }]);
    for (const table of GHL_TABLES) {
      const asOutsider = await outsider.client
        .from(table)
        .select('*', { count: 'exact', head: true });
      expect(asOutsider.count ?? 0, `outsider read ${table}`).toBe(0);
      const asAnon = await anon.from(table).select('*', { count: 'exact', head: true });
      expect(asAnon.count ?? 0, `anon read ${table}`).toBe(0);
    }
  });

  it('a session cannot write the mirror or start a run through PostgREST, and nothing moves', async () => {
    const insert = await staff.client.from('ghl_opportunities').insert({
      ghl_id: `${PIPELINE}-sneak`,
      pipeline_ghl_id: PIPELINE,
      stage_ghl_id: `${PIPELINE}-stage`,
      name: 'sneak',
      status: 'open',
      content_hash: 'x',
    });
    expect(insert.error).not.toBeNull();
    const update = await staff.client
      .from('ghl_opportunities')
      .update({ stage_ghl_id: 'moved-from-a-browser' })
      .eq('ghl_id', `${PIPELINE}-opp`);
    expect(update.error).not.toBeNull();
    const remove = await staff.client
      .from('ghl_opportunities')
      .delete()
      .eq('ghl_id', `${PIPELINE}-opp`);
    expect(remove.error).not.toBeNull();
    const run = await staff.client
      .from('ghl_sync_runs')
      .insert({ pipeline_ghl_id: PIPELINE, trigger: 'test' });
    expect(run.error).not.toBeNull();

    const after = await db.query<{ stage_ghl_id: string; n: string }>(
      `select stage_ghl_id, (select count(*) from public.ghl_opportunities where pipeline_ghl_id = $1) as n
       from public.ghl_opportunities where ghl_id = $2`,
      [PIPELINE, `${PIPELINE}-opp`],
    );
    expect(after.rows[0]).toEqual({ stage_ghl_id: `${PIPELINE}-stage`, n: '1' });
    const runs = await db.query<{ n: string }>(
      `select count(*) as n from public.ghl_sync_runs where pipeline_ghl_id = $1`,
      [PIPELINE],
    );
    expect(runs.rows[0]?.n).toBe('0');
  });

  it('the three sync functions and the three write functions are executable by service_role only — catalog and behaviour', async () => {
    const privileges = await db.query<{ fn: string; role: string; can: boolean }>(
      `select fn, role, has_function_privilege(role, fn, 'execute') as can
       from (values
         ('public.begin_ghl_sync_run(text,text,uuid,integer)'),
         ('public.apply_ghl_snapshot(uuid,jsonb)'),
         ('public.finish_ghl_sync_run(uuid,text,text,text,jsonb,jsonb)'),
         ('public.begin_ghl_write(uuid,uuid,text,text,text,text,text,text)'),
         ('public.finish_ghl_write(uuid,text,integer,text,integer,text,jsonb,jsonb)'),
         ('public.mark_ghl_opportunity_removed(text)')
       ) f(fn)
       cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)`,
    );
    expect(privileges.rows).toHaveLength(18);
    for (const row of privileges.rows) {
      expect(row.can, `${row.role} on ${row.fn}`).toBe(row.role === 'service_role');
    }
    const begin = await staff.client.rpc('begin_ghl_sync_run', {
      p_pipeline_ghl_id: PIPELINE,
      p_trigger: 'test',
      p_triggered_by: null,
      p_stale_after_seconds: 900,
    });
    expect(begin.error).not.toBeNull();
    const landed = await db.query<{ n: string }>(
      `select count(*) as n from public.ghl_sync_runs where pipeline_ghl_id = $1`,
      [PIPELINE],
    );
    expect(landed.rows[0]?.n).toBe('0');
    // Part 4: a session cannot claim a write record, mark a row removed, or insert a note.
    const claim = await staff.client.rpc('begin_ghl_write', {
      p_request_id: crypto.randomUUID(),
      p_actor: staff.id,
      p_kind: 'stage_move',
      p_pipeline_ghl_id: PIPELINE,
      p_opportunity_ghl_id: `${PIPELINE}-opp`,
      p_contact_ghl_id: null,
      p_screen_stage_ghl_id: null,
      p_to_stage_ghl_id: `${PIPELINE}-stage`,
    });
    expect(claim.error).not.toBeNull();
    const mark = await staff.client.rpc('mark_ghl_opportunity_removed', {
      p_ghl_id: `${PIPELINE}-opp`,
    });
    expect(mark.error).not.toBeNull();
    const writeRow = await staff.client.from('ghl_writes').insert({
      request_id: crypto.randomUUID(),
      actor: staff.id,
      kind: 'note',
      pipeline_ghl_id: PIPELINE,
      opportunity_ghl_id: `${PIPELINE}-opp`,
    });
    expect(writeRow.error).not.toBeNull();
    const noteRow = await staff.client.from('ghl_notes').insert({
      ghl_id: `${PIPELINE}-note`,
      contact_ghl_id: 'c',
      opportunity_ghl_id: `${PIPELINE}-opp`,
      body: 'sneak',
    });
    expect(noteRow.error).not.toBeNull();
    const nothing = await db.query<{ w: string; n: string; r: string }>(
      `select (select count(*) from public.ghl_writes where pipeline_ghl_id = $1) as w,
              (select count(*) from public.ghl_notes where opportunity_ghl_id = $2) as n,
              (select count(*) from public.ghl_opportunities where ghl_id = $2 and removed_at is not null) as r`,
      [PIPELINE, `${PIPELINE}-opp`],
    );
    expect(nothing.rows[0]).toEqual({ w: '0', n: '0', r: '0' });
  });

  it('no policy on a GHL table grants anything but SELECT, and only to authenticated', async () => {
    const policies = await db.query<{ tablename: string; cmd: string; roles: string[] }>(
      // roles is name[], which node-pg hands back as text ('{authenticated}'); text[] it parses.
      `select tablename, cmd, roles::text[] as roles from pg_policies where schemaname = 'public' and tablename = any($1)`,
      [GHL_TABLES],
    );
    expect(policies.rows).toHaveLength(GHL_TABLES.length);
    for (const row of policies.rows) {
      expect(row.cmd).toBe('SELECT');
      expect(row.roles).toEqual(['authenticated']);
    }
  });
});
