/**
 * The overview's numbers against a real Supabase stack (Milestone 4 part 2, Part D item
 * 14): a KNOWN snapshot is written through the part-1 functions exactly as a sync writes
 * it, then read back the way the screen reads it — the same five selects, under RLS, as an
 * allowlisted member — and the view built from those rows is compared, figure by figure,
 * against what the snapshot says. Not against whatever happens to be in the database.
 *
 * Two things are proven that the unit tests cannot: that the column names and shapes the
 * screen selects are the ones the migration created, and that RLS hides nothing from a
 * member that the numbers need (the view built from the service-role rows is identical).
 *
 * Every row is keyed on this run's pipeline id and removed afterwards. Runs are read for
 * this pipeline only; the screen reads the newest five of any pipeline, which in production
 * is the one pipeline the sync mirrors.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';
import {
  OVERVIEW_OPPORTUNITY_LIMIT,
  buildOverview,
  type GhlContactRow,
  type GhlOpportunityRow,
  type GhlPipelineRow,
  type GhlStageRow,
  type GhlSyncRunRow,
  type OverviewInput,
  type OverviewView,
} from '../../web/src/lib/overviewView.js';

/* eslint-disable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style -- supabase-js schema shape */
/** The five mirror tables as the browser's WebDatabase declares them (web/src/lib/supabase.ts). */
type MirrorDatabase = {
  public: {
    Tables: {
      ghl_pipelines: {
        Row: GhlPipelineRow;
        Insert: Partial<GhlPipelineRow>;
        Update: Partial<GhlPipelineRow>;
        Relationships: [];
      };
      ghl_stages: {
        Row: GhlStageRow;
        Insert: Partial<GhlStageRow>;
        Update: Partial<GhlStageRow>;
        Relationships: [];
      };
      ghl_opportunities: {
        Row: GhlOpportunityRow;
        Insert: Partial<GhlOpportunityRow>;
        Update: Partial<GhlOpportunityRow>;
        Relationships: [];
      };
      ghl_contacts: {
        Row: GhlContactRow;
        Insert: Partial<GhlContactRow>;
        Update: Partial<GhlContactRow>;
        Relationships: [];
      };
      ghl_sync_runs: {
        Row: GhlSyncRunRow;
        Insert: Partial<GhlSyncRunRow>;
        Update: Partial<GhlSyncRunRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
/* eslint-enable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style */
type MirrorClient = SupabaseClient<MirrorDatabase>;

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);
const PIPELINE = `OVTEST-${RUN}`;
const STAGE = (n: number): string => `${PIPELINE}-stage-${String(n)}`;
const OPP = (n: number): string => `${PIPELINE}-opp-${String(n)}`;
const CONTACT = (n: number): string => `${PIPELINE}-contact-${String(n)}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const cfg = env ?? {
  url: 'http://stack-not-running.invalid',
  anonKey: 'unset',
  serviceRoleKey: 'unset',
  dbUrl: 'postgresql://stack-not-running.invalid/postgres',
};

function iso(msAgo: number, now: number): string {
  return new Date(now - msAgo).toISOString();
}

/** The snapshot as src/lib/crm/ghl/sync.ts builds it, with the values this test asserts. */
function snapshot(now: number): Record<string, unknown> {
  const opportunity = (
    n: number,
    stage: number,
    contact: number | null,
    status: string,
    createdMsAgo: number,
  ): Record<string, unknown> => ({
    ghl_id: OPP(n),
    stage_ghl_id: STAGE(stage),
    contact_ghl_id: contact === null ? null : CONTACT(contact),
    name: `Lead ${String(n)}`,
    status,
    monetary_value: 0,
    source: null,
    assigned_to: null,
    ghl_created_at: iso(createdMsAgo, now),
    ghl_updated_at: iso(createdMsAgo, now),
    last_stage_change_at: null,
    last_status_change_at: null,
    content_hash: `hash-opp-${String(n)}`,
  });
  return {
    pipeline: {
      ghl_id: PIPELINE,
      name: 'Overview Test Pipeline',
      location_id: 'loc',
      ghl_updated_at: null,
    },
    stages: [
      { ghl_id: STAGE(1), name: 'New Lead', position: 0, win_probability: null },
      { ghl_id: STAGE(2), name: 'Appointment Booked', position: 1, win_probability: null },
      { ghl_id: STAGE(3), name: 'Contacted', position: 2, win_probability: null },
      { ghl_id: STAGE(4), name: 'Settled', position: 3, win_probability: null },
    ],
    // Completeness off: no removals, so nothing another suite owns can be marked.
    opportunities_complete: false,
    opportunities: [
      opportunity(1, 1, 1, 'open', 45 * MIN),
      opportunity(2, 1, 2, 'open', 20 * HOUR),
      opportunity(3, 2, 3, 'open', 5 * DAY),
      opportunity(4, 2, null, 'open', 9 * DAY),
      opportunity(5, 4, 1, 'won', 30 * DAY),
      // A stage the pipeline never listed — the sync stores what GoHighLevel said.
      opportunity(6, 9, null, 'open', 2 * DAY),
    ],
    contacts: [
      {
        ghl_id: CONTACT(1),
        first_name: 'Alex',
        last_name: 'Tran',
        full_name: 'Alex Tran',
        email: 'alex.synthetic@example.com',
        phone: '+61400000001',
        source: null,
        dnd: false,
        tags: [],
        custom_fields: {},
        ghl_created_at: iso(45 * MIN, now),
        ghl_updated_at: iso(45 * MIN, now),
        content_hash: 'hash-contact-1',
      },
      {
        ghl_id: CONTACT(2),
        first_name: 'Sam',
        last_name: 'Ó Brádaigh 🏠',
        full_name: 'Sam Ó Brádaigh 🏠',
        email: null,
        phone: null,
        source: null,
        dnd: null,
        tags: [],
        custom_fields: {},
        ghl_created_at: iso(20 * HOUR, now),
        ghl_updated_at: iso(20 * HOUR, now),
        content_hash: 'hash-contact-2',
      },
      // Contact 3 is deliberately absent: its opportunity is live, its details were not read.
    ],
    custom_fields_complete: false,
    custom_fields: [],
  };
}

/** The screen's reads, verbatim from web/src/components/Overview.tsx, scoped to this pipeline. */
async function readLikeTheScreen(client: MirrorClient): Promise<OverviewInput> {
  const pipelines = await client
    .from('ghl_pipelines')
    .select('ghl_id, name, last_changed_at')
    .eq('ghl_id', PIPELINE)
    .limit(20);
  const stages = await client
    .from('ghl_stages')
    .select('ghl_id, pipeline_ghl_id, name, position, removed_at')
    .eq('pipeline_ghl_id', PIPELINE)
    .limit(500);
  const opportunities = await client
    .from('ghl_opportunities')
    .select(
      'ghl_id, pipeline_ghl_id, stage_ghl_id, contact_ghl_id, name, status, ghl_created_at, removed_at',
    )
    .eq('pipeline_ghl_id', PIPELINE)
    .is('removed_at', null)
    .eq('status', 'open')
    .limit(OVERVIEW_OPPORTUNITY_LIMIT);
  const runs = await client
    .from('ghl_sync_runs')
    .select(
      'id, pipeline_ghl_id, status, started_at, applied_at, finished_at, error_code, contacts_failed, contacts_missing, contacts_rejected, opportunities_rejected',
    )
    .eq('pipeline_ghl_id', PIPELINE)
    .order('started_at', { ascending: false })
    .limit(5);
  for (const answer of [pipelines, stages, opportunities, runs]) {
    expect(answer.error).toBeNull();
  }
  const ids = (opportunities.data ?? [])
    .map((o) => o.contact_ghl_id)
    .filter((id): id is string => id !== null);
  const contacts = await client
    .from('ghl_contacts')
    .select('ghl_id, full_name, first_name, last_name, removed_at')
    .in('ghl_id', ids)
    .limit(5);
  expect(contacts.error).toBeNull();
  return {
    pipelines: pipelines.data ?? [],
    stages: stages.data ?? [],
    opportunities: opportunities.data ?? [],
    contacts: contacts.data ?? [],
    runs: runs.data ?? [],
    opportunityLimit: OVERVIEW_OPPORTUNITY_LIMIT,
  };
}

describe.skipIf(env === null)('the overview against a real stack', () => {
  const db = new pg.Client({ connectionString: cfg.dbUrl });
  const service: MirrorClient = createClient<MirrorDatabase>(cfg.url, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let staff: MirrorClient;
  let staffId = '';
  let runId = '';
  const now = Date.now();

  beforeAll(async () => {
    await db.connect();
    // An allowlisted member, the way the RLS suite makes one.
    const email = `overview-${RUN}@example.com`;
    const password = crypto.randomUUID();
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error !== null) throw new Error(created.error.message);
    staffId = created.data.user.id;
    await db.query(
      `insert into public.app_users (user_id, email, role, is_active) values ($1, $2, 'staff', true)`,
      [staffId, email],
    );
    const signedIn = await anon.auth.signInWithPassword({ email, password });
    if (signedIn.error !== null) throw new Error(signedIn.error.message);
    staff = createClient<MirrorDatabase>(cfg.url, cfg.anonKey, {
      global: { headers: { Authorization: `Bearer ${signedIn.data.session.access_token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // The snapshot lands through the part-1 functions, as a sync writes it.
    const begun = await db.query<{ id: string }>(
      `select id from public.begin_ghl_sync_run($1, 'test', null, 900)`,
      [PIPELINE],
    );
    runId = begun.rows[0]?.id ?? '';
    await db.query(`select public.apply_ghl_snapshot($1, $2::jsonb)`, [
      runId,
      JSON.stringify(snapshot(now)),
    ]);
    await db.query(
      `select public.finish_ghl_sync_run($1, 'partial', null, null, $2::jsonb, $3::jsonb)`,
      [
        runId,
        JSON.stringify([{ kind: 'contact', id: CONTACT(3), code: 'NETWORK' }]),
        JSON.stringify({
          requests: 9,
          pages_fetched: 1,
          opportunities_fetched: 6,
          opportunities_rejected: 0,
          contacts_fetched: 2,
          contacts_failed: 1,
          contacts_rejected: 0,
          contacts_missing: 0,
          custom_fields_fetched: 0,
        }),
      ],
    );
  }, 60_000);

  afterAll(async () => {
    await db.query(`delete from public.ghl_sync_runs where pipeline_ghl_id = $1`, [PIPELINE]);
    await db.query(`delete from public.ghl_opportunities where pipeline_ghl_id = $1`, [PIPELINE]);
    await db.query(`delete from public.ghl_stages where pipeline_ghl_id = $1`, [PIPELINE]);
    await db.query(`delete from public.ghl_contacts where ghl_id like $1`, [`${PIPELINE}-%`]);
    await db.query(`delete from public.ghl_pipelines where ghl_id = $1`, [PIPELINE]);
    if (staffId !== '') {
      await db.query(`delete from public.app_users where user_id = $1`, [staffId]);
      await service.auth.admin.deleteUser(staffId);
    }
    await db.end();
  }, 60_000);

  let view: OverviewView;

  it('a member reads the mirror the way the screen does, and the numbers are the snapshot’s', async () => {
    const input = await readLikeTheScreen(staff);
    view = buildOverview(input, now);
    expect(view.kind).toBe('ready');
    expect(view.pipelineName).toBe('Overview Test Pipeline');
    // Six rows in the snapshot: five open, one won. Won is not "in the pipeline".
    expect(view.openTotal).toBe(5);
    // 45 minutes, 20 hours, 5 days and 2 days count; 9 days does not.
    expect(view.newThisWeek).toBe(4);
    expect(view.stages.map((s) => [s.name, s.count, s.kind])).toEqual([
      ['New Lead', 2, 'stage'],
      ['Appointment Booked', 2, 'stage'],
      ['Contacted', 0, 'stage'],
      ['Settled', 0, 'stage'],
      ['Stage not in the pipeline', 1, 'unknown-stage'],
    ]);
    expect(view.capped).toBe(false);
  });

  it('the arrivals are the newest open leads, named from the contact where the sync has one', () => {
    expect(view.arrivals.map((a) => [a.name, a.stageName, a.contactKnown])).toEqual([
      ['Alex Tran', 'New Lead', true],
      ['Sam Ó Brádaigh 🏠', 'New Lead', true],
      ['Lead 6', 'Stage not in the pipeline', false],
      ['Lead 3', 'Appointment Booked', false],
      ['Lead 4', 'Appointment Booked', false],
    ]);
  });

  it('freshness and the run state come from the run row the sync wrote', () => {
    expect(view.freshness.kind).toBe('known');
    if (view.freshness.kind !== 'known') throw new Error('unreachable');
    expect(view.freshness.tone).toBe('fresh');
    expect(view.freshness.label).toBe('Updated just now');
    expect(view.sync).toMatchObject({
      running: false,
      stuck: false,
      lastFailed: false,
      lastPartial: true,
      contactsUnread: 1,
      lastRun: { status: 'partial', errorCode: null },
    });
  });

  it('RLS hides nothing a member needs: the same view from the service-role rows', async () => {
    const asService = buildOverview(await readLikeTheScreen(service), now);
    expect(asService).toStrictEqual(view);
  });

  it('a mirror with no applied run reads as "not set up", never as zero leads', async () => {
    // The same reads, scoped to a pipeline id nothing has ever written.
    const empty = await readLikeTheScreen(staff);
    const none = buildOverview(
      { ...empty, pipelines: [], stages: [], opportunities: [], contacts: [], runs: [] },
      now,
    );
    expect(none.kind).toBe('not-set-up');
    expect(none.openTotal).toBe(0);
  });
});
