/**
 * Who can read a Google Drive connection, its records, and the files that came from it
 * (Milestone 5 part 3a; SECURITY.md §6, §14) — proven against a running stack through the
 * surfaces an attacker would hold: the anon key, a real signed-in session against PostgREST,
 * and the drive endpoint itself.
 *
 *   1. anon, an account off the allowlist, a deactivated account — and the connection's own
 *      owner — read no connection, no Drive read record and no connection attempt. Nothing of
 *      a connection is ever read by a browser; the drive function reports a person's own status.
 *   2. THE CROSS-USER TEST (PHASE-ACCEPTANCE M5 part 3a, D12): one account cannot read another's
 *      connection, sealed token, Drive reads or Drive file — asked for by person, by address,
 *      by listing everything — and through the endpoint, a person's request only ever uses
 *      their OWN token, and cannot attach bytes another person read.
 *   3. Nothing can be written from a session: no connection forged or altered, no read record,
 *      and none of the functions that do the writing can be called.
 *   4. EACH OF THOSE FAILS WITHOUT ITS PROTECTION. Inside a transaction that is always rolled
 *      back, the policy is weakened; the same read is made as the same person; the row that
 *      should be hidden comes back.
 *
 * Fixtures are invented and run-scoped; every read is scoped to this run's ids.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServiceClient, supabaseVerifyDeps } from '../../src/lib/auth/clients.js';
import { SEALED_FOR, importSealKey, seal, toBase64Url } from '../../src/lib/drive/crypto.js';
import { DRIVE_FILE_SCOPE } from '../../src/lib/drive/limits.js';
import { handleDriveRequest, type DrivePageDeps } from '../../src/lib/drive/page.js';
import { createDriveServiceClient, supabaseDriveStore } from '../../src/lib/drive/store.js';
import { FILES_DEFAULTS } from '../../src/lib/files/config.js';
import { handleFilesRequest, type FilesPageDeps } from '../../src/lib/files/page.js';
import { createFilesServiceClient, supabaseFileStore } from '../../src/lib/files/store.js';
import { DEFAULT_PRICING } from '../../src/lib/llm/pricing.js';
import { supabaseConversationStore, supabaseUsageStore } from '../../src/lib/llm/store.js';
import { createLogger } from '../../src/lib/logger.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';
import { scriptedClaude, scriptedPages } from '../unit/files/helpers.js';
import { callsTo, scriptedGoogle } from '../unit/drive/helpers.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);

const cfg = env ?? {
  url: 'http://stack-not-running.invalid',
  anonKey: 'unset',
  serviceRoleKey: 'unset',
  dbUrl: 'postgresql://stack-not-running.invalid/postgres',
};

const KEY = toBase64Url(new Uint8Array(32).fill(11));
// Token-shaped, built at runtime (no literal for a scanner to match).
const AUTHOR_REFRESH = ['1', '//', '0author', 'A'.repeat(60), RUN].join('');
const COLLEAGUE_REFRESH = ['1', '//', '0colleague', 'C'.repeat(60), RUN].join('');
const AUTHOR_EMAIL = `author-drive-${RUN}@example.com`;
const AUTHOR_FILE = `AuthorDriveFile${RUN}`;

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly token: string;
  readonly client: SupabaseClient;
}

const DRIVE_FUNCTIONS = [
  'public.create_drive_oauth_state(uuid, text, text, integer, integer)',
  'public.return_drive_oauth_state(text, text, text)',
  'public.take_drive_oauth_state(uuid, uuid)',
  'public.save_drive_connection(uuid, uuid, uuid, text, text, text, text)',
  'public.mark_drive_connection_broken(uuid, uuid, text)',
  'public.delete_drive_connection(uuid, uuid)',
  'public.claim_drive_read(uuid, uuid, text, integer)',
  'public.complete_drive_read(uuid, uuid, text, text, text, text, text, bigint, text, timestamptz, integer)',
];

describe.skipIf(env === null)(
  'Google Drive — who can read a connection, its records and its files (requires a running Supabase stack)',
  () => {
    const db = new pg.Client({ connectionString: cfg.dbUrl });
    const admin = createClient(cfg.url, cfg.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anon = createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const service = createServiceClient(cfg);
    const store = supabaseDriveStore(createDriveServiceClient(cfg));
    const log = createLogger({ level: 'silent' });
    const google = scriptedGoogle();
    let sealKey: CryptoKey;

    let author: TestUser;
    let colleague: TestUser;
    let outsider: TestUser; // authenticated, NOT on the allowlist
    let deactivated: TestUser; // on the allowlist, switched off after signing in
    const createdUsers: TestUser[] = [];

    const ids = {
      privateConversation: '',
      driveFile: '',
      authorRead: crypto.randomUUID(),
      authorTokenId: crypto.randomUUID(),
      colleagueTokenId: crypto.randomUUID(),
      authorAttempt: '',
    };

    async function createUser(label: string, allowlisted: boolean): Promise<TestUser> {
      const email = `drive-sec-${label}-${RUN}@example.com`;
      const password = crypto.randomUUID();
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error !== null) throw new Error(`createUser ${label}: ${created.error.message}`);
      const id = created.data.user.id;
      if (allowlisted) {
        await db.query(
          `insert into public.app_users (user_id, email, role, is_active) values ($1, $2, 'staff', true)`,
          [id, email],
        );
      }
      const signIn = await anon.auth.signInWithPassword({ email, password });
      if (signIn.error !== null) throw new Error(`signIn ${label}: ${signIn.error.message}`);
      const token = signIn.data.session.access_token;
      const client = createClient(cfg.url, cfg.anonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const user: TestUser = { id, email, token, client };
      createdUsers.push(user);
      return user;
    }

    async function connectAt(
      user: TestUser,
      tokenId: string,
      refresh: string,
      email: string,
    ): Promise<void> {
      const sealed = await seal(sealKey, refresh, SEALED_FOR.refreshToken(user.id, tokenId));
      await db.query(`select * from public.save_drive_connection($1, null, $2, $3, $4, $5, $6)`, [
        user.id,
        tokenId,
        `perm-${user.id}`,
        email,
        sealed,
        DRIVE_FILE_SCOPE,
      ]);
    }

    function driveDeps(): DrivePageDeps {
      return {
        verify: supabaseVerifyDeps(service),
        drive: {
          config: {
            clientId: '123456789012-abcdefgh.apps.googleusercontent.com',
            clientSecret: 'not-a-real-secret-for-the-stack',
            sealKey,
            redirectUri: 'http://127.0.0.1:54321/functions/v1/drive/callback',
            responseMode: 'form_post',
            appOrigin: 'http://localhost:5173',
          },
          google,
          store,
        },
        log,
      };
    }

    function filesDeps(): FilesPageDeps {
      return {
        verify: supabaseVerifyDeps(service),
        conversations: supabaseConversationStore(service),
        files: supabaseFileStore(createFilesServiceClient(cfg)),
        vision: { claude: scriptedClaude(), route: 'default', maxTokens: 512, log },
        usage: supabaseUsageStore(service),
        caps: { dailyUsd: 5, monthlyUsd: 50, warnFraction: 0.8 },
        visionPricing: DEFAULT_PRICING['claude-sonnet-5'] ?? {
          inputPerMTok: 3,
          outputPerMTok: 15,
          cacheWritePerMTok: 3.75,
          cacheReadPerMTok: 0.3,
        },
        config: FILES_DEFAULTS,
        pages: scriptedPages(),
        log,
      };
    }

    /**
     * One read made as a signed-in person, inside a transaction that is always rolled back —
     * optionally after weakening the schema. The weakened rule never commits.
     */
    async function readAs<T extends pg.QueryResultRow>(
      userId: string,
      sql: string,
      params: readonly unknown[],
      weaken: readonly string[] = [],
    ): Promise<T[]> {
      await db.query('begin');
      try {
        for (const statement of weaken) await db.query(statement);
        await db.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: userId, role: 'authenticated' }),
        ]);
        await db.query('set local role authenticated');
        const result = await db.query<T>(sql, [...params]);
        return result.rows;
      } finally {
        await db.query('rollback');
      }
    }

    const replacePolicy = (table: string, policy: string, using: string): string[] => [
      `drop policy ${policy} on public.${table}`,
      `create policy ${policy} on public.${table} for select to authenticated using (${using})`,
    ];

    beforeAll(async () => {
      const imported = await importSealKey(KEY);
      if (!imported.ok) throw imported.error;
      sealKey = imported.value;
      await db.connect();
      author = await createUser('author', true);
      colleague = await createUser('colleague', true);
      outsider = await createUser('outsider', false);
      deactivated = await createUser('deactivated', true);
      await db.query(`update public.app_users set is_active = false where user_id = $1`, [
        deactivated.id,
      ]);

      await connectAt(author, ids.authorTokenId, AUTHOR_REFRESH, AUTHOR_EMAIL);
      await connectAt(
        colleague,
        ids.colleagueTokenId,
        COLLEAGUE_REFRESH,
        `colleague-drive-${RUN}@example.com`,
      );

      await db.query(`select * from public.claim_drive_read($1, $2, $3, 20)`, [
        ids.authorRead,
        author.id,
        AUTHOR_FILE,
      ]);
      await db.query(
        `select public.complete_drive_read($1, $2, 'fetched', null, $3, 'application/pdf', null, 9, $4, now(), 50)`,
        [ids.authorRead, author.id, `Author private statement ${RUN}`, 'f'.repeat(64)],
      );
      const attempt = await db.query<{ id: string }>(
        `select public.create_drive_oauth_state($1, $2, $3, 600, 5) as id`,
        // A hex state hash unique to this run (RUN is eight hex characters).
        [author.id, `${'a'.repeat(56)}${RUN}`, await seal(sealKey, 'V'.repeat(64), 'x')],
      );
      ids.authorAttempt = attempt.rows[0]?.id ?? '';

      const conversation = await db.query<{ id: string }>(
        `insert into public.conversations (user_id, scope, title) values ($1, 'user', $2) returning id`,
        [author.id, `drive-sec-private-${RUN}`],
      );
      ids.privateConversation = conversation.rows[0]?.id ?? '';
      const file = await db.query<{ id: string }>(
        `insert into public.conversation_files
           (conversation_id, user_id, scope, uploaded_by, request_id, name, kind, byte_size,
            content_hash, expected_pages, page_count, char_count, status, ready_at, expires_at,
            source_url, source_host, fetched_at, drive_file_id)
         values ($1, $2, 'user', $2, gen_random_uuid(), $3, 'pdf', 9, $4, 1, 1, 9, 'ready', now(),
                 now() + interval '30 days', $5, 'drive.google.com', now(), $6)
         returning id`,
        [
          ids.privateConversation,
          author.id,
          `Author private statement ${RUN}`,
          'd'.repeat(64),
          `https://drive.google.com/file/d/${AUTHOR_FILE}/view`,
          AUTHOR_FILE,
        ],
      );
      ids.driveFile = file.rows[0]?.id ?? '';
    }, 60_000);

    afterAll(async () => {
      const userIds = createdUsers.map((user) => user.id);
      await db.query(`delete from public.drive_oauth_states where user_id = any($1::uuid[])`, [
        userIds,
      ]);
      await db.query(`delete from public.drive_connections where user_id = any($1::uuid[])`, [
        userIds,
      ]);
      await db.query(`delete from public.conversations where title like $1`, [
        `drive-sec-%-${RUN}`,
      ]);
      await db.query(
        `delete from public.audit_log where entity_id = any($1::uuid[]) and entity_type = 'drive_connections'`,
        [userIds],
      );
      for (const user of createdUsers) {
        await db.query(`delete from public.app_users where user_id = $1`, [user.id]);
        await admin.auth.admin.deleteUser(user.id);
      }
      await db.end();
    }, 60_000);

    const everyone = (): { who: string; client: SupabaseClient }[] => [
      { who: 'author (the owner)', client: author.client },
      { who: 'colleague', client: colleague.client },
      { who: 'outsider', client: outsider.client },
      { who: 'deactivated', client: deactivated.client },
      { who: 'anon', client: anon },
    ];

    it('the fixtures are what the tests below assume (a vacuous pass is a failure)', async () => {
      const connections = await db.query<{ user_id: string; google_email: string }>(
        `select user_id, google_email from public.drive_connections where user_id = any($1::uuid[]) order by google_email`,
        [[author.id, colleague.id]],
      );
      expect(connections.rows.map((row) => row.user_id).sort()).toEqual(
        [author.id, colleague.id].sort(),
      );
      const reads = await db.query(
        `select 1 from public.drive_reads where id = $1 and status = 'fetched'`,
        [ids.authorRead],
      );
      expect(reads.rowCount).toBe(1);
      const attempts = await db.query(`select 1 from public.drive_oauth_states where id = $1`, [
        ids.authorAttempt,
      ]);
      expect(attempts.rowCount).toBe(1);
      const file = await db.query<{ drive_file_id: string }>(
        `select drive_file_id from public.conversation_files where id = $1`,
        [ids.driveFile],
      );
      expect(file.rows[0]?.drive_file_id).toBe(AUTHOR_FILE);
    });

    it('1. no session reads a connection, a Drive read record or a connection attempt — the owner included', async () => {
      for (const { who, client } of everyone()) {
        for (const table of ['drive_connections', 'drive_reads', 'drive_oauth_states'] as const) {
          const read = await client.from(table).select('*');
          // anon holds no privilege at all (an error); a session holds SELECT and meets `false`.
          const rows = read.data ?? [];
          expect(rows, `${who} on ${table}`).toEqual([]);
          if (who === 'anon') expect(read.error, `${who} on ${table}`).not.toBeNull();
        }
      }
    });

    it("2. THE CROSS-USER TEST: the colleague cannot learn anything of the author's Drive", async () => {
      // By person, by address, by the sealed token's prefix, and by listing everything.
      const byPerson = await colleague.client
        .from('drive_connections')
        .select('*')
        .eq('user_id', author.id);
      const byEmail = await colleague.client
        .from('drive_connections')
        .select('*')
        .eq('google_email', AUTHOR_EMAIL);
      const bySeal = await colleague.client
        .from('drive_connections')
        .select('*')
        .like('refresh_token_sealed', 'v1.%');
      const reads = await colleague.client
        .from('drive_reads')
        .select('*')
        .eq('drive_file_id', AUTHOR_FILE);
      for (const result of [byPerson, byEmail, bySeal, reads])
        expect(result.data ?? []).toEqual([]);

      // The Drive file attached in the author's PRIVATE conversation: not its row, not its id.
      const file = await colleague.client
        .from('conversation_files')
        .select('*')
        .eq('id', ids.driveFile);
      const byDriveId = await colleague.client
        .from('conversation_files')
        .select('*')
        .eq('drive_file_id', AUTHOR_FILE);
      expect(file.data ?? []).toEqual([]);
      expect(byDriveId.data ?? []).toEqual([]);
      // …while the author, whose conversation it is, does see it — the rule is the conversation's.
      const own = await author.client
        .from('conversation_files')
        .select('drive_file_id')
        .eq('id', ids.driveFile);
      expect(own.data).toEqual([{ drive_file_id: AUTHOR_FILE }]);

      // Through the endpoint: the colleague's status is the colleague's, never the author's…
      const status = await handleDriveRequest(driveDeps(), {
        token: colleague.token,
        body: { action: 'status' },
      });
      expect(JSON.stringify(status.body)).not.toContain(AUTHOR_EMAIL);
      expect(status.body).toMatchObject({
        state: 'connected',
        email: `colleague-drive-${RUN}@example.com`,
      });
      // …a read the colleague asks for uses the COLLEAGUE's token, and only it…
      google.files.set(AUTHOR_FILE, { ok: false, error: { kind: 'no_access' } });
      const read = await handleDriveRequest(driveDeps(), {
        token: colleague.token,
        body: { action: 'read_file', requestId: crypto.randomUUID(), fileId: AUTHOR_FILE },
      });
      expect(read.status).toBe(422);
      const usedTokens = callsTo(google, 'refresh').map((args) => args[0]);
      expect(usedTokens).toContain(COLLEAGUE_REFRESH);
      expect(usedTokens).not.toContain(AUTHOR_REFRESH);
      // …and the bytes the AUTHOR read cannot be attached by the colleague.
      const conversation = await db.query<{ id: string }>(
        `insert into public.conversations (user_id, scope, title) values ($1, 'workspace', $2) returning id`,
        [colleague.id, `drive-sec-colleague-${RUN}`],
      );
      const stolen = await handleFilesRequest(filesDeps(), {
        token: colleague.token,
        body: {
          action: 'begin',
          requestId: crypto.randomUUID(),
          conversationId: conversation.rows[0]?.id,
          name: 'x.pdf',
          kind: 'pdf',
          byteSize: 9,
          contentHash: 'f'.repeat(64),
          totalPages: 1,
          visionPages: 0,
          driveReadId: ids.authorRead,
        },
      });
      expect(stolen.status).toBe(409);
      const attached = await db.query(
        `select 1 from public.conversation_files where conversation_id = $1`,
        [conversation.rows[0]?.id],
      );
      expect(attached.rowCount).toBe(0);
    });

    it('3. nothing can be written from a session: not a connection, not a record, not through the functions', async () => {
      const forged = await colleague.client.from('drive_connections').insert({
        user_id: colleague.id,
        token_id: crypto.randomUUID(),
        google_account_id: 'forged',
        google_email: 'forged@example.com',
        refresh_token_sealed: `v1.${'A'.repeat(16)}.${'B'.repeat(60)}`,
        granted_scope: DRIVE_FILE_SCOPE,
      });
      expect(forged.error).not.toBeNull();
      const altered = await author.client
        .from('drive_connections')
        .update({ google_email: 'moved@example.com' })
        .eq('user_id', author.id);
      expect(altered.error).not.toBeNull();
      const wiped = await colleague.client.from('drive_reads').delete().eq('id', ids.authorRead);
      expect(wiped.error).not.toBeNull();
      const rpc = await colleague.client.rpc('save_drive_connection', {
        p_user_id: author.id,
        p_expected_token_id: ids.authorTokenId,
        p_token_id: crypto.randomUUID(),
        p_account_id: 'stolen',
        p_email: 'stolen@example.com',
        p_refresh_sealed: `v1.${'A'.repeat(16)}.${'B'.repeat(60)}`,
        p_scope: DRIVE_FILE_SCOPE,
      });
      expect(rpc.error).not.toBeNull();
      const take = await colleague.client.rpc('take_drive_oauth_state', {
        p_id: ids.authorAttempt,
        p_user_id: colleague.id,
      });
      expect(take.error).not.toBeNull();

      // Nothing moved.
      const row = await db.query<{ google_email: string; token_id: string }>(
        `select google_email, token_id from public.drive_connections where user_id = $1`,
        [author.id],
      );
      expect(row.rows[0]).toEqual({ google_email: AUTHOR_EMAIL, token_id: ids.authorTokenId });
      expect(
        (await db.query(`select 1 from public.drive_reads where id = $1`, [ids.authorRead]))
          .rowCount,
      ).toBe(1);
      expect(
        (
          await db.query(`select 1 from public.drive_oauth_states where id = $1`, [
            ids.authorAttempt,
          ])
        ).rowCount,
      ).toBe(1);

      const privileges = await db.query<{ fn: string; role: string; can: boolean }>(
        `select fn, role, has_function_privilege(role, fn, 'execute') as can
           from unnest($1::text[]) fn cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)`,
        [DRIVE_FUNCTIONS],
      );
      expect(privileges.rows).toHaveLength(DRIVE_FUNCTIONS.length * 3);
      for (const row of privileges.rows)
        expect(row.can, `${row.role} on ${row.fn}`).toBe(row.role === 'service_role');
    });

    describe('4. each of those fails without its protection', () => {
      const connectionSql = `select user_id, refresh_token_sealed from public.drive_connections where user_id = $1`;

      it('the stand-in for a session is faithful: under the real rules it sees what PostgREST shows', async () => {
        expect(await readAs(colleague.id, connectionSql, [author.id])).toEqual([]);
        expect(await readAs(author.id, connectionSql, [author.id])).toEqual([]);
      });

      it("with the policy made true, the colleague reads the author's sealed token", async () => {
        const rows = await readAs<{ user_id: string; refresh_token_sealed: string }>(
          colleague.id,
          connectionSql,
          [author.id],
          replacePolicy('drive_connections', 'drive_connections_no_browser_read', 'true'),
        );
        expect(rows.map((row) => row.user_id)).toEqual([author.id]);
        expect(rows[0]?.refresh_token_sealed).toMatch(/^v1\./);
      });

      it('with an "own rows" policy, the owner’s browser could read his own sealed token — which is why there is none', async () => {
        const rows = await readAs(
          author.id,
          connectionSql,
          [author.id],
          replacePolicy(
            'drive_connections',
            'drive_connections_no_browser_read',
            'user_id = (select auth.uid())',
          ),
        );
        expect(rows).toHaveLength(1);
      });

      it("with the read records' policy made true, the colleague reads which file the author read", async () => {
        const rows = await readAs<{ drive_file_id: string }>(
          colleague.id,
          `select drive_file_id from public.drive_reads where id = $1`,
          [ids.authorRead],
          replacePolicy('drive_reads', 'drive_reads_no_browser_read', 'true'),
        );
        expect(rows).toEqual([{ drive_file_id: AUTHOR_FILE }]);
      });

      it("without the owner-or-shared clause on files, the colleague reads the author's private Drive file id", async () => {
        const rows = await readAs<{ drive_file_id: string }>(
          colleague.id,
          `select drive_file_id from public.conversation_files where id = $1`,
          [ids.driveFile],
          replacePolicy(
            'conversation_files',
            'conversation_files_read',
            `status <> 'reading' and public.is_active_staff()`,
          ),
        );
        expect(rows).toEqual([{ drive_file_id: AUTHOR_FILE }]);
      });

      it("nothing above was left behind: each table has its one false policy, and the files policy is part 1's", async () => {
        const policies = await db.query<{ tablename: string; qual: string; cmd: string }>(
          `select tablename, qual, cmd from pg_policies
            where schemaname = 'public' and tablename in ('drive_connections', 'drive_reads', 'drive_oauth_states')
            order by tablename`,
        );
        expect(policies.rows).toEqual([
          { tablename: 'drive_connections', qual: 'false', cmd: 'SELECT' },
          { tablename: 'drive_oauth_states', qual: 'false', cmd: 'SELECT' },
          { tablename: 'drive_reads', qual: 'false', cmd: 'SELECT' },
        ]);
        const files = await db.query<{ policyname: string }>(
          `select policyname from pg_policies where schemaname = 'public' and tablename = 'conversation_files'`,
        );
        expect(files.rows).toEqual([{ policyname: 'conversation_files_read' }]);
      });
    });
  },
);
