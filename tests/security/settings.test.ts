/**
 * The settings page — who can see and who can forget (Milestone 5 part 4, Part D item 12) —
 * against a real Supabase stack: GoTrue sessions, PostgREST, row-level security, the settings
 * handler over the real stores, and `forget_document` with its check under the locks.
 *
 * What "another account's documents" means in this app: knowledge is the ACCOUNT's (part 5,
 * decision 3), so every active member of staff sees every learned document. The accounts that
 * must see nothing are the ones outside it — a signed-in account that is not on the staff list,
 * and a member who has been switched off. And the one that must not FORGET is a member of staff
 * who is not an administrator, for a document someone else added — including one whose copy sits
 * in a colleague's PRIVATE conversation. The protection is the permission block in
 * `forget_document` (migration 20261017020000); without it, the "not allowed" cases below fail
 * — shown on 17 Oct by running the same assertions against the function with that block removed.
 *
 * Connector keys are each person's: a colleague never lists another person's key and cannot
 * switch it off, and the key itself is in no table anybody can read.
 */
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';
import {
  SettingsStack,
  hashFor,
  vector,
  type SeededDocument,
  type StackUser,
} from '../helpers/settingsStack.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);
const AXIS = 311;
const CANARY = `SETTINGS-SECURITY-CANARY-${RUN}`;

describe.skipIf(env === null)(
  'the settings page — who can see and forget (requires a running Supabase stack)',
  () => {
    const stack = new SettingsStack(
      env ?? {
        url: 'http://stack-not-running.invalid',
        anonKey: 'unset',
        serviceRoleKey: 'unset',
        dbUrl: 'postgresql://stack-not-running.invalid/postgres',
      },
      RUN,
    );
    let admin: StackUser;
    let author: StackUser;
    let colleague: StackUser;
    let outsider: StackUser;
    let switchedOff: StackUser;
    let authors: SeededDocument;
    let shared: SeededDocument;
    let sharedPrivateCopy: SeededDocument;
    let authorsPrivate = '';

    beforeAll(async () => {
      await stack.connect();
      admin = await stack.user('admin', { active: true, admin: true });
      author = await stack.user('author', { active: true, admin: false });
      colleague = await stack.user('colleague', { active: true, admin: false });
      outsider = await stack.user('outsider', null);
      switchedOff = await stack.user('off', { active: false, admin: false });
      const authorsShared = await stack.conversation(author, 'workspace');
      authorsPrivate = await stack.conversation(author, 'user');
      const colleaguesShared = await stack.conversation(colleague, 'workspace');
      authors = await stack.attach(authorsShared, author, hashFor(RUN, 1), CANARY, 'ready', AXIS);
      // The colleague's document, and the author's copy of the same bytes in the author's
      // PRIVATE conversation — which the colleague cannot see.
      shared = await stack.attach(
        colleaguesShared,
        colleague,
        hashFor(RUN, 2),
        CANARY,
        'ready',
        AXIS,
      );
      sharedPrivateCopy = await stack.attach(
        authorsPrivate,
        author,
        hashFor(RUN, 2),
        CANARY,
        'ready',
        AXIS,
      );
    });

    afterAll(async () => {
      await stack.cleanup();
    });

    it('forget_document is the server’s alone: no session can call it, whoever it is', async () => {
      const signedOut = createClient(stack.cfg.url, stack.cfg.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      for (const client of [signedOut, outsider.client, colleague.client, admin.client]) {
        const call = await client.rpc('forget_document', {
          p_source_id: authors.sourceId,
          p_actor: admin.id,
        });
        expect(call.error).not.toBeNull();
      }
      expect(await stack.state(authors)).toEqual({
        source: 'ready',
        chunks: 3,
        file: 'ready',
        pages: 1,
      });
    });

    it('an account outside the staff list, or switched off, sees no learned document and forgets none', async () => {
      for (const user of [outsider, switchedOff]) {
        const read = await user.client.from('knowledge_sources').select('id, name');
        expect(read.data ?? []).toEqual([]);
        const result = await stack.ask(user, {
          action: 'forget_document',
          sourceId: authors.sourceId,
        });
        expect(result.status).toBe(403);
      }
      expect(await stack.state(authors)).toEqual({
        source: 'ready',
        chunks: 3,
        file: 'ready',
        pages: 1,
      });
    });

    it('a colleague sees the author’s document (knowledge is the account’s) and cannot forget it', async () => {
      const read = await colleague.client
        .from('knowledge_sources')
        .select('id, name, uploaded_by')
        .eq('id', authors.sourceId);
      expect(read.data).toEqual([
        { id: authors.sourceId, name: `Settings doc ${RUN}.pdf`, uploaded_by: author.id },
      ]);
      const result = await stack.ask(colleague, {
        action: 'forget_document',
        sourceId: authors.sourceId,
      });
      expect(result.status).toBe(403);
      expect(JSON.stringify(result.body)).toContain('NOT_YOURS');
      // Nothing moved: the passages, the summary, the attachment and its text are all there.
      expect(await stack.state(authors)).toEqual({
        source: 'ready',
        chunks: 3,
        file: 'ready',
        pages: 1,
      });
    });

    it('a colleague cannot forget even their OWN document while a copy sits in someone else’s private conversation', async () => {
      // The colleague cannot see the author's private conversation...
      const hidden = await colleague.client
        .from('conversation_files')
        .select('id')
        .eq('id', sharedPrivateCopy.fileId);
      expect(hidden.data ?? []).toEqual([]);
      // ...and forgetting their own copy would remove the text from it, so it is refused.
      const result = await stack.ask(colleague, {
        action: 'forget_document',
        sourceId: shared.sourceId,
      });
      expect(result.status).toBe(403);
      expect(await stack.state(shared)).toEqual({
        source: 'ready',
        chunks: 3,
        file: 'ready',
        pages: 1,
      });
      expect(await stack.state(sharedPrivateCopy)).toEqual({
        source: 'ready',
        chunks: 3,
        file: 'ready',
        pages: 1,
      });
    });

    it('the author may forget what they alone added; an administrator may forget anyone’s, every copy', async () => {
      const own = await stack.ask(author, {
        action: 'forget_document',
        sourceId: authors.sourceId,
      });
      expect(own).toMatchObject({
        status: 200,
        body: { outcome: 'forgotten', sources: 1, files: 1, chunks: 3 },
      });
      expect(await stack.state(authors)).toEqual({
        source: 'forgotten',
        chunks: 0,
        file: 'removed',
        pages: 0,
      });

      // An answer the assistant gave from the copy, in the author's PRIVATE conversation.
      await stack.db.query(
        `insert into public.messages (conversation_id, user_id, scope, role, content, document_coverage)
         values ($1, $2, 'user', 'assistant', 'An answer.', $3::jsonb)`,
        [
          authorsPrivate,
          author.id,
          JSON.stringify({
            v: 1,
            documents: [
              {
                file: sharedPrivateCopy.fileId,
                origin: 'attached',
                kind: 'pdf',
                mode: 'whole',
                pages: [1],
                total: 1,
              },
            ],
          }),
        ],
      );
      const admins = await stack.ask(admin, {
        action: 'forget_document',
        sourceId: shared.sourceId,
      });
      // The administrator is told THAT one conversation still holds an answer from it — a
      // number — and nothing of which, whose, or what it says.
      expect(admins).toMatchObject({
        status: 200,
        body: {
          outcome: 'forgotten',
          sources: 2,
          files: 2,
          chunks: 6,
          conversationsWithAnswers: 1,
        },
      });
      expect(JSON.stringify(admins.body)).not.toContain(authorsPrivate);
      expect(stack.lines.join('\n')).not.toContain(authorsPrivate);
      expect(await stack.state(shared)).toEqual({
        source: 'forgotten',
        chunks: 0,
        file: 'removed',
        pages: 0,
      });
      expect(await stack.state(sharedPrivateCopy)).toEqual({
        source: 'forgotten',
        chunks: 0,
        file: 'removed',
        pages: 0,
      });
      // And retrieval, as the server runs it, finds none of it.
      const found = await stack.knowledge.match(vector(AXIS), {
        userId: admin.id,
        attachedFileIds: [],
        excludeFileIds: [],
        includeLearned: true,
        sections: [],
        limit: 20,
        minSimilarity: 0,
        attachedMinSimilarity: 0,
      });
      expect(found.ok).toBe(true);
      if (found.ok) expect(found.value.filter((c) => c.content.includes(CANARY))).toEqual([]);
    });

    it('the audit trail names who forgot, by id — never a name, never a word', async () => {
      const rows = await stack.db.query<{ actor: string; action: string; body: string }>(
        `select actor, action, coalesce(before::text, '') || coalesce(after::text, '') as body
           from public.audit_log
          where entity_id = any($1::uuid[]) and action in ('KNOWLEDGE_FORGOTTEN', 'FILE_REMOVED')
          order by action, actor`,
        [
          [
            authors.sourceId,
            authors.fileId,
            shared.sourceId,
            shared.fileId,
            sharedPrivateCopy.sourceId,
            sharedPrivateCopy.fileId,
          ],
        ],
      );
      expect(
        rows.rows
          .map((r) => [
            r.action,
            r.actor === admin.id ? 'admin' : r.actor === author.id ? 'author' : 'other',
          ])
          .sort(),
      ).toEqual(
        [
          ['FILE_REMOVED', 'admin'],
          ['FILE_REMOVED', 'admin'],
          ['FILE_REMOVED', 'author'],
          ['KNOWLEDGE_FORGOTTEN', 'admin'],
          ['KNOWLEDGE_FORGOTTEN', 'admin'],
          ['KNOWLEDGE_FORGOTTEN', 'author'],
        ].sort(),
      );
      for (const row of rows.rows) {
        expect(row.body).not.toContain(CANARY);
        expect(row.body).not.toContain('Settings doc');
      }
    });

    it('connector keys: a colleague never lists another person’s key, cannot switch it off, and the key is in no table', async () => {
      const made = await stack.ask(author, { action: 'create_key', label: `Author laptop ${RUN}` });
      expect(made.status).toBe(200);
      const body = made.body as { keyId: string; key: string };
      const own = await author.client.from('connector_keys').select('key_id');
      expect((own.data ?? []).map((r: { key_id: string }) => r.key_id)).toContain(body.keyId);
      const theirs = await colleague.client.from('connector_keys').select('key_id');
      expect((theirs.data ?? []).map((r: { key_id: string }) => r.key_id)).not.toContain(
        body.keyId,
      );
      const refused = await stack.ask(colleague, { action: 'revoke_key', keyId: body.keyId });
      expect(refused.status).toBe(404);
      const still = await stack.db.query<{ revoked_at: string | null }>(
        'select revoked_at from public.connector_keys where key_id = $1',
        [body.keyId],
      );
      expect(still.rows[0]?.revoked_at).toBeNull();
      // Stored as its digest only, in a table no session reads; the key itself nowhere.
      const digest = createHash('sha256').update(body.key).digest('hex');
      const secrets = await stack.db.query<{ hex: string }>(
        `select encode(x.key_hash, 'hex') as hex from public.connector_key_secrets x
           join public.connector_keys k on k.id = x.connector_key_id where k.key_id = $1`,
        [body.keyId],
      );
      expect(secrets.rows[0]?.hex).toBe(digest);
      const readable = await author.client.from('connector_key_secrets').select('*');
      expect(readable.data ?? []).toEqual([]);
      const anywhere = await stack.db.query<{ n: number }>(
        `select count(*)::int as n from (
           select row_to_json(k)::text as t from public.connector_keys k where k.key_id = $1
           union all
           select row_to_json(a)::text from public.audit_log a where a.actor = $2
         ) rows where t like '%' || $3 || '%'`,
        [body.keyId, author.id, body.key.slice(body.key.lastIndexOf('_') + 1)],
      );
      expect(anywhere.rows[0]?.n).toBe(0);
      expect(stack.lines.join('\n')).not.toContain(body.key);
    });
  },
);
