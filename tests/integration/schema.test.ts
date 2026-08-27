/**
 * Schema integration suite (TESTING.md §4, tasks 2.2.12/2.2.14).
 *
 * Runs against a stack whose database was replayed from zero (`supabase db reset`), so a
 * green run here IS the evidence that the migration set produces a working schema:
 *
 *   - exactly the expected tables exist, and nothing from a parked SCHEMA.md section
 *   - the seed landed: two app_users rows, ten ghl_field_map stage rows with the real
 *     stage IDs from the 24 Aug authorized read (mapping pinned below)
 *   - consumer_leads carries consent_basis and opt_out (not null, default false) from the
 *     first migration (Spam Act, R10)
 *   - the ownership triggers hold: children mirror their conversation, flips cascade
 *   - memory_facts refuses two live values for one key
 *   - review_queue refuses parked-era entity types
 *   - the audit triggers write insert/update/delete rows
 *
 * All writes go through the direct DB connection (service level — the sanctioned write
 * path) and every fixture is synthetic and removed afterwards.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();

const EXPECTED_TABLES = [
  'api_usage',
  'app_users',
  'audit_log',
  'consumer_leads',
  'conversations',
  'crm_sync_log',
  'field_overrides',
  'ghl_field_map',
  'memory_chunks',
  'memory_facts',
  'messages',
  'notion_sync_map',
  'review_queue',
  'tasks',
  'workflow_runs',
];

// Tables that belong to parked SCHEMA.md sections and must never ship (D23, D36).
const PARKED_TABLES = [
  'organizations',
  'org_sources',
  'contacts',
  'email_verifications',
  'rankings',
  'rubric_versions',
  'merge_log',
  'social_accounts',
  'social_metrics',
  'social_posts',
];

// Seeded staff identities (supabase/seed.sql) — fixed UUIDs, no client data.
const ROSS = 'a0000000-0000-4000-8000-000000000001';
const DEV = 'a0000000-0000-4000-8000-000000000002';

const RUN = crypto.randomUUID().slice(0, 8);

describe.skipIf(env === null)('schema from zero (requires a running Supabase stack)', () => {
  const db = new pg.Client({
    connectionString: env?.dbUrl ?? 'postgresql://stack-not-running.invalid/postgres',
  });

  beforeAll(async () => {
    await db.connect();
  }, 30_000);

  afterAll(async () => {
    await db.query(`delete from public.memory_facts where key like $1`, [`process:schema-test-%-${RUN}`]);
    // Children before parents — the memory FKs deliberately do not cascade (SCHEMA §4):
    // chunks and messages under this run's conversations first, then the conversations.
    await db.query(
      `delete from public.memory_chunks where conversation_id in
         (select id from public.conversations where title like $1)`,
      [`schema-test-${RUN}%`],
    );
    await db.query(
      `delete from public.messages where content like $1 or conversation_id in
         (select id from public.conversations where title like $1)`,
      [`schema-test-${RUN}%`],
    );
    await db.query(`delete from public.conversations where title like $1`, [`schema-test-${RUN}%`]);
    await db.query(`delete from public.consumer_leads where full_name like $1`, [
      `SYNTHETIC SCHEMA TEST ${RUN}%`,
    ]);
    await db.end();
  }, 30_000);

  it('creates exactly the expected tables', async () => {
    const res = await db.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    expect(res.rows.map((r) => r.tablename)).toStrictEqual(EXPECTED_TABLES);
  });

  it('ships nothing from a parked SCHEMA.md section', async () => {
    const res = await db.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' and tablename = any($1)`,
      [PARKED_TABLES],
    );
    expect(res.rows).toStrictEqual([]);
  });

  it('installed pgcrypto, pg_trgm and vector', async () => {
    const res = await db.query<{ extname: string }>(
      `select extname from pg_extension where extname in ('pgcrypto', 'pg_trgm', 'vector')
       order by extname`,
    );
    expect(res.rows.map((r) => r.extname)).toStrictEqual(['pg_trgm', 'pgcrypto', 'vector']);
  });

  it('seeded the two staff allowlist rows — both admins (part 3) — and nothing else', async () => {
    const res = await db.query<{
      user_id: string;
      email: string;
      is_active: boolean;
      is_admin: boolean;
    }>(`select user_id, email, is_active, is_admin from public.app_users order by email`);
    expect(res.rows).toStrictEqual([
      { user_id: DEV, email: 'alihamzarao14@gmail.com', is_active: true, is_admin: true },
      { user_id: ROSS, email: 'rossb@fundd.com.au', is_active: true, is_admin: true },
    ]);
  });

  it('app_users.is_admin is not null and defaults to false — a new user is never born admin', async () => {
    const res = await db.query<{ is_nullable: string; column_default: string | null }>(
      `select is_nullable, column_default
       from information_schema.columns
       where table_schema = 'public' and table_name = 'app_users' and column_name = 'is_admin'`,
    );
    expect(res.rows).toStrictEqual([{ is_nullable: 'NO', column_default: 'false' }]);
  });

  it('seeded the ten Finance Pipeline stage rows with their real GHL stage IDs', async () => {
    const res = await db.query<{ internal_field: string; ghl_custom_field_id: string | null }>(
      `select internal_field, ghl_custom_field_id from public.ghl_field_map
       where entity = 'stage' order by internal_field`,
    );
    // The full mapping is pinned deliberately: these IDs are configuration read from the
    // live account on 24 Aug 2026 (pipeline M4unnMKBy0TgwCwOA6wS), and a drift here means
    // someone changed the seed or GHL without a fresh authorized read. Matched on ID,
    // never name (MEMORY.md 12 Aug).
    expect(res.rows).toStrictEqual([
      {
        internal_field: 'appointment_booked',
        ghl_custom_field_id: '3a47fe3c-57d1-41d4-bc89-20241eb978f4',
      },
      { internal_field: 'approved', ghl_custom_field_id: '2c356add-69e4-458e-b940-a7aaa9947159' },
      { internal_field: 'contacted', ghl_custom_field_id: 'f2393065-3038-4fba-bdf1-8c39b7b18183' },
      {
        internal_field: 'docs_received',
        ghl_custom_field_id: '924f9bfc-3156-4440-a624-3eb10f506c6c',
      },
      {
        internal_field: 'docs_requested',
        ghl_custom_field_id: '8727dd26-4e4d-4faf-b198-14e181c12e9e',
      },
      {
        internal_field: 'lost_not_proceeding',
        ghl_custom_field_id: '2ee75d16-1407-43cf-811e-957e0e2adc3a',
      },
      { internal_field: 'new_lead', ghl_custom_field_id: '51c98561-cd26-49a9-a001-97536c31dd0a' },
      { internal_field: 'qualified', ghl_custom_field_id: '5d215f52-d09d-45c8-a192-a2555ce46317' },
      { internal_field: 'settled', ghl_custom_field_id: '9cef8b67-1171-4347-9275-36e1055a97aa' },
      {
        internal_field: 'submitted_to_lender',
        ghl_custom_field_id: 'dea94c3a-84d0-40e4-a722-6ff3db4c8af9',
      },
    ]);
  });

  it('consumer_leads carries consent_basis and a non-null opt_out defaulting to false', async () => {
    const res = await db.query<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select column_name, is_nullable, column_default
       from information_schema.columns
       where table_schema = 'public' and table_name = 'consumer_leads'
         and column_name in ('consent_basis', 'opt_out')
       order by column_name`,
    );
    expect(res.rows.map((r) => r.column_name)).toStrictEqual(['consent_basis', 'opt_out']);
    const optOut = res.rows[1];
    expect(optOut?.is_nullable).toBe('NO');
    expect(optOut?.column_default).toBe('false');
  });

  it('every memory table carries user_id not null and a scope check', async () => {
    const res = await db.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `select table_name, column_name, is_nullable
       from information_schema.columns
       where table_schema = 'public'
         and table_name in ('conversations', 'messages', 'memory_chunks', 'memory_facts')
         and column_name in ('user_id', 'scope')
       order by table_name, column_name`,
    );
    expect(res.rows).toHaveLength(8);
    expect(res.rows.every((r) => r.is_nullable === 'NO')).toBe(true);
  });

  it('messages mirror their conversation and a scope flip cascades', async () => {
    const conv = await db.query<{ id: string }>(
      `insert into public.conversations (user_id, scope, title)
       values ($1, 'workspace', $2) returning id`,
      [ROSS, `schema-test-${RUN}`],
    );
    const convId = conv.rows[0]?.id ?? '';

    // Deliberately wrong owner and scope: the trigger must correct both to the parent's.
    const msg = await db.query<{ user_id: string; scope: string }>(
      `insert into public.messages (conversation_id, user_id, scope, role, content)
       values ($1, $2, 'user', 'user', $3) returning user_id, scope`,
      [convId, DEV, `schema-test-${RUN} wrong owner`],
    );
    expect(msg.rows[0]).toStrictEqual({ user_id: ROSS, scope: 'workspace' });

    await db.query(`update public.conversations set scope = 'user' where id = $1`, [convId]);
    const after = await db.query<{ scope: string }>(
      `select scope from public.messages where conversation_id = $1`,
      [convId],
    );
    expect(after.rows[0]?.scope).toBe('user');
  });

  it('memory_chunks (Stage 3 part 1): no overlapping ranges, a mandatory valid range, HNSW on the embedding', async () => {
    const conv = await db.query<{ id: string }>(
      `insert into public.conversations (user_id, scope, title)
       values ($1, 'workspace', $2) returning id`,
      [ROSS, `schema-test-${RUN} chunks`],
    );
    const convId = conv.rows[0]?.id ?? '';
    const vector = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? '1' : '0')).join(',')}]`;
    const insert = (range: string): Promise<unknown> =>
      db.query(
        `insert into public.memory_chunks (conversation_id, user_id, scope, summary, embedding, turn_range)
         values ($1, $2, 'workspace', $3, $4::vector, $5::int4range)`,
        [convId, ROSS, `schema-test-${RUN} chunk ${range}`, vector, range],
      );

    await insert('[1,11)');
    // The same range, an overlapping one, and a sub-range: all refused by the constraint.
    await expect(insert('[1,11)')).rejects.toThrow(/memory_chunks_no_overlap/);
    await expect(insert('[5,15)')).rejects.toThrow(/memory_chunks_no_overlap/);
    await expect(insert('[3,4)')).rejects.toThrow(/memory_chunks_no_overlap/);
    // The next tile is fine.
    await insert('[11,21)');
    // No pointer, an empty pointer, a pointer starting at 0: refused.
    await expect(
      db.query(
        `insert into public.memory_chunks (conversation_id, user_id, scope, summary, embedding)
         values ($1, $2, 'workspace', 'no range', $3::vector)`,
        [convId, ROSS, vector],
      ),
    ).rejects.toThrow(/null value in column "turn_range"/);
    await expect(insert('[30,30)')).rejects.toThrow(/memory_chunks_turn_range_valid/);
    await expect(insert('[0,5)')).rejects.toThrow(/memory_chunks_turn_range_valid/);

    const stored = await db.query<{ turn_range: string; dims: number }>(
      `select turn_range::text, vector_dims(embedding) as dims
       from public.memory_chunks where conversation_id = $1 order by lower(turn_range)`,
      [convId],
    );
    expect(stored.rows).toStrictEqual([
      { turn_range: '[1,11)', dims: 1024 },
      { turn_range: '[11,21)', dims: 1024 },
    ]);

    const index = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname = 'public' and indexname = 'memory_chunks_embedding_idx'`,
    );
    expect(index.rows[0]?.indexdef).toMatch(
      // Postgres drops the schema qualifier when `extensions` is on the search_path (CI #18).
      /USING hnsw \(embedding (extensions\.)?vector_cosine_ops\)/,
    );
    expect(index.rows[0]?.indexdef).not.toMatch(/ivfflat/);

    const ext = await db.query<{ extname: string }>(
      `select extname from pg_extension where extname = 'btree_gist'`,
    );
    expect(ext.rows).toStrictEqual([{ extname: 'btree_gist' }]);

    await db.query(`delete from public.memory_chunks where conversation_id = $1`, [convId]);
  });

  it('memory_facts refuses a second live value for the same key', async () => {
    const key = `process:schema-test-dup-${RUN}`;
    await db.query(
      `insert into public.memory_facts (user_id, scope, key, value) values ($1, 'workspace', $2, 'v1')`,
      [ROSS, key],
    );
    await expect(
      db.query(
        `insert into public.memory_facts (user_id, scope, key, value) values ($1, 'workspace', $2, 'v2')`,
        [ROSS, key],
      ),
    ).rejects.toThrow(/memory_facts_live_key_uniq/);
  });

  it('review_queue refuses parked-era entity types', async () => {
    await expect(
      db.query(
        `insert into public.review_queue (entity_type, reason, payload)
         values ('org', 'parked', '{}')`,
      ),
    ).rejects.toThrow(/review_queue_entity_type_check/);
  });

  it('review_queue refuses an item with neither entity_id nor payload', async () => {
    await expect(
      db.query(
        `insert into public.review_queue (entity_type, reason) values ('content_draft', 'x')`,
      ),
    ).rejects.toThrow(/review_queue_target_check/);
  });

  it('consumer_leads requires name, type, stage and source; tasks requires source', async () => {
    const res = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
       from information_schema.columns
       where table_schema = 'public'
         and ((table_name = 'consumer_leads'
                 and column_name in ('full_name', 'lead_type', 'pipeline_stage', 'lead_source'))
              or (table_name = 'tasks' and column_name = 'source')
              or (table_name = 'review_queue' and column_name = 'reason'))
         and is_nullable = 'NO'
       order by table_name, column_name`,
    );
    expect(res.rows.map((r) => `${r.table_name}.${r.column_name}`)).toStrictEqual([
      'consumer_leads.full_name',
      'consumer_leads.lead_source',
      'consumer_leads.lead_type',
      'consumer_leads.pipeline_stage',
      'review_queue.reason',
      'tasks.source',
    ]);
  });

  it('audit triggers record insert, update and delete on consumer_leads', async () => {
    const lead = await db.query<{ id: string }>(
      `insert into public.consumer_leads (full_name, lead_type, pipeline_stage, lead_source)
       values ($1, 'refinance', 'new_lead', 'ads') returning id`,
      [`SYNTHETIC SCHEMA TEST ${RUN}`],
    );
    const leadId = lead.rows[0]?.id ?? '';
    await db.query(`update public.consumer_leads set notes = 'touched' where id = $1`, [leadId]);
    await db.query(`delete from public.consumer_leads where id = $1`, [leadId]);

    const audit = await db.query<{ action: string }>(
      `select action from public.audit_log
       where entity_type = 'consumer_leads' and entity_id = $1 order by created_at`,
      [leadId],
    );
    expect(audit.rows.map((r) => r.action)).toStrictEqual(['INSERT', 'UPDATE', 'DELETE']);
  });

  it('updated_at trigger overrides a supplied value', async () => {
    const lead = await db.query<{ id: string }>(
      `insert into public.consumer_leads (full_name, lead_type, pipeline_stage, lead_source)
       values ($1, 'refinance', 'new_lead', 'ads') returning id`,
      [`SYNTHETIC SCHEMA TEST ${RUN} updated_at`],
    );
    const leadId = lead.rows[0]?.id ?? '';
    const updated = await db.query<{ recent: boolean }>(
      `update public.consumer_leads set notes = 'x', updated_at = '2000-01-01T00:00:00Z'
       where id = $1 returning (updated_at > now() - interval '1 minute') as recent`,
      [leadId],
    );
    expect(updated.rows[0]?.recent).toBe(true);
    await db.query(`delete from public.consumer_leads where id = $1`, [leadId]);
  });
});
