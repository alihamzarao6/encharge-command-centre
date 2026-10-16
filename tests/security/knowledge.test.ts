/**
 * Who can reach learned knowledge (Milestone 5 part 5) — against a real Supabase stack: GoTrue
 * sessions, PostgREST, row-level security, pgvector.
 *
 * Part D item 15, "one account cannot retrieve another's knowledge". This app is one business's
 * workspace: knowledge is shared by its staff (decision 3) and must reach nobody else. So the
 * accounts that must get NOTHING are the ones outside it — a signed-out browser, a signed-in
 * account that is not on the staff list, and a member who has been deactivated — through every
 * path there is: reading the tables, calling the functions, writing to them, and asking the
 * assistant. And the one that must get it — a teammate, from a document attached in the author's
 * PRIVATE conversation — gets it through the real adapter and the real vector search.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServiceClient, supabaseVerifyDeps } from '../../src/lib/auth/clients.js';
import { ok } from '../../src/lib/errors.js';
import { createTurnDocuments } from '../../src/lib/files/context.js';
import { createFilesServiceClient, supabaseFileStore } from '../../src/lib/files/store.js';
import { KNOWLEDGE_DEFAULTS } from '../../src/lib/knowledge/config.js';
import {
  createKnowledgeServiceClient,
  supabaseKnowledgeStore,
} from '../../src/lib/knowledge/store.js';
import { handleChatTurn, type ChatDeps } from '../../src/lib/llm/chat.js';
import { supabaseConversationStore } from '../../src/lib/llm/store.js';
import { createLogger } from '../../src/lib/logger.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';
import { completion, scriptedClaude } from '../unit/files/helpers.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);
const DIMS = 1024;
const SECRET_TEXT = `Week one: book fifty discovery calls. KNOWLEDGE-CANARY-${RUN}`;

const cfg = env ?? {
  url: 'http://stack-not-running.invalid',
  anonKey: 'unset',
  serviceRoleKey: 'unset',
  dbUrl: 'postgresql://stack-not-running.invalid/postgres',
};

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly token: string;
  readonly client: SupabaseClient;
}

function vector(axis: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[axis] = 1;
  return v;
}

const TABLES = ['knowledge_sources', 'knowledge_chunks', 'knowledge_drain_state'] as const;

describe.skipIf(env === null)(
  'learned knowledge — who can reach it (requires a running Supabase stack)',
  () => {
    const db = new pg.Client({ connectionString: cfg.dbUrl });
    const admin = createClient(cfg.url, cfg.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anon = createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const service = createServiceClient(cfg);
    const knowledge = supabaseKnowledgeStore(createKnowledgeServiceClient(cfg));
    const log = createLogger({ level: 'silent' });
    const created: TestUser[] = [];
    let author: TestUser;
    let colleague: TestUser;
    let outsider: TestUser;
    let deactivated: TestUser;
    const conversation = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    let sourceId = '';

    async function createUser(label: string, allowlisted: boolean): Promise<TestUser> {
      const email = `knowledge-sec-${label}-${RUN}@example.com`;
      const password = crypto.randomUUID();
      const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (made.error !== null) throw new Error(`createUser ${label}: ${made.error.message}`);
      const id = made.data.user.id;
      if (allowlisted) {
        await db.query(
          `insert into public.app_users (user_id, email, role, is_active) values ($1, $2, 'staff', true)`,
          [id, email],
        );
      }
      // Signed in on a client of its own: signing in through `anon` would leave `anon` holding
      // that session, and the signed-out checks below would test a signed-in user (found 17 Oct
      // in the Drive suite, where it made "anon is refused outright" fail).
      const signer = createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const signIn = await signer.auth.signInWithPassword({ email, password });
      if (signIn.error !== null) throw new Error(`signIn ${label}: ${signIn.error.message}`);
      const token = signIn.data.session.access_token;
      const client = createClient(cfg.url, cfg.anonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const user = { id, email, token, client };
      created.push(user);
      return user;
    }

    /** A real turn, through the real verify, store and search; the model is scripted. */
    function chatAs(): {
      deps: ChatDeps;
      claude: ReturnType<typeof scriptedClaude>;
      queries: () => number;
    } {
      const claude = scriptedClaude(ok(completion('An answer.')));
      let queries = 0;
      return {
        claude,
        queries: () => queries,
        deps: {
          verify: supabaseVerifyDeps(service),
          claude,
          conversations: supabaseConversationStore(service),
          log,
          documents: createTurnDocuments(
            supabaseFileStore(createFilesServiceClient(cfg)),
            48_000,
            () => new Date(),
            {
              sourcesForFiles: (ids) => knowledge.sourcesForFiles(ids),
              match: (q, p) => knowledge.match(q, p),
              neighbours: (s, o) => knowledge.neighbours(s, o),
              summaries: (s) => knowledge.summariesOf(s),
              anyReady: () => knowledge.anyReady(),
              config: { ...KNOWLEDGE_DEFAULTS.retrieval, minSimilarity: 0.9 },
              log,
            },
          ),
          query: {
            embed: () => {
              queries += 1;
              return Promise.resolve(
                ok({ vector: vector(7), text: '', aboutDocuments: true, overview: false }),
              );
            },
          },
        },
      };
    }

    beforeAll(async () => {
      await db.connect();
      author = await createUser('author', true);
      colleague = await createUser('colleague', true);
      outsider = await createUser('outsider', false);
      deactivated = await createUser('deactivated', true);
      await db.query('update public.app_users set is_active = false where user_id = $1', [
        deactivated.id,
      ]);

      // A document in the AUTHOR'S PRIVATE conversation, attached the way the files function does it.
      await db.query(
        `insert into public.conversations (id, user_id, scope) values ($1, $2, 'user')`,
        [conversation, author.id],
      );
      await db.query(
        `insert into public.conversation_files (id, conversation_id, user_id, scope, uploaded_by, request_id, name, kind, byte_size, content_hash, expected_pages, expires_at)
       values ($1, $2, $3, 'user', $3, gen_random_uuid(), $4, 'pdf', 1000, $5, 1, now() + interval '30 days')`,
        [fileId, conversation, author.id, `Course transcript ${RUN}.pdf`, RUN.padEnd(64, '0')],
      );
      await db.query('select public.append_conversation_file_pages($1, $2::jsonb)', [
        fileId,
        JSON.stringify([
          {
            page_no: 1,
            label: 'Page 1',
            content: SECRET_TEXT,
            extraction_method: 'pdf_text_layer',
            confidence: 1,
            legibility: 'full',
            letter_count: 40,
          },
        ]),
      ]);
      await db.query('select public.finish_conversation_file($1, $2, 1000000)', [
        fileId,
        author.id,
      ]);
      const source = await db.query<{ id: string }>(
        'select id from public.knowledge_sources where file_id = $1',
        [fileId],
      );
      sourceId = source.rows[0]?.id ?? '';
      const captured = await knowledge.capture(
        sourceId,
        'c1-1500-200',
        [
          {
            ordinal: 1,
            pageNo: 1,
            pageLabel: 'Page 1',
            method: 'pdf_text_layer',
            legibility: 'full',
            section: null,
            charStart: 0,
            charEnd: SECRET_TEXT.length,
            content: SECRET_TEXT,
          },
        ],
        false,
      );
      if (!captured.ok) throw captured.error;
      const embedded = await knowledge.attachEmbeddings(sourceId, [
        { ordinal: 1, vector: vector(7) },
      ]);
      if (!embedded.ok || embedded.value.status !== 'ready')
        throw new Error('the test document did not become ready');
    });

    afterAll(async () => {
      const ids = created.map((u) => u.id);
      await db.query('delete from public.knowledge_sources where id = $1', [sourceId]);
      await db.query('delete from public.messages where user_id = any($1::uuid[])', [ids]);
      await db.query('delete from public.conversation_files where conversation_id = $1', [
        conversation,
      ]);
      await db.query('delete from public.conversations where user_id = any($1::uuid[])', [ids]);
      await db.query(
        `delete from public.audit_log where entity_type = 'conversation_files' and actor = any($1::text[])`,
        [ids],
      );
      await db.query('delete from public.app_users where user_id = any($1::uuid[])', [ids]);
      for (const user of created) await admin.auth.admin.deleteUser(user.id);
      await db.end();
    });

    it('a signed-out browser, a non-member and a deactivated member read NOTHING from any knowledge table', async () => {
      for (const [who, client] of [
        ['anon', anon],
        ['outsider', outsider.client],
        ['deactivated', deactivated.client],
      ] as const) {
        for (const table of TABLES) {
          const res = await client.from(table).select('*', { count: 'exact', head: true });
          expect(res.count ?? 0, `${who} read ${table}`).toBe(0);
          // Signed out, there is no privilege at all: refused outright, not merely empty.
          if (who === 'anon') expect(res.error, `${who} on ${table}`).not.toBeNull();
        }
      }
    });

    it('a teammate reads the NAME of a document from the author’s private conversation — and never a word of its text', async () => {
      const names = await colleague.client
        .from('knowledge_sources')
        .select('id, name')
        .eq('id', sourceId);
      expect(names.data).toEqual([{ id: sourceId, name: `Course transcript ${RUN}.pdf` }]);
      const chunks = await colleague.client
        .from('knowledge_chunks')
        .select('content', { count: 'exact', head: true });
      expect(chunks.count ?? 0).toBe(0);
      const ownChunks = await author.client
        .from('knowledge_chunks')
        .select('content')
        .eq('source_id', sourceId);
      expect(ownChunks.data ?? []).toEqual([]);
    });

    it('no session can search, write, forget or drain through the functions — and nothing changes', async () => {
      for (const user of [colleague, outsider, deactivated]) {
        const search = await user.client.rpc('match_knowledge_chunks', {
          p_query: JSON.stringify(vector(7)),
          p_user_id: user.id,
          p_attached_file_ids: [],
          p_exclude_file_ids: [],
          p_include_learned: true,
          p_sections: [],
          p_limit: 5,
          p_min_similarity: 0,
          p_attached_min_similarity: 0,
        });
        expect(search.error, `${user.email} searched`).not.toBeNull();
        expect(JSON.stringify(search.data ?? null)).not.toContain('KNOWLEDGE-CANARY');
        for (const [fn, args] of [
          [
            'capture_knowledge_source',
            { p_source_id: sourceId, p_chunker_version: 'x', p_chunks: [] },
          ],
          ['attach_knowledge_embeddings', { p_source_id: sourceId, p_embeddings: [] }],
          [
            'forget_knowledge',
            { p_source_id: sourceId, p_content_hash: null, p_actor: user.id, p_reason: 'user' },
          ],
          ['claim_knowledge_drain', { p_holder: user.id, p_lease_seconds: 600 }],
          ['knowledge_neighbours', { p_source_id: sourceId, p_ordinals: [1] }],
        ] as const) {
          const call = await user.client.rpc(fn, args);
          expect(call.error, `${user.email} → ${fn}`).not.toBeNull();
        }
        const write = await user.client
          .from('knowledge_sources')
          .update({ name: 'pwned' })
          .eq('id', sourceId)
          .select('id');
        expect(write.data ?? []).toEqual([]);
        const insert = await user.client.from('knowledge_chunks').insert({
          source_id: sourceId,
          ordinal: 99,
          page_no: 1,
          page_label: 'x',
          extraction_method: 'plain_text',
          char_start: 0,
          char_end: 1,
          content: 'x',
        });
        expect(insert.error).not.toBeNull();
      }
      const still = await db.query(
        'select status, name from public.knowledge_sources where id = $1',
        [sourceId],
      );
      expect(still.rows[0]).toEqual({ status: 'ready', name: `Course transcript ${RUN}.pdf` });
    });

    it('asking the assistant: a non-member and a deactivated member are refused before any search; a teammate gets the passage', async () => {
      for (const user of [outsider, deactivated]) {
        const turn = chatAs();
        const result = await handleChatTurn(turn.deps, {
          token: user.token,
          message: 'what happens in week one',
        });
        expect(result.status).toBe(403);
        expect(turn.queries()).toBe(0);
        expect(turn.claude.calls).toHaveLength(0);
      }
      const turn = chatAs();
      const result = await handleChatTurn(turn.deps, {
        token: colleague.token,
        message: 'what happens in week one',
      });
      expect(result.status).toBe(200);
      expect(turn.queries()).toBe(1);
      const request = JSON.stringify(turn.claude.calls[0]);
      expect(request).toContain(`KNOWLEDGE-CANARY-${RUN}`);
      expect(request).toContain('from=\\"learned earlier, in another conversation\\"');
      // And the note's record was stored on the reply as ids and numbers: no name, no text.
      const saved = await db.query<{ document_coverage: unknown }>(
        `select document_coverage from public.messages where user_id = $1 and role = 'assistant' order by created_at desc limit 1`,
        [colleague.id],
      );
      const coverage = JSON.stringify(saved.rows[0]?.document_coverage);
      expect(coverage).toContain(sourceId);
      expect(coverage).not.toContain('Course transcript');
      expect(coverage).not.toContain('KNOWLEDGE-CANARY');
    });

    it('the vector search the adapter calls refuses a caller who is not active staff, even as service_role', async () => {
      for (const user of [outsider, deactivated]) {
        const found = await knowledge.match(vector(7), {
          userId: user.id,
          attachedFileIds: [],
          excludeFileIds: [],
          includeLearned: true,
          sections: [],
          limit: 5,
          minSimilarity: 0,
          attachedMinSimilarity: 0,
        });
        expect(found.ok && found.value.filter((c) => c.sourceId === sourceId)).toEqual([]);
      }
      const teammate = await knowledge.match(vector(7), {
        userId: colleague.id,
        attachedFileIds: [],
        excludeFileIds: [],
        includeLearned: true,
        sections: [],
        limit: 5,
        minSimilarity: 0.9,
        attachedMinSimilarity: 0.9,
      });
      expect(teammate.ok && teammate.value.map((c) => c.sourceId)).toContain(sourceId);
    });
  },
);
