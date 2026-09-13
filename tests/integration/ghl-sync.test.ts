/**
 * The GoHighLevel sync against a real Supabase stack (Milestone 4 part 1) — the production
 * code path (the real client through src/lib/http.ts, the real supabase store, the real
 * database functions) with ONE substitution: fetch to GoHighLevel is a scripted fixture
 * built from the live account's shapes, so CI touches no live CRM and needs no token.
 *
 * What is proven here, row by row:
 *   1. a first sync lands the pipeline, ten stages, four opportunities (zero / null /
 *      fractional value kept apart; one with no contact; one won), two contacts (one with
 *      no phone, one with a 5,000-character unicode value), thirteen definitions, and a
 *      success run row with every count;
 *   2. IDEMPOTENCY: the same sync again reports everything `unchanged` and every row in
 *      the five mirror tables is byte-identical to the first run — timestamps included;
 *   3. the shape changing underneath: a renamed pipeline, a renamed + reordered + removed
 *      + added stage, a deleted opportunity, a moved one, a renamed contact (GHL merged a
 *      new submission into the same email) and a renamed + removed definition — each
 *      marked or updated BY ID, the untouched rows still byte-identical;
 *   4. what comes back after being removed has its mark cleared;
 *   5. overlapping runs are refused with a definite error, and a stale run is retired —
 *      both without any race;
 *   6. a partial run keeps the previous row of the contact that failed;
 *   7. a dead token mid-run applies nothing.
 *
 * Every row is scoped to this file's pipeline id and removed afterwards.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGhlClient } from '../../src/lib/crm/ghl/client.js';
import type { GhlConfig } from '../../src/lib/crm/ghl/config.js';
import { createGhlServiceClient, supabaseGhlSyncStore } from '../../src/lib/crm/ghl/store.js';
import { runGhlSync, type SyncReport } from '../../src/lib/crm/ghl/sync.js';
import { createHttpClient, type FetchLike } from '../../src/lib/http.js';
import { createLogger } from '../../src/lib/logger.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();
const FINANCE = 'M4unnMKBy0TgwCwOA6wS';
const CONTACT_IDS = ['CONTACT000000000001', 'CONTACT000000000002', 'CONTACT000000000003'];
const FIELD_IDS_IN_FIXTURES = [
  'UWmWQyJn1lEhC8XRjqQD',
  'ZtrfHuvMZQZAPEEd7o1U',
  '8OCSa3zz8OI6by5AIM2t',
  'tQA4cVpB63irs4gBdKBO',
  'Vpn7DLqHwMoQ91AJUjzu',
  'M6vWreBBuMuRVdEefafI',
  '9Qm4YOeMoHMDNyl2keDL',
  'axTFAYBC1ZCQ4KKuAMXZ',
  'J8AzUUemQHCzZZB0uUDc',
  'TANd0sfC9wRwuJKhSGFx',
  'hX8JQblBT9iJhYEa348M',
  'Ht7MfhngWRq1uloc65B3',
  'Ht7MfhngWRq1uloc65B3',
  '3ma6Czg50bY5yhJ18zrD',
  '7pR62a3yZcOtnmF2sJrQ',
];

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'ghl', `${name}.json`), 'utf8');

const config: GhlConfig = {
  token: 'pit-00000000-0000-4000-8000-000000000000',
  baseUrl: 'https://ghl.test',
  apiVersion: '2021-07-28',
  locationId: 'tgw5Q3BnoZoSsVOnRUxB',
  pipelineId: FINANCE,
  customFieldFolderIds: ['BEFyPDjs8dlcpRuz3ZcL', 'fA9zYqgDoZUUN5CKnb5G'],
  timeoutMs: 5_000,
  retries: 0,
  pageSize: 100,
  maxPages: 50,
  maxContactsPerRun: 2_000,
  staleRunAfterSeconds: 900,
  rateLimitFloor: 5,
};

/**
 * Which fixture answers which route. Mutated between runs to change "GHL's" state. A contact
 * entry of FAIL is a transport failure, UNAUTHORIZED a 401; anything else is a fixture name.
 */
const FAIL = 'fail';
const UNAUTHORIZED = 'unauthorized';
const world = {
  pipelines: 'pipelines',
  opportunities: 'opportunities-all',
  contacts: new Map<string, string>([
    ['CONTACT000000000001', 'contact-1'],
    ['CONTACT000000000002', 'contact-2'],
  ]),
  customFields: 'custom-fields-clean',
};

const fixtureFetch: FetchLike = (url) => {
  const { pathname } = new URL(url);
  const respond = (name: string, status = 200): Promise<Response> =>
    Promise.resolve(
      new Response(fixture(name), { status, headers: { 'content-type': 'application/json' } }),
    );
  if (pathname === '/opportunities/pipelines') return respond(world.pipelines);
  if (pathname === '/opportunities/search') return respond(world.opportunities);
  if (pathname.endsWith('/customFields')) return respond(world.customFields);
  if (pathname.startsWith('/contacts/')) {
    const id = pathname.slice('/contacts/'.length);
    const answer = world.contacts.get(id);
    if (answer === undefined) return respond('contact-not-found', 404);
    if (answer === FAIL) return Promise.reject(new TypeError('ghl unreachable'));
    if (answer === UNAUTHORIZED) return respond('error-401', 401);
    return respond(answer);
  }
  return Promise.reject(new Error(`unexpected route ${pathname}`));
};

describe.skipIf(env === null)('GoHighLevel sync against a real stack', () => {
  const db = new pg.Client({
    connectionString: env?.dbUrl ?? 'postgresql://stack-not-running.invalid/postgres',
  });
  const logLines: string[] = [];
  const log = createLogger({
    level: 'debug',
    sink: (line) => {
      logLines.push(line);
    },
  });
  const store = supabaseGhlSyncStore(
    createGhlServiceClient({
      url: env?.url ?? 'http://stack-not-running.invalid',
      anonKey: env?.anonKey ?? 'unset',
      serviceRoleKey: env?.serviceRoleKey ?? 'unset',
    }),
  );

  function sync(): Promise<SyncReport> {
    const http = createHttpClient({ fetch: fixtureFetch, retries: 0, logger: log });
    const client = createGhlClient({ config, http, log });
    return runGhlSync({ client, store, config, log }, { trigger: 'test' });
  }

  /** Every column of every mirror row for this pipeline, as JSON, ordered — the diff unit. */
  async function mirror(): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    const pipelines = await db.query(
      `select to_jsonb(p) as row from public.ghl_pipelines p where ghl_id = $1`,
      [FINANCE],
    );
    out['ghl_pipelines'] = pipelines.rows.map((r: { row: unknown }) => r.row);
    const stages = await db.query(
      `select to_jsonb(s) as row from public.ghl_stages s where pipeline_ghl_id = $1 order by ghl_id`,
      [FINANCE],
    );
    out['ghl_stages'] = stages.rows.map((r: { row: unknown }) => r.row);
    const opps = await db.query(
      `select to_jsonb(o) as row from public.ghl_opportunities o where pipeline_ghl_id = $1 order by ghl_id`,
      [FINANCE],
    );
    out['ghl_opportunities'] = opps.rows.map((r: { row: unknown }) => r.row);
    const contacts = await db.query(
      `select to_jsonb(c) as row from public.ghl_contacts c where ghl_id = any($1) order by ghl_id`,
      [CONTACT_IDS],
    );
    out['ghl_contacts'] = contacts.rows.map((r: { row: unknown }) => r.row);
    const fields = await db.query(
      `select to_jsonb(f) as row from public.ghl_custom_fields f where ghl_id = any($1) order by ghl_id`,
      [FIELD_IDS_IN_FIXTURES],
    );
    out['ghl_custom_fields'] = fields.rows.map((r: { row: unknown }) => r.row);
    return out;
  }

  async function cleanup(): Promise<void> {
    await db.query(`delete from public.ghl_sync_runs where pipeline_ghl_id = $1`, [FINANCE]);
    await db.query(`delete from public.ghl_opportunities where pipeline_ghl_id = $1`, [FINANCE]);
    await db.query(`delete from public.ghl_stages where pipeline_ghl_id = $1`, [FINANCE]);
    await db.query(`delete from public.ghl_contacts where ghl_id = any($1)`, [CONTACT_IDS]);
    await db.query(`delete from public.ghl_custom_fields where ghl_id = any($1)`, [
      FIELD_IDS_IN_FIXTURES,
    ]);
    await db.query(`delete from public.ghl_pipelines where ghl_id = $1`, [FINANCE]);
  }

  beforeAll(async () => {
    await db.connect();
    await cleanup();
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await db.end();
  }, 30_000);

  let afterFirst: Record<string, unknown[]> = {};
  let afterSecond: Record<string, unknown[]> = {};

  it('1. the first sync lands every row with the values GHL sent', async () => {
    const report = await sync();
    expect(report.status).toBe('success');
    expect(report.errors).toEqual([]);
    expect(report.apply).toEqual({
      stages_seen: 10,
      stages_added: 10,
      stages_updated: 0,
      stages_removed: 0,
      opportunities_inserted: 4,
      opportunities_updated: 0,
      opportunities_unchanged: 0,
      opportunities_removed: 0,
      contacts_inserted: 2,
      contacts_updated: 0,
      contacts_unchanged: 0,
      contacts_removed: 0,
      custom_fields_seen: 13,
      custom_fields_removed: 0,
    });
    expect(report.fetch).toEqual({
      requests: 5,
      pages_fetched: 1,
      opportunities_fetched: 4,
      opportunities_rejected: 0,
      contacts_fetched: 2,
      contacts_failed: 0,
      contacts_rejected: 0,
      contacts_missing: 0,
      custom_fields_fetched: 14,
    });

    const opps = await db.query<{
      ghl_id: string;
      stage_ghl_id: string;
      contact_ghl_id: string | null;
      status: string;
      monetary_value: string | null;
      ghl_created_at: Date;
      removed_at: Date | null;
    }>(
      `select ghl_id, stage_ghl_id, contact_ghl_id, status, monetary_value, ghl_created_at, removed_at
       from public.ghl_opportunities where pipeline_ghl_id = $1 order by ghl_id`,
      [FINANCE],
    );
    expect(
      opps.rows.map((r) => [r.ghl_id, r.contact_ghl_id, r.status, r.monetary_value, r.removed_at]),
    ).toEqual([
      ['OPP0000000000000001', 'CONTACT000000000001', 'open', '0.00', null],
      ['OPP0000000000000002', 'CONTACT000000000002', 'open', null, null],
      ['OPP0000000000000003', null, 'open', '450000.50', null],
      ['OPP0000000000000004', 'CONTACT000000000001', 'won', '0.00', null],
    ]);
    // UTC in, UTC out.
    expect(opps.rows[0]?.ghl_created_at.toISOString()).toBe('2026-09-01T02:15:00.000Z');

    const contacts = await db.query<{
      ghl_id: string;
      full_name: string | null;
      email: string | null;
      phone: string | null;
      dnd: boolean | null;
      custom_fields: Record<string, unknown>;
    }>(
      `select ghl_id, full_name, email, phone, dnd, custom_fields from public.ghl_contacts where ghl_id = any($1) order by ghl_id`,
      [CONTACT_IDS],
    );
    expect(contacts.rows).toHaveLength(2);
    expect(contacts.rows[0]).toMatchObject({
      ghl_id: 'CONTACT000000000001',
      full_name: 'Alex Tran',
      phone: '+61400000001',
      dnd: false,
    });
    expect(contacts.rows[0]?.custom_fields['UWmWQyJn1lEhC8XRjqQD']).toBe(650000);
    expect(contacts.rows[0]?.custom_fields['9Qm4YOeMoHMDNyl2keDL']).toBe('');
    expect(contacts.rows[0]?.custom_fields['tQA4cVpB63irs4gBdKBO']).toBeNull();
    expect(contacts.rows[1]).toMatchObject({
      ghl_id: 'CONTACT000000000002',
      full_name: 'Sam Ó Brádaigh 🏠',
      phone: null,
      dnd: null,
    });
    expect(
      (contacts.rows[1]?.custom_fields['3ma6Czg50bY5yhJ18zrD'] as string).length,
    ).toBeGreaterThan(5000);

    const stages = await db.query<{ ghl_id: string; name: string; position: number }>(
      `select ghl_id, name, position from public.ghl_stages where pipeline_ghl_id = $1 and removed_at is null order by position`,
      [FINANCE],
    );
    expect(stages.rows.map((s) => s.name)).toEqual([
      'New Lead',
      'Appointment Booked',
      'Contacted',
      'Qualified',
      'Docs Requested',
      'Docs Received',
      'Submitted to Lender',
      'Approved',
      'Settled',
      'Lost / Not Proceeding',
    ]);

    const run = await db.query<{
      status: string;
      opportunities_inserted: number;
      contacts_fetched: number;
      requests: number;
      duration_ms: number;
      finished_at: Date | null;
      applied_at: Date | null;
    }>(
      `select status, opportunities_inserted, contacts_fetched, requests, duration_ms, finished_at, applied_at
       from public.ghl_sync_runs where id = $1`,
      [report.runId],
    );
    expect(run.rows[0]).toMatchObject({
      status: 'success',
      opportunities_inserted: 4,
      contacts_fetched: 2,
      requests: 5,
    });
    expect(run.rows[0]?.finished_at).not.toBeNull();
    expect(run.rows[0]?.applied_at).not.toBeNull();

    afterFirst = await mirror();
    expect(afterFirst['ghl_opportunities']).toHaveLength(4);
    expect(afterFirst['ghl_custom_fields']).toHaveLength(13);
    for (const line of logLines) {
      expect(line).not.toContain('alex.synthetic@example.com');
      expect(line).not.toContain('+61400000001');
    }
  });

  it('2. the same sync again changes nothing: every row byte-identical, everything reported unchanged', async () => {
    const report = await sync();
    expect(report.status).toBe('success');
    expect(report.apply).toEqual({
      stages_seen: 10,
      stages_added: 0,
      stages_updated: 0,
      stages_removed: 0,
      opportunities_inserted: 0,
      opportunities_updated: 0,
      opportunities_unchanged: 4,
      opportunities_removed: 0,
      contacts_inserted: 0,
      contacts_updated: 0,
      contacts_unchanged: 2,
      contacts_removed: 0,
      custom_fields_seen: 13,
      custom_fields_removed: 0,
    });
    afterSecond = await mirror();
    expect(afterSecond).toStrictEqual(afterFirst);
    const runs = await db.query<{ n: string }>(
      `select count(*) as n from public.ghl_sync_runs where pipeline_ghl_id = $1 and status = 'success'`,
      [FINANCE],
    );
    expect(runs.rows[0]?.n).toBe('2');
  });

  it('3. the shape changes underneath: everything is matched by id and the untouched rows stay identical', async () => {
    world.pipelines = 'pipelines-changed';
    world.opportunities = 'opportunities-all-changed';
    world.contacts.set('CONTACT000000000001', 'contact-1-renamed');
    world.customFields = 'custom-fields-changed';
    const report = await sync();
    expect(report.status).toBe('success');
    expect(report.apply).toMatchObject({
      stages_added: 1,
      stages_removed: 1,
      opportunities_updated: 1,
      opportunities_unchanged: 2,
      opportunities_removed: 1,
      contacts_updated: 1,
      contacts_removed: 1,
      // Two, not one: J8Az… left the definitions read, and 3ma6… was stored only because
      // contact 2 carried it — contact 2's opportunity is gone in this fixture, so the
      // definition leaves scope with it (sync.ts keeps folder fields + fields in play).
      custom_fields_removed: 2,
    });
    expect(report.apply?.stages_updated).toBeGreaterThanOrEqual(1);

    const stages = await db.query<{ ghl_id: string; name: string; removed_at: Date | null }>(
      `select ghl_id, name, removed_at from public.ghl_stages where pipeline_ghl_id = $1 order by position, ghl_id`,
      [FINANCE],
    );
    const byId = new Map(stages.rows.map((s) => [s.ghl_id, s]));
    expect(byId.get('51c98561-cd26-49a9-a001-97536c31dd0a')?.name).toBe('Lead In ');
    expect(byId.get('9cef8b67-1171-4347-9275-36e1055a97aa')?.removed_at).not.toBeNull();
    expect(byId.get('aaaaaaaa-0000-4000-8000-0000000new01')?.removed_at).toBeNull();
    expect(stages.rows).toHaveLength(11);

    const pipeline = await db.query<{ name: string }>(
      `select name from public.ghl_pipelines where ghl_id = $1`,
      [FINANCE],
    );
    expect(pipeline.rows[0]?.name).toBe('Fundd Pipeline ');

    const now = await mirror();
    const oppsNow = new Map(
      (
        now['ghl_opportunities'] as {
          ghl_id: string;
          stage_ghl_id: string;
          removed_at: string | null;
        }[]
      ).map((o) => [o.ghl_id, o]),
    );
    const oppsBefore = new Map(
      (afterSecond['ghl_opportunities'] as { ghl_id: string }[]).map((o) => [o.ghl_id, o]),
    );
    expect(oppsNow.get('OPP0000000000000002')?.removed_at).not.toBeNull();
    expect(oppsNow.get('OPP0000000000000001')?.stage_ghl_id).toBe(
      'f2393065-3038-4fba-bdf1-8c39b7b18183',
    );
    expect(oppsNow.get('OPP0000000000000003')).toStrictEqual(oppsBefore.get('OPP0000000000000003'));
    expect(oppsNow.get('OPP0000000000000004')).toStrictEqual(oppsBefore.get('OPP0000000000000004'));

    const contactsNow = new Map(
      (
        now['ghl_contacts'] as { ghl_id: string; full_name: string; removed_at: string | null }[]
      ).map((c) => [c.ghl_id, c]),
    );
    expect(contactsNow.get('CONTACT000000000001')?.full_name).toBe('Alexandra Tran-Nguyen');
    expect(contactsNow.get('CONTACT000000000001')?.removed_at).toBeNull();
    // Nothing live references contact 2 any more (its opportunity was deleted): out of scope, marked.
    expect(contactsNow.get('CONTACT000000000002')?.removed_at).not.toBeNull();

    const fieldsNow = new Map(
      (
        now['ghl_custom_fields'] as { ghl_id: string; name: string; removed_at: string | null }[]
      ).map((f) => [f.ghl_id, f]),
    );
    expect(fieldsNow.get('UWmWQyJn1lEhC8XRjqQD')?.name).toBe('Loan Amount (AUD) ');
    expect(fieldsNow.get('J8AzUUemQHCzZZB0uUDc')?.removed_at).not.toBeNull();
    // A renamed definition never touches a stored value.
    expect(contactsNow.get('CONTACT000000000001')).toMatchObject({
      custom_fields: expect.objectContaining({ UWmWQyJn1lEhC8XRjqQD: 650000 }) as unknown,
    });
  });

  it('4. what comes back has its mark cleared', async () => {
    world.pipelines = 'pipelines';
    world.opportunities = 'opportunities-all';
    world.contacts.set('CONTACT000000000001', 'contact-1');
    world.customFields = 'custom-fields-clean';
    const report = await sync();
    expect(report.status).toBe('success');
    expect(report.apply).toMatchObject({
      stages_removed: 1,
      opportunities_updated: 2,
      opportunities_removed: 0,
      contacts_updated: 2,
    });
    const opp = await db.query<{ removed_at: Date | null }>(
      `select removed_at from public.ghl_opportunities where ghl_id = 'OPP0000000000000002'`,
    );
    expect(opp.rows[0]?.removed_at).toBeNull();
    const contact = await db.query<{ removed_at: Date | null }>(
      `select removed_at from public.ghl_contacts where ghl_id = 'CONTACT000000000002'`,
    );
    expect(contact.rows[0]?.removed_at).toBeNull();
    const settled = await db.query<{ removed_at: Date | null }>(
      `select removed_at from public.ghl_stages where ghl_id = '9cef8b67-1171-4347-9275-36e1055a97aa'`,
    );
    expect(settled.rows[0]?.removed_at).toBeNull();
    const added = await db.query<{ removed_at: Date | null }>(
      `select removed_at from public.ghl_stages where ghl_id = 'aaaaaaaa-0000-4000-8000-0000000new01'`,
    );
    expect(added.rows[0]?.removed_at).not.toBeNull();
  });

  it('5. two syncs cannot overlap, and an interrupted one is retired — no race involved', async () => {
    const first = await db.query<{ id: string; stale_marked: number }>(
      `select * from public.begin_ghl_sync_run($1, 'test', null, 900)`,
      [FINANCE],
    );
    const firstId = first.rows[0]?.id ?? '';
    expect(firstId).not.toBe('');
    // A second starter while the first is running: a definite refusal, SQLSTATE 55006.
    await expect(
      db.query(`select * from public.begin_ghl_sync_run($1, 'test', null, 900)`, [FINANCE]),
    ).rejects.toMatchObject({ code: '55006' });
    // And through the production path, the report says 'refused' and nothing is fetched.
    const refused = await sync();
    expect(refused.status).toBe('refused');
    expect(refused.runId).toBeNull();

    // The first run dies without finishing: age it past the stale threshold. The next
    // starter retires it as failed/STALE and takes the slot.
    await db.query(
      `update public.ghl_sync_runs set started_at = now() - interval '1 hour' where id = $1`,
      [firstId],
    );
    const next = await db.query<{ id: string; stale_marked: number }>(
      `select * from public.begin_ghl_sync_run($1, 'test', null, 900)`,
      [FINANCE],
    );
    // Whatever fails below, the slot this test took is released: a run left `running` here
    // would make every later test read 'refused' and hide the real failure behind it.
    try {
      expect(next.rows[0]?.stale_marked).toBe(1);
      const stale = await db.query<{ status: string; error_code: string | null }>(
        `select status, error_code from public.ghl_sync_runs where id = $1`,
        [firstId],
      );
      expect(stale.rows[0]).toEqual({ status: 'failed', error_code: 'STALE' });
      // Applying against the retired run is refused too. The snapshot names the pipeline so
      // the refusal is about the run's state (55006), not about a payload with no pipeline.
      await expect(
        db.query(`select public.apply_ghl_snapshot($1, $2::jsonb)`, [
          firstId,
          JSON.stringify({ pipeline: { ghl_id: FINANCE } }),
        ]),
      ).rejects.toMatchObject({ code: '55006' });
    } finally {
      await db.query(
        `select public.finish_ghl_sync_run($1, 'failed', 'TEST', 'closed by the test', '[]'::jsonb, '{}'::jsonb)`,
        [next.rows[0]?.id],
      );
    }
  });

  it('6. a contact that fails mid-run keeps its previous row and the run is partial, listed by id', async () => {
    const before = await mirror();
    world.contacts.set('CONTACT000000000002', FAIL);
    const report = await sync();
    world.contacts.set('CONTACT000000000002', 'contact-2');
    expect(report.status).toBe('partial');
    expect(report.fetch.contacts_failed).toBe(1);
    expect(report.errors).toEqual([
      { kind: 'contact', id: 'CONTACT000000000002', code: 'NETWORK' },
    ]);
    const after = await mirror();
    expect(after['ghl_contacts']).toStrictEqual(before['ghl_contacts']);
    expect(after['ghl_opportunities']).toStrictEqual(before['ghl_opportunities']);
    const run = await db.query<{ status: string; contacts_failed: number; errors: unknown }>(
      `select status, contacts_failed, errors from public.ghl_sync_runs where id = $1`,
      [report.runId],
    );
    expect(run.rows[0]).toEqual({
      status: 'partial',
      contacts_failed: 1,
      errors: [{ kind: 'contact', id: 'CONTACT000000000002', code: 'NETWORK' }],
    });
  });

  it('7. a dead token mid-run applies nothing and the run row says why', async () => {
    const before = await mirror();
    world.contacts.set('CONTACT000000000001', UNAUTHORIZED);
    const report = await sync();
    world.contacts.set('CONTACT000000000001', 'contact-1');
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('UNAUTHENTICATED');
    expect(await mirror()).toStrictEqual(before);
    const run = await db.query<{
      status: string;
      error_code: string | null;
      applied_at: Date | null;
      error: string;
    }>(`select status, error_code, applied_at, error from public.ghl_sync_runs where id = $1`, [
      report.runId,
    ]);
    expect(run.rows[0]).toMatchObject({
      status: 'failed',
      error_code: 'UNAUTHENTICATED',
      applied_at: null,
    });
    expect(run.rows[0]?.error).toContain('NOT an empty pipeline');
    expect(logLines.some((l) => l.includes('ghl_token_rejected'))).toBe(true);
  });
});
