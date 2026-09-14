/**
 * The leads screen against a real Supabase stack (Milestone 4 part 3, Part D item 12): a
 * KNOWN snapshot is written through the part-1 functions exactly as a sync writes it, then
 * read back the way the screen reads it — the same six selects, under RLS, as an allowlisted
 * member — and the count in every column and what every row says are compared against what
 * the snapshot says. Not against whatever is in the database.
 *
 * Proven here and nowhere else: that the contact columns the screen selects (`email`,
 * `phone`, `custom_fields`) and the seeded `ghl_field_map` rows are readable by a member
 * under RLS with the names the migration created, and that the view a member builds is
 * identical to the one the service role builds.
 *
 * Every row is keyed on this run's pipeline id and removed afterwards. Never a whole-table
 * count: the field map is read for the two internal names, not counted.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';
import {
  FIELD_INTEREST_RATE,
  FIELD_LOAN_BALANCE,
  LEADS_OPPORTUNITY_LIMIT,
  buildLeads,
  fieldIdFor,
  type GhlContactDetailRow,
  type GhlFieldMapRow,
  type LeadsInput,
  type LeadsView,
} from '../../web/src/lib/leadsView.js';
import type {
  GhlOpportunityRow,
  GhlPipelineRow,
  GhlStageRow,
  GhlSyncRunRow,
} from '../../web/src/lib/overviewView.js';

/* eslint-disable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style -- supabase-js schema shape */
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
        Row: GhlContactDetailRow;
        Insert: Partial<GhlContactDetailRow>;
        Update: Partial<GhlContactDetailRow>;
        Relationships: [];
      };
      ghl_field_map: {
        Row: GhlFieldMapRow;
        Insert: Partial<GhlFieldMapRow>;
        Update: Partial<GhlFieldMapRow>;
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
const PIPELINE = `LDTEST-${RUN}`;
const STAGE = (n: number): string => `${PIPELINE}-stage-${String(n)}`;
const OPP = (n: number): string => `${PIPELINE}-opp-${String(n)}`;
const CONTACT = (n: number): string => `${PIPELINE}-contact-${String(n)}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The seed's ids for the two form fields (seed.sql) — read back through ghl_field_map below. */
const BALANCE_ID = 'TANd0sfC9wRwuJKhSGFx';
const RATE_ID = 'hX8JQblBT9iJhYEa348M';

const cfg = env ?? {
  url: 'http://stack-not-running.invalid',
  anonKey: 'unset',
  serviceRoleKey: 'unset',
  dbUrl: 'postgresql://stack-not-running.invalid/postgres',
};

function iso(msAgo: number, now: number): string {
  return new Date(now - msAgo).toISOString();
}

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
  const contact = (
    n: number,
    names: { first: string | null; last: string | null; full: string | null },
    email: string | null,
    phone: string | null,
    customFields: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ghl_id: CONTACT(n),
    first_name: names.first,
    last_name: names.last,
    full_name: names.full,
    email,
    phone,
    source: null,
    dnd: false,
    tags: [],
    custom_fields: customFields,
    ghl_created_at: iso(DAY, now),
    ghl_updated_at: iso(DAY, now),
    content_hash: `hash-contact-${String(n)}`,
  });
  return {
    pipeline: {
      ghl_id: PIPELINE,
      name: 'Leads Test Pipeline',
      location_id: 'loc',
      ghl_updated_at: null,
    },
    stages: [
      { ghl_id: STAGE(1), name: 'New Lead', position: 0, win_probability: null },
      { ghl_id: STAGE(2), name: 'Appointment Booked', position: 1, win_probability: null },
      { ghl_id: STAGE(3), name: 'Contacted', position: 2, win_probability: null },
      { ghl_id: STAGE(4), name: 'Settled', position: 3, win_probability: null },
    ],
    opportunities_complete: false,
    opportunities: [
      opportunity(1, 1, 1, 'open', 45 * MIN),
      opportunity(2, 1, 2, 'open', 20 * HOUR),
      opportunity(3, 2, 3, 'open', 5 * DAY),
      opportunity(4, 2, null, 'open', 9 * DAY),
      opportunity(5, 4, 1, 'won', 30 * DAY),
      opportunity(6, 9, null, 'open', 2 * DAY),
    ],
    contacts: [
      // The form's two bands, as GoHighLevel returns a MULTIPLE_OPTIONS answer (an array).
      contact(
        1,
        { first: 'Alex', last: 'Tran', full: 'Alex Tran' },
        'alex.synthetic@example.com',
        '+61400000001',
        {
          [BALANCE_ID]: ['$500k–$750k'],
          [RATE_ID]: ['6.2% - 6.5%'],
        },
      ),
      // No email, no phone, nothing captured on the form: normal, and must look normal.
      contact(2, { first: null, last: null, full: 'Sam Ó Brádaigh 🏠' }, null, null, {}),
      // Contact 3 is deliberately absent: its opportunity is live, its details were not read.
    ],
    custom_fields_complete: false,
    custom_fields: [],
  };
}

/** The screen's reads, verbatim from web/src/components/Leads.tsx, scoped to this pipeline. */
async function readLikeTheScreen(client: MirrorClient): Promise<LeadsInput> {
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
    .limit(LEADS_OPPORTUNITY_LIMIT);
  const contacts = await client
    .from('ghl_contacts')
    .select('ghl_id, full_name, first_name, last_name, email, phone, custom_fields, removed_at')
    .like('ghl_id', `${PIPELINE}-%`)
    .is('removed_at', null)
    .limit(2_000);
  const fieldMap = await client
    .from('ghl_field_map')
    .select('internal_field, ghl_custom_field_id, entity')
    .eq('entity', 'contact')
    .limit(100);
  const runs = await client
    .from('ghl_sync_runs')
    .select(
      'id, pipeline_ghl_id, status, started_at, applied_at, finished_at, error_code, contacts_failed, contacts_missing, contacts_rejected, opportunities_rejected',
    )
    .eq('pipeline_ghl_id', PIPELINE)
    .order('started_at', { ascending: false })
    .limit(5);
  for (const answer of [pipelines, stages, opportunities, contacts, fieldMap, runs]) {
    expect(answer.error).toBeNull();
  }
  return {
    pipelines: pipelines.data ?? [],
    stages: stages.data ?? [],
    opportunities: opportunities.data ?? [],
    contacts: contacts.data ?? [],
    fieldMap: fieldMap.data ?? [],
    runs: runs.data ?? [],
    opportunityLimit: LEADS_OPPORTUNITY_LIMIT,
  };
}

describe.skipIf(env === null)('the leads screen against a real stack', () => {
  const db = new pg.Client({ connectionString: cfg.dbUrl });
  const service: MirrorClient = createClient<MirrorDatabase>(cfg.url, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let staff: MirrorClient;
  let staffId = '';
  const now = Date.now();

  beforeAll(async () => {
    await db.connect();
    const email = `leads-${RUN}@example.com`;
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

    const begun = await db.query<{ id: string }>(
      `select id from public.begin_ghl_sync_run($1, 'test', null, 900)`,
      [PIPELINE],
    );
    const runId = begun.rows[0]?.id ?? '';
    await db.query(`select public.apply_ghl_snapshot($1, $2::jsonb)`, [
      runId,
      JSON.stringify(snapshot(now)),
    ]);
    await db.query(
      `select public.finish_ghl_sync_run($1, 'success', null, null, '[]'::jsonb, $2::jsonb)`,
      [
        runId,
        JSON.stringify({
          requests: 8,
          pages_fetched: 1,
          opportunities_fetched: 6,
          opportunities_rejected: 0,
          contacts_fetched: 2,
          contacts_failed: 0,
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

  let input: LeadsInput;
  let view: LeadsView;

  it('a member reads the seeded field map: the two form fields resolve to the ids the seed holds', async () => {
    input = await readLikeTheScreen(staff);
    expect(fieldIdFor(input.fieldMap, FIELD_LOAN_BALANCE)).toBe(BALANCE_ID);
    expect(fieldIdFor(input.fieldMap, FIELD_INTEREST_RATE)).toBe(RATE_ID);
  });

  it('the count in every column is the snapshot’s, zeros kept, the unknown stage after the pipeline', () => {
    view = buildLeads(input, now);
    expect(view.kind).toBe('ready');
    expect(view.pipelineName).toBe('Leads Test Pipeline');
    expect(view.leads).toHaveLength(5);
    expect(view.columns.map((c) => [c.number, c.name, c.leads.length, c.kind])).toEqual([
      [1, 'New Lead', 2, 'stage'],
      [2, 'Appointment Booked', 2, 'stage'],
      [3, 'Contacted', 0, 'stage'],
      [4, 'Settled', 0, 'stage'],
      [null, 'Stage not in the pipeline', 1, 'unknown-stage'],
    ]);
    expect(view.capped).toBe(false);
  });

  it('every row says what the snapshot said: names, phone, email, the bands, and the honest gaps', () => {
    expect(
      view.leads.map((l) => [
        l.opportunityId,
        l.name,
        l.contactKnown,
        l.email,
        l.phone,
        l.loanBalance,
        l.interestRate,
      ]),
    ).toEqual([
      [
        OPP(1),
        'Alex Tran',
        true,
        'alex.synthetic@example.com',
        '+61400000001',
        '$500k–$750k',
        '6.2% - 6.5%',
      ],
      [OPP(2), 'Sam Ó Brádaigh 🏠', true, null, null, null, null],
      [OPP(6), 'Lead 6', false, null, null, null, null],
      [OPP(3), 'Lead 3', false, null, null, null, null],
      [OPP(4), 'Lead 4', false, null, null, null, null],
    ]);
  });

  it('RLS hides nothing a member needs: the same view from the service-role rows', async () => {
    const asService = buildLeads(await readLikeTheScreen(service), now);
    expect(asService).toStrictEqual(view);
  });
});
