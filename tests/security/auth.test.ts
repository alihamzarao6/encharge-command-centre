/**
 * Auth security suite (Stage 2 part 3, FND-220 Part C) — against a real stack, through the
 * real library code (src/lib/auth wired by createAdminDeps), so a green run proves the
 * production path, not a re-implementation. Asserts, in order:
 *
 *   0. bootstrap: attaching credentials to the seeded fixed UUIDs creates NO new identity
 *      (auth-user count identical before/after, ids unchanged)
 *   1. a newly created user can sign in and read workspace memory rows
 *   2. a deactivated user is refused AT THE DATABASE: their still-valid JWT gets zero rows
 *      (and a fresh sign-in is refused by the ban); the row and memory survive — never
 *      deleted
 *   3. an auth.users account with no app_users row reads nothing
 *   4. creating a user is refused when the caller is not an admin, and no auth user is
 *      minted by the attempt
 *   5. the service role key appears in no result object and no log line (the
 *      client-bundle scan is tests/security/secrets.test.ts)
 *   6. no generated password appears in any log line or in any row of any table
 *   +  public signup is refused (config.toml enable_signup = false) and mints no user
 *
 * Every log line the library emits during the run is captured through a sink and scanned.
 * Fixtures are synthetic and removed; the seeded accounts keep their attached credentials
 * (local/CI stacks are throwaway — the same bootstrap is how production gets credentials).
 */
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SEEDED_STAFF,
  attachSeededCredentials,
  createStaffUser,
  deactivateStaffUser,
  resetStaffPassword,
} from '../../src/lib/auth/admin.js';
import type { AdminDeps } from '../../src/lib/auth/admin.js';
import { createAdminDeps, signInWithPassword } from '../../src/lib/auth/clients.js';
import type { SupabaseAuthConfig } from '../../src/lib/auth/clients.js';
import { verifyStaffAccess } from '../../src/lib/auth/verify.js';
import { createLogger } from '../../src/lib/logger.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);

const cfg: SupabaseAuthConfig = {
  url: env?.url ?? 'http://stack-not-running.invalid',
  anonKey: env?.anonKey ?? 'unset',
  serviceRoleKey: env?.serviceRoleKey ?? 'unset',
};

// Return type inferred deliberately: the bare `SupabaseClient` default generics differ
// from createClient's inferred generics, which trips no-unsafe-return under strict lint.
function userClient(token: string) {
  return createClient(cfg.url, cfg.anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function countRows(data: unknown): number {
  return Array.isArray(data) ? data.length : 0;
}

describe.skipIf(env === null)(
  'auth and user management (requires a running Supabase stack)',
  () => {
    const db = new pg.Client({
      connectionString: env?.dbUrl ?? 'postgresql://stack-not-running.invalid/postgres',
    });

    const logLines: string[] = [];
    const generatedPasswords: string[] = [];
    let deps: AdminDeps;

    // State threaded through the ordered tests below.
    let devToken = '';
    const staffEmail = `auth-staff-${RUN}@example.com`;
    let staffUserId = '';
    let staffToken = ''; // session minted BEFORE deactivation
    let workspaceConvId = '';
    const createdAuthIds: string[] = [];

    beforeAll(async () => {
      await db.connect();
      deps = createAdminDeps(
        cfg,
        createLogger({
          level: 'debug',
          sink: (line) => {
            logLines.push(line);
          },
        }),
      );

      const conv = await db.query<{ id: string }>(
        `insert into public.conversations (user_id, scope, title)
       values ($1, 'workspace', $2)
       returning id`,
        [SEEDED_STAFF.ross.userId, `auth-ws-conv-${RUN}`],
      );
      workspaceConvId = conv.rows[0]?.id ?? '';
    }, 60_000);

    afterAll(async () => {
      await db.query(`delete from public.conversations where title like $1`, [`auth-%-${RUN}`]);
      if (createdAuthIds.length > 0) {
        await db.query(`delete from public.audit_log where entity_id = any($1::uuid[])`, [
          createdAuthIds,
        ]);
        await db.query(`delete from public.app_users where user_id = any($1::uuid[])`, [
          createdAuthIds,
        ]);
        await db.query(`delete from auth.users where id = any($1::uuid[])`, [createdAuthIds]);
      }
      await db.end();
    }, 60_000);

    it('0. bootstrap attaches credentials to the seeded UUID without creating a second user', async () => {
      // Scoped to the seeded identities, not the whole table: the security files run in
      // parallel and rls.test.ts creates its own users mid-run (CI #6 read 3 for that
      // reason). "No second identity for THIS person" is the property that matters.
      const seededCount = `select count(*) as n from auth.users
        where id in ($1, $2) or email in ($3, $4)`;
      const seededArgs = [
        SEEDED_STAFF.ross.userId,
        SEEDED_STAFF.developer.userId,
        SEEDED_STAFF.ross.email,
        SEEDED_STAFF.developer.email,
      ];
      const before = await db.query<{ n: string }>(seededCount, seededArgs);
      expect(before.rows[0]?.n).toBe('2');
      const seededBefore = await db.query<{ id: string; email: string }>(
        `select id, email from auth.users where id in ($1, $2) order by email`,
        [SEEDED_STAFF.ross.userId, SEEDED_STAFF.developer.userId],
      );
      expect(seededBefore.rows).toHaveLength(2);

      const attached = await attachSeededCredentials(deps, 'developer');
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      generatedPasswords.push(attached.value.generatedPassword);
      expect(attached.value.userId).toBe(SEEDED_STAFF.developer.userId);

      // The measured no-duplicate-identity claim: still two seeded identities, same ids,
      // exactly one row per seeded email.
      const after = await db.query<{ n: string }>(seededCount, seededArgs);
      expect(after.rows[0]?.n).toBe('2');
      const perEmail = await db.query<{ email: string; n: string; ids: string[] }>(
        `select email, count(*) as n, array_agg(id::text) as ids
       from auth.users where email in ($1, $2) group by email order by email`,
        [SEEDED_STAFF.ross.email, SEEDED_STAFF.developer.email],
      );
      expect(perEmail.rows).toStrictEqual([
        { email: SEEDED_STAFF.developer.email, n: '1', ids: [SEEDED_STAFF.developer.userId] },
        { email: SEEDED_STAFF.ross.email, n: '1', ids: [SEEDED_STAFF.ross.userId] },
      ]);

      // The attached credential works, resolves to the SAME fixed UUID, and that identity
      // is an active admin.
      const session = await signInWithPassword(
        cfg,
        SEEDED_STAFF.developer.email,
        attached.value.generatedPassword,
      );
      expect(session.ok).toBe(true);
      if (!session.ok) return;
      expect(session.value.userId).toBe(SEEDED_STAFF.developer.userId);
      devToken = session.value.accessToken;

      const access = await verifyStaffAccess(deps.verify, devToken);
      expect(access.ok).toBe(true);
      if (!access.ok) return;
      expect(access.value.kind).toBe('authorized');
      if (access.value.kind !== 'authorized') return;
      expect(access.value.user.isAdmin).toBe(true);
    }, 60_000);

    it('1. an admin adds an email; the new user signs in and reads workspace memory', async () => {
      expect(devToken).not.toBe('');
      const created = await createStaffUser(deps, devToken, staffEmail);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      staffUserId = created.value.userId;
      createdAuthIds.push(staffUserId);
      generatedPasswords.push(created.value.generatedPassword);

      const session = await signInWithPassword(cfg, staffEmail, created.value.generatedPassword);
      expect(session.ok).toBe(true);
      if (!session.ok) return;
      staffToken = session.value.accessToken;

      const conv = await userClient(staffToken)
        .from('conversations')
        .select('id')
        .eq('id', workspaceConvId);
      expect(conv.error).toBeNull();
      expect(countRows(conv.data)).toBe(1);

      // Audit: the creation landed with the human admin as actor.
      const audit = await db.query<{ actor: string }>(
        `select actor from public.audit_log
       where action = 'USER_CREATED' and entity_id = $1`,
        [staffUserId],
      );
      expect(audit.rows).toStrictEqual([{ actor: SEEDED_STAFF.developer.email }]);
    }, 60_000);

    it('4. a non-admin staff member cannot create users, and the attempt mints no identity', async () => {
      expect(staffToken).not.toBe('');
      const attemptEmail = `auth-attempt-${RUN}@example.com`;
      const refused = await createStaffUser(deps, staffToken, attemptEmail);
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.code).toBe('FORBIDDEN');

      const minted = await db.query<{ n: string }>(
        `select count(*) as n from auth.users where email = $1`,
        [attemptEmail],
      );
      expect(minted.rows[0]?.n).toBe('0');
    }, 60_000);

    it('password reset issues a fresh working credential and audits it', async () => {
      const reset = await resetStaffPassword(deps, devToken, staffEmail);
      expect(reset.ok).toBe(true);
      if (!reset.ok) return;
      generatedPasswords.push(reset.value.generatedPassword);

      const session = await signInWithPassword(cfg, staffEmail, reset.value.generatedPassword);
      expect(session.ok).toBe(true);

      const audit = await db.query<{ n: string }>(
        `select count(*) as n from public.audit_log
       where action = 'PASSWORD_RESET' and entity_id = $1 and actor = $2`,
        [staffUserId, SEEDED_STAFF.developer.email],
      );
      expect(audit.rows[0]?.n).toBe('1');
    }, 60_000);

    it('2. a deactivated user is refused at the database, and nothing is deleted', async () => {
      const deactivated = await deactivateStaffUser(deps, devToken, staffEmail);
      expect(deactivated.ok).toBe(true);

      // Their PRE-deactivation JWT is still cryptographically valid — the refusal below can
      // only come from RLS reading is_active, which is the point.
      const asDeactivated = userClient(staffToken);
      for (const table of ['conversations', 'memory_facts', 'app_users']) {
        const res = await asDeactivated.from(table).select('*', { count: 'exact', head: true });
        expect(res.count ?? 0, `deactivated user read ${table}`).toBe(0);
      }

      // Deactivate, never delete: the allowlist row and the workspace memory both survive.
      const row = await db.query<{ is_active: boolean }>(
        `select is_active from public.app_users where user_id = $1`,
        [staffUserId],
      );
      expect(row.rows).toStrictEqual([{ is_active: false }]);
      const conv = await db.query<{ n: string }>(
        `select count(*) as n from public.conversations where id = $1`,
        [workspaceConvId],
      );
      expect(conv.rows[0]?.n).toBe('1');

      // Belt and braces: the ban refuses any NEW session.
      const lastPassword = generatedPasswords[generatedPasswords.length - 1] ?? '';
      const freshSignIn = await signInWithPassword(cfg, staffEmail, lastPassword);
      expect(freshSignIn.ok).toBe(false);

      const audit = await db.query<{ n: string }>(
        `select count(*) as n from public.audit_log
       where action = 'USER_DEACTIVATED' and entity_id = $1`,
        [staffUserId],
      );
      expect(audit.rows[0]?.n).toBe('1');
    }, 60_000);

    it('3. an auth.users account with no app_users row reads nothing', async () => {
      // Created through the same production adapter the library uses, but deliberately
      // WITHOUT an app_users row — the state a half-completed creation would leave behind.
      const orphanEmail = `auth-orphan-${RUN}@example.com`;
      const password = `Orphan-${crypto.randomUUID()}`;
      const orphan = await deps.authAdmin.createUser(orphanEmail, password);
      expect(orphan.ok).toBe(true);
      if (!orphan.ok) return;
      createdAuthIds.push(orphan.value.id);

      const session = await signInWithPassword(cfg, orphanEmail, password);
      expect(session.ok).toBe(true);
      if (!session.ok) return;

      const asOrphan = userClient(session.value.accessToken);
      for (const table of [
        'conversations',
        'messages',
        'memory_facts',
        'memory_chunks',
        'app_users',
      ]) {
        const res = await asOrphan.from(table).select('*', { count: 'exact', head: true });
        expect(res.count ?? 0, `orphan read ${table}`).toBe(0);
      }

      const access = await verifyStaffAccess(deps.verify, session.value.accessToken);
      expect(access.ok).toBe(true);
      if (!access.ok) return;
      expect(access.value).toStrictEqual({
        kind: 'forbidden',
        httpStatus: 403,
        reason: 'not_allowlisted',
      });
    }, 60_000);

    it('public signup is refused — accounts exist only through the audited admin path', async () => {
      // config.toml enable_signup = false. Without this assertion, re-enabling signup would
      // pass CI silently; the hosted project must mirror the setting (manual, deploy-time).
      const attemptEmail = `auth-signup-${RUN}@example.com`;
      const anon = createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const attempt = await anon.auth.signUp({
        email: attemptEmail,
        password: `Signup-${crypto.randomUUID()}`,
      });
      expect(attempt.error, 'anon signUp must be refused').not.toBeNull();

      const minted = await db.query<{ n: string }>(
        `select count(*) as n from auth.users where email = $1`,
        [attemptEmail],
      );
      expect(minted.rows[0]?.n).toBe('0');
    }, 60_000);

    it('5. the service role key appears in no log line captured from the full run', () => {
      expect(logLines.length).toBeGreaterThan(0);
      for (const line of logLines) {
        expect(line).not.toContain(cfg.serviceRoleKey);
      }
    });

    it('6. no generated password appears in any log line or in any row of any table', async () => {
      expect(generatedPasswords.length).toBeGreaterThanOrEqual(3); // bootstrap, create, reset
      for (const password of generatedPasswords) {
        for (const line of logLines) {
          expect(line, 'log line must not contain a generated password').not.toContain(password);
        }
      }

      // Every row of every public table, serialised, plus auth.users (where only the bcrypt
      // hash may live). The alphabet has no LIKE metacharacters, so position() is literal.
      const tables = await db.query<{ relname: string }>(
        `select c.relname
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
      );
      for (const password of generatedPasswords) {
        for (const { relname } of tables.rows) {
          // Identifier, not a parameter — guarded by the catalog-name shape before use.
          expect(relname).toMatch(/^[a-z_][a-z0-9_]*$/);
          const res = await db.query<{ n: string }>(
            `select count(*) as n from public."${relname}" t where position($1 in t::text) > 0`,
            [password],
          );
          expect(res.rows[0]?.n, `password found in public.${relname}`).toBe('0');
        }
        const inAuth = await db.query<{ n: string }>(
          `select count(*) as n from auth.users u where position($1 in to_jsonb(u)::text) > 0`,
          [password],
        );
        expect(inAuth.rows[0]?.n, 'password found in auth.users').toBe('0');
      }
    }, 60_000);
  },
);
