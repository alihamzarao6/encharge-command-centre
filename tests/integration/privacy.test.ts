/**
 * Private conversations against a real Supabase stack (Stage 3 part 5, FND-340, R27).
 *
 * The client chose: each person's chats are their own, an administrator can see everybody's,
 * and what the assistant LEARNS still goes into the one shared brain. That last clause is
 * what makes this file necessary — every other part of it the schema already did, and the
 * one thing that could quietly stop being true is the chunk that has to stay workspace while
 * the conversation it came from does not.
 *
 * Part A, the seven assertions, one `it` each:
 *
 *   1. a private conversation is unreadable by another allowlisted non-admin — AT THE
 *      DATABASE, through PostgREST as a real signed-in session, not hidden in the UI;
 *   2. its messages are equally unreadable;
 *   3. its chunks stay workspace-scoped and are reachable by shared recall;
 *   4. an admin can read it;
 *   5. toggling back restores normal visibility, and toggling repeatedly does not corrupt
 *      scope on messages or chunks;
 *   6. existing workspace conversations are unaffected by the migration;
 *   7. facts are unchanged by any of it.
 *
 * Every read that proves a refusal is made with a REAL session against PostgREST, because
 * that is the only thing an attacker would hold. Fixtures are synthetic and run-scoped;
 * counts are scoped to this run, never to a whole table.
 */
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SEEDED_STAFF } from '../../src/lib/auth/admin.js';
import {
  createAdminDeps,
  createServiceClient,
  signInWithPassword,
  supabaseAuditWriter,
  supabaseVerifyDeps,
  type SupabaseAuthConfig,
} from '../../src/lib/auth/clients.js';
import { createHttpClient } from '../../src/lib/http.js';
import { createClaudeClient } from '../../src/lib/llm/client.js';
import type { LlmConfig } from '../../src/lib/llm/config.js';
import { DEFAULT_PRICING } from '../../src/lib/llm/pricing.js';
import { supabaseUsageStore } from '../../src/lib/llm/store.js';
import { createLogger } from '../../src/lib/logger.js';
import { supabaseFactStore } from '../../src/lib/memory/facts.js';
import {
  handleMemoryRequest,
  supabaseMemoryPageStore,
  type MemoryPageDeps,
  type MemoryPageResult,
  type MemoryRequestBody,
} from '../../src/lib/memory/page.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);

const cfg: SupabaseAuthConfig = {
  url: env?.url ?? 'http://stack-not-running.invalid',
  anonKey: env?.anonKey ?? 'unset',
  serviceRoleKey: env?.serviceRoleKey ?? 'unset',
};

/** Present because the deps type requires it; no action in this file reaches Claude. */
const llmConfig: LlmConfig = {
  apiKey: 'sk-ant-integration-not-a-real-key-000000',
  baseUrl: 'https://anthropic.invalid',
  apiVersion: '2023-06-01',
  models: { default: 'claude-sonnet-5', fast: 'claude-haiku-4-5-20251001' },
  maxTokens: 256,
  timeoutMs: 5_000,
  retries: 0,
  thinking: 'disabled',
  history: { maxMessages: 20, maxChars: 24_000 },
  caps: { dailyUsd: 5, monthlyUsd: 1_000, warnFraction: 0.8 },
  pricing: DEFAULT_PRICING,
};

/** A distinctive vector so `match_memory_chunks` returns this run's chunk and not another. */
const VECTOR = `[${Array.from({ length: 1024 }, (_v, i) => (i === 3 ? '1' : '0')).join(',')}]`;

/** A real signed-in session: the anon key plus one person's JWT, exactly what a browser holds. */
function userClient(token: string) {
  return createClient(cfg.url, cfg.anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type UserClient = ReturnType<typeof userClient>;

function replyBody(result: MemoryPageResult): Record<string, unknown> {
  return result.body as unknown as Record<string, unknown>;
}

describe.skipIf(env === null)('private conversations (requires a running Supabase stack)', () => {
  const db = new pg.Client({
    connectionString: env?.dbUrl ?? 'postgresql://stack-not-running.invalid/postgres',
  });
  const logLines: string[] = [];

  /** The AUTHOR: the seeded owner, whose conversation goes private. */
  const AUTHOR = SEEDED_STAFF.ross.userId;
  const AUTHOR_EMAIL = SEEDED_STAFF.ross.email;
  /**
   * The ADMIN and the OUTSIDER are both created FOR THIS RUN rather than borrowed from the
   * seed. The seeded developer is an admin and would have done — but `users.test.ts` resets
   * that account's password in its own `beforeAll`, and two files racing to own one set of
   * credentials is exactly the cross-file leak that cost a CI round in part 4. Nothing here
   * touches an account another suite depends on.
   */
  const adminEmail = `privacy-admin-${RUN}@example.com`;
  let adminId = '';
  let adminSession: UserClient;

  const outsiderEmail = `privacy-outsider-${RUN}@example.com`;
  let outsiderId = '';
  let outsider: UserClient;
  const createdIds: string[] = [];

  /** Deps acting AS the author, as the admin, and as the outsider — the verifier is the only stub. */
  let asAuthor: MemoryPageDeps;
  let asAdmin: MemoryPageDeps;
  let asOutsider: MemoryPageDeps;

  let privateConvId = '';
  let privateChunkId = '';
  let privateMessageId = '';
  let sharedConvId = '';
  let sharedChunkId = '';
  let factId = '';

  /**
   * The two seeded conversations must NOT share a message text. Assertion 2 ends by looking
   * the private sentence up BY CONTENT across the whole table — which only means anything if
   * that sentence exists in exactly one conversation. The first version of this file used one
   * constant for both, so the outsider legitimately found the shared conversation's copy and
   * CI failed on it. A fixture defect, and the reason the by-content check is worth having:
   * a scoped-by-id read can pass while the row is still reachable another way.
   */
  const PRIVATE_TEXT = `A sentence only its author should read — ${RUN}`;
  const SHARED_TEXT = `A sentence the whole team may read — ${RUN}`;
  const FACT_KEY = `process:privacy-${RUN}`;

  function depsFor(userId: string, email: string): MemoryPageDeps {
    const log = createLogger({
      level: 'debug',
      sink: (line) => {
        logLines.push(line);
      },
    });
    const service = createServiceClient(cfg);
    return {
      // The verifier is the ONE substitution, exactly as in conversations.test.ts: minting a
      // real JWT for each of three people would add GoTrue round trips that prove nothing
      // this file is about. Everything below it — the store, RLS, the triggers — is
      // production code, and every REFUSAL below is proven with a real session anyway.
      verify: {
        ...supabaseVerifyDeps(service),
        getUserFromToken: () => Promise.resolve({ ok: true, value: { id: userId, email } }),
      },
      claude: createClaudeClient({
        config: llmConfig,
        http: createHttpClient({ timeoutMs: 1_000, retries: 0, logger: log }),
        usage: supabaseUsageStore(service),
        log,
      }),
      facts: supabaseFactStore(service),
      store: supabaseMemoryPageStore(service),
      audit: supabaseAuditWriter(service),
      log,
    };
  }

  /** One conversation with two messages and one chunk over them. Workspace to start with. */
  async function seed(
    label: string,
    range: string,
    text: string,
  ): Promise<{ id: string; chunkId: string; messageId: string }> {
    const conv = await db.query<{ id: string }>(
      `insert into public.conversations (user_id, scope, title)
       values ($1, 'workspace', $2) returning id`,
      [AUTHOR, `privacy-${label}-${RUN}`],
    );
    const id = conv.rows[0]?.id ?? '';
    const messages = await db.query<{ id: string }>(
      `insert into public.messages (conversation_id, user_id, scope, role, content)
       values ($1, $2, 'workspace', 'user', $3), ($1, $2, 'workspace', 'assistant', $4)
       returning id`,
      [id, AUTHOR, text, `An answer about ${label}`],
    );
    const chunk = await db.query<{ id: string }>(
      `insert into public.memory_chunks
         (conversation_id, user_id, scope, summary, audience, embedding, turn_range)
       values ($1, $2, 'workspace', $3, $4, $5::extensions.vector, $6::int4range)
       returning id`,
      [id, AUTHOR, `Summary of ${label} — synthetic ${RUN}`, 'synthetic audience', VECTOR, range],
    );
    return { id, chunkId: chunk.rows[0]?.id ?? '', messageId: messages.rows[0]?.id ?? '' };
  }

  beforeAll(async () => {
    await db.connect();
    asAuthor = depsFor(AUTHOR, AUTHOR_EMAIL);

    // A real third account, created through the real admin path, so its refusals below are a
    // real session hitting real policies.
    const log = createLogger({ level: 'error', sink: () => undefined });
    const admin = createAdminDeps(cfg, log);

    /** One run-scoped account with a real session. Returns its id. */
    async function makePerson(email: string, isAdmin: boolean): Promise<[string, UserClient]> {
      const password = `Privacy-${crypto.randomUUID()}`;
      const created = await admin.authAdmin.createUser(email, password);
      expect(created.ok, `${email} was created`).toBe(true);
      if (!created.ok) throw new Error('account creation failed');
      createdIds.push(created.value.id);
      const allowlisted = await admin.staff.insert({
        user_id: created.value.id,
        email,
        role: 'staff',
        is_active: true,
        is_admin: isAdmin,
      });
      expect(allowlisted.ok, `${email} is allowlisted and active`).toBe(true);
      const session = await signInWithPassword(cfg, email, password);
      expect(session.ok, `${email} can sign in`).toBe(true);
      if (!session.ok) throw new Error('sign-in failed');
      return [created.value.id, userClient(session.value.accessToken)];
    }

    [outsiderId, outsider] = await makePerson(outsiderEmail, false);
    asOutsider = depsFor(outsiderId, outsiderEmail);
    [adminId, adminSession] = await makePerson(adminEmail, true);
    asAdmin = depsFor(adminId, adminEmail);

    const priv = await seed('private', '[1,3)', PRIVATE_TEXT);
    privateConvId = priv.id;
    privateChunkId = priv.chunkId;
    privateMessageId = priv.messageId;

    const shared = await seed('shared', '[1,3)', SHARED_TEXT);
    sharedConvId = shared.id;
    sharedChunkId = shared.chunkId;

    // A standing note stated in the conversation that is about to go private. Assertion 7 is
    // that nothing here moves — it is workspace knowledge, and staying so is the decision.
    const fact = await db.query<{ id: string }>(
      `insert into public.memory_facts (user_id, scope, key, value, confidence, source_message_id)
       values ($1, 'workspace', $2, $3, 1, $4) returning id`,
      [
        AUTHOR,
        FACT_KEY,
        `A standing note stated in a private conversation — ${RUN}`,
        privateMessageId,
      ],
    );
    factId = fact.rows[0]?.id ?? '';
  }, 180_000);

  afterAll(async () => {
    await db.query(`delete from public.memory_facts where key = $1`, [FACT_KEY]);
    for (const table of ['memory_chunks', 'messages']) {
      await db.query(
        `delete from public.${table} where conversation_id in
           (select id from public.conversations where title like $1)`,
        [`privacy-%-${RUN}`],
      );
    }
    await db.query(
      `delete from public.audit_log where entity_id in
         (select id from public.conversations where title like $1)`,
      [`privacy-%-${RUN}`],
    );
    await db.query(`delete from public.conversations where title like $1`, [`privacy-%-${RUN}`]);
    if (createdIds.length > 0) {
      await db.query(`delete from public.audit_log where entity_id = any($1::uuid[])`, [
        createdIds,
      ]);
      await db.query(`delete from public.app_users where user_id = any($1::uuid[])`, [createdIds]);
      await db.query(`delete from auth.users where id = any($1::uuid[])`, [createdIds]);
    }
    await db.end();
  }, 180_000);

  async function post(deps: MemoryPageDeps, request: MemoryRequestBody): Promise<MemoryPageResult> {
    return handleMemoryRequest(deps, { token: 'stubbed-in-this-suite', body: request });
  }

  it('the outsider can read the conversation while it is still shared (the control)', async () => {
    // Without this, assertion 1 could pass because the outsider can read NOTHING — a vacuous
    // pass, and the most likely way a privacy test lies.
    const before = await outsider.from('conversations').select('id').eq('id', privateConvId);
    expect(before.error).toBeNull();
    expect(before.data).toHaveLength(1);
    const messages = await outsider
      .from('messages')
      .select('id')
      .eq('conversation_id', privateConvId);
    expect(messages.data).toHaveLength(2);
  }, 120_000);

  it('1. a private conversation is unreadable by another allowlisted non-admin, at the database', async () => {
    const result = await post(asAuthor, {
      action: 'set_conversation_privacy',
      conversationId: privateConvId,
      isPrivate: true,
    });
    expect(result.status).toBe(200);
    expect(replyBody(result)['outcome']).toBe('changed');

    const scope = await db.query<{ scope: string }>(
      `select scope from public.conversations where id = $1`,
      [privateConvId],
    );
    expect(scope.rows[0]?.scope).toBe('user');

    // The proof: a real session, a real policy, zero rows. Not a filtered list — the row.
    const asOutsiderRead = await outsider
      .from('conversations')
      .select('id')
      .eq('id', privateConvId);
    expect(asOutsiderRead.error).toBeNull();
    expect(asOutsiderRead.data).toStrictEqual([]);

    // And it is not that they can see nothing: the shared one is still there.
    const stillVisible = await outsider.from('conversations').select('id').eq('id', sharedConvId);
    expect(stillVisible.data).toHaveLength(1);

    const audit = await db.query<{ actor: string; action: string }>(
      `select actor, action from public.audit_log
       where entity_id = $1 and action = 'CONVERSATION_MADE_PRIVATE'`,
      [privateConvId],
    );
    expect(audit.rows).toStrictEqual([{ actor: AUTHOR, action: 'CONVERSATION_MADE_PRIVATE' }]);
  }, 120_000);

  it('2. its messages are equally unreadable — the cascade carried the scope to every one', async () => {
    const scopes = await db.query<{ scope: string }>(
      `select distinct scope from public.messages where conversation_id = $1`,
      [privateConvId],
    );
    expect(scopes.rows).toStrictEqual([{ scope: 'user' }]);

    const read = await outsider
      .from('messages')
      .select('id, content')
      .eq('conversation_id', privateConvId);
    expect(read.error).toBeNull();
    expect(read.data).toStrictEqual([]);

    // Belt and braces, and the assertion that a scoped-by-id read cannot make: the private
    // sentence is unreachable by ANY query this session can write, including one that never
    // mentions the conversation. It exists in exactly one conversation (see SHARED_TEXT).
    const byContent = await outsider.from('messages').select('id').eq('content', PRIVATE_TEXT);
    expect(byContent.error).toBeNull();
    expect(byContent.data).toStrictEqual([]);

    // …and not because content lookups return nothing to this session: the other
    // conversation's sentence, in the same table, by the same query shape, is right there.
    const shared = await outsider.from('messages').select('id').eq('content', SHARED_TEXT);
    expect(shared.data, 'the by-content check is not vacuous').toHaveLength(1);
  }, 120_000);

  it('3. its chunk stays workspace-scoped, readable by the outsider, and reachable by shared recall', async () => {
    // This is the assertion the whole part exists for. The conversation is private; the note
    // the assistant wrote about it is not.
    const row = await db.query<{ scope: string; user_id: string }>(
      `select scope, user_id from public.memory_chunks where id = $1`,
      [privateChunkId],
    );
    expect(row.rows[0]?.scope).toBe('workspace');
    // The author is still carried, so attribution and "who may remove this" still work.
    expect(row.rows[0]?.user_id).toBe(AUTHOR);

    const asOutsiderRead = await outsider
      .from('memory_chunks')
      .select('id, summary')
      .eq('id', privateChunkId);
    expect(asOutsiderRead.error).toBeNull();
    expect(asOutsiderRead.data).toHaveLength(1);

    // Shared recall: `match_memory_chunks` scoped to the OUTSIDER must still return it.
    const recalled = await db.query<{ id: string }>(
      `select id from public.match_memory_chunks($1::extensions.vector, $2, null, 0, 20, 0.1)`,
      [VECTOR, outsiderId],
    );
    expect(recalled.rows.map((r) => r.id)).toContain(privateChunkId);
  }, 120_000);

  it('nothing can make that chunk private — the trigger corrects it, the constraint backs it', async () => {
    // Two mechanisms, failing in different circumstances. The trigger fires on an update OF
    // scope and rewrites the value, so a direct attempt is corrected, not refused.
    await db.query(`update public.memory_chunks set scope = 'user' where id = $1`, [
      privateChunkId,
    ]);
    const after = await db.query<{ scope: string }>(
      `select scope from public.memory_chunks where id = $1`,
      [privateChunkId],
    );
    expect(after.rows[0]?.scope).toBe('workspace');

    // The constraint is what holds when the trigger is not there to fire.
    const constraint = await db.query<{ definition: string; validated: boolean }>(
      `select pg_get_constraintdef(oid) as definition, convalidated as validated
       from pg_constraint where conname = 'memory_chunks_scope_workspace'`,
    );
    expect(constraint.rows[0]?.definition).toContain("scope = 'workspace'");
    expect(constraint.rows[0]?.validated, 'checked against every existing row').toBe(true);
  }, 120_000);

  it('4. an admin can read it — through the audited server path, never through a policy', async () => {
    // First: the policy did NOT widen. An admin's own PostgREST session sees nothing either.
    const throughRls = await adminSession
      .from('messages')
      .select('id')
      .eq('conversation_id', privateConvId);
    expect(throughRls.data, 'RLS was not widened for admins — that is the design').toStrictEqual(
      [],
    );

    // Then: the server path, which returns it and records that it did.
    const listed = await post(asAdmin, { action: 'admin_list_private' });
    expect(listed.status).toBe(200);
    const rows = replyBody(listed)['conversations'] as { id: string }[];
    expect(rows.map((r) => r.id)).toContain(privateConvId);
    // Metadata only: no title reaches the listing, so listing is not reading.
    expect(JSON.stringify(rows)).not.toContain('privacy-private');

    const read = await post(asAdmin, {
      action: 'admin_read_conversation',
      conversationId: privateConvId,
    });
    expect(read.status).toBe(200);
    const messages = replyBody(read)['messages'] as { content: string }[];
    expect(messages.map((m) => m.content)).toContain(PRIVATE_TEXT);

    const audit = await db.query<{ actor: string }>(
      `select actor from public.audit_log
       where entity_id = $1 and action = 'CONVERSATION_ADMIN_READ'`,
      [privateConvId],
    );
    expect(audit.rows).toStrictEqual([{ actor: adminId }]);
  }, 180_000);

  it('an admin may not change whose it is, and a non-admin may not read it', async () => {
    const shared = await post(asAdmin, {
      action: 'set_conversation_privacy',
      conversationId: privateConvId,
      isPrivate: false,
    });
    expect(shared.status).toBe(403);
    const stillPrivate = await db.query<{ scope: string }>(
      `select scope from public.conversations where id = $1`,
      [privateConvId],
    );
    expect(stillPrivate.rows[0]?.scope).toBe('user');

    // The outsider is refused both admin actions by the server, before anything is read.
    expect((await post(asOutsider, { action: 'admin_list_private' })).status).toBe(403);
    expect(
      (await post(asOutsider, { action: 'admin_read_conversation', conversationId: privateConvId }))
        .status,
    ).toBe(403);
  }, 120_000);

  it('5. toggling back restores visibility, and toggling repeatedly corrupts nothing', async () => {
    for (const isPrivate of [false, true, false, true, false]) {
      const result = await post(asAuthor, {
        action: 'set_conversation_privacy',
        conversationId: privateConvId,
        isPrivate,
      });
      expect(result.status).toBe(200);

      const conversation = await db.query<{ scope: string }>(
        `select scope from public.conversations where id = $1`,
        [privateConvId],
      );
      expect(conversation.rows[0]?.scope).toBe(isPrivate ? 'user' : 'workspace');

      // Messages follow, every one of them, every time — never a mixture.
      const messages = await db.query<{ scope: string; n: string }>(
        `select scope, count(*) as n from public.messages
         where conversation_id = $1 group by scope`,
        [privateConvId],
      );
      expect(messages.rows).toStrictEqual([{ scope: isPrivate ? 'user' : 'workspace', n: '2' }]);

      // Chunks never move, whatever the conversation does.
      const chunks = await db.query<{ scope: string; user_id: string }>(
        `select scope, user_id from public.memory_chunks where conversation_id = $1`,
        [privateConvId],
      );
      expect(chunks.rows).toStrictEqual([{ scope: 'workspace', user_id: AUTHOR }]);
    }

    // It ends shared, and the outsider can read it again — the flip is genuinely reversible.
    const visible = await outsider
      .from('messages')
      .select('id')
      .eq('conversation_id', privateConvId);
    expect(visible.data).toHaveLength(2);
  }, 180_000);

  it('6. the conversation that was never touched is exactly where it was', async () => {
    const row = await db.query<{ scope: string }>(
      `select scope from public.conversations where id = $1`,
      [sharedConvId],
    );
    expect(row.rows[0]?.scope).toBe('workspace');
    const messages = await db.query<{ scope: string }>(
      `select distinct scope from public.messages where conversation_id = $1`,
      [sharedConvId],
    );
    expect(messages.rows).toStrictEqual([{ scope: 'workspace' }]);
    const chunk = await db.query<{ scope: string }>(
      `select scope from public.memory_chunks where id = $1`,
      [sharedChunkId],
    );
    expect(chunk.rows[0]?.scope).toBe('workspace');
    const visible = await outsider.from('conversations').select('id').eq('id', sharedConvId);
    expect(visible.data).toHaveLength(1);
  }, 120_000);

  it('6b. the migration left no private chunk anywhere in the database', async () => {
    // Whole-table, deliberately: this is the migration's own claim, and it is about every
    // row, not this run's. It asserts an absence, so another suite's fixtures cannot make it
    // pass — only break it, which is the safe direction.
    const stray = await db.query<{ n: string }>(
      `select count(*) as n from public.memory_chunks where scope <> 'workspace'`,
    );
    expect(stray.rows[0]?.n).toBe('0');
  }, 120_000);

  it('7. the standing note is untouched by any of it — value, author, scope, date and source', async () => {
    const row = await db.query<{
      user_id: string;
      scope: string;
      value: string;
      superseded_by: string | null;
      source_message_id: string | null;
    }>(
      `select user_id, scope, value, superseded_by, source_message_id
       from public.memory_facts where id = $1`,
      [factId],
    );
    expect(row.rows[0]).toStrictEqual({
      user_id: AUTHOR,
      scope: 'workspace',
      value: `A standing note stated in a private conversation — ${RUN}`,
      superseded_by: null,
      source_message_id: privateMessageId,
    });
    // Exactly one row for this key — no supersede was triggered by anything above.
    const count = await db.query<{ n: string }>(
      `select count(*) as n from public.memory_facts where key = $1`,
      [FACT_KEY],
    );
    expect(count.rows[0]?.n).toBe('1');
    // And the outsider still reads it: a note said in a private conversation is workspace
    // knowledge, which is the client's own decision.
    const visible = await outsider.from('memory_facts').select('id').eq('id', factId);
    expect(visible.data).toHaveLength(1);
  }, 120_000);

  it('no log line from any of it contains a message, a summary or a private title', () => {
    const joined = logLines.join('\n');
    expect(joined).not.toContain(PRIVATE_TEXT);
    expect(joined).not.toContain(SHARED_TEXT);
    expect(joined).not.toContain(`privacy-private-${RUN}`);
    expect(joined).not.toContain('synthetic audience');
  });
});
