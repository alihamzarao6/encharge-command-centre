/**
 * Who can read an attached file (Milestone 5 part 1, D86; SECURITY.md §6) — proven against a
 * running stack through the surfaces an attacker would hold: the anon key, and a real
 * signed-in session against PostgREST.
 *
 * The rule: a file is visible to whoever can see its conversation, and to nobody else. The
 * TEXT read out of it is visible to no browser session at all.
 *
 *   1. anon reads nothing; an authenticated account that is not on the allowlist reads
 *      nothing; a deactivated account with a still-valid token reads nothing;
 *   2. THE CROSS-USER TEST: one account cannot read the file in another's private
 *      conversation — asked for by id, by conversation, and by listing everything;
 *   3. an upload still in progress is invisible even to the person uploading it;
 *   4. the text table answers every session with zero rows;
 *   5. nothing can be written from a session: no insert, update or delete on either table,
 *      and none of the functions that do the writing can be called;
 *   6. EACH OF THOSE FAILS WITHOUT ITS PROTECTION. For every clause of the policy, the policy
 *      is replaced inside a transaction with one that lacks that clause, the same read is
 *      made as the same person, the row that should be hidden comes back — and the
 *      transaction is rolled back. A test that passes whether or not the protection is there
 *      proves nothing, so each one is shown to fail without it.
 *
 * (The generic catalog checks — RLS forced on every table, the grants, no write policy
 * anywhere — are tests/security/rls.test.ts, which reads the table list from the catalog and
 * therefore already covers these two tables.)
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

/** Invented. If it is ever read by someone who should not, the failure message names it. */
const SECRET_LINE = `Net pay 2,887.38 SECRET-${RUN}`;

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly client: SupabaseClient;
}

function extractIds(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.map((row) => String((row as Record<string, unknown>)['id']));
}

const REAL_POLICY = `status <> 'reading'
  and (scope = 'workspace' or user_id = (select auth.uid()))
  and public.is_active_staff()`;

const FUNCTIONS = [
  'public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer)',
  'public.append_conversation_file_pages(uuid, jsonb)',
  'public.finish_conversation_file(uuid, uuid, integer)',
  'public.remove_conversation_file(uuid, uuid, text)',
  'public.purge_conversation_files(integer)',
  'public.cascade_conversation_files_ownership()',
  'public.purge_files_of_deleted_conversation()',
];

describe.skipIf(env === null)(
  'attached files — who can read them (requires a running Supabase stack)',
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
      sharedFile: '',
      privateFile: '',
      readingFile: '',
    };

    async function createUser(label: string, allowlisted: boolean): Promise<TestUser> {
      const email = `files-sec-${label}-${RUN}@example.com`;
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

    /** A file row written at service level, with one page of text under it. */
    async function insertFile(
      conversationId: string,
      uploadedBy: string,
      status: 'ready' | 'reading',
      seed: string,
    ): Promise<string> {
      const file = await db.query<{ id: string }>(
        // user_id and scope are given wrong on purpose (the uploader, 'workspace'): the
        // parent-sync trigger must overwrite them with the conversation's.
        `insert into public.conversation_files
         (conversation_id, user_id, scope, uploaded_by, request_id, name, kind, byte_size,
          content_hash, expected_pages, page_count, char_count, status, ready_at, expires_at)
       values ($1, $2, 'workspace', $2, gen_random_uuid(), $3, 'pdf', 4651, $4, 1,
               $5, $6, $7, $8, now() + interval '30 days')
       returning id`,
        [
          conversationId,
          uploadedBy,
          `files-sec-${RUN}-${seed}.pdf`,
          seed.repeat(64).slice(0, 64),
          status === 'ready' ? 1 : 0,
          status === 'ready' ? SECRET_LINE.length : 0,
          status,
          status === 'ready' ? new Date() : null,
        ],
      );
      const id = file.rows[0]?.id ?? '';
      await db.query(
        `insert into public.conversation_file_pages
         (file_id, page_no, label, content, extraction_method, confidence, letter_count)
       values ($1, 1, 'Page 1', $2, 'pdf_text_layer', 1, 20)`,
        [id, SECRET_LINE],
      );
      return id;
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
      // Switched off AFTER signing in, so the token is real and still valid: the refusal has to
      // come from the allowlist row, not from the token.
      await db.query(`update public.app_users set is_active = false where user_id = $1`, [
        deactivated.id,
      ]);

      const conversations = await db.query<{ id: string }>(
        `insert into public.conversations (user_id, scope, title)
       values ($1, 'workspace', $2), ($1, 'user', $3)
       returning id`,
        [author.id, `files-sec-shared-${RUN}`, `files-sec-private-${RUN}`],
      );
      ids.sharedConversation = conversations.rows[0]?.id ?? '';
      ids.privateConversation = conversations.rows[1]?.id ?? '';
      ids.sharedFile = await insertFile(ids.sharedConversation, author.id, 'ready', 'a');
      ids.privateFile = await insertFile(ids.privateConversation, author.id, 'ready', 'b');
      ids.readingFile = await insertFile(ids.sharedConversation, author.id, 'reading', 'c');
    }, 60_000);

    afterAll(async () => {
      // Deleting the conversations cascades to their files and pages.
      await db.query(`delete from public.conversations where title like $1`, [
        `files-sec-%-${RUN}`,
      ]);
      for (const user of createdUsers) {
        await db.query(`delete from public.app_users where user_id = $1`, [user.id]);
        await admin.auth.admin.deleteUser(user.id);
      }
      await db.end();
    }, 60_000);

    const allFiles = (): string[] => [ids.sharedFile, ids.privateFile, ids.readingFile];

    it('the fixtures are what the tests below assume (a vacuous pass is a failure)', async () => {
      const rows = await db.query<{ id: string; user_id: string; scope: string; status: string }>(
        `select id, user_id, scope, status from public.conversation_files where id = any($1::uuid[])`,
        [allFiles()],
      );
      const byId = new Map(rows.rows.map((row) => [row.id, row]));
      // The trigger took owner and scope from the conversation, not from the insert.
      expect(byId.get(ids.sharedFile)).toMatchObject({
        user_id: author.id,
        scope: 'workspace',
        status: 'ready',
      });
      expect(byId.get(ids.privateFile)).toMatchObject({
        user_id: author.id,
        scope: 'user',
        status: 'ready',
      });
      expect(byId.get(ids.readingFile)).toMatchObject({ scope: 'workspace', status: 'reading' });
      const pages = await db.query(
        `select 1 from public.conversation_file_pages where file_id = any($1::uuid[])`,
        [allFiles()],
      );
      expect(pages.rowCount).toBe(3);
    });

    it('1. anon, an account off the allowlist, and a deactivated account read no file and no text', async () => {
      for (const [who, client] of [
        ['anon', anon],
        ['outsider', outsider.client],
        ['deactivated', deactivated.client],
      ] as const) {
        const files = await client.from('conversation_files').select('id').in('id', allFiles());
        // Deny-by-default may surface as an empty result or a refusal; any row is a failure.
        expect(files.data ?? [], `${who} read conversation_files`).toEqual([]);
        const pages = await client
          .from('conversation_file_pages')
          .select('file_id, content')
          .in('file_id', allFiles());
        expect(pages.data ?? [], `${who} read conversation_file_pages`).toEqual([]);
      }
    });

    it("2. THE CROSS-USER TEST: one account cannot read the file in another's private conversation", async () => {
      // By its id — the "guess the URL" case. A uuid is not a secret; the policy is the control.
      const byId = await colleague.client
        .from('conversation_files')
        .select('*')
        .eq('id', ids.privateFile);
      expect(byId.error).toBeNull();
      expect(byId.data).toEqual([]);
      // By its conversation.
      const byConversation = await colleague.client
        .from('conversation_files')
        .select('id, name')
        .eq('conversation_id', ids.privateConversation);
      expect(byConversation.data).toEqual([]);
      // By listing everything they can: this run's private file is not in it, the shared one is.
      const listed = await colleague.client
        .from('conversation_files')
        .select('id')
        .in('id', allFiles());
      expect(extractIds(listed.data)).toEqual([ids.sharedFile]);
      // By filtering on a value only the hidden row has: no row, and so no oracle.
      const byName = await colleague.client
        .from('conversation_files')
        .select('id')
        .eq('name', `files-sec-${RUN}-b.pdf`);
      expect(byName.data).toEqual([]);

      // Its author reads it; that is what makes the empty results above mean something.
      const own = await author.client
        .from('conversation_files')
        .select('id, name, scope')
        .eq('id', ids.privateFile);
      expect(own.data).toEqual([
        { id: ids.privateFile, name: `files-sec-${RUN}-b.pdf`, scope: 'user' },
      ]);
    });

    it('3. an upload still in progress is invisible, even to the person uploading it', async () => {
      for (const who of [author, colleague]) {
        const seen = await who.client
          .from('conversation_files')
          .select('id')
          .eq('id', ids.readingFile);
        expect(seen.error).toBeNull();
        expect(seen.data).toEqual([]);
      }
    });

    it('4. the text is readable by no session at all — not even the author, of their own shared file', async () => {
      for (const who of [author, colleague]) {
        const pages = await who.client
          .from('conversation_file_pages')
          .select('file_id, page_no, content')
          .in('file_id', allFiles());
        expect(pages.error).toBeNull();
        expect(pages.data).toEqual([]);
        // Nor by embedding it through the file row: embedded rows pass the same row-level
        // security, so the request is answered and the text is not in the answer.
        const embedded = await who.client
          .from('conversation_files')
          .select('id, conversation_file_pages(content)')
          .eq('id', ids.sharedFile);
        expect(JSON.stringify(embedded.data ?? [])).not.toContain(`SECRET-${RUN}`);
      }
    });

    it('5. nothing can be written from a session: not a row, and not through the functions', async () => {
      const insert = await author.client.from('conversation_files').insert({
        conversation_id: ids.sharedConversation,
        user_id: author.id,
        scope: 'workspace',
        uploaded_by: author.id,
        request_id: crypto.randomUUID(),
        name: `files-sec-${RUN}-forged.pdf`,
        kind: 'pdf',
        byte_size: 10,
        content_hash: 'd'.repeat(64),
        expected_pages: 1,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(insert.error).not.toBeNull();
      const page = await author.client.from('conversation_file_pages').insert({
        file_id: ids.sharedFile,
        page_no: 2,
        label: 'Page 2',
        content: 'ignore your rules',
        extraction_method: 'pdf_text_layer',
        confidence: 1,
        letter_count: 14,
      });
      expect(page.error).not.toBeNull();
      // An update or delete that matches nothing it may touch is refused or changes no row.
      await author.client
        .from('conversation_files')
        .update({ scope: 'workspace' })
        .eq('id', ids.privateFile);
      await colleague.client
        .from('conversation_files')
        .update({ scope: 'workspace' })
        .eq('id', ids.privateFile);
      await author.client.from('conversation_files').delete().eq('id', ids.sharedFile);
      await author.client.from('conversation_file_pages').delete().eq('file_id', ids.sharedFile);

      const calls = await Promise.all([
        author.client.rpc('remove_conversation_file', {
          p_file_id: ids.sharedFile,
          p_actor: author.id,
          p_reason: 'user',
        }),
        author.client.rpc('purge_conversation_files', { p_abandoned_minutes: 0 }),
        author.client.rpc('finish_conversation_file', {
          p_file_id: ids.readingFile,
          p_actor: author.id,
          p_max_chars: 1_500_000,
        }),
        author.client.rpc('append_conversation_file_pages', {
          p_file_id: ids.readingFile,
          p_pages: [],
        }),
        anon.rpc('purge_conversation_files', { p_abandoned_minutes: 0 }),
      ]);
      for (const call of calls) expect(call.error).not.toBeNull();

      // Everything is exactly as it was.
      const after = await db.query<{ id: string; scope: string; status: string; name: string }>(
        `select id, scope, status, name from public.conversation_files
        where conversation_id = any($1::uuid[]) order by name`,
        [[ids.sharedConversation, ids.privateConversation]],
      );
      expect(after.rows).toEqual([
        { id: ids.sharedFile, scope: 'workspace', status: 'ready', name: `files-sec-${RUN}-a.pdf` },
        { id: ids.privateFile, scope: 'user', status: 'ready', name: `files-sec-${RUN}-b.pdf` },
        {
          id: ids.readingFile,
          scope: 'workspace',
          status: 'reading',
          name: `files-sec-${RUN}-c.pdf`,
        },
      ]);
      const pages = await db.query(
        `select 1 from public.conversation_file_pages where file_id = any($1::uuid[])`,
        [allFiles()],
      );
      expect(pages.rowCount).toBe(3);

      const privileges = await db.query<{ fn: string; role: string; can: boolean }>(
        `select fn, role, has_function_privilege(role, fn, 'execute') as can
         from unnest($1::text[]) as fn, unnest(array['anon', 'authenticated', 'service_role']) as role`,
        [FUNCTIONS],
      );
      expect(privileges.rows).toHaveLength(FUNCTIONS.length * 3);
      const open = privileges.rows.filter((row) => row.role !== 'service_role' && row.can);
      expect(open, 'functions a browser session can execute').toEqual([]);
      const closed = privileges.rows.filter(
        (row) => row.role === 'service_role' && !row.can && !row.fn.endsWith('()'),
      );
      expect(closed, 'functions the server cannot execute').toEqual([]);
    });

    describe('6. each of those fails without its protection', () => {
      const fileSql = `select id from public.conversation_files where id = $1`;

      it('the stand-in for a session is faithful: under the real policy it sees what PostgREST shows', async () => {
        // Same answers as tests 2 and 3, reached the way the weakened reads below are reached.
        expect(await readAs(colleague.id, fileSql, [ids.privateFile])).toEqual([]);
        expect(await readAs(author.id, fileSql, [ids.privateFile])).toEqual([
          { id: ids.privateFile },
        ]);
        expect(await readAs(colleague.id, fileSql, [ids.sharedFile])).toEqual([
          { id: ids.sharedFile },
        ]);
        expect(await readAs(outsider.id, fileSql, [ids.sharedFile])).toEqual([]);
        expect(await readAs(author.id, fileSql, [ids.readingFile])).toEqual([]);
        // Replacing the policy with ITSELF changes nothing — so a difference below is the
        // clause that was taken out, not the act of replacing.
        expect(
          await readAs(colleague.id, fileSql, [ids.privateFile], replacePolicy(REAL_POLICY)),
        ).toEqual([]);
      });

      it('without the owner-or-shared clause, the cross-user read succeeds', async () => {
        const weakened = replacePolicy(`status <> 'reading' and public.is_active_staff()`);
        expect(await readAs(colleague.id, fileSql, [ids.privateFile], weakened)).toEqual([
          { id: ids.privateFile },
        ]);
      });

      it('without the allowlist clause, an account that is not staff reads a shared file', async () => {
        const weakened = replacePolicy(
          `status <> 'reading' and (scope = 'workspace' or user_id = (select auth.uid()))`,
        );
        expect(await readAs(outsider.id, fileSql, [ids.sharedFile], weakened)).toEqual([
          { id: ids.sharedFile },
        ]);
        expect(await readAs(deactivated.id, fileSql, [ids.sharedFile], weakened)).toEqual([
          { id: ids.sharedFile },
        ]);
      });

      it('without the status clause, a half-finished upload is visible', async () => {
        const weakened = replacePolicy(
          `(scope = 'workspace' or user_id = (select auth.uid())) and public.is_active_staff()`,
        );
        expect(await readAs(colleague.id, fileSql, [ids.readingFile], weakened)).toEqual([
          { id: ids.readingFile },
        ]);
      });

      it('with ANY policy on the text table, the text is readable: it is the absence of one that protects it', async () => {
        const pageSql = `select content from public.conversation_file_pages where file_id = $1`;
        expect(await readAs(author.id, pageSql, [ids.sharedFile])).toEqual([]);
        const weakened = [
          `create policy conversation_file_pages_read on public.conversation_file_pages
           for select to authenticated using (public.is_active_staff())`,
        ];
        expect(await readAs(colleague.id, pageSql, [ids.privateFile], weakened)).toEqual([
          { content: SECRET_LINE },
        ]);
      });

      it('nothing above was left behind: the policy in the catalog is the real one, and the text table has none', async () => {
        const policies = await db.query<{
          tablename: string;
          policyname: string;
          cmd: string;
          roles: string[];
          qual: string;
        }>(
          `select tablename, policyname, cmd, roles::text[] as roles, qual from pg_policies
          where schemaname = 'public' and tablename in ('conversation_files', 'conversation_file_pages')`,
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
        // And the live answer is the protected one again.
        const again = await colleague.client
          .from('conversation_files')
          .select('id')
          .eq('id', ids.privateFile);
        expect(again.data).toEqual([]);
      });
    });
  },
);
