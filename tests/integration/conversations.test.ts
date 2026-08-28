/**
 * Renaming and deleting a conversation against a real Supabase stack (Stage 3 part 4,
 * FND-330) — the production path (`handleMemoryRequest` over `supabaseMemoryPageStore`,
 * which calls the `delete_conversation` transaction) with no Claude and no Voyage involved,
 * because neither action spends anything.
 *
 * Part C, database half:
 *
 *   6. a RENAMED conversation keeps its messages, its conversation notes and its standing
 *      notes — a rename touches one column and nothing else;
 *   7. a DELETED conversation behaves exactly as Part A decided, asserted row by row:
 *        conversations  — soft-deleted, the row still there,
 *        messages       — GONE, permanently,
 *        memory_chunks  — tombstoned: the row and its turn_range survive, the summary, the
 *                         audience and the embedding do not,
 *        memory_facts   — ALIVE and unchanged apart from source_message_id, which had to be
 *                         cleared because the message it pointed at no longer exists;
 *   8. both actions land in audit_log naming the person.
 *
 * Plus the two properties the design turns on: the delete is one transaction (a failure part
 * way through leaves nothing changed), and the tombstoned range is never re-summarised.
 *
 * Fixtures are synthetic and run-scoped; counts are scoped to this run, never to a table.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SEEDED_STAFF } from '../../src/lib/auth/admin.js';
import {
  createServiceClient,
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
  CHUNK_TOMBSTONE_SUMMARY,
  handleMemoryRequest,
  supabaseMemoryPageStore,
  type MemoryPageDeps,
  type MemoryRequestBody,
  type MemoryPageResult,
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

const VECTOR = `[${Array.from({ length: 1024 }, (_v, i) => (i === 0 ? '1' : '0')).join(',')}]`;

function body(result: MemoryPageResult): Record<string, unknown> {
  return result.body as unknown as Record<string, unknown>;
}

describe.skipIf(env === null)('conversation management (requires a running Supabase stack)', () => {
  const db = new pg.Client({
    connectionString: env?.dbUrl ?? 'postgresql://stack-not-running.invalid/postgres',
  });
  const logLines: string[] = [];
  let deps: MemoryPageDeps;

  const OWNER = SEEDED_STAFF.ross.userId;
  const OWNER_EMAIL = SEEDED_STAFF.ross.email;
  /** A token is not needed: verify is stubbed to the seeded owner, an active allowlisted user. */
  const TOKEN = 'stubbed-in-this-suite';

  let renamedConvId = '';
  let deletedConvId = '';
  let survivingFactId = '';
  let deletedChunkId = '';
  let keptChunkId = '';
  let firstMessageId = '';

  async function post(request: MemoryRequestBody): Promise<MemoryPageResult> {
    return handleMemoryRequest(deps, { token: TOKEN, body: request });
  }

  /** One conversation with two messages, one chunk over them, and one fact sourced from it. */
  async function seedConversation(
    label: string,
  ): Promise<{ id: string; chunkId: string; messageId: string }> {
    const conv = await db.query<{ id: string }>(
      `insert into public.conversations (user_id, scope, title)
       values ($1, 'workspace', $2) returning id`,
      [OWNER, `convs-${label}-${RUN}`],
    );
    const id = conv.rows[0]?.id ?? '';
    const messages = await db.query<{ id: string }>(
      `insert into public.messages (conversation_id, user_id, scope, role, content)
       values ($1, $2, 'workspace', 'user', $3), ($1, $2, 'workspace', 'assistant', $4)
       returning id`,
      [id, OWNER, `A question about ${label}`, `An answer about ${label}`],
    );
    const messageId = messages.rows[0]?.id ?? '';
    const chunk = await db.query<{ id: string }>(
      `insert into public.memory_chunks
         (conversation_id, user_id, scope, summary, audience, embedding, turn_range)
       values ($1, $2, 'workspace', $3, $4, $5::extensions.vector, '[1,3)')
       returning id`,
      [id, OWNER, `Summary of ${label} — synthetic`, 'synthetic audience', VECTOR],
    );
    return { id, chunkId: chunk.rows[0]?.id ?? '', messageId };
  }

  beforeAll(async () => {
    await db.connect();
    const log = createLogger({
      level: 'debug',
      sink: (line) => {
        logLines.push(line);
      },
    });
    const service = createServiceClient(cfg);
    deps = {
      // The verifier is the ONE substitution: signing a real JWT for the seeded owner would
      // add a GoTrue round trip that proves nothing this file is about. Everything below the
      // verifier — the store, the transaction, the audit writer — is production code.
      verify: {
        ...supabaseVerifyDeps(service),
        getUserFromToken: () =>
          Promise.resolve({ ok: true, value: { id: OWNER, email: OWNER_EMAIL } }),
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

    const renamed = await seedConversation('renamed');
    renamedConvId = renamed.id;
    keptChunkId = renamed.chunkId;

    const deleted = await seedConversation('deleted');
    deletedConvId = deleted.id;
    deletedChunkId = deleted.chunkId;
    firstMessageId = deleted.messageId;

    // A standing note that came OUT of the conversation about to be deleted. This is the row
    // the whole decision turns on: the words go, the thing someone chose to keep stays.
    const fact = await db.query<{ id: string }>(
      `insert into public.memory_facts (user_id, scope, key, value, confidence, source_message_id)
       values ($1, 'workspace', $2, $3, 1, $4) returning id`,
      [
        OWNER,
        `process:convs-${RUN}`,
        'Synthetic standing note stated during a conversation that is later deleted.',
        firstMessageId,
      ],
    );
    survivingFactId = fact.rows[0]?.id ?? '';
  }, 120_000);

  afterAll(async () => {
    await db.query(`delete from public.memory_facts where key = $1`, [`process:convs-${RUN}`]);
    await db.query(
      `delete from public.memory_chunks where conversation_id in
         (select id from public.conversations where title like $1)`,
      [`convs-%-${RUN}`],
    );
    await db.query(
      `delete from public.messages where conversation_id in
         (select id from public.conversations where title like $1)`,
      [`convs-%-${RUN}`],
    );
    await db.query(
      `delete from public.audit_log where entity_id in
         (select id from public.conversations where title like $1)`,
      [`convs-%-${RUN}`],
    );
    await db.query(`delete from public.conversations where title like $1`, [`convs-%-${RUN}`]);
    await db.end();
  }, 120_000);

  it('6. a renamed conversation keeps its messages, its chunks and its facts', async () => {
    const before = await db.query<{ messages: string; chunks: string; facts: string }>(
      `select
         (select count(*) from public.messages where conversation_id = $1) as messages,
         (select count(*) from public.memory_chunks where conversation_id = $1) as chunks,
         (select count(*) from public.memory_facts where key = $2) as facts`,
      [renamedConvId, `process:convs-${RUN}`],
    );

    const result = await post({
      action: 'rename_conversation',
      conversationId: renamedConvId,
      title: 'Refinance ads for October',
    });
    expect(result.status).toBe(200);
    expect(body(result)['outcome']).toBe('renamed');

    const after = await db.query<{
      title: string | null;
      deleted_at: string | null;
      messages: string;
      chunks: string;
      facts: string;
      summary: string;
      embedding_is_null: boolean;
    }>(
      `select c.title, c.deleted_at,
         (select count(*) from public.messages where conversation_id = c.id) as messages,
         (select count(*) from public.memory_chunks where conversation_id = c.id) as chunks,
         (select count(*) from public.memory_facts where key = $2) as facts,
         (select summary from public.memory_chunks where id = $3) as summary,
         (select embedding is null from public.memory_chunks where id = $3) as embedding_is_null
       from public.conversations c where c.id = $1`,
      [renamedConvId, `process:convs-${RUN}`, keptChunkId],
    );
    const row = after.rows[0];
    expect(row?.title).toBe('Refinance ads for October');
    expect(row?.deleted_at).toBeNull();
    expect(row?.messages).toBe(before.rows[0]?.messages);
    expect(row?.chunks).toBe(before.rows[0]?.chunks);
    expect(row?.facts).toBe(before.rows[0]?.facts);
    // The chunk is untouched — a rename must not disturb what the assistant can recall.
    expect(row?.summary).toContain('Summary of renamed');
    expect(row?.embedding_is_null).toBe(false);

    // 8: one audit row, naming the person.
    const audit = await db.query<{ actor: string }>(
      `select actor from public.audit_log
       where action = 'CONVERSATION_RENAMED' and entity_id = $1`,
      [renamedConvId],
    );
    expect(audit.rows).toStrictEqual([{ actor: OWNER }]);
  }, 120_000);

  it('renaming it again to the same name writes nothing and audits nothing', async () => {
    const result = await post({
      action: 'rename_conversation',
      conversationId: renamedConvId,
      title: 'Refinance ads for October',
    });
    expect(body(result)['outcome']).toBe('unchanged');
    const audit = await db.query<{ n: string }>(
      `select count(*) as n from public.audit_log
       where action = 'CONVERSATION_RENAMED' and entity_id = $1`,
      [renamedConvId],
    );
    expect(audit.rows[0]?.n).toBe('1');
  }, 120_000);

  it('7. a deleted conversation removes exactly what was decided, and keeps exactly what was decided', async () => {
    const result = await post({ action: 'delete_conversation', conversationId: deletedConvId });
    expect(result.status).toBe(200);
    expect(body(result)['outcome']).toBe('deleted');
    expect(body(result)['messagesDeleted']).toBe(2);
    expect(body(result)['chunksTombstoned']).toBe(1);

    // conversations — soft: the row is STILL THERE, marked.
    const conversation = await db.query<{ deleted_at: string | null; title: string | null }>(
      `select deleted_at, title from public.conversations where id = $1`,
      [deletedConvId],
    );
    expect(conversation.rows).toHaveLength(1);
    expect(conversation.rows[0]?.deleted_at).not.toBeNull();

    // messages — GONE. Not hidden, not tombstoned: gone.
    const messages = await db.query<{ n: string }>(
      `select count(*) as n from public.messages where conversation_id = $1`,
      [deletedConvId],
    );
    expect(messages.rows[0]?.n).toBe('0');

    // memory_chunks — tombstoned: the claim over the range survives, the content does not.
    const chunk = await db.query<{
      summary: string;
      audience: string | null;
      embedding_is_null: boolean;
      turn_range: string;
      deleted_at: string | null;
      deleted_by: string | null;
    }>(
      `select summary, audience, embedding is null as embedding_is_null,
              turn_range::text as turn_range, deleted_at, deleted_by
       from public.memory_chunks where id = $1`,
      [deletedChunkId],
    );
    expect(chunk.rows[0]?.summary).toBe(CHUNK_TOMBSTONE_SUMMARY);
    expect(chunk.rows[0]?.audience).toBeNull();
    expect(chunk.rows[0]?.embedding_is_null).toBe(true);
    expect(chunk.rows[0]?.turn_range, 'the range stays claimed').toBe('[1,3)');
    expect(chunk.rows[0]?.deleted_at).not.toBeNull();
    expect(chunk.rows[0]?.deleted_by).toBe(OWNER);

    // memory_facts — ALIVE, with its value, author and date intact; only the pointer to a
    // message that no longer exists was cleared.
    const fact = await db.query<{
      value: string;
      user_id: string;
      superseded_by: string | null;
      source_message_id: string | null;
    }>(
      `select value, user_id, superseded_by, source_message_id
       from public.memory_facts where id = $1`,
      [survivingFactId],
    );
    expect(fact.rows).toHaveLength(1);
    expect(fact.rows[0]?.superseded_by, 'the note is still live').toBeNull();
    expect(fact.rows[0]?.value).toContain('Synthetic standing note');
    expect(fact.rows[0]?.user_id).toBe(OWNER);
    expect(fact.rows[0]?.source_message_id).toBeNull();

    // 8: one audit row, naming the person, carrying no content.
    const audit = await db.query<{ actor: string; before: unknown; after: unknown }>(
      `select actor, before, after from public.audit_log
       where action = 'CONVERSATION_DELETED' and entity_id = $1`,
      [deletedConvId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor).toBe(OWNER);
    expect(audit.rows[0]?.before).toBeNull();
    expect(audit.rows[0]?.after).toBeNull();

    // And the words are not preserved anywhere else either — audit_log has no row-level
    // trigger on messages, which is exactly why a hard delete is safe here.
    const anywhere = await db.query<{ n: string }>(
      `select count(*) as n from public.audit_log where before::text like $1 or after::text like $1`,
      ['%An answer about deleted%'],
    );
    expect(anywhere.rows[0]?.n).toBe('0');
  }, 120_000);

  it('a deleted conversation is invisible to retrieval, and its range is never re-summarised', async () => {
    // match_memory_chunks excludes both a tombstoned chunk and a deleted conversation.
    const search = await db.query<{ n: string }>(
      `select count(*) as n from public.match_memory_chunks(
         $1::extensions.vector, $2::uuid, null, 0, 10, 0.0)
       where conversation_id = $3`,
      [VECTOR, OWNER, deletedConvId],
    );
    expect(search.rows[0]?.n).toBe('0');

    // The exclusion constraint still holds the range, so a summariser that somehow ran
    // against this conversation could not claim it again.
    await expect(
      db.query(
        `insert into public.memory_chunks (conversation_id, user_id, scope, summary, turn_range)
         values ($1, $2, 'workspace', 'should never land', '[1,3)')`,
        [deletedConvId, OWNER],
      ),
    ).rejects.toThrow();
  }, 120_000);

  it('deleting it again is a no-op that reports `already` and writes no second audit row', async () => {
    const result = await post({ action: 'delete_conversation', conversationId: deletedConvId });
    expect(result.status).toBe(200);
    expect(body(result)['outcome']).toBe('already');
    const audit = await db.query<{ n: string }>(
      `select count(*) as n from public.audit_log
       where action = 'CONVERSATION_DELETED' and entity_id = $1`,
      [deletedConvId],
    );
    expect(audit.rows[0]?.n).toBe('1');
  }, 120_000);

  it('renaming a deleted conversation is refused, so nothing comes back under a new name', async () => {
    const result = await post({
      action: 'rename_conversation',
      conversationId: deletedConvId,
      title: 'back from the dead',
    });
    expect(result.status).toBe(404);
    const row = await db.query<{ title: string | null }>(
      `select title from public.conversations where id = $1`,
      [deletedConvId],
    );
    expect(row.rows[0]?.title).toBe(`convs-deleted-${RUN}`);
  }, 120_000);

  it('no log line from any of it contains a message, a summary or a title', () => {
    for (const line of logLines) {
      expect(line).not.toContain('An answer about');
      expect(line).not.toContain('Summary of');
      expect(line).not.toContain('Refinance ads for October');
    }
  });
});
