/**
 * Who can read a page that was read from a link, and the record of the fetch behind it
 * (Milestone 5 part 2; SECURITY.md §6 and §11) — proven against a running stack through the
 * surfaces an attacker would hold: the anon key, and a real signed-in session against
 * PostgREST.
 *
 * Two rules. A page is a row of `conversation_files`, so it is visible to whoever can see its
 * conversation and to nobody else — and that now includes the ADDRESS it came from, which
 * can say as much about a client as the page does. The record of fetches (`web_fetches`:
 * who asked for which address, and how the site answered) is visible to no session at all,
 * not even the person it is about.
 *
 *   1. anon, an account off the allowlist and a deactivated account read no page, no address
 *      and no fetch record;
 *   2. THE CROSS-USER TEST: one account cannot learn what page another read in a private
 *      conversation — asked for by id, by its address, by its site, and by listing every page;
 *   3. the fetch records answer every session with zero rows, including their owner's;
 *   4. nothing can be written from a session: no fetch record forged or altered, no address
 *      put on a file, and none of the functions that do the writing can be called;
 *   5. EACH OF THOSE FAILS WITHOUT ITS PROTECTION. The policy is replaced, or one is added,
 *      inside a transaction; the same read is made as the same person; the row that should
 *      be hidden comes back; and the transaction is rolled back.
 *
 * Part 2 changed no policy. Test 5's last case reads the catalog to say so.
 *
 * (The generic catalog checks — RLS forced on every table, the grants, no write policy
 * anywhere — are tests/security/rls.test.ts, which reads the table list from the catalog and
 * therefore already covers `web_fetches`.)
 *
 * Fixtures are invented and run-scoped; every read is scoped to this run's ids.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);

const cfg = env ?? {
  url: 'http://stack-not-running.invalid',
  anonKey: 'unset',
  serviceRoleKey: 'unset',
  dbUrl: 'postgresql://stack-not-running.invalid/postgres',
};

/** Invented. An address that names a client's lender is the thing being protected here. */
const SHARED_HOST = `www.shared-${RUN}.example.org`;
const PRIVATE_HOST = `www.private-${RUN}.example.org`;
const SHARED_URL = `https://${SHARED_HOST}/home-loans/rates`;
const PRIVATE_URL = `https://${PRIVATE_HOST}/hardship/application-SECRET-${RUN}`;

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly client: SupabaseClient;
}

const REAL_POLICY = `status <> 'reading'
  and (scope = 'workspace' or user_id = (select auth.uid()))
  and public.is_active_staff()`;

const FUNCTIONS = [
  'public.claim_web_fetch(uuid, uuid, text, text, integer, integer)',
  'public.complete_web_fetch(uuid, uuid, text, text, text, text, integer, text, bigint, text, integer, integer)',
  'public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer, uuid, uuid)',
  'public.finish_conversation_file(uuid, uuid, integer, text, text)',
];

describe.skipIf(env === null)(
  'pages read from links — who can read them (requires a running Supabase stack)',
  () => {
    const db = new pg.Client({ connectionString: cfg.dbUrl });
    const admin = createClient(cfg.url, cfg.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anon = createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let author: TestUser;
    let colleague: TestUser;
    let outsider: TestUser; // authenticated, NOT on the allowlist
    let deactivated: TestUser; // on the allowlist, switched off after signing in
    const createdUsers: TestUser[] = [];

    const ids = {
      sharedConversation: '',
      privateConversation: '',
      sharedPage: '',
      privatePage: '',
      authorFetch: crypto.randomUUID(),
      colleagueFetch: crypto.randomUUID(),
    };

    async function createUser(label: string, allowlisted: boolean): Promise<TestUser> {
      const email = `pages-sec-${label}-${RUN}@example.com`;
      const password = crypto.randomUUID();
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error !== null) {
        throw new Error(`could not create test user ${label}: ${created.error.message}`);
      }
      const id = created.data.user.id;
      if (allowlisted) {
        await db.query(
          `insert into public.app_users (user_id, email, role, is_active) values ($1, $2, 'staff', true)`,
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

    /** A page row written at service level: ready, with the address it was read from. */
    async function insertPage(
      conversationId: string,
      uploadedBy: string,
      url: string,
      host: string,
      seed: string,
    ): Promise<string> {
      const file = await db.query<{ id: string }>(
        `insert into public.conversation_files
           (conversation_id, user_id, scope, uploaded_by, request_id, name, kind, byte_size,
            content_hash, expected_pages, page_count, char_count, status, ready_at, expires_at,
            source_url, source_host, fetched_at)
         values ($1, $2, 'workspace', $2, gen_random_uuid(), $3, 'html', 4651, $4, 1,
                 1, 40, 'ready', now(), now() + interval '1 day', $5, $6, now())
         returning id`,
        [
          conversationId,
          uploadedBy,
          `pages-sec-${RUN}-${seed}`,
          seed.repeat(64).slice(0, 64),
          url,
          host,
        ],
      );
      return file.rows[0]?.id ?? '';
    }

    async function insertFetch(
      id: string,
      userId: string,
      url: string,
      host: string,
    ): Promise<void> {
      await db.query(
        `insert into public.web_fetches
           (id, user_id, requested_url, requested_host, final_url, final_host, status,
            http_status, content_type, byte_size, content_hash, hops, duration_ms, fetched_at)
         values ($1, $2, $3, $4, $3, $4, 'fetched', 200, 'text/html', 4651, $5, 0, 120, now())`,
        [id, userId, url, host, 'e'.repeat(64)],
      );
    }

    /**
     * One read made as a signed-in person, inside a transaction that is always rolled back —
     * optionally after changing the schema. This is how "without its protection" is shown
     * without ever leaving the protection off: the weakened policy never commits.
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

    const replacePolicy = (using: string): string[] => [
      `drop policy conversation_files_read on public.conversation_files`,
      `create policy conversation_files_read on public.conversation_files
       for select to authenticated using (${using})`,
    ];

    beforeAll(async () => {
      await db.connect();
      author = await createUser('author', true);
      colleague = await createUser('colleague', true);
      outsider = await createUser('outsider', false);
      deactivated = await createUser('deactivated', true);
      // Switched off AFTER signing in, so the token is real and still valid.
      await db.query(`update public.app_users set is_active = false where user_id = $1`, [
        deactivated.id,
      ]);

      const conversations = await db.query<{ id: string }>(
        `insert into public.conversations (user_id, scope, title)
         values ($1, 'workspace', $2), ($1, 'user', $3)
         returning id`,
        [author.id, `pages-sec-shared-${RUN}`, `pages-sec-private-${RUN}`],
      );
      ids.sharedConversation = conversations.rows[0]?.id ?? '';
      ids.privateConversation = conversations.rows[1]?.id ?? '';
      ids.sharedPage = await insertPage(
        ids.sharedConversation,
        author.id,
        SHARED_URL,
        SHARED_HOST,
        'a',
      );
      ids.privatePage = await insertPage(
        ids.privateConversation,
        author.id,
        PRIVATE_URL,
        PRIVATE_HOST,
        'b',
      );
      await insertFetch(ids.authorFetch, author.id, PRIVATE_URL, PRIVATE_HOST);
      await insertFetch(ids.colleagueFetch, colleague.id, SHARED_URL, SHARED_HOST);
    }, 60_000);

    afterAll(async () => {
      await db.query(`delete from public.web_fetches where id = any($1::uuid[])`, [
        [ids.authorFetch, ids.colleagueFetch],
      ]);
      // Deleting the conversations cascades to their files.
      await db.query(`delete from public.conversations where title like $1`, [
        `pages-sec-%-${RUN}`,
      ]);
      for (const user of createdUsers) {
        await db.query(`delete from public.app_users where user_id = $1`, [user.id]);
        await admin.auth.admin.deleteUser(user.id);
      }
      await db.end();
    }, 60_000);

    const everyone = (): { who: string; client: SupabaseClient }[] => [
      { who: 'author', client: author.client },
      { who: 'colleague', client: colleague.client },
      { who: 'outsider', client: outsider.client },
      { who: 'deactivated', client: deactivated.client },
      { who: 'anon', client: anon },
    ];

    it('the fixtures are what the tests below assume (a vacuous pass is a failure)', async () => {
      const pages = await db.query<{ id: string; scope: string; source_url: string }>(
        `select id, scope, source_url from public.conversation_files where id = any($1::uuid[])`,
        [[ids.sharedPage, ids.privatePage]],
      );
      const byId = new Map(pages.rows.map((row) => [row.id, row]));
      // The trigger took the scope from the conversation, not from the insert.
      expect(byId.get(ids.sharedPage)).toMatchObject({
        scope: 'workspace',
        source_url: SHARED_URL,
      });
      expect(byId.get(ids.privatePage)).toMatchObject({ scope: 'user', source_url: PRIVATE_URL });
      const fetches = await db.query<{ id: string; user_id: string }>(
        `select id, user_id from public.web_fetches where id = any($1::uuid[]) order by user_id`,
        [[ids.authorFetch, ids.colleagueFetch]],
      );
      expect(fetches.rows).toHaveLength(2);
      expect(fetches.rows.map((row) => row.user_id).sort()).toEqual(
        [author.id, colleague.id].sort(),
      );
    });

    it('1. anon, an account off the allowlist, and a deactivated account read no page and no address', async () => {
      for (const { who, client } of [
        { who: 'anon', client: anon },
        { who: 'outsider', client: outsider.client },
        { who: 'deactivated', client: deactivated.client },
      ]) {
        const byId = await client
          .from('conversation_files')
          .select('id, source_url, source_host')
          .in('id', [ids.sharedPage, ids.privatePage]);
        expect(byId.data ?? [], `${who} read a page by id`).toEqual([]);
        const byHost = await client
          .from('conversation_files')
          .select('id')
          .in('source_host', [SHARED_HOST, PRIVATE_HOST]);
        expect(byHost.data ?? [], `${who} read a page by its site`).toEqual([]);
      }
    });

    it('2. THE CROSS-USER TEST: one account cannot learn what page another read in a private conversation', async () => {
      // The shared one is visible, address and all: the test is not passing because nothing is.
      const shared = await colleague.client
        .from('conversation_files')
        .select('id, source_url, source_host')
        .eq('id', ids.sharedPage);
      expect(shared.data).toEqual([
        { id: ids.sharedPage, source_url: SHARED_URL, source_host: SHARED_HOST },
      ]);

      const attempts = [
        colleague.client.from('conversation_files').select('id').eq('id', ids.privatePage),
        colleague.client.from('conversation_files').select('id').eq('source_url', PRIVATE_URL),
        colleague.client.from('conversation_files').select('id').eq('source_host', PRIVATE_HOST),
        colleague.client
          .from('conversation_files')
          .select('id')
          .eq('conversation_id', ids.privateConversation),
        colleague.client
          .from('conversation_files')
          .select('id')
          .like('source_url', `%SECRET-${RUN}%`),
      ];
      for (const attempt of await Promise.all(attempts)) {
        expect(attempt.error).toBeNull();
        expect(attempt.data).toEqual([]);
      }
      // Listing every page this run made returns the shared one and not the private one.
      const listed = await colleague.client
        .from('conversation_files')
        .select('id')
        .eq('kind', 'html')
        .in('id', [ids.sharedPage, ids.privatePage]);
      expect(listed.data).toEqual([{ id: ids.sharedPage }]);
      // Its author still reads it.
      const own = await author.client
        .from('conversation_files')
        .select('id, source_url')
        .eq('id', ids.privatePage);
      expect(own.data).toEqual([{ id: ids.privatePage, source_url: PRIVATE_URL }]);
    });

    it('3. the record of fetches answers every session with nothing — its owner included', async () => {
      for (const { who, client } of everyone()) {
        const byId = await client
          .from('web_fetches')
          .select('id, requested_url')
          .in('id', [ids.authorFetch, ids.colleagueFetch]);
        expect(byId.data ?? [], `${who} read a fetch record by id`).toEqual([]);
        const byHost = await client
          .from('web_fetches')
          .select('id')
          .in('requested_host', [SHARED_HOST, PRIVATE_HOST]);
        expect(byHost.data ?? [], `${who} read a fetch record by site`).toEqual([]);
      }
      const own = await author.client.from('web_fetches').select('id').eq('user_id', author.id);
      expect(own.data ?? []).toEqual([]);
    });

    it('4. nothing can be written from a session: not a record, not an address, and not through the functions', async () => {
      const forged = await author.client.from('web_fetches').insert({
        id: crypto.randomUUID(),
        user_id: author.id,
        requested_url: `https://www.forged-${RUN}.example.org/`,
        requested_host: `www.forged-${RUN}.example.org`,
      });
      expect(forged.error).not.toBeNull();
      // An update or delete that may touch nothing is refused or changes no row.
      await author.client
        .from('web_fetches')
        .update({
          final_url: `https://www.forged-${RUN}.example.org/`,
          content_hash: 'f'.repeat(64),
        })
        .eq('id', ids.authorFetch);
      await author.client.from('web_fetches').delete().eq('id', ids.authorFetch);
      await colleague.client.from('web_fetches').delete().eq('id', ids.authorFetch);
      // Nor can a session say where a file came from.
      await author.client
        .from('conversation_files')
        .update({ source_url: `https://www.forged-${RUN}.example.org/`, source_host: 'forged' })
        .eq('id', ids.sharedPage);

      const calls = await Promise.all([
        author.client.rpc('claim_web_fetch', {
          p_id: crypto.randomUUID(),
          p_user_id: author.id,
          p_url: `https://www.forged-${RUN}.example.org/`,
          p_host: `www.forged-${RUN}.example.org`,
          p_per_minute: 1_000,
          p_host_gap_ms: 0,
        }),
        author.client.rpc('complete_web_fetch', {
          p_id: ids.authorFetch,
          p_user_id: author.id,
          p_status: 'fetched',
          p_outcome: null,
          p_final_url: `https://www.forged-${RUN}.example.org/`,
          p_final_host: `www.forged-${RUN}.example.org`,
          p_http_status: 200,
          p_content_type: 'text/html',
          p_byte_size: 10,
          p_content_hash: 'f'.repeat(64),
          p_hops: 0,
          p_duration_ms: 1,
        }),
        author.client.rpc('begin_conversation_file', {
          p_conversation_id: ids.sharedConversation,
          p_uploaded_by: author.id,
          p_request_id: crypto.randomUUID(),
          p_name: 'forged',
          p_kind: 'html',
          p_byte_size: 4651,
          p_content_hash: 'e'.repeat(64),
          p_expected_pages: 1,
          p_vision_pages: 0,
          p_retention_days: 1,
          p_max_files: 10,
          p_abandoned_minutes: 15,
          p_fetch_id: ids.authorFetch,
        }),
        anon.rpc('claim_web_fetch', {
          p_id: crypto.randomUUID(),
          p_user_id: author.id,
          p_url: `https://www.forged-${RUN}.example.org/`,
          p_host: `www.forged-${RUN}.example.org`,
          p_per_minute: 1_000,
          p_host_gap_ms: 0,
        }),
      ]);
      for (const call of calls) expect(call.error).not.toBeNull();

      // Everything is exactly as it was.
      const fetches = await db.query<{ id: string; final_url: string; content_hash: string }>(
        `select id, final_url, content_hash from public.web_fetches where id = any($1::uuid[])`,
        [[ids.authorFetch, ids.colleagueFetch]],
      );
      expect(fetches.rows).toHaveLength(2);
      for (const row of fetches.rows) {
        expect(row.content_hash).toBe('e'.repeat(64));
        expect(row.final_url).not.toContain('forged');
      }
      const forgedRows = await db.query(
        `select 1 from public.web_fetches where requested_host = $1`,
        [`www.forged-${RUN}.example.org`],
      );
      expect(forgedRows.rowCount).toBe(0);
      const page = await db.query<{ source_url: string; source_host: string }>(
        `select source_url, source_host from public.conversation_files where id = $1`,
        [ids.sharedPage],
      );
      expect(page.rows).toEqual([{ source_url: SHARED_URL, source_host: SHARED_HOST }]);
      const forgedFiles = await db.query(
        `select 1 from public.conversation_files where conversation_id = $1 and name = 'forged'`,
        [ids.sharedConversation],
      );
      expect(forgedFiles.rowCount).toBe(0);

      const privileges = await db.query<{ fn: string; role: string; can: boolean }>(
        `select fn, role, has_function_privilege(role, fn, 'execute') as can
           from unnest($1::text[]) as fn, unnest(array['anon', 'authenticated', 'service_role']) as role`,
        [FUNCTIONS],
      );
      expect(privileges.rows).toHaveLength(FUNCTIONS.length * 3);
      const open = privileges.rows.filter((row) => row.role !== 'service_role' && row.can);
      expect(open, 'functions a browser session can execute').toEqual([]);
      const closed = privileges.rows.filter((row) => row.role === 'service_role' && !row.can);
      expect(closed, 'functions the server cannot execute').toEqual([]);
    });

    describe('5. each of those fails without its protection', () => {
      const pageSql = `select id, source_url from public.conversation_files where id = $1`;
      const fetchSql = `select id, requested_url from public.web_fetches where id = $1`;

      it('the stand-in for a session is faithful: under the real rules it sees what PostgREST shows', async () => {
        expect(await readAs(colleague.id, pageSql, [ids.privatePage])).toEqual([]);
        expect(await readAs(author.id, pageSql, [ids.privatePage])).toEqual([
          { id: ids.privatePage, source_url: PRIVATE_URL },
        ]);
        expect(await readAs(colleague.id, pageSql, [ids.sharedPage])).toEqual([
          { id: ids.sharedPage, source_url: SHARED_URL },
        ]);
        expect(await readAs(outsider.id, pageSql, [ids.sharedPage])).toEqual([]);
        expect(await readAs(author.id, fetchSql, [ids.authorFetch])).toEqual([]);
        // Replacing the policy with ITSELF changes nothing — so a difference below is the
        // clause that was taken out, not the act of replacing.
        expect(
          await readAs(colleague.id, pageSql, [ids.privatePage], replacePolicy(REAL_POLICY)),
        ).toEqual([]);
      });

      it("without the owner-or-shared clause, a colleague reads the address of another's private page", async () => {
        const weakened = replacePolicy(`status <> 'reading' and public.is_active_staff()`);
        expect(await readAs(colleague.id, pageSql, [ids.privatePage], weakened)).toEqual([
          { id: ids.privatePage, source_url: PRIVATE_URL },
        ]);
      });

      it('without the allowlist clause, an account that is not staff reads a shared page', async () => {
        const weakened = replacePolicy(
          `status <> 'reading' and (scope = 'workspace' or user_id = (select auth.uid()))`,
        );
        expect(await readAs(outsider.id, pageSql, [ids.sharedPage], weakened)).toEqual([
          { id: ids.sharedPage, source_url: SHARED_URL },
        ]);
      });

      it('with ANY policy on the fetch records they are readable: it is the absence of one that protects them', async () => {
        // The most innocent-looking policy there is: "a person may see their own".
        const own = [
          `create policy web_fetches_read_own on public.web_fetches
             for select to authenticated using (user_id = (select auth.uid()))`,
        ];
        expect(await readAs(author.id, fetchSql, [ids.authorFetch], own)).toEqual([
          { id: ids.authorFetch, requested_url: PRIVATE_URL },
        ]);
        // And one a little wider hands a colleague the address of a private read.
        const staff = [
          `create policy web_fetches_read_staff on public.web_fetches
             for select to authenticated using (public.is_active_staff())`,
        ];
        expect(await readAs(colleague.id, fetchSql, [ids.authorFetch], staff)).toEqual([
          { id: ids.authorFetch, requested_url: PRIVATE_URL },
        ]);
      });

      it('nothing above was left behind, and part 2 changed no policy', async () => {
        const policies = await db.query<{
          tablename: string;
          policyname: string;
          cmd: string;
          roles: string[];
          qual: string;
        }>(
          `select tablename, policyname, cmd, roles::text[] as roles, qual from pg_policies
            where schemaname = 'public' and tablename in ('conversation_files', 'web_fetches')`,
        );
        expect(policies.rows).toHaveLength(1);
        const policy = policies.rows[0];
        expect(policy).toMatchObject({
          tablename: 'conversation_files',
          policyname: 'conversation_files_read',
          cmd: 'SELECT',
          roles: ['authenticated'],
        });
        expect(policy?.qual).toContain(`status <> 'reading'`);
        expect(policy?.qual).toContain(`scope = 'workspace'`);
        expect(policy?.qual).toContain('auth.uid()');
        expect(policy?.qual).toContain('is_active_staff()');
        // And the live answers are the protected ones again.
        const page = await colleague.client
          .from('conversation_files')
          .select('id')
          .eq('id', ids.privatePage);
        expect(page.data).toEqual([]);
        const record = await author.client
          .from('web_fetches')
          .select('id')
          .eq('id', ids.authorFetch);
        expect(record.data ?? []).toEqual([]);
      });
    });
  },
);
