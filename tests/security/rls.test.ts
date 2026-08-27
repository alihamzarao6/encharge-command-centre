/**
 * RLS verification (SECURITY.md §6, SCHEMA.md §7, task 2.2.11).
 *
 * Not "we enabled RLS" — proven against a running stack, through the same surfaces an
 * attacker would use (the anon key and a real authenticated session via PostgREST).
 * The table list is read from the catalog, never hand-written, so a table added later
 * without RLS fails CI. Asserts:
 *
 *   1. every public table has rowsecurity AND forcerowsecurity
 *   2. an anon client selecting from every table gets zero rows
 *   3. an authenticated but NON-allowlisted user gets zero rows from every table
 *   4. on memory tables an allowlisted user reads every workspace row regardless of author
 *   5. user A cannot read user B's user-scoped rows (and vice versa)
 *   6. no authenticated insert/update/delete policy exists on any table, and a
 *      behavioural write attempt through PostgREST is refused
 *
 * All fixtures are synthetic (example.com users, run-scoped keys) and removed afterwards.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();

const MEMORY_TABLES = ['conversations', 'messages', 'memory_chunks', 'memory_facts'];
const RUN = crypto.randomUUID().slice(0, 8);

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly client: SupabaseClient;
}

function extractIds(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.map((row) => String((row as Record<string, unknown>)['id']));
}

// The describe body always runs (vitest registers tests even for a skipped suite), so the
// clients are constructed with inert placeholders when the stack is absent; no connection
// is opened outside beforeAll, and beforeAll never runs for a skipped suite.
const cfg = env ?? {
  url: 'http://stack-not-running.invalid',
  anonKey: 'unset',
  serviceRoleKey: 'unset',
  dbUrl: 'postgresql://stack-not-running.invalid/postgres',
};

describe.skipIf(env === null)('row-level security (requires a running Supabase stack)', () => {
  const db = new pg.Client({ connectionString: cfg.dbUrl });
  const admin = createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let tables: string[] = [];
  let userA: TestUser; // allowlisted
  let userB: TestUser; // allowlisted
  let outsider: TestUser; // authenticated, NOT in app_users
  // Only users that were actually created get cleaned up — if beforeAll throws midway,
  // afterAll must report nothing but the setup error, not a TypeError on top of it.
  const createdUsers: TestUser[] = [];
  const fixtureIds = {
    convWorkspaceA: '',
    convPrivateA: '',
    factWorkspaceA: '',
    factPrivateA: '',
    factPrivateB: '',
    chunkWorkspaceA: '',
    chunkPrivateA: '',
  };

  async function createUser(label: string, allowlisted: boolean): Promise<TestUser> {
    const email = `rls-${label}-${RUN}@example.com`;
    const password = crypto.randomUUID();
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error !== null) {
      throw new Error(`could not create test user ${label}: ${created.error.message}`);
    }
    const id = created.data.user.id;
    if (allowlisted) {
      await db.query(
        `insert into public.app_users (user_id, email, role, is_active)
         values ($1, $2, 'staff', true)`,
        [id, email],
      );
    }
    const signIn = await anon.auth.signInWithPassword({ email, password });
    if (signIn.error !== null) {
      throw new Error(`could not sign in test user ${label}: ${signIn.error.message}`);
    }
    const client = createClient(cfg.url, cfg.anonKey, {
      global: { headers: { Authorization: `Bearer ${signIn.data.session.access_token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const user: TestUser = { id, email, client };
    createdUsers.push(user);
    return user;
  }

  beforeAll(async () => {
    await db.connect();

    const tableRows = await db.query<{ relname: string }>(
      `select c.relname
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by c.relname`,
    );
    tables = tableRows.rows.map((r) => r.relname);

    userA = await createUser('a', true);
    userB = await createUser('b', true);
    outsider = await createUser('outsider', false);

    // Memory fixtures, written as service level (the only sanctioned write path).
    const conv = await db.query<{ id: string }>(
      `insert into public.conversations (user_id, scope, title)
       values ($1, 'workspace', $2), ($1, 'user', $3)
       returning id`,
      [userA.id, `rls-ws-conv-${RUN}`, `rls-private-conv-${RUN}`],
    );
    fixtureIds.convWorkspaceA = conv.rows[0]?.id ?? '';
    fixtureIds.convPrivateA = conv.rows[1]?.id ?? '';

    const facts = await db.query<{ id: string }>(
      `insert into public.memory_facts (user_id, scope, key, value)
       values ($1, 'workspace', $3, 'shared'), ($1, 'user', $4, 'private-a'), ($2, 'user', $5, 'private-b')
       returning id`,
      // Keys follow memory_facts_key_format (part 2): <category>:<slug>.
      [
        userA.id,
        userB.id,
        `process:rls-ws-fact-${RUN}`,
        `process:rls-private-a-${RUN}`,
        `process:rls-private-b-${RUN}`,
      ],
    );
    fixtureIds.factWorkspaceA = facts.rows[0]?.id ?? '';
    fixtureIds.factPrivateA = facts.rows[1]?.id ?? '';
    fixtureIds.factPrivateB = facts.rows[2]?.id ?? '';

    // Stage 3 part 1: one chunk under each conversation. user_id/scope are written wrong
    // on purpose (B, 'user' / A, 'workspace') — the parent-sync trigger must overwrite them
    // with the conversation's, which is what makes the RLS outcome below the parent's.
    const chunks = await db.query<{ id: string }>(
      `insert into public.memory_chunks (conversation_id, user_id, scope, summary, embedding, turn_range)
       values ($1, $3, 'user', $4, $6::vector, '[1,3)'),
              ($2, $3, 'workspace', $5, $6::vector, '[1,3)')
       returning id`,
      [
        fixtureIds.convWorkspaceA,
        fixtureIds.convPrivateA,
        userB.id,
        `rls-ws-chunk-${RUN}`,
        `rls-private-chunk-${RUN}`,
        `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? '1' : '0')).join(',')}]`,
      ],
    );
    fixtureIds.chunkWorkspaceA = chunks.rows[0]?.id ?? '';
    fixtureIds.chunkPrivateA = chunks.rows[1]?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    // Fixture rows first (memory FKs deliberately do not cascade), then the users.
    await db.query(`delete from public.memory_facts where key like $1`, [`process:rls-%-${RUN}`]);
    await db.query(`delete from public.memory_chunks where conversation_id = any($1::uuid[])`, [
      [fixtureIds.convWorkspaceA, fixtureIds.convPrivateA].filter((s) => s !== ''),
    ]);
    await db.query(`delete from public.messages where conversation_id = any($1::uuid[])`, [
      [fixtureIds.convWorkspaceA, fixtureIds.convPrivateA].filter((s) => s !== ''),
    ]);
    await db.query(`delete from public.conversations where title like $1`, [`rls-%-${RUN}`]);
    for (const user of createdUsers) {
      await db.query(`delete from public.app_users where user_id = $1`, [user.id]);
      await admin.auth.admin.deleteUser(user.id);
    }
    await db.end();
  }, 60_000);

  it('discovers a non-trivial schema (a vacuous pass is a failure)', () => {
    expect(tables.length).toBeGreaterThanOrEqual(15);
    for (const t of MEMORY_TABLES) expect(tables).toContain(t);
  });

  it('1. every table has rowsecurity AND forcerowsecurity', async () => {
    const res = await db.query<{ relname: string; rls: boolean; force: boolean }>(
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by c.relname`,
    );
    const missing = res.rows.filter((r) => !(r.rls && r.force)).map((r) => r.relname);
    expect(missing).toStrictEqual([]);
  });

  it('privilege layer: authenticated holds SELECT on every table and nothing else; anon holds nothing', async () => {
    // Without this, tests 2 and 3 can pass for the wrong reason: a missing GRANT refuses
    // the query at the privilege layer (42501) before any RLS policy is evaluated, and
    // "zero rows" would prove nothing about the policies. Asserting the grants here means
    // the zero-row tests below are exercising RLS itself — and a future migration that
    // forgets its grant (or over-grants) fails loudly. (Found by CI on the first push:
    // hosted pre-grants via default privileges, the local stack grants nothing.)
    const grants = await db.query<{
      table_name: string;
      grantee: string;
      privilege_type: string;
    }>(
      `select table_name, grantee, privilege_type
       from information_schema.role_table_grants
       where table_schema = 'public' and grantee in ('anon', 'authenticated')`,
    );

    const anonGrants = grants.rows.filter((g) => g.grantee === 'anon');
    expect(anonGrants, 'anon must hold no table grants at all').toStrictEqual([]);

    const authSelect = new Set(
      grants.rows
        .filter((g) => g.grantee === 'authenticated' && g.privilege_type === 'SELECT')
        .map((g) => g.table_name),
    );
    const missingSelect = tables.filter((t) => !authSelect.has(t));
    expect(missingSelect, 'tables where authenticated lacks SELECT').toStrictEqual([]);

    const authBeyondSelect = grants.rows.filter(
      (g) => g.grantee === 'authenticated' && g.privilege_type !== 'SELECT',
    );
    expect(authBeyondSelect, 'authenticated must hold nothing beyond SELECT').toStrictEqual([]);
  });

  it('privilege layer: service_role holds full DML on every table — explicit, never inherited', async () => {
    // Part 3 (FND-220): the sanctioned write path is service_role through PostgREST (Edge
    // Functions, the staff CLI). Hosted pre-grants it via default privileges; the local/CI
    // stack grants nothing — the same divergence that produced the 42501 on the first
    // part-2 push, so the grant is stated in a migration and asserted here. A later
    // migration that adds a table without its service_role grant fails this test.
    const grants = await db.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
       from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'service_role'`,
    );
    const byTable = new Map<string, Set<string>>();
    for (const g of grants.rows) {
      const set = byTable.get(g.table_name) ?? new Set<string>();
      set.add(g.privilege_type);
      byTable.set(g.table_name, set);
    }
    const missing = tables.filter((t) => {
      const held = byTable.get(t) ?? new Set<string>();
      return !['SELECT', 'INSERT', 'UPDATE', 'DELETE'].every((p) => held.has(p));
    });
    expect(missing, 'tables where service_role lacks full DML').toStrictEqual([]);
  });

  it('2. anon client: zero rows from every table', async () => {
    for (const table of tables) {
      const res = await anon.from(table).select('*', { count: 'exact', head: true });
      // Deny-by-default may surface as an empty result or a refusal; any rows are a failure.
      expect(res.count ?? 0, `anon read ${table}`).toBe(0);
    }
  });

  it('3. authenticated but non-allowlisted client: zero rows from every table', async () => {
    for (const table of tables) {
      const res = await outsider.client.from(table).select('*', { count: 'exact', head: true });
      expect(res.count ?? 0, `outsider read ${table}`).toBe(0);
    }
  });

  it('4. an allowlisted user reads workspace memory rows regardless of author', async () => {
    // The workspace conversation and fact were authored by A; B must see them.
    const conv = await userB.client
      .from('conversations')
      .select('id')
      .eq('id', fixtureIds.convWorkspaceA);
    expect(conv.error).toBeNull();
    expect(extractIds(conv.data)).toContain(fixtureIds.convWorkspaceA);

    const fact = await userB.client
      .from('memory_facts')
      .select('id')
      .eq('id', fixtureIds.factWorkspaceA);
    expect(fact.error).toBeNull();
    expect(extractIds(fact.data)).toContain(fixtureIds.factWorkspaceA);

    // Stage 3: the chunk under the workspace conversation, too — and its ownership is the
    // conversation's, whatever the insert claimed (trigger), so the policy sees workspace.
    const chunk = await userB.client
      .from('memory_chunks')
      .select('id, user_id, scope')
      .eq('id', fixtureIds.chunkWorkspaceA);
    expect(chunk.error).toBeNull();
    expect(chunk.data).toEqual([
      { id: fixtureIds.chunkWorkspaceA, user_id: userA.id, scope: 'workspace' },
    ]);
  });

  it("4b. an allowlisted user never reads a chunk's embedding or summary of a private conversation; the outsider reads no chunk at all", async () => {
    const outsiderRead = await outsider.client.from('memory_chunks').select('id');
    expect(extractIds(outsiderRead.data)).toStrictEqual([]);
    const privateFromB = await userB.client
      .from('memory_chunks')
      .select('id, summary')
      .eq('id', fixtureIds.chunkPrivateA);
    expect(privateFromB.data).toStrictEqual([]);
  });

  it("5. a user cannot read another user's user-scoped rows, but reads their own", async () => {
    // B cannot see A's private conversation or fact…
    const convFromB = await userB.client
      .from('conversations')
      .select('id')
      .eq('id', fixtureIds.convPrivateA);
    expect(extractIds(convFromB.data)).toStrictEqual([]);

    const factFromB = await userB.client
      .from('memory_facts')
      .select('id')
      .eq('id', fixtureIds.factPrivateA);
    expect(extractIds(factFromB.data)).toStrictEqual([]);

    // …A cannot see B's private fact…
    const factFromA = await userA.client
      .from('memory_facts')
      .select('id')
      .eq('id', fixtureIds.factPrivateB);
    expect(extractIds(factFromA.data)).toStrictEqual([]);

    // …and each owner still sees their own private rows.
    const ownConv = await userA.client
      .from('conversations')
      .select('id')
      .eq('id', fixtureIds.convPrivateA);
    expect(extractIds(ownConv.data)).toContain(fixtureIds.convPrivateA);

    const ownFact = await userB.client
      .from('memory_facts')
      .select('id')
      .eq('id', fixtureIds.factPrivateB);
    expect(extractIds(ownFact.data)).toContain(fixtureIds.factPrivateB);

    // Stage 3: the private conversation's chunk follows the same rule — B sees nothing,
    // A (the owner) sees it, with the trigger-corrected ownership.
    const chunkFromB = await userB.client
      .from('memory_chunks')
      .select('id')
      .eq('id', fixtureIds.chunkPrivateA);
    expect(extractIds(chunkFromB.data)).toStrictEqual([]);
    const ownChunk = await userA.client
      .from('memory_chunks')
      .select('id, user_id, scope')
      .eq('id', fixtureIds.chunkPrivateA);
    expect(ownChunk.data).toEqual([
      { id: fixtureIds.chunkPrivateA, user_id: userA.id, scope: 'user' },
    ]);
  });

  it('6a. no insert/update/delete policy exists for authenticated (or anon) on any table', async () => {
    const res = await db.query<{ tablename: string; policyname: string; cmd: string }>(
      `select tablename, policyname, cmd
       from pg_policies
       where schemaname = 'public'
         and (('authenticated' = any(roles) or 'anon' = any(roles) or 'public' = any(roles)))
         and cmd <> 'SELECT'`,
    );
    expect(res.rows).toStrictEqual([]);
  });

  it('6b. an allowlisted user still cannot write through PostgREST', async () => {
    // A fully valid row, so the refusal below can only be RLS, never a constraint.
    const insert = await userA.client.from('consumer_leads').insert({
      full_name: `SYNTHETIC ${RUN}`,
      lead_type: 'refinance',
      pipeline_stage: 'new_lead',
      lead_source: 'ads',
      opt_out: false,
    });
    expect(insert.error).not.toBeNull();

    const check = await db.query<{ n: string }>(
      `select count(*) as n from public.consumer_leads where full_name = $1`,
      [`SYNTHETIC ${RUN}`],
    );
    expect(check.rows[0]?.n).toBe('0');
  });

  it('7. Stage 3 part 2: the memory functions are executable by service_role only — a session cannot search memory or write a fact', async () => {
    // Postgres grants EXECUTE on a new function to PUBLIC by default; the migration
    // revokes it. Asserted from the catalog AND behaviourally through PostgREST.
    const privileges = await db.query<{ fn: string; role: string; can: boolean }>(
      `select fn, role, has_function_privilege(role, fn, 'execute') as can
       from (values
         ('public.upsert_memory_fact(uuid,text,text,text,numeric,uuid)'),
         ('public.match_memory_chunks(extensions.vector,uuid,uuid,integer,integer,double precision)')
       ) f(fn)
       cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)`,
    );
    for (const row of privileges.rows) {
      expect(row.can, `${row.role} on ${row.fn}`).toBe(row.role === 'service_role');
    }
    const write = await userA.client.rpc('upsert_memory_fact', {
      p_user_id: userA.id,
      p_scope: 'workspace',
      p_key: `process:rls-rpc-${RUN}`,
      p_value: 'should never land',
      p_confidence: 1,
      p_source_message_id: null,
    });
    expect(write.error).not.toBeNull();
    const landed = await db.query<{ n: string }>(
      `select count(*) as n from public.memory_facts where key = $1`,
      [`process:rls-rpc-${RUN}`],
    );
    expect(landed.rows[0]?.n).toBe('0');
    const search = await userA.client.rpc('match_memory_chunks', {
      p_query: `[${Array.from({ length: 1024 }, () => '0').join(',')}]`,
      p_user_id: userA.id,
      p_conversation_id: null,
      p_history_messages: 0,
      p_limit: 3,
      p_min_similarity: 0,
    });
    expect(search.error).not.toBeNull();
  });

  it('anon policies do not exist at all', async () => {
    const res = await db.query<{ tablename: string }>(
      `select tablename from pg_policies
       where schemaname = 'public' and ('anon' = any(roles) or 'public' = any(roles))`,
    );
    expect(res.rows).toStrictEqual([]);
  });
});
