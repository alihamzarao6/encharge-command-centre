/**
 * The Users page against a real Supabase stack (Stage 3 part 4, FND-330) — the production
 * code path (`handleUsersRequest` over `createAdminDeps`), no substitutions at all: this
 * endpoint talks to GoTrue and Postgres and to nothing else, so there is nothing to script
 * and no money to spend.
 *
 * Part C, database half. Each `it` is one of its numbered assertions:
 *
 *   1. an admin creates a user FROM THE ENDPOINT; that user signs in and reads workspace
 *      memory — the whole promise, end to end;
 *   2. the generated password is in the one response body and in no table, no audit row and
 *      no log line, checked against the real database rather than a fake;
 *   3. a non-admin is refused by the SERVER for every action, and nothing moves;
 *   4. the workspace cannot reach zero administrators — including when two admins demote
 *      each other AT THE SAME TIME, which is the case the advisory lock exists for and the
 *      only one the application check alone cannot hold;
 *   5. a deactivated user is refused at the database, and their memory contributions survive;
 *   8. every action lands in audit_log with the right actor.
 *
 * Every fixture is synthetic (example.com addresses, run-scoped) and removed afterwards.
 * Counts are scoped to this run's users, never to a whole table.
 */
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SEEDED_STAFF, type AdminDeps } from '../../src/lib/auth/admin.js';
import {
  createAdminDeps,
  signInWithPassword,
  type SupabaseAuthConfig,
} from '../../src/lib/auth/clients.js';
import {
  handleUsersRequest,
  type UsersPageDeps,
  type UsersPageResult,
  type UsersRequestBody,
} from '../../src/lib/auth/page.js';
import { createLogger } from '../../src/lib/logger.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);

const cfg: SupabaseAuthConfig = {
  url: env?.url ?? 'http://stack-not-running.invalid',
  anonKey: env?.anonKey ?? 'unset',
  serviceRoleKey: env?.serviceRoleKey ?? 'unset',
};

function userClient(token: string) {
  return createClient(cfg.url, cfg.anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function body(result: UsersPageResult): Record<string, unknown> {
  return result.body as unknown as Record<string, unknown>;
}

describe.skipIf(env === null)('the users page (requires a running Supabase stack)', () => {
  const db = new pg.Client({
    connectionString: env?.dbUrl ?? 'postgresql://stack-not-running.invalid/postgres',
  });
  const logLines: string[] = [];
  let deps: UsersPageDeps;

  // The developer's seeded account is the admin doing the administering.
  let adminToken = '';
  const passwords: string[] = [];

  // Two synthetic people, created through the endpoint itself.
  const staffEmail = `users-staff-${RUN}@example.com`;
  const secondEmail = `users-second-${RUN}@example.com`;
  let staffId = '';
  let secondId = '';
  let staffToken = '';
  const createdIds: string[] = [];

  let workspaceConvId = '';
  let staffFactId = '';

  async function post(request: UsersRequestBody, token = adminToken): Promise<UsersPageResult> {
    return handleUsersRequest(deps, { token, body: request });
  }

  beforeAll(async () => {
    await db.connect();
    const log = createLogger({
      level: 'debug',
      sink: (line) => {
        logLines.push(line);
      },
    });
    const admin: AdminDeps = createAdminDeps(cfg, log);
    deps = { ...admin, log };

    // Credentials for the seeded developer account (an admin by seed.sql), the same way the
    // bootstrap CLI does it, so this suite has an admin session to act with.
    const bootstrapPassword = `Bootstrap-${crypto.randomUUID()}`;
    const set = await deps.authAdmin.setPassword(SEEDED_STAFF.developer.userId, bootstrapPassword);
    expect(set.ok).toBe(true);
    const session = await signInWithPassword(cfg, SEEDED_STAFF.developer.email, bootstrapPassword);
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    adminToken = session.value.accessToken;

    // A workspace conversation and a workspace fact for the "their contributions survive"
    // assertion, authored by the seeded owner rather than by anyone this suite deactivates.
    const conv = await db.query<{ id: string }>(
      `insert into public.conversations (user_id, scope, title)
       values ($1, 'workspace', $2) returning id`,
      [SEEDED_STAFF.ross.userId, `users-ws-conv-${RUN}`],
    );
    workspaceConvId = conv.rows[0]?.id ?? '';
  }, 120_000);

  afterAll(async () => {
    await db.query(`delete from public.memory_facts where key = $1`, [`process:users-${RUN}`]);
    await db.query(`delete from public.conversations where title like $1`, [`users-%-${RUN}`]);
    if (createdIds.length > 0) {
      await db.query(`delete from public.audit_log where entity_id = any($1::uuid[])`, [
        createdIds,
      ]);
      await db.query(`delete from public.app_users where user_id = any($1::uuid[])`, [createdIds]);
      await db.query(`delete from auth.users where id = any($1::uuid[])`, [createdIds]);
    }
    await db.end();
  }, 120_000);

  it('1. an admin creates a user from the page; that user signs in and reads workspace memory', async () => {
    const created = await post({ action: 'create', email: staffEmail });
    expect(created.status).toBe(200);
    const reply = body(created);
    staffId = String(reply['userId']);
    createdIds.push(staffId);
    const password = String(reply['oneTimePassword']);
    passwords.push(password);
    expect(password.length).toBe(24);

    const session = await signInWithPassword(cfg, staffEmail, password);
    expect(session.ok, 'the password handed over actually works').toBe(true);
    if (!session.ok) return;
    staffToken = session.value.accessToken;

    // The whole point of adding someone: they can see what the business has taught it.
    const asStaff = userClient(staffToken);
    const conversations = await asStaff
      .from('conversations')
      .select('id')
      .eq('id', workspaceConvId);
    expect(conversations.error).toBeNull();
    expect(conversations.data).toHaveLength(1);

    // And, since part 4, who their colleagues are — the roster read the page is built on.
    const roster = await asStaff.from('app_users').select('user_id, email');
    expect(roster.error).toBeNull();
    expect((roster.data ?? []).length).toBeGreaterThan(1);

    // 8: one audit row, naming the admin who asked, not the role the write used.
    const audit = await db.query<{ actor: string }>(
      `select actor from public.audit_log where action = 'USER_CREATED' and entity_id = $1`,
      [staffId],
    );
    expect(audit.rows).toStrictEqual([{ actor: SEEDED_STAFF.developer.email }]);
  }, 120_000);

  it('2. the generated password is in no table, no audit row and no log line', async () => {
    expect(passwords.length).toBeGreaterThan(0);
    for (const password of passwords) {
      // Every text-ish column of every public table, from the catalog — not a hand-written
      // list, so a table added later is searched too.
      const columns = await db.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name
         from information_schema.columns
         where table_schema = 'public' and data_type in ('text', 'character varying', 'jsonb')`,
      );
      for (const { table_name, column_name } of columns.rows) {
        const found = await db.query<{ n: string }>(
          `select count(*) as n from public.${table_name} where ${column_name}::text like $1`,
          [`%${password}%`],
        );
        expect(found.rows[0]?.n, `${table_name}.${column_name}`).toBe('0');
      }
      for (const line of logLines) expect(line).not.toContain(password);
    }
  }, 180_000);

  it('3. a non-admin is refused by the server for every action, and nothing moves', async () => {
    expect(staffToken).not.toBe('');
    const attempts: readonly UsersRequestBody[] = [
      { action: 'create', email: `users-sneak-${RUN}@example.com` },
      { action: 'deactivate', userId: SEEDED_STAFF.ross.userId },
      { action: 'reactivate', userId: SEEDED_STAFF.ross.userId },
      { action: 'promote', userId: staffId },
      { action: 'demote', userId: SEEDED_STAFF.ross.userId },
      { action: 'reset_password', userId: SEEDED_STAFF.ross.userId },
      { action: 'sign_ins' },
    ];
    for (const request of attempts) {
      const result = await post(request, staffToken);
      expect(result.status, String(request.action)).toBe(403);
    }

    const minted = await db.query<{ n: string }>(
      `select count(*) as n from auth.users where email = $1`,
      [`users-sneak-${RUN}@example.com`],
    );
    expect(minted.rows[0]?.n).toBe('0');
    const unchanged = await db.query<{ is_admin: boolean; is_active: boolean }>(
      `select is_admin, is_active from public.app_users where user_id = $1`,
      [staffId],
    );
    expect(unchanged.rows[0]).toStrictEqual({ is_admin: false, is_active: true });
  }, 120_000);

  it('4. the workspace cannot reach zero administrators — including under a concurrent race', async () => {
    // A second admin, so there are two to play the race with.
    const second = await post({ action: 'create', email: secondEmail });
    expect(second.status).toBe(200);
    secondId = String(body(second)['userId']);
    createdIds.push(secondId);
    passwords.push(String(body(second)['oneTimePassword']));
    expect((await post({ action: 'promote', userId: secondId })).status).toBe(200);

    // Reduce the workspace to exactly ONE active administrator by DEMOTING the others —
    // never by deactivating them, and never the caller. The acting admin's token is what
    // every later test uses, so deactivating them here (as the first version of this test
    // did) turns any failure in this test into five unrelated 403s. Demotion keeps the
    // caller able to call while still producing the one-admin state under test.
    const soleAdmin = SEEDED_STAFF.developer.userId;
    await db.query(`update public.app_users set is_admin = false where user_id <> $1`, [soleAdmin]);
    try {
      const activeAdmins = await db.query<{ n: string }>(
        `select count(*) as n from public.app_users where is_admin and is_active`,
      );
      expect(activeAdmins.rows[0]?.n).toBe('1');

      // Directly at the database, which is where the guarantee lives — the application
      // checks are asserted in tests/unit/auth. Both routes to zero must raise.
      await expect(
        db.query(`select * from public.set_staff_admin($1, false)`, [soleAdmin]),
      ).rejects.toThrow(/at least one active administrator/);
      await expect(
        db.query(`select * from public.set_staff_active($1, false)`, [soleAdmin]),
      ).rejects.toThrow(/at least one active administrator/);

      // THE RACE: two administrators, two connections, each demoting the other. Without the
      // shared advisory lock both read "two admins", both pass their own check, and both
      // commit — the lockout no application-level check can prevent.
      await db.query(`update public.app_users set is_admin = true where user_id = $1`, [secondId]);

      // `statement_timeout` so a blocked query can never hang the suite: if the lock does not
      // behave as designed this fails in seconds with a clear error, instead of running out
      // the test timeout and leaving an open transaction holding row locks behind it.
      const a = new pg.Client({ connectionString: env?.dbUrl, statement_timeout: 15_000 });
      const b = new pg.Client({ connectionString: env?.dbUrl, statement_timeout: 15_000 });
      await a.connect();
      await b.connect();
      try {
        // ORDER MATTERS, and it has to be forced rather than hoped for. Issuing both calls
        // and awaiting the first deadlocks whenever `b` reaches the lock first: `b` then
        // holds it until a commit this code only performs after `a` returns. So `a`'s call
        // is AWAITED first — its transaction stays open, and `pg_advisory_xact_lock` is
        // transaction-scoped, so the lock is still held when `b` goes for it.
        await a.query('begin');
        await a.query(`select * from public.set_staff_admin($1, false)`, [soleAdmin]);

        await b.query('begin');
        const blocked = b
          .query(`select * from public.set_staff_admin($1, false)`, [secondId])
          .then(() => 'allowed' as const)
          .catch((error: unknown) => (error instanceof Error ? error.message : 'failed'));

        // Releasing the lock. `b` then re-reads under it and finds itself the last one.
        await a.query('commit');
        const outcome = await blocked;
        expect(outcome).toContain('at least one active administrator');
        await b.query('rollback');
      } finally {
        await a.end();
        await b.end();
      }

      const after = await db.query<{ n: string }>(
        `select count(*) as n from public.app_users where is_admin and is_active`,
      );
      expect(Number(after.rows[0]?.n ?? '0')).toBeGreaterThanOrEqual(1);
    } finally {
      // Restore every seeded administrator, whatever happened above.
      await db.query(
        `update public.app_users set is_active = true, is_admin = true
         where user_id = any($1::uuid[])`,
        [[SEEDED_STAFF.ross.userId, SEEDED_STAFF.developer.userId]],
      );
    }
  }, 60_000);

  it('5. a deactivated user is refused at the database, and their contributions survive', async () => {
    // Something of theirs in shared memory first, written the way the assistant would.
    const fact = await db.query<{ id: string }>(
      `insert into public.memory_facts (user_id, scope, key, value, confidence)
       values ($1, 'workspace', $2, $3, 1) returning id`,
      [staffId, `process:users-${RUN}`, 'Synthetic note from a person who later left.'],
    );
    staffFactId = fact.rows[0]?.id ?? '';

    const deactivated = await post({ action: 'deactivate', userId: staffId });
    expect(deactivated.status).toBe(200);
    expect(body(deactivated)['outcome']).toBe('changed');

    // Their PRE-deactivation JWT is still cryptographically valid; the refusal can only be
    // RLS reading is_active.
    const asDeactivated = userClient(staffToken);
    for (const table of ['conversations', 'memory_facts', 'app_users']) {
      const read = await asDeactivated.from(table).select('*', { count: 'exact', head: true });
      expect(read.count ?? 0, `deactivated read ${table}`).toBe(0);
    }
    // And a new session cannot be minted at all (the GoTrue ban).
    const refused = await signInWithPassword(cfg, staffEmail, passwords[0] ?? '');
    expect(refused.ok).toBe(false);

    // Never deleted: the row, and the note they contributed, both survive.
    const row = await db.query<{ is_active: boolean }>(
      `select is_active from public.app_users where user_id = $1`,
      [staffId],
    );
    expect(row.rows).toStrictEqual([{ is_active: false }]);
    const survived = await db.query<{ value: string; superseded_by: string | null }>(
      `select value, superseded_by from public.memory_facts where id = $1`,
      [staffFactId],
    );
    expect(survived.rows[0]?.superseded_by, 'a live note stays live').toBeNull();
    expect(survived.rows[0]?.value).toContain('Synthetic note');

    // And it is still readable by everyone else — it is the workspace's, not theirs.
    const stillThere = await db.query<{ n: string }>(
      `select count(*) as n from public.memory_facts where key = $1 and superseded_by is null`,
      [`process:users-${RUN}`],
    );
    expect(stillThere.rows[0]?.n).toBe('1');
  }, 120_000);

  it('reactivating gives their access back without touching anything else', async () => {
    const restored = await post({ action: 'reactivate', userId: staffId });
    expect(restored.status).toBe(200);
    const session = await signInWithPassword(cfg, staffEmail, passwords[0] ?? '');
    expect(session.ok, 'their existing password works again').toBe(true);
    if (!session.ok) return;
    const asStaff = userClient(session.value.accessToken);
    const read = await asStaff.from('memory_facts').select('id').eq('id', staffFactId);
    expect(read.data).toHaveLength(1);
  }, 120_000);

  it('8. every user action landed in audit_log with the acting admin as the actor', async () => {
    const rows = await db.query<{ action: string; actor: string; entity_id: string }>(
      `select action, actor, entity_id from public.audit_log
       where entity_id = any($1::uuid[])
         and action in ('USER_CREATED','USER_DEACTIVATED','USER_REACTIVATED','USER_PROMOTED','PASSWORD_RESET')
       order by created_at`,
      [createdIds],
    );
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toContain('USER_CREATED');
    expect(actions).toContain('USER_DEACTIVATED');
    expect(actions).toContain('USER_REACTIVATED');
    expect(actions).toContain('USER_PROMOTED');
    for (const row of rows.rows) {
      expect(row.actor, 'the human, never service_role').toBe(SEEDED_STAFF.developer.email);
    }
  }, 120_000);

  it('a password reset issues a working credential and the old one stops working', async () => {
    const reset = await post({ action: 'reset_password', userId: staffId });
    expect(reset.status).toBe(200);
    const fresh = String(body(reset)['oneTimePassword']);
    passwords.push(fresh);

    expect((await signInWithPassword(cfg, staffEmail, fresh)).ok).toBe(true);
    expect((await signInWithPassword(cfg, staffEmail, passwords[0] ?? '')).ok).toBe(false);
  }, 120_000);

  it('sign_ins reports a real last-sign-in for someone who has, and null for someone who has not', async () => {
    const result = await post({ action: 'sign_ins' });
    expect(result.status).toBe(200);
    const rows = body(result)['signIns'] as { userId: string; lastSignInAt: string | null }[];
    const seen = new Map(rows.map((r) => [r.userId, r.lastSignInAt]));
    // staffId signed in above; secondId was created and never used.
    expect(seen.get(staffId)).not.toBeNull();
    expect(seen.get(secondId)).toBeNull();
    // Only allowlisted people are reported.
    const allowlisted = await db.query<{ n: string }>(`select count(*) as n from public.app_users`);
    expect(rows.length).toBe(Number(allowlisted.rows[0]?.n ?? '0'));
  }, 120_000);
});
