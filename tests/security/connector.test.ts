/**
 * MCP connector, stage 1 — the security tests (the brief's Part D, items 17–20, and the
 * database half of Part C).
 *
 * The endpoint is on the public internet with a key as the only thing in front of the
 * client's live CRM. Four promises are made about it, and each has a test here that fails
 * when its protection is taken away (the mutation runs are recorded in docs/MEMORY.md):
 *
 *   17. every tool refuses a call without a live key;
 *   18. no tool can reach a pipeline other than the configured one;
 *   19. no tool can read another user's data — a read happens AS the key's own user, under
 *       the mirror's existing row-level security;
 *   20. no administrative capability is reachable through any tool.
 *
 * Static — runs everywhere, no database:
 *   - the function's own bundle makes ONE database call, names no table, holds no
 *     GoHighLevel client or token, and contains nothing that issues or revokes a key;
 *   - no key-shaped string is written anywhere in the repository.
 *
 * Database-backed — one Postgres connection, no PostgREST: the same SQL the function runs,
 * called as the role the function calls it as. Every test seeds rows under ids of its own
 * and runs in a transaction that is rolled back, so nothing here depends on, or changes,
 * what else is in the database.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TOOL_NAMES } from '../../src/lib/connector/tools.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');

// ---------------------------------------------------------------------------------------
// Static
// ---------------------------------------------------------------------------------------

describe('the connector function, as it is bundled', () => {
  let bundle = '';

  beforeAll(async () => {
    const result = await build({
      entryPoints: [join(REPO_ROOT, 'src', 'functions', 'connector', 'index.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      target: 'esnext',
      mainFields: ['module', 'main'],
      external: ['@supabase/supabase-js', 'zod', 'node:*'],
      legalComments: 'none',
      logLevel: 'silent',
    });
    bundle = result.outputFiles[0]?.text ?? '';
  });

  it('is a non-trivial bundle (a vacuous pass is a failure)', () => {
    expect(bundle.length).toBeGreaterThan(20_000);
    expect(bundle).toContain('connector_call');
    for (const tool of TOOL_NAMES) expect(bundle).toContain(tool);
  });

  it('makes exactly one kind of database call, and names no table', () => {
    expect(bundle.match(/\.rpc\(/g) ?? []).toHaveLength(1);
    expect(bundle).toMatch(/\.rpc\(\s*"connector_call"/);
    expect(bundle).not.toMatch(/\.from\(\s*["'`]/);
    for (const table of [
      'ghl_opportunities',
      'ghl_contacts',
      'ghl_notes',
      'ghl_writes',
      'ghl_sync_runs',
      'app_users',
      'audit_log',
      'memory_facts',
      'conversations',
      'api_usage',
      'connector_keys',
      'connector_key_secrets',
      'connector_calls',
    ]) {
      expect(bundle, table).not.toContain(table);
    }
  });

  it('holds nothing that can write to GoHighLevel: no client, no token, no address', () => {
    for (const absent of [
      'GHL_PRIVATE_INTEGRATION_TOKEN',
      'leadconnectorhq',
      'GHL_LOCATION_ID',
      'begin_ghl_write',
      'finish_ghl_write',
      'apply_ghl_snapshot',
      'begin_ghl_sync_run',
      'moveLead',
      'addNote',
      'runGhlSync',
    ]) {
      expect(bundle, absent).not.toContain(absent);
    }
    // It never opens a connection of its own to anywhere: its one way out is supabase-js.
    expect(bundle).not.toMatch(/\bfetch\(\s*["'`]https?:/);
  });

  it('holds no administrative capability: nothing that manages keys, users, spend, memory or the audit log', () => {
    for (const absent of [
      'issue_connector_key',
      'revoke_connector_key',
      'mintKey',
      'createStaffUser',
      'deactivateStaffUser',
      'setStaffAdmin',
      'resetStaffPassword',
      'auth.admin',
      'SPEND_CAP',
      'ANTHROPIC_API_KEY',
      'VOYAGE_API_KEY',
      'set_conversation_privacy',
    ]) {
      expect(bundle, absent).not.toContain(absent);
    }
  });

  it('the source agrees: only the terminal command imports key management', () => {
    const fn = read('src/functions/connector/index.ts');
    const lib = [
      'handler',
      'wiring',
      'store',
      'tools',
      'protocol',
      'auth',
      'keys',
      'config',
      'body',
    ]
      .map((name) => read(`src/lib/connector/${name}.ts`))
      .join('\n');
    expect(`${fn}\n${lib}`).not.toMatch(/from '\.\/keyAdmin\.js'|from '\.\/cli\.js'|keyAdmin\.js'/);
    expect(lib).not.toMatch(/from '\.\.\/(crm|memory|llm|voice|pages)\//);
    expect(lib).not.toMatch(/from '\.\.\/auth\/(admin|page|password|cli)\.js'/);
    expect(read('scripts/connector.ts')).toContain("from '../src/lib/connector/keyAdmin.js'");
    // The store's own types: one function, no tables at all.
    expect(read('src/lib/connector/store.ts')).toMatch(/Tables: \{ \[_ in never\]: never \};/);
  });

  it('the read function is declared to run as the signed-in role, and says so in the migration', () => {
    const sql = read('supabase/migrations/20261013010000_connector.sql');
    const reader = sql.slice(sql.indexOf('create or replace function public.connector_read('));
    const head = reader.slice(0, reader.indexOf('as $$'));
    expect(head).toMatch(/security invoker/);
    expect(head).toMatch(/set role = 'authenticated'/);
    // No statement in the whole migration writes to a mirror table.
    expect(sql).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+public\.ghl_/i);
    expect(sql).not.toMatch(/\bexecute\s+format|\bexecute\s+'/i);
  });
});

describe('no connector key is written down anywhere', () => {
  it('no key-shaped string in any tracked file', () => {
    const shape = /fcc_[a-hjkmnp-z2-9]{12}_[A-Za-z0-9_-]{43}/;
    const tracked = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    )
      .split('\0')
      .filter(
        (file) =>
          file !== '' &&
          !/\.(png|jpe?g|pdf|docx|xlsx?|xlsm|pptx|zip|bin|heic|ico|woff2?)$/i.test(file),
      );
    expect(tracked.length).toBeGreaterThan(200);
    const hits = tracked.filter((file) => {
      try {
        return shape.test(readFileSync(join(REPO_ROOT, file), 'utf8'));
      } catch {
        return false;
      }
    });
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// Database-backed
// ---------------------------------------------------------------------------------------

const env = loadSupabaseTestEnv();
const cfg = env ?? { dbUrl: 'postgresql://stack-not-running.invalid/postgres' };
const RUN = randomUUID().slice(0, 8);
/** The two seeded staff accounts (supabase/seed.sql): used only where rows must be committed. */
const ROSS = 'a0000000-0000-4000-8000-000000000001';
const DEV = 'a0000000-0000-4000-8000-000000000002';
const TABLES = ['connector_keys', 'connector_key_secrets', 'connector_calls'] as const;
const FUNCTIONS = [
  'connector_call',
  'connector_read',
  'connector_digest_equal',
  'issue_connector_key',
  'revoke_connector_key',
] as const;
const MIRROR = [
  'ghl_pipelines',
  'ghl_stages',
  'ghl_contacts',
  'ghl_opportunities',
  'ghl_custom_fields',
  'ghl_sync_runs',
  'ghl_notes',
  'ghl_writes',
  'ghl_field_map',
] as const;

const sha = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
/** Twelve symbols from the key-id alphabet, different on every call. */
function keyId(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(
    randomUUID().replace(/-/g, '').slice(0, 12),
    (hex) => alphabet[parseInt(hex, 16)] ?? 'a',
  ).join('');
}

interface Reply {
  outcome: string;
  reason?: string;
  key_id?: string;
  call_id?: string;
  window?: string;
  retry_after_seconds?: number;
  data?: Record<string, unknown> | null;
}

describe.skipIf(env === null)('the connector in the database (requires a running database)', () => {
  const db = new pg.Client({ connectionString: cfg.dbUrl });
  const FINANCE = `CONN-${RUN}-finance`;
  const OTHER = `CONN-${RUN}-other`;

  beforeAll(async () => {
    await db.connect();
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  /** Everything inside is undone: `work` runs in a transaction that is always rolled back. */
  async function rolledBack<T>(work: () => Promise<T>): Promise<T> {
    await db.query('begin');
    try {
      return await work();
    } finally {
      await db.query('rollback');
    }
  }

  /**
   * Run `work` as another role inside a savepoint. When it fails, the savepoint is rolled
   * back — which also gives the role back — and the failure is the one the caller sees.
   */
  async function inRole<T>(setup: () => Promise<void>, work: () => Promise<T>): Promise<T> {
    await db.query('savepoint in_role');
    try {
      await setup();
      const out = await work();
      await db.query('reset role');
      await db.query(`select set_config('request.jwt.claims', '', true)`);
      await db.query('release savepoint in_role');
      return out;
    } catch (caught: unknown) {
      await db.query('rollback to savepoint in_role');
      throw caught;
    }
  }

  /** A statement expected to fail, kept from taking the test's transaction down with it. */
  function guarded<T>(work: () => Promise<T>): Promise<T> {
    return inRole(() => Promise.resolve(), work);
  }

  /** As the function's own role, the way the Edge Function reaches the database. */
  function asService<T>(work: () => Promise<T>): Promise<T> {
    return inRole(async () => {
      await db.query('set local role service_role');
    }, work);
  }

  /** As a signed-in person's browser: the authenticated role, with their id as auth.uid(). */
  function asUser<T>(userId: string, work: () => Promise<T>): Promise<T> {
    return inRole(async () => {
      await db.query('set local role authenticated');
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ]);
    }, work);
  }

  async function user(label: string, active = true): Promise<string> {
    const id = randomUUID();
    const email = `conn-${label}-${RUN}-${id.slice(0, 6)}@example.com`;
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
    await db.query(
      `insert into public.app_users (user_id, email, role, is_active) values ($1, $2, 'staff', $3)`,
      [id, email, active],
    );
    return id;
  }

  async function issue(userId: string, secret: string): Promise<string> {
    const id = keyId();
    await db.query('select * from public.issue_connector_key($1, $2, $3, $4, null)', [
      userId,
      id,
      sha(secret),
      'test',
    ]);
    return id;
  }

  async function call(
    id: string,
    secret: string,
    tool: string | null,
    args: Record<string, unknown> = {},
    options: { pipeline?: string; method?: string; perMinute?: number; perDay?: number } = {},
  ): Promise<Reply> {
    return asService(async () => {
      const result = await db.query<{ reply: Reply }>(
        'select public.connector_call($1, $2, $3, $4, $5::jsonb, $6, $7, $8) as reply',
        [
          id,
          sha(secret),
          options.method ?? (tool === null ? 'tools/list' : 'tools/call'),
          tool,
          JSON.stringify(args),
          options.pipeline ?? FINANCE,
          options.perMinute ?? 30,
          options.perDay ?? 1_000,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('connector_call returned no row');
      return row.reply;
    });
  }

  /** A Finance pipeline with three leads, and the unrelated business's pipeline beside it. */
  async function seedPipelines(author: string): Promise<void> {
    await db.query(
      `insert into public.ghl_pipelines (ghl_id, name, location_id) values ($1, 'Finance Pipeline', 'loc'), ($2, 'Club Memberships', 'loc')`,
      [FINANCE, OTHER],
    );
    await db.query(
      `insert into public.ghl_stages (ghl_id, pipeline_ghl_id, name, position) values
         ($1, $3, 'New Lead', 0), ($2, $4, 'New Member', 0)`,
      [`${FINANCE}-new`, `${OTHER}-new`, FINANCE, OTHER],
    );
    await db.query(
      `insert into public.ghl_contacts (ghl_id, full_name, email, phone, content_hash) values
         ($1, 'Alex Finance', 'alex@example.com', '+61400000111', 'h'),
         ($2, 'Blake Finance', 'blake@example.com', '+61400000222', 'h'),
         ($3, 'Casey Clubmember', 'casey@example.com', '+61400000333', 'h')`,
      [`${FINANCE}-c1`, `${FINANCE}-c2`, `${OTHER}-c1`],
    );
    await db.query(
      `insert into public.ghl_opportunities
         (ghl_id, pipeline_ghl_id, stage_ghl_id, contact_ghl_id, name, status, ghl_created_at, content_hash) values
         ($1, $5, $7, $9,  'Finance one',   'open', now() - interval '1 day', 'h'),
         ($2, $5, $7, $10, 'Finance two',   'open', now() - interval '2 days', 'h'),
         ($3, $5, 'stage-nobody-listed', null, 'Finance three', 'open', null, 'h'),
         ($4, $6, $8, $11, 'Club membership', 'open', now(), 'h')`,
      [
        `${FINANCE}-o1`,
        `${FINANCE}-o2`,
        `${FINANCE}-o3`,
        `${OTHER}-o1`,
        FINANCE,
        OTHER,
        `${FINANCE}-new`,
        `${OTHER}-new`,
        `${FINANCE}-c1`,
        `${FINANCE}-c2`,
        `${OTHER}-c1`,
      ],
    );
    await db.query(
      `insert into public.ghl_sync_runs (pipeline_ghl_id, trigger, status, started_at, applied_at, finished_at) values
         ($1, 'test', 'success', now() - interval '5 minutes', now() - interval '5 minutes', now() - interval '5 minutes'),
         ($2, 'test', 'success', now(), now(), now())`,
      [FINANCE, OTHER],
    );
    await db.query(
      `insert into public.ghl_notes (ghl_id, contact_ghl_id, opportunity_ghl_id, author_user_id, body, ghl_date_added) values
         ($1, $3, $4, $5, 'A note on the finance lead.', now()),
         ($2, $6, $7, $5, 'A note on the club member.', now())`,
      [
        `${FINANCE}-n1`,
        `${OTHER}-n1`,
        `${FINANCE}-c1`,
        `${FINANCE}-o1`,
        author,
        `${OTHER}-c1`,
        `${OTHER}-o1`,
      ],
    );
  }

  const strip = (reply: Reply): unknown => {
    const data = { ...(reply.data ?? {}) } as Record<string, unknown>;
    const freshness = { ...(data['freshness'] as Record<string, unknown>) };
    delete freshness['read_at'];
    return { outcome: reply.outcome, data: { ...data, freshness } };
  };

  // -------------------------------------------------------------------------------------
  describe('the tables and the functions', () => {
    it('the three tables exist with row-level security enabled AND forced, and a policy each', async () => {
      const flags = await db.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select c.relname, c.relrowsecurity, c.relforcerowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = any($1) order by 1`,
        [[...TABLES]],
      );
      expect(flags.rows).toEqual([
        { relname: 'connector_calls', relrowsecurity: true, relforcerowsecurity: true },
        { relname: 'connector_key_secrets', relrowsecurity: true, relforcerowsecurity: true },
        { relname: 'connector_keys', relrowsecurity: true, relforcerowsecurity: true },
      ]);
      const policies = await db.query<{
        tablename: string;
        policyname: string;
        cmd: string;
        roles: string;
        qual: string;
      }>(
        `select tablename, policyname, cmd, roles::text, qual from pg_policies
         where schemaname = 'public' and tablename = any($1) order by 1`,
        [[...TABLES]],
      );
      const named = policies.rows.map((row) => ({
        tablename: row.tablename,
        policyname: row.policyname,
        cmd: row.cmd,
        roles: row.roles,
      }));
      expect(named).toEqual([
        {
          tablename: 'connector_calls',
          policyname: 'connector_calls_select_own',
          cmd: 'SELECT',
          roles: '{authenticated}',
        },
        {
          tablename: 'connector_key_secrets',
          policyname: 'connector_key_secrets_no_browser_read',
          cmd: 'SELECT',
          roles: '{authenticated}',
        },
        {
          tablename: 'connector_keys',
          policyname: 'connector_keys_select_own',
          cmd: 'SELECT',
          roles: '{authenticated}',
        },
      ]);
      // The digests' one policy admits nobody.
      expect(policies.rows.find((row) => row.tablename === 'connector_key_secrets')?.qual).toBe(
        'false',
      );
    });

    it('a signed-in browser holds SELECT and nothing that writes; anon holds nothing; row-level security does the rest', async () => {
      for (const table of TABLES) {
        for (const role of ['anon', 'authenticated']) {
          for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
            const result = await db.query<{ has: boolean }>(
              `select has_table_privilege($1, $2, $3) as has`,
              [role, `public.${table}`, privilege],
            );
            expect(result.rows[0]?.has, `${role} ${privilege} ${table}`).toBe(false);
          }
        }
        const anon = await db.query<{ has: boolean }>(
          `select has_any_column_privilege('anon', $1, 'SELECT') as has`,
          [`public.${table}`],
        );
        expect(anon.rows[0]?.has, `anon select ${table}`).toBe(false);
      }
      // The digest is not a column of the table a person can list at all.
      const columns = await db.query<{ column_name: string }>(
        `select column_name::text from information_schema.columns
         where table_schema = 'public' and table_name = 'connector_keys' order by 1`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'created_at',
        'created_by',
        'id',
        'key_id',
        'label',
        'last_used_at',
        'revoked_at',
        'revoked_by',
        'user_id',
      ]);
    });

    it('every connector function is executable by the server role and by no browser role', async () => {
      const acl = await db.query<{
        proname: string;
        anon: boolean;
        authenticated: boolean;
        service: boolean;
      }>(
        `select p.proname,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as service
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any($1) order by 1`,
        [[...FUNCTIONS]],
      );
      expect(acl.rows).toEqual(
        [...FUNCTIONS]
          .sort()
          .map((proname) => ({ proname, anon: false, authenticated: false, service: true })),
      );
    });

    it('the read function carries its role in the catalog, and no connector function is security definer', async () => {
      const rows = await db.query<{
        proname: string;
        prosecdef: boolean;
        proconfig: string[] | null;
      }>(
        `select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any($1) order by 1`,
        [[...FUNCTIONS]],
      );
      expect(rows.rows.every((row) => !row.prosecdef)).toBe(true);
      const reader = rows.rows.find((row) => row.proname === 'connector_read');
      expect(reader?.proconfig).toEqual(
        expect.arrayContaining([
          'role=authenticated',
          'request.jwt.claims=',
          'request.jwt.claim.sub=',
          'search_path=public',
        ]),
      );
      // The door itself keeps the server's role: it must, to check the key and count the call.
      expect(rows.rows.find((row) => row.proname === 'connector_call')?.proconfig).toEqual([
        'search_path=public',
      ]);
    });

    it('the signed-in role holds SELECT on the mirror and nothing that writes', async () => {
      for (const table of MIRROR) {
        for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          const result = await db.query<{ has: boolean }>(
            `select has_table_privilege('authenticated', $1, $2) as has`,
            [`public.${table}`, privilege],
          );
          expect(result.rows[0]?.has, `${privilege} ${table}`).toBe(false);
        }
      }
    });
  });

  // -------------------------------------------------------------------------------------
  describe('17 · a call without a live key reads nothing', () => {
    it.each(TOOL_NAMES)(
      '%s: an unknown key, a wrong secret, a revoked key and a deactivated user are all refused, and nothing is recorded',
      (tool) =>
        rolledBack(async () => {
          const staff = await user('auth');
          const left = await user('left');
          await seedPipelines(staff);
          const live = await issue(staff, 'live-secret');
          const revoked = await issue(staff, 'revoked-secret');
          const orphan = await issue(left, 'orphan-secret');
          await db.query('select * from public.revoke_connector_key(null, $1, null)', [revoked]);
          await db.query('update public.app_users set is_active = false where user_id = $1', [
            left,
          ]);
          const args =
            tool === 'get_lead'
              ? { lead_id: `${FINANCE}-o1` }
              : tool === 'search_leads'
                ? { query: 'finance' }
                : {};

          const refusals: (readonly [string, Reply])[] = [
            ['unknown_key', await call(keyId(), 'live-secret', tool, args)],
            ['wrong_secret', await call(live, 'not-the-secret', tool, args)],
            ['revoked', await call(revoked, 'revoked-secret', tool, args)],
            ['user_inactive', await call(orphan, 'orphan-secret', tool, args)],
          ];
          for (const [reason, reply] of refusals) {
            expect(reply.outcome, reason).toBe('unauthenticated');
            expect(reply.reason, reason).toBe(reason);
            expect(reply).not.toHaveProperty('data');
            expect(reply).not.toHaveProperty('call_id');
          }
          // Nothing was counted, and no key was marked as used.
          const recorded = await db.query<{ n: string }>(
            `select count(*) as n from public.connector_calls c join public.connector_keys k on k.id = c.connector_key_id
           where k.key_id = any($1)`,
            [[live, revoked, orphan]],
          );
          expect(recorded.rows[0]?.n).toBe('0');
          const used = await db.query<{ n: string }>(
            `select count(*) as n from public.connector_keys where key_id = any($1) and last_used_at is not null`,
            [[live, revoked, orphan]],
          );
          expect(used.rows[0]?.n).toBe('0');
          // The live key, with its own secret, is served: the refusals above were about the key.
          expect((await call(live, 'live-secret', tool, args)).outcome).toBe('ok');
        }),
    );

    it('two keys for one user, one revoked: the revoked one is dead on its very next request, the other lives on', () =>
      rolledBack(async () => {
        const staff = await user('two');
        await seedPipelines(staff);
        const first = await issue(staff, 'first');
        const second = await issue(staff, 'second');
        expect((await call(first, 'first', 'pipeline_summary')).outcome).toBe('ok');
        expect((await call(second, 'second', 'pipeline_summary')).outcome).toBe('ok');
        await db.query('select * from public.revoke_connector_key(null, $1, null)', [first]);
        expect(await call(first, 'first', 'pipeline_summary')).toMatchObject({
          outcome: 'unauthenticated',
          reason: 'revoked',
        });
        expect((await call(second, 'second', 'pipeline_summary')).outcome).toBe('ok');
      }));

    it('the digests are compared in a fixed 32 steps: right, wrong at the first byte, wrong at the last', async () => {
      const a = sha('one');
      const firstByte = Buffer.from(a);
      firstByte[0] = (firstByte[0] ?? 0) ^ 0xff;
      const lastByte = Buffer.from(a);
      lastByte[31] = (lastByte[31] ?? 0) ^ 0x01;
      const result = await db.query<{
        same: boolean;
        first: boolean;
        last: boolean;
        short: boolean;
        nul: boolean;
        other: boolean;
      }>(
        `select public.connector_digest_equal($1, $1) as same,
                public.connector_digest_equal($1, $2) as first,
                public.connector_digest_equal($1, $3) as last,
                public.connector_digest_equal($1, $4) as short,
                public.connector_digest_equal($1, null) as nul,
                public.connector_digest_equal($1, $5) as other`,
        [a, firstByte, lastByte, a.subarray(0, 31), sha('two')],
      );
      expect(result.rows[0]).toEqual({
        same: true,
        first: false,
        last: false,
        short: false,
        nul: false,
        other: false,
      });
      // No way out of the loop before its end: one loop, no exit, and the result is computed
      // only after it. A statistical timing test would prove less and fail at random.
      const source = await db.query<{ prosrc: string }>(
        `select prosrc from pg_proc where proname = 'connector_digest_equal'`,
      );
      const body = (source.rows[0]?.prosrc ?? '').toLowerCase();
      const loop = body.slice(body.indexOf('for i in 0..31 loop'), body.indexOf('end loop'));
      expect(loop).toContain('v_diff := v_diff | (get_byte(p_a, i) # get_byte(p_b, i))');
      expect(loop).not.toMatch(/\b(exit|return|continue|if)\b/);
      expect(body.match(/\bloop\b/g) ?? []).toHaveLength(2);
    });

    it('an unknown key id is compared against a dummy all the same, and an all-zero digest opens nothing', () =>
      rolledBack(async () => {
        const reply = await asService(async () => {
          const result = await db.query<{ reply: Reply }>(
            `select public.connector_call($1, decode(repeat('00', 32), 'hex'), 'tools/list', null, null, $2, 30, 1000) as reply`,
            [keyId(), FINANCE],
          );
          return result.rows[0]?.reply;
        });
        expect(reply).toEqual({ outcome: 'unauthenticated', reason: 'unknown_key' });
      }));
  });

  // -------------------------------------------------------------------------------------
  describe('18 · no tool can reach a pipeline other than the configured one', () => {
    it("get_lead: the other business's lead is not found — exactly as an id that never existed is not found", () =>
      rolledBack(async () => {
        const staff = await user('pipe');
        await seedPipelines(staff);
        const key = await issue(staff, 's');
        const foreign = await call(key, 's', 'get_lead', { lead_id: `${OTHER}-o1` });
        const never = await call(key, 's', 'get_lead', { lead_id: `CONN-${RUN}-no-such-lead` });
        expect(foreign.data).toMatchObject({ outcome: 'not_found', records: 0 });
        expect(foreign.data).not.toHaveProperty('lead');
        // The refusal cannot confirm the id exists: the two answers are the same answer.
        expect(strip(foreign)).toEqual(strip(never));
        // Asked with the OTHER pipeline configured, the same id IS found: the rows are there,
        // and the pipeline id is the only thing that kept them out.
        const configured = await call(
          key,
          's',
          'get_lead',
          { lead_id: `${OTHER}-o1` },
          { pipeline: OTHER },
        );
        expect((configured.data?.['lead'] as { lead_id: string }).lead_id).toBe(`${OTHER}-o1`);
      }));

    it('list_leads, search_leads and pipeline_summary return this pipeline’s rows and none of the other’s', () =>
      rolledBack(async () => {
        const staff = await user('pipe2');
        await seedPipelines(staff);
        const key = await issue(staff, 's');

        const list = await call(key, 's', 'list_leads', { status: 'any', limit: 50 });
        const ids = (list.data?.['leads'] as { lead_id: string }[]).map((lead) => lead.lead_id);
        expect(ids.sort()).toEqual([`${FINANCE}-o1`, `${FINANCE}-o2`, `${FINANCE}-o3`]);
        expect(list.data?.['total_matching']).toBe(3);
        // A row is these nine columns and no others: a list never carries a contact's details.
        const ROW_KEYS = [
          'created_at',
          'last_stage_change_at',
          'lead_id',
          'name',
          'stage_id',
          'stage_known',
          'stage_name',
          'stage_removed',
          'status',
        ];
        for (const row of list.data?.['leads'] as Record<string, unknown>[]) {
          expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
        }
        const found = await call(key, 's', 'search_leads', { query: 'alex@example.com' });
        for (const row of found.data?.['leads'] as Record<string, unknown>[]) {
          expect(Object.keys(row).sort()).toEqual([...ROW_KEYS, 'matched_on'].sort());
          expect(row['matched_on']).toEqual(['email']);
        }
        expect(JSON.stringify([list.data?.['leads'], found.data?.['leads']])).not.toMatch(
          /@example\.com|\+614/,
        );

        // Every way of naming the club member finds nothing: name, email, phone, opportunity.
        for (const query of [
          'Casey',
          'Clubmember',
          'casey@example.com',
          '0400 000 333',
          'Club membership',
          'member',
        ]) {
          const found = await call(key, 's', 'search_leads', { query });
          expect(found.data?.['total_matching'], query).toBe(0);
          expect(found.data?.['leads'], query).toEqual([]);
        }
        const mine = await call(key, 's', 'search_leads', { query: 'finance' });
        expect(mine.data?.['total_matching']).toBe(3);

        // Filtering by the other pipeline's stage id finds nothing and says the stage is not ours.
        const stage = await call(key, 's', 'list_leads', { stage_id: `${OTHER}-new` });
        expect(stage.data).toMatchObject({ total_matching: 0, leads: [], stage_exists: false });

        const summary = await call(key, 's', 'pipeline_summary');
        expect(summary.data?.['pipeline']).toEqual({ id: FINANCE, name: 'Finance Pipeline' });
        expect(summary.data?.['by_status']).toEqual({ open: 3 });
        expect((summary.data?.['stages'] as { stage_id: string }[]).map((s) => s.stage_id)).toEqual(
          [`${FINANCE}-new`],
        );
        const everything = JSON.stringify([list.data, mine.data, stage.data, summary.data]);
        for (const theirs of [OTHER, 'Casey', 'Club', 'casey@example.com', '+61400000333']) {
          expect(everything, theirs).not.toContain(theirs);
        }
      }));

    it('a note on the other pipeline’s lead cannot be reached through a lead of ours', () =>
      rolledBack(async () => {
        const staff = await user('pipe3');
        await seedPipelines(staff);
        const key = await issue(staff, 's');
        const lead = (await call(key, 's', 'get_lead', { lead_id: `${FINANCE}-o1` })).data?.[
          'lead'
        ] as {
          notes: { body: string }[];
          notes_total: number;
        };
        expect(lead.notes.map((note) => note.body)).toEqual(['A note on the finance lead.']);
        expect(lead.notes_total).toBe(1);
      }));

    it('a pipeline that has never been copied is said to be exactly that, and a removed lead is not found', () =>
      rolledBack(async () => {
        const staff = await user('pipe4');
        await seedPipelines(staff);
        const key = await issue(staff, 's');
        const unsynced = `CONN-${RUN}-never`;
        for (const tool of TOOL_NAMES) {
          const args =
            tool === 'get_lead'
              ? { lead_id: `${FINANCE}-o1` }
              : tool === 'search_leads'
                ? { query: 'finance' }
                : {};
          const reply = await call(key, 's', tool, args, { pipeline: unsynced });
          expect(reply.data, tool).toMatchObject({ outcome: 'never_synced', records: 0 });
          expect(reply.data).not.toHaveProperty('leads');
        }
        await db.query('update public.ghl_opportunities set removed_at = now() where ghl_id = $1', [
          `${FINANCE}-o2`,
        ]);
        expect((await call(key, 's', 'get_lead', { lead_id: `${FINANCE}-o2` })).data).toMatchObject(
          { outcome: 'not_found' },
        );
        // A lead whose stage the pipeline never listed is still listed, and says so.
        const odd = (await call(key, 's', 'list_leads', { status: 'any' })).data?.['leads'] as {
          lead_id: string;
          stage_known: boolean;
          stage_name: string | null;
        }[];
        expect(odd.find((lead) => lead.lead_id === `${FINANCE}-o3`)).toMatchObject({
          stage_known: false,
          stage_name: null,
        });
        const summary = await call(key, 's', 'pipeline_summary');
        expect(summary.data?.['unknown_stages']).toEqual([
          { stage_id: 'stage-nobody-listed', open_leads: 1 },
        ]);
      }));

    it('a search is a value to find, never a pattern: % and _ match themselves', () =>
      rolledBack(async () => {
        const staff = await user('like');
        await seedPipelines(staff);
        const key = await issue(staff, 's');
        for (const query of ['%%', '__', 'F%e', 'Finance _ne', "x' or '1'='1"]) {
          expect(
            (await call(key, 's', 'search_leads', { query })).data?.['total_matching'],
            query,
          ).toBe(0);
        }
        await db.query(
          `update public.ghl_opportunities set name = '100% offset_account' where ghl_id = $1`,
          [`${FINANCE}-o1`],
        );
        expect(
          (await call(key, 's', 'search_leads', { query: '100%' })).data?.['total_matching'],
        ).toBe(1);
        expect(
          (await call(key, 's', 'search_leads', { query: 'offset_acc' })).data?.['total_matching'],
        ).toBe(1);
      }));
  });

  // -------------------------------------------------------------------------------------
  describe("19 · no tool can read another user's data — a read happens as the key's own user", () => {
    it("each key's read is answered as its own user: the same note is 'yours' to one and not to the other", () =>
      rolledBack(async () => {
        const alice = await user('alice');
        const bob = await user('bob');
        await seedPipelines(alice);
        const aliceKey = await issue(alice, 'a');
        const bobKey = await issue(bob, 'b');
        const yours = async (key: string, secret: string): Promise<boolean[]> =>
          (
            (await call(key, secret, 'get_lead', { lead_id: `${FINANCE}-o1` })).data?.['lead'] as {
              notes: { yours: boolean }[];
            }
          ).notes.map((note) => note.yours);
        expect(await yours(aliceKey, 'a')).toEqual([true]);
        expect(await yours(bobKey, 'b')).toEqual([false]);
        // And each call is on record under its own user, never the other's.
        const recorded = await db.query<{ key_id: string; user_id: string }>(
          `select k.key_id, c.user_id from public.connector_calls c join public.connector_keys k on k.id = c.connector_key_id
           where k.key_id = any($1) order by 1`,
          [[aliceKey, bobKey]],
        );
        expect(new Set(recorded.rows.map((row) => `${row.key_id}:${row.user_id}`))).toEqual(
          new Set([`${aliceKey}:${alice}`, `${bobKey}:${bob}`]),
        );
      }));

    it('the mirror’s row-level security decides: a policy that narrows what a user may see narrows what their key reads', () =>
      rolledBack(async () => {
        const alice = await user('rls-a');
        const bob = await user('rls-b');
        await seedPipelines(alice);
        await db.query(
          `insert into public.ghl_notes (ghl_id, contact_ghl_id, opportunity_ghl_id, author_user_id, body, ghl_date_added)
           values ($1, $2, $3, $4, 'Written by Bob.', now())`,
          [`${FINANCE}-n-bob`, `${FINANCE}-c1`, `${FINANCE}-o1`, bob],
        );
        const aliceKey = await issue(alice, 'a');
        const bobKey = await issue(bob, 'b');
        const bodies = async (key: string, secret: string): Promise<string[]> =>
          (
            (await call(key, secret, 'get_lead', { lead_id: `${FINANCE}-o1` })).data?.['lead'] as {
              notes: { body: string }[];
            }
          ).notes
            .map((note) => note.body)
            .sort();
        // Today's policy: every active member of staff reads every note.
        expect(await bodies(aliceKey, 'a')).toEqual([
          'A note on the finance lead.',
          'Written by Bob.',
        ]);
        // A stricter policy, added for this transaction only: a person reads their own notes.
        // Nothing in the connector changes — and each key now reads only its own user's.
        await db.query(
          `create policy conn_test_own_notes on public.ghl_notes as restrictive for select to authenticated
             using (author_user_id = (select auth.uid()))`,
        );
        expect(await bodies(aliceKey, 'a')).toEqual(['A note on the finance lead.']);
        expect(await bodies(bobKey, 'b')).toEqual(['Written by Bob.']);
      }));

    it('a user who is not active staff reads nothing, even if the key check were not there', () =>
      rolledBack(async () => {
        const staff = await user('direct');
        const inactive = await user('inactive', false);
        await seedPipelines(staff);
        // Straight to the read function, past the door, as the server: it refuses by itself.
        for (const who of [inactive, randomUUID()]) {
          await expect(
            asService(() =>
              db.query('select public.connector_read($1, $2, $3, $4::jsonb)', [
                who,
                FINANCE,
                'list_leads',
                '{}',
              ]),
            ),
          ).rejects.toMatchObject({ code: '42501' });
        }
        const active = await asService(() =>
          db.query<{ reply: { outcome: string } }>(
            'select public.connector_read($1, $2, $3, $4::jsonb) as reply',
            [staff, FINANCE, 'pipeline_summary', '{}'],
          ),
        );
        expect(active.rows[0]?.reply.outcome).toBe('ok');
        // The identity it took on is gone again when it returns.
        const after = await db.query<{ who: string; claims: string | null }>(
          `select current_user as who, nullif(current_setting('request.jwt.claims', true), '') as claims`,
        );
        expect(after.rows[0]?.claims).toBeNull();
      }));

    it("a signed-in person sees their own keys and calls, never another's — and never a digest", () =>
      rolledBack(async () => {
        const alice = await user('own-a');
        const bob = await user('own-b');
        await seedPipelines(alice);
        const aliceKey = await issue(alice, 'a');
        const bobKey = await issue(bob, 'b');
        await call(aliceKey, 'a', 'pipeline_summary');
        await call(bobKey, 'b', 'pipeline_summary');

        const as = asUser;
        const keys = await as(alice, () =>
          db.query<{ key_id: string }>(
            `select key_id from public.connector_keys where key_id = any($1)`,
            [[aliceKey, bobKey]],
          ),
        );
        expect(keys.rows.map((row) => row.key_id)).toEqual([aliceKey]);
        const calls = await as(alice, () =>
          db.query<{ user_id: string }>(
            `select c.user_id from public.connector_calls c where c.user_id = any($1)`,
            [[alice, bob]],
          ),
        );
        expect(new Set(calls.rows.map((row) => row.user_id))).toEqual(new Set([alice]));
        // Her own key's digest is in the database — and not for her: zero rows, by policy.
        const present = await db.query<{ n: string }>(
          `select count(*) as n from public.connector_key_secrets x join public.connector_keys k on k.id = x.connector_key_id
           where k.key_id = $1`,
          [aliceKey],
        );
        expect(present.rows[0]?.n).toBe('1');
        const digests = await as(alice, () =>
          db.query('select * from public.connector_key_secrets'),
        );
        expect(digests.rows).toEqual([]);
        for (const statement of [
          `update public.connector_key_secrets set key_hash = key_hash`,
          `delete from public.connector_key_secrets`,
          `update public.connector_keys set revoked_at = null`,
          `delete from public.connector_calls`,
          `insert into public.connector_calls (connector_key_id, user_id, method) select id, user_id, 'ping' from public.connector_keys`,
        ]) {
          await expect(
            as(alice, () => db.query(statement)),
            statement,
          ).rejects.toMatchObject({ code: '42501' });
        }
        // And the functions themselves are not theirs to call.
        for (const statement of [
          `select public.connector_read('${bob}', '${FINANCE}', 'list_leads', '{}'::jsonb)`,
          `select public.connector_call('${bobKey}', '\\x00', 'tools/list', null, null, '${FINANCE}', 30, 1000)`,
          `select * from public.issue_connector_key('${alice}', 'aaaaaaaaaaaa', '\\x00', 'x', null)`,
          `select * from public.revoke_connector_key(null, '${bobKey}', null)`,
        ]) {
          await expect(
            as(alice, () => db.query(statement)),
            statement,
          ).rejects.toMatchObject({ code: '42501' });
        }
      }));
  });

  // -------------------------------------------------------------------------------------
  describe('reading only — a write is impossible, not merely absent', () => {
    it('the role every read runs as cannot change a row of the mirror', () =>
      rolledBack(async () => {
        const staff = await user('write');
        await seedPipelines(staff);
        const visible = await asUser(staff, () =>
          db.query(`select 1 from public.ghl_opportunities where ghl_id = $1`, [`${FINANCE}-o1`]),
        );
        expect(visible.rows).toHaveLength(1);
        for (const statement of [
          `update public.ghl_opportunities set stage_ghl_id = 'moved' where ghl_id = '${FINANCE}-o1'`,
          `delete from public.ghl_opportunities where ghl_id = '${FINANCE}-o1'`,
          `insert into public.ghl_notes (ghl_id, contact_ghl_id, opportunity_ghl_id, body) values ('x', 'x', 'x', 'x')`,
          `update public.ghl_contacts set email = 'changed@example.com'`,
          `update public.ghl_sync_runs set status = 'failed'`,
          `truncate public.ghl_notes`,
        ]) {
          await expect(
            asUser(staff, () => db.query(statement)),
            statement,
          ).rejects.toMatchObject({ code: '42501' });
        }
      }));

    it('a tool call leaves every mirror row exactly as it was', () =>
      rolledBack(async () => {
        const staff = await user('still');
        await seedPipelines(staff);
        const key = await issue(staff, 's');
        const fingerprint = async (): Promise<string> => {
          const rows = await db.query<{ f: string }>(
            `select md5(string_agg(t.tableoid::regclass::text || ':' || t.ctid::text || ':' || t.xmin::text, ',' order by 1)) as f from (
               select tableoid, ctid, xmin from public.ghl_opportunities where pipeline_ghl_id = any($1)
               union all select tableoid, ctid, xmin from public.ghl_contacts where ghl_id like $2
               union all select tableoid, ctid, xmin from public.ghl_notes where ghl_id like $2
               union all select tableoid, ctid, xmin from public.ghl_stages where pipeline_ghl_id = any($1)
               union all select tableoid, ctid, xmin from public.ghl_sync_runs where pipeline_ghl_id = any($1)
             ) t`,
            [[FINANCE, OTHER], `CONN-${RUN}%`],
          );
          return rows.rows[0]?.f ?? '';
        };
        const before = await fingerprint();
        await call(key, 's', 'pipeline_summary');
        await call(key, 's', 'list_leads', { status: 'any' });
        await call(key, 's', 'get_lead', { lead_id: `${FINANCE}-o1` });
        await call(key, 's', 'search_leads', { query: 'finance' });
        expect(await fingerprint()).toBe(before);
      }));
  });

  // -------------------------------------------------------------------------------------
  describe('the rate limit', () => {
    it('the limit reached: refused with how long to wait, and the refusal is not itself counted', () =>
      rolledBack(async () => {
        const staff = await user('rate');
        await seedPipelines(staff);
        const key = await issue(staff, 's');
        for (let i = 0; i < 3; i += 1) {
          expect((await call(key, 's', 'pipeline_summary', {}, { perMinute: 3 })).outcome).toBe(
            'ok',
          );
        }
        for (let i = 0; i < 5; i += 1) {
          const refused = await call(key, 's', 'pipeline_summary', {}, { perMinute: 3 });
          expect(refused).toMatchObject({ outcome: 'rate_limited', window: 'minute', key_id: key });
          expect(refused.retry_after_seconds).toBeGreaterThanOrEqual(1);
          expect(refused.retry_after_seconds).toBeLessThanOrEqual(60);
          expect(refused).not.toHaveProperty('data');
        }
        const counted = await db.query<{ n: string }>(
          `select count(*) as n from public.connector_calls c join public.connector_keys k on k.id = c.connector_key_id where k.key_id = $1`,
          [key],
        );
        expect(counted.rows[0]?.n).toBe('3');
        // The handshake counts too: it is a request like any other.
        expect(
          (await call(key, 's', null, {}, { method: 'initialize', perMinute: 3 })).outcome,
        ).toBe('rate_limited');
        // Another key is not slowed by this one — even the same person's.
        const other = await issue(staff, 't');
        expect((await call(other, 't', 'pipeline_summary', {}, { perMinute: 3 })).outcome).toBe(
          'ok',
        );
      }));

    it('the day’s limit is its own window, and says so', () =>
      rolledBack(async () => {
        const staff = await user('day');
        await seedPipelines(staff);
        const key = await issue(staff, 's');
        await db.query(
          `insert into public.connector_calls (connector_key_id, user_id, method, created_at)
           select k.id, k.user_id, 'tools/list', now() - interval '3 hours' from public.connector_keys k, generate_series(1, 4)
           where k.key_id = $1`,
          [key],
        );
        const refused = await call(key, 's', 'pipeline_summary', {}, { perDay: 4 });
        expect(refused).toMatchObject({ outcome: 'rate_limited', window: 'day' });
        expect(refused.retry_after_seconds).toBeGreaterThan(20 * 3600);
        expect(refused.retry_after_seconds).toBeLessThanOrEqual(21 * 3600);
        expect((await call(key, 's', 'pipeline_summary', {}, { perDay: 5 })).outcome).toBe('ok');
      }));

    it('limits that are not positive are refused outright', () =>
      rolledBack(async () => {
        const staff = await user('zero');
        const key = await issue(staff, 's');
        for (const options of [{ perMinute: 0 }, { perDay: 0 }, { perMinute: -1 }]) {
          await expect(call(key, 's', 'pipeline_summary', {}, options)).rejects.toMatchObject({
            code: '22023',
          });
        }
      }));
  });

  // -------------------------------------------------------------------------------------
  describe('what is recorded', () => {
    it('ids, counts and a word from a fixed list — never the caller’s own text', () =>
      rolledBack(async () => {
        const staff = await user('ledger');
        await seedPipelines(staff);
        const key = await issue(staff, 's');
        await call(key, 's', 'get_lead', { lead_id: `${FINANCE}-o1` });
        await call(key, 's', 'get_lead', { lead_id: `CONN-${RUN}-none` });
        await call(key, 's', 'search_leads', { query: 'Alex Finance 0400 000 111' });
        await call(key, 's', 'not_a_tool', { anything: 'at all' });
        await call(key, 's', null, {}, { method: 'resources/list; drop table x' });
        await call(key, 's', null, {}, { method: 'invalid' });
        const rows = await db.query<{
          method: string;
          tool: string | null;
          subject_id: string | null;
          outcome: string;
          records: number | null;
        }>(
          `select c.method, c.tool, c.subject_id, c.outcome, c.records
           from public.connector_calls c join public.connector_keys k on k.id = c.connector_key_id
           where k.key_id = $1 order by c.created_at`,
          [key],
        );
        expect(rows.rows).toEqual([
          {
            method: 'tools/call',
            tool: 'get_lead',
            subject_id: `${FINANCE}-o1`,
            outcome: 'ok',
            records: 1,
          },
          {
            method: 'tools/call',
            tool: 'get_lead',
            subject_id: `CONN-${RUN}-none`,
            outcome: 'not_found',
            records: 0,
          },
          {
            method: 'tools/call',
            tool: 'search_leads',
            subject_id: null,
            outcome: 'ok',
            records: 1,
          },
          { method: 'tools/call', tool: null, subject_id: null, outcome: 'ok', records: null },
          { method: 'other', tool: null, subject_id: null, outcome: 'ok', records: null },
          { method: 'invalid', tool: null, subject_id: null, outcome: 'ok', records: null },
        ]);
        const text = JSON.stringify(
          (
            await db.query(
              `select to_jsonb(c) as row from public.connector_calls c where c.user_id = $1`,
              [staff],
            )
          ).rows,
        );
        for (const absent of ['Alex', '0400', 'alex@example.com', 'drop table', 'anything']) {
          expect(text, absent).not.toContain(absent);
        }
        const used = await db.query<{ last_used_at: Date | null }>(
          `select last_used_at from public.connector_keys where key_id = $1`,
          [key],
        );
        expect(used.rows[0]?.last_used_at).not.toBeNull();
      }));

    it('a read that fails is recorded as failed, counted, and tells the caller nothing but that', () =>
      rolledBack(async () => {
        const staff = await user('fail');
        await seedPipelines(staff);
        const key = await issue(staff, 's');
        // A limit that is not a number reaches the read only if the code above it is wrong;
        // the read then fails inside its own savepoint, and the door still answers.
        const reply = await call(key, 's', 'list_leads', { limit: 'lots' });
        expect(reply).toMatchObject({ outcome: 'read_failed', key_id: key });
        expect(Object.keys(reply.data ?? {})).toEqual(['sqlstate']);
        const row = await db.query<{ outcome: string }>(
          `select c.outcome from public.connector_calls c where c.id = $1`,
          [reply.call_id],
        );
        expect(row.rows[0]?.outcome).toBe('read_failed');
      }));

    it('rows older than thirty days go when the same key next calls; another key’s are left alone', () =>
      rolledBack(async () => {
        const staff = await user('prune');
        await seedPipelines(staff);
        const key = await issue(staff, 's');
        const other = await issue(staff, 't');
        await db.query(
          `insert into public.connector_calls (connector_key_id, user_id, method, created_at)
           select k.id, k.user_id, 'ping', now() - interval '31 days' from public.connector_keys k where k.key_id = any($1)`,
          [[key, other]],
        );
        await call(key, 's', 'pipeline_summary');
        const left = await db.query<{ key_id: string; n: string }>(
          `select k.key_id, count(*) as n from public.connector_calls c join public.connector_keys k on k.id = c.connector_key_id
           where k.key_id = any($1) and c.created_at < now() - interval '30 days' group by 1`,
          [[key, other]],
        );
        expect(left.rows).toEqual([{ key_id: other, n: '1' }]);
      }));
  });

  // -------------------------------------------------------------------------------------
  describe('issuing and revoking', () => {
    it('only for active staff, five live keys at most, and the same key issued twice is one key', () =>
      rolledBack(async () => {
        const staff = await user('issue');
        const inactive = await user('issue-off', false);
        const id = keyId();
        const first = await db.query<{ id: string }>(
          'select * from public.issue_connector_key($1, $2, $3, $4, null)',
          [staff, id, sha('k'), ' Grok '],
        );
        const again = await db.query<{ id: string }>(
          'select * from public.issue_connector_key($1, $2, $3, $4, null)',
          [staff, id, sha('k'), 'Grok'],
        );
        expect(again.rows[0]?.id).toBe(first.rows[0]?.id);
        const stored = await db.query<{ label: string; n: string }>(
          `select label, (select count(*) from public.connector_keys where key_id = $1) as n from public.connector_keys where key_id = $1`,
          [id],
        );
        expect(stored.rows[0]).toEqual({ label: 'Grok', n: '1' });

        const refusals: (readonly [string, unknown[]])[] = [
          ['CK001', [inactive, keyId(), sha('x'), '', null]],
          ['CK001', [randomUUID(), keyId(), sha('x'), '', null]],
          ['CK003', [staff, id, sha('a-different-key'), '', null]],
        ];
        for (const [code, params] of refusals) {
          await expect(
            guarded(() =>
              db.query('select * from public.issue_connector_key($1, $2, $3, $4, $5)', params),
            ),
            code,
          ).rejects.toMatchObject({ code });
        }
        for (let i = 0; i < 4; i += 1) await issue(staff, `more-${String(i)}`);
        await expect(guarded(() => issue(staff, 'sixth'))).rejects.toMatchObject({ code: 'CK002' });
        // A revoked key no longer counts against the five.
        await db.query('select * from public.revoke_connector_key(null, $1, null)', [id]);
        await issue(staff, 'sixth');
      }));

    it('revoking is idempotent, scoped to its owner when an owner is given, and both are audited by id', () =>
      rolledBack(async () => {
        const alice = await user('rev-a');
        const bob = await user('rev-b');
        const key = await issue(alice, 's');
        // Bob, through a settings screen one day, cannot revoke Alice's key.
        expect(
          (await db.query('select * from public.revoke_connector_key($1, $2, $1)', [bob, key]))
            .rows,
        ).toEqual([]);
        const first = await db.query<{ already: boolean; revoked_at: Date }>(
          'select * from public.revoke_connector_key($1, $2, $1)',
          [alice, key],
        );
        const second = await db.query<{ already: boolean; revoked_at: Date }>(
          'select * from public.revoke_connector_key(null, $1, null)',
          [key],
        );
        expect(first.rows[0]?.already).toBe(false);
        expect(second.rows[0]?.already).toBe(true);
        expect(second.rows[0]?.revoked_at).toEqual(first.rows[0]?.revoked_at);
        expect(
          (await db.query('select * from public.revoke_connector_key(null, $1, null)', [keyId()]))
            .rows,
        ).toEqual([]);
        const audit = await db.query<{
          action: string;
          actor: string;
          after: Record<string, string>;
        }>(
          `select a.action, a.actor, a.after from public.audit_log a
           where a.entity_type = 'connector_keys' and a.after ->> 'key_id' = $1 order by a.created_at`,
          [key],
        );
        expect(audit.rows).toEqual([
          {
            action: 'CONNECTOR_KEY_ISSUED',
            actor: 'terminal',
            after: { key_id: key, user_id: alice },
          },
          { action: 'CONNECTOR_KEY_REVOKED', actor: alice, after: { key_id: key, user_id: alice } },
        ]);
      }));

    it('what is stored is 32 bytes and nothing that could be turned back into a key', () =>
      rolledBack(async () => {
        const staff = await user('at-rest');
        const key = await issue(staff, 'the-secret-part');
        const row = await db.query<{ len: number; hash: Buffer; row: string }>(
          `select octet_length(x.key_hash) as len, x.key_hash as hash, to_jsonb(k)::text || to_jsonb(x)::text as row
           from public.connector_keys k join public.connector_key_secrets x on x.connector_key_id = k.id where k.key_id = $1`,
          [key],
        );
        expect(row.rows[0]?.len).toBe(32);
        expect(row.rows[0]?.hash.equals(sha('the-secret-part'))).toBe(true);
        expect(row.rows[0]?.row).not.toContain('the-secret-part');
        await expect(
          guarded(() =>
            db.query('select * from public.issue_connector_key($1, $2, $3, $4, null)', [
              staff,
              keyId(),
              Buffer.from('short'),
              '',
            ]),
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }));
  });

  // -------------------------------------------------------------------------------------
  describe('the run — rows committed, then removed', () => {
    const keys: string[] = [];
    const PIPE = `CONN-${RUN}-run`;

    beforeAll(async () => {
      await db.query(
        `insert into public.ghl_pipelines (ghl_id, name, location_id) values ($1, 'Run pipeline', 'loc')`,
        [PIPE],
      );
      await db.query(
        `insert into public.ghl_sync_runs (pipeline_ghl_id, trigger, status, started_at, applied_at, finished_at)
         values ($1, 'test', 'success', now(), now(), now())`,
        [PIPE],
      );
      for (const [owner, secret] of [
        [ROSS, 'run-ross'],
        [DEV, 'run-dev'],
      ] as const) {
        const id = keyId();
        await db.query('select * from public.issue_connector_key($1, $2, $3, $4, null)', [
          owner,
          id,
          sha(secret),
          `test ${RUN}`,
        ]);
        keys.push(id);
      }
    }, 30_000);

    afterAll(async () => {
      await db.query(
        `delete from public.audit_log where entity_type = 'connector_keys' and after ->> 'key_id' = any($1)`,
        [keys],
      );
      await db.query(`delete from public.connector_keys where key_id = any($1)`, [keys]);
      await db.query(`delete from public.ghl_sync_runs where pipeline_ghl_id = $1`, [PIPE]);
      await db.query(`delete from public.ghl_pipelines where ghl_id = $1`, [PIPE]);
    });

    /** One call on a connection of its own, committed: how real requests arrive. */
    async function committed(id: string, secret: string, perMinute: number): Promise<Reply> {
      const client = new pg.Client({ connectionString: cfg.dbUrl });
      await client.connect();
      try {
        await client.query('begin');
        await client.query('set local role service_role');
        const result = await client.query<{ reply: Reply }>(
          `select public.connector_call($1, $2, 'tools/call', 'pipeline_summary', '{}'::jsonb, $3, $4, 100000) as reply`,
          [id, sha(secret), PIPE, perMinute],
        );
        await client.query('commit');
        const row = result.rows[0];
        if (row === undefined) throw new Error('no reply');
        return row.reply;
      } finally {
        await client.end();
      }
    }

    it('many calls at once on one key: exactly the limit are let through, however they interleave', async () => {
      const [ross] = keys;
      if (ross === undefined) throw new Error('no key');
      const replies = await Promise.all(
        Array.from({ length: 12 }, () => committed(ross, 'run-ross', 5)),
      );
      // Not a race to be won: the count is taken under a lock, so the split is 5 and 7 always.
      expect(replies.filter((reply) => reply.outcome === 'ok')).toHaveLength(5);
      expect(replies.filter((reply) => reply.outcome === 'rate_limited')).toHaveLength(7);
      const counted = await db.query<{ n: string }>(
        `select count(*) as n from public.connector_calls c join public.connector_keys k on k.id = c.connector_key_id where k.key_id = $1`,
        [ross],
      );
      expect(counted.rows[0]?.n).toBe('5');
    }, 60_000);

    it('two keys used at once by different users: each is counted and recorded as its own', async () => {
      const [ross, dev] = keys;
      if (ross === undefined || dev === undefined) throw new Error('no keys');
      const replies = await Promise.all(
        Array.from({ length: 8 }, (_unused, i) =>
          i % 2 === 0 ? committed(dev, 'run-dev', 4) : committed(ross, 'run-ross', 5),
        ),
      );
      // Ross's key is already at its limit from the test above; the developer's has its own.
      expect(
        replies
          .filter((_unused, i) => i % 2 === 1)
          .every((reply) => reply.outcome === 'rate_limited'),
      ).toBe(true);
      expect(replies.filter((_unused, i) => i % 2 === 0).map((reply) => reply.outcome)).toEqual([
        'ok',
        'ok',
        'ok',
        'ok',
      ]);
      const owners = await db.query<{ key_id: string; user_id: string; n: string }>(
        `select k.key_id, c.user_id, count(*) as n from public.connector_calls c
         join public.connector_keys k on k.id = c.connector_key_id where k.key_id = any($1) group by 1, 2 order by 1`,
        [keys],
      );
      expect(owners.rows.sort((a, b) => a.user_id.localeCompare(b.user_id))).toEqual([
        { key_id: ross, user_id: ROSS, n: '5' },
        { key_id: dev, user_id: DEV, n: '4' },
      ]);
    }, 60_000);
  });
});
