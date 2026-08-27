/**
 * The memory page against a real Supabase stack (Stage 3 part 3, FND-320) — the production
 * code path (`handleMemoryRequest` over `supabaseMemoryPageStore` / `supabaseFactStore` /
 * `supabaseAuditWriter`, and `handleChatTurn` over `createTurnMemory`) with ONE
 * substitution: fetch to Anthropic and Voyage is a scripted fixture, so CI spends no money
 * and needs no key.
 *
 * This is Part C's database half, and each `it` is one of its numbered assertions:
 *
 *   1. a note added from the page is in the NEXT TURN's request to Claude;
 *   2. a note forgotten from the page is not — and the row survives, self-referenced, with
 *      its value and its author intact;
 *   3. an edit supersedes rather than duplicating: one live row, the old value still
 *      readable as history, never two live rows for one key;
 *   4. a deleted conversation note stops being retrieved AND its range stays claimed, so the
 *      summariser cannot quietly rebuild what was removed;
 *   8. every change is one audit_log row naming the person, alongside the trigger's own row.
 *
 * Plus the part-3 review's own assertion (D54, migration 20260827040000): a workspace note
 * belonging to ANOTHER author is superseded, not forked — one live row per key, whoever
 * wrote it — and the database refuses a second live one even if the write path is bypassed.
 *
 * Counts are scoped to this run's user and conversations, never the whole table.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createServiceClient,
  supabaseAuditWriter,
  supabaseVerifyDeps,
  type SupabaseAuthConfig,
} from '../../src/lib/auth/clients.js';
import { createHttpClient, type FetchLike } from '../../src/lib/http.js';
import { handleChatTurn, type ChatDeps } from '../../src/lib/llm/chat.js';
import { createClaudeClient } from '../../src/lib/llm/client.js';
import type { LlmConfig } from '../../src/lib/llm/config.js';
import { DEFAULT_PRICING } from '../../src/lib/llm/pricing.js';
import { supabaseConversationStore, supabaseUsageStore } from '../../src/lib/llm/store.js';
import { createTurnMemory } from '../../src/lib/llm/wiring.js';
import { supabaseChunkStore } from '../../src/lib/memory/chunks.js';
import {
  POLICY_DEFAULTS,
  RETRIEVAL_DEFAULTS,
  type MemoryConfig,
} from '../../src/lib/memory/config.js';
import { createVoyageEmbedder } from '../../src/lib/memory/embed.js';
import { supabaseFactStore } from '../../src/lib/memory/facts.js';
import {
  CHUNK_TOMBSTONE_SUMMARY,
  handleMemoryRequest,
  supabaseMemoryPageStore,
  type MemoryPageDeps,
  type MemoryRequestBody,
} from '../../src/lib/memory/page.js';
import { createLogger } from '../../src/lib/logger.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);
const FAKE_ANTHROPIC_KEY = 'sk-ant-integration-not-a-real-key-000000';
const FAKE_VOYAGE_KEY = 'pa-integration-not-a-real-key-00000000000';

const cfg: SupabaseAuthConfig = {
  url: env?.url ?? 'http://stack-not-running.invalid',
  anonKey: env?.anonKey ?? 'unset',
  serviceRoleKey: env?.serviceRoleKey ?? 'unset',
};

const fixture = (dir: string, name: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', dir, `${name}.json`), 'utf8');

const FIXTURE_VECTOR: number[] =
  (JSON.parse(fixture('voyage', 'embeddings-ok')) as { data: { embedding: number[] }[] }).data[0]
    ?.embedding ?? [];

const llmConfig: LlmConfig = {
  apiKey: FAKE_ANTHROPIC_KEY,
  baseUrl: 'https://anthropic.test',
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

const memoryConfig: MemoryConfig = {
  voyage: {
    apiKey: FAKE_VOYAGE_KEY,
    baseUrl: 'https://voyage.test',
    model: 'voyage-3',
    dimensions: 1024,
    timeoutMs: 5_000,
    retries: 0,
    pricePerMTok: 0.06,
    caps: { dailyUsd: 0.5, monthlyUsd: 5, warnFraction: 0.8 },
  },
  policy: POLICY_DEFAULTS,
  retrieval: { ...RETRIEVAL_DEFAULTS, timeoutMs: 10_000 },
};

interface SystemBlockWire {
  readonly text: string;
}

/**
 * A WORKSPACE note is one note for the business — since D54 its identity is the key alone,
 * across the whole table. Two integration files that both write one are therefore two files
 * pretending to be the same workspace, and the recorded extractor answers they share
 * (`fact-ok`) would land on the same key with the same wording. `vitest.config.ts` stops
 * them running at the same time; this makes them disjoint even so, by run-scoping the topic
 * and the value in the recorded envelope before it is served. Same technique as
 * `capture.test.ts`'s `textStep()`: a real recorded Haiku response with its text replaced,
 * so the extractor, the guards and the key format are all still the real thing.
 */
const SCOPE_SUFFIX = RUN.slice(0, 6);

function scopedFactAnswer(name: string): string {
  const envelope = JSON.parse(fixture('anthropic', name)) as {
    content: { type: string; text: string }[];
  };
  const block = envelope.content[0];
  if (block !== undefined) {
    block.text = block.text
      .replace(/"topic":\s*"([^"]+)"/, `"topic": "$1 ${SCOPE_SUFFIX}"`)
      .replace(/(Rule of One framework and ends with a direct CTA)/, `$1 (${SCOPE_SUFFIX})`);
  }
  return JSON.stringify(envelope);
}

describe.skipIf(env === null)('the memory page against a real stack', () => {
  const db = new pg.Client({
    connectionString: env?.dbUrl ?? 'postgresql://stack-not-running.invalid/postgres',
  });
  const service = createServiceClient(cfg);
  const admin = createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const log = createLogger({ level: 'error', sink: () => undefined });

  const seen: { url: string; body: string }[] = [];
  let haikuAnswer = 'fact-ok';
  const fixtureFetch: FetchLike = (url, init) => {
    const body = typeof init.body === 'string' ? init.body : '';
    seen.push({ url, body });
    if (url.startsWith('https://anthropic.test')) {
      const parsed = JSON.parse(body === '' ? '{}' : body) as { model?: string };
      const isHaiku = typeof parsed.model === 'string' && parsed.model.includes('haiku');
      const name = isHaiku ? haikuAnswer : 'messages-ok';
      return Promise.resolve(
        new Response(isHaiku ? scopedFactAnswer(name) : fixture('anthropic', name), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response(fixture('voyage', 'embeddings-ok'), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  function claude(): ReturnType<typeof createClaudeClient> {
    return createClaudeClient({
      config: llmConfig,
      http: createHttpClient({ fetch: fixtureFetch, retries: 0, logger: log }),
      usage: supabaseUsageStore(service),
      log,
    });
  }

  /** The chat path, wired as production wires it. */
  function chatDeps(): ChatDeps {
    const http = createHttpClient({ fetch: fixtureFetch, retries: 0, logger: log });
    const usage = supabaseUsageStore(service);
    const shared = claude();
    return {
      verify: supabaseVerifyDeps(service),
      claude: shared,
      conversations: supabaseConversationStore(service),
      log,
      history: llmConfig.history,
      memory: createTurnMemory(memoryConfig, service, {
        claude: shared,
        embedder: createVoyageEmbedder({ config: memoryConfig.voyage, http, usage, log }),
        chunks: supabaseChunkStore(service),
        policy: memoryConfig.policy,
        log,
      }),
    };
  }

  /** The memory page's endpoint, wired as production wires it. */
  function pageDeps(): MemoryPageDeps {
    return {
      verify: supabaseVerifyDeps(service),
      claude: claude(),
      facts: supabaseFactStore(service),
      store: supabaseMemoryPageStore(service),
      audit: supabaseAuditWriter(service),
      log,
    };
  }

  const page = (body: MemoryRequestBody): ReturnType<typeof handleMemoryRequest> =>
    handleMemoryRequest(pageDeps(), { token, body });

  /** The `system` array of the most recent request that went to Anthropic. */
  function lastSystemText(): string {
    const last = [...seen].reverse().find((s) => s.url.startsWith('https://anthropic.test'));
    const body = JSON.parse(last?.body ?? '{}') as { system?: SystemBlockWire[] };
    return (body.system ?? []).map((block) => block.text).join('\n');
  }

  /** One ordinary turn in a brand-new conversation, so nothing is excluded as "recent". */
  async function ordinaryTurn(message: string): Promise<void> {
    const result = await handleChatTurn(chatDeps(), { token, message });
    expect(result.status).toBe(200);
  }

  async function auditRowsFor(
    entityId: string,
  ): Promise<{ actor: string; action: string; entity_type: string }[]> {
    const rows = await db.query<{ actor: string; action: string; entity_type: string }>(
      `select actor, action, entity_type from public.audit_log
       where entity_id = $1 order by created_at, action`,
      [entityId],
    );
    return rows.rows;
  }

  let userId = '';
  let teammateId = '';
  let token = '';
  let earlierConversationId = '';
  let chunkId = '';
  let factId = '';
  const KEY = `writing:finance-content-framework-${SCOPE_SUFFIX}`;
  const NOTE = `Finance content uses the Rule of One framework and ends with a direct CTA (${SCOPE_SUFFIX}).`;
  const CHUNK_MARKER = `PAGE-CHUNK-${RUN}`;

  beforeAll(async () => {
    await db.connect();
    const email = `mempage-${RUN}@example.com`;
    const password = `Fixture-${crypto.randomUUID()}`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error !== null) throw new Error(created.error.message);
    userId = created.data.user.id;
    await db.query(
      `insert into public.app_users (user_id, email, role, is_active, is_admin)
       values ($1, $2, 'staff', true, false)`,
      [userId, email],
    );
    const signIn = await anon.auth.signInWithPassword({ email, password });
    if (signIn.error !== null) throw new Error(signIn.error.message);
    token = signIn.data.session.access_token;

    // A second allowlisted member, so "a note a teammate wrote" is a real row with a real
    // author rather than a fabricated id.
    const mateEmail = `mempage-mate-${RUN}@example.com`;
    const mate = await admin.auth.admin.createUser({
      email: mateEmail,
      password: `Fixture-${crypto.randomUUID()}`,
      email_confirm: true,
    });
    if (mate.error !== null) throw new Error(mate.error.message);
    teammateId = mate.data.user.id;
    await db.query(
      `insert into public.app_users (user_id, email, role, is_active, is_admin)
       values ($1, $2, 'staff', true, false)`,
      [teammateId, mateEmail],
    );

    // An earlier conversation with ten messages and one chunk covering the first ten, whose
    // embedding IS the fixture vector — so any query embedded through the fixture matches it
    // at similarity 1 and it is certain to be retrieved while it is live.
    const conv = await db.query<{ id: string }>(
      `insert into public.conversations (user_id, scope, title)
       values ($1, 'workspace', $2) returning id`,
      [userId, `mempage-${RUN} earlier`],
    );
    earlierConversationId = conv.rows[0]?.id ?? '';
    for (let i = 0; i < 10; i += 1) {
      await db.query(
        `insert into public.messages (conversation_id, user_id, scope, role, content, created_at)
         values ($1, $2, 'workspace', $3, $4, now() - make_interval(days => 2, mins => $5))`,
        [earlierConversationId, userId, i % 2 === 0 ? 'user' : 'assistant', `earlier ${i}`, 10 - i],
      );
    }
    const chunk = await db.query<{ id: string }>(
      `insert into public.memory_chunks (conversation_id, user_id, scope, summary, audience, embedding, turn_range)
       values ($1, $2, 'workspace', $3, 'renters aspiring to homeownership', $4::vector, '[1,11)')
       returning id`,
      [
        earlierConversationId,
        userId,
        `${CHUNK_MARKER}: the user asked for a Meta ad about renting and wanted the headline shortened.`,
        `[${FIXTURE_VECTOR.join(',')}]`,
      ],
    );
    chunkId = chunk.rows[0]?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    // Every statement is ATTEMPTED, then the first failure is rethrown. A cleanup that stops
    // at its first error leaves fixture rows behind, and since these files share one database
    // — and, since D54, one workspace — a leak here fails other files rather than this one.
    // That is exactly what happened on this branch's first CI: a type error on the opening
    // statement abandoned the rest, and two unrelated suites went red.
    const failures: string[] = [];
    const attempt = async (label: string, sql: string, params: unknown[]): Promise<void> => {
      try {
        await db.query(sql, params);
      } catch (caught: unknown) {
        failures.push(`${label}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    };

    // `audit_log.actor` is TEXT and `memory_facts.user_id` is UUID; Postgres resolves a
    // placeholder to ONE type, so reusing $1 for both makes it uuid and `actor = $1` fails.
    await attempt(
      'audit_log',
      `delete from public.audit_log where actor = $1 or entity_id in (
         select id from public.memory_facts where user_id = $2
         union select id from public.memory_chunks
           where conversation_id in (select id from public.conversations where user_id = $2))`,
      [userId, userId],
    );
    await attempt('api_usage', `delete from public.api_usage where user_id = $1`, [userId]);
    // Delete without nulling `superseded_by` first. The self-FK is NO ACTION, so a single
    // DELETE that removes a whole chain is checked at end of statement and passes — whereas
    // nulling the chain first makes two rows live under one key at once, which since D54 the
    // partial unique index refuses. (`recall.test.ts` has always deleted this way.)
    await attempt(
      'memory_facts',
      `delete from public.memory_facts where user_id = any($1::uuid[])`,
      [[userId, teammateId].filter((id) => id !== '')],
    );
    await attempt(
      'memory_chunks',
      `delete from public.memory_chunks where conversation_id in (select id from public.conversations where user_id = $1)`,
      [userId],
    );
    await attempt(
      'messages',
      `delete from public.messages where conversation_id in (select id from public.conversations where user_id = $1)`,
      [userId],
    );
    await attempt('conversations', `delete from public.conversations where user_id = $1`, [userId]);
    await attempt('app_users', `delete from public.app_users where user_id = any($1::uuid[])`, [
      [userId, teammateId].filter((id) => id !== ''),
    ]);
    for (const id of [userId, teammateId].filter((value) => value !== '')) {
      const deleted = await admin.auth.admin.deleteUser(id);
      if (deleted.error !== null) failures.push(`auth.users: ${deleted.error.message}`);
    }
    await db.end();
    if (failures.length > 0) {
      throw new Error(`fixture cleanup left rows behind — ${failures.join(' | ')}`);
    }
  }, 60_000);

  it("1. a note added from the page is in the next turn's request to Claude", async () => {
    haikuAnswer = 'fact-ok';
    const added = await page({
      action: 'add',
      text: 'Remember that finance content uses the Rule of One framework and a direct CTA.',
    });
    expect(added.status).toBe(200);
    if (added.status !== 200) return;
    expect(added.body).toMatchObject({
      action: 'add',
      outcome: 'saved',
      key: KEY,
      value: NOTE,
      replaced: false,
    });
    if (added.body.outcome !== 'saved') return;
    factId = added.body.factId;

    // Exactly one row for this user, live, workspace-scoped, with no source message (it was
    // typed on the page, not said in a conversation).
    const rows = await db.query<{
      id: string;
      scope: string;
      key: string;
      value: string;
      source_message_id: string | null;
      superseded_by: string | null;
    }>(
      `select id, scope, key, value, source_message_id, superseded_by
       from public.memory_facts where user_id = $1`,
      [userId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      id: factId,
      scope: 'workspace',
      key: KEY,
      value: NOTE,
      source_message_id: null,
      superseded_by: null,
    });

    await ordinaryTurn('Draft a Facebook post about offset accounts.');
    expect(lastSystemText()).toContain(NOTE);
  });

  it('2. a note forgotten from the page stops reaching the next turn, and the row survives', async () => {
    const forgotten = await page({ action: 'forget', factId });
    expect(forgotten.status).toBe(200);
    if (forgotten.status !== 200) return;
    expect(forgotten.body).toMatchObject({ action: 'forget', outcome: 'forgotten' });

    const rows = await db.query<{ id: string; value: string; superseded_by: string | null }>(
      `select id, value, superseded_by from public.memory_facts where user_id = $1`,
      [userId],
    );
    // Append-only: the row is still there, with its wording and its author, pointing at
    // ITSELF — the one value of superseded_by that cannot mean "replaced by another row".
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ id: factId, value: NOTE, superseded_by: factId });

    await ordinaryTurn('Draft a Facebook post about offset accounts.');
    expect(lastSystemText()).not.toContain(NOTE);

    // Forgetting again is a no-op, not an error and not a second audit row.
    const again = await page({ action: 'forget', factId });
    expect(again.status).toBe(200);
    if (again.status !== 200) return;
    expect(again.body).toMatchObject({ outcome: 'already' });
    expect(
      (await auditRowsFor(factId)).filter((r) => r.action === 'MEMORY_FACT_FORGOTTEN'),
    ).toHaveLength(1);
  });

  it('3. an edit supersedes rather than duplicating, and the earlier wording stays readable', async () => {
    // Bring the note back first (a forgotten row can be restored — nothing replaced it),
    // then reword it. Both go through the page.
    const restored = await page({ action: 'edit', factId, value: NOTE });
    expect(restored.status).toBe(200);
    if (restored.status !== 200) return;
    if (restored.body.outcome !== 'saved') throw new Error('restore did not save');
    const liveId = restored.body.factId;

    const reworded = 'Finance content uses the Rule of One framework and ends with one clear CTA.';
    const edited = await page({ action: 'edit', factId: liveId, value: reworded });
    expect(edited.status).toBe(200);
    if (edited.status !== 200) return;
    expect(edited.body).toMatchObject({
      action: 'edit',
      outcome: 'saved',
      key: KEY,
      value: reworded,
      replaced: true,
    });

    const rows = await db.query<{ id: string; value: string; superseded_by: string | null }>(
      `select id, value, superseded_by from public.memory_facts
       where key = $1 order by created_at`,
      [KEY],
    );
    // Three rows, ONE live: the forgotten original, the restored copy it did not replace,
    // and the rewording that superseded that copy.
    expect(rows.rows).toHaveLength(3);
    const live = rows.rows.filter((r) => r.superseded_by === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.value).toBe(reworded);
    // The history a person sees on the page: every value this note has ever held.
    expect(rows.rows.map((r) => r.value)).toStrictEqual([NOTE, NOTE, reworded]);
    expect(rows.rows[1]?.superseded_by).toBe(live[0]?.id);

    // Editing the row that was just superseded is a conflict, never a second live note.
    const stale = await page({ action: 'edit', factId: liveId, value: 'Something else entirely.' });
    expect(stale.status).toBe(409);
    const stillOne = await db.query<{ n: string }>(
      `select count(*) as n from public.memory_facts
       where user_id = $1 and superseded_by is null`,
      [userId],
    );
    expect(stillOne.rows[0]?.n).toBe('1');

    await ordinaryTurn('Draft a Facebook post about offset accounts.');
    const system = lastSystemText();
    expect(system).toContain(reworded);
  });

  it('4. a deleted conversation note stops being retrieved, and its range stays claimed', async () => {
    // While it is live it is certain to be recalled: its embedding IS the query vector.
    await ordinaryTurn('Write a Meta ad about renting versus buying.');
    expect(lastSystemText()).toContain(CHUNK_MARKER);

    const deleted = await page({ action: 'delete_chunk', chunkId });
    expect(deleted.status).toBe(200);
    if (deleted.status !== 200) return;
    expect(deleted.body).toMatchObject({ action: 'delete_chunk', outcome: 'deleted' });

    const row = await db.query<{
      summary: string;
      audience: string | null;
      embedding: string | null;
      turn_range: string;
      deleted_at: string | null;
      deleted_by: string | null;
    }>(
      `select summary, audience, embedding::text as embedding, turn_range::text as turn_range,
              deleted_at, deleted_by
       from public.memory_chunks where id = $1`,
      [chunkId],
    );
    // The content is gone; the claim over the range is not.
    expect(row.rows[0]).toMatchObject({
      summary: CHUNK_TOMBSTONE_SUMMARY,
      audience: null,
      embedding: null,
      turn_range: '[1,11)',
      deleted_by: userId,
    });
    expect(row.rows[0]?.deleted_at).not.toBeNull();

    await ordinaryTurn('Write a Meta ad about renting versus buying.');
    expect(lastSystemText()).not.toContain(CHUNK_MARKER);

    // The summariser still sees the range as covered, so the note cannot quietly come back.
    const coverage = await supabaseChunkStore(service).coverage(earlierConversationId);
    expect(coverage.ok).toBe(true);
    if (!coverage.ok) return;
    expect(coverage.value.nextOrdinal).toBe(11);
    expect(coverage.value.ranges).toContainEqual({ lo: 1, hi: 11 });

    // And it is gone from the page's own list, which selects `deleted_at is null`.
    const listed = await service
      .from('memory_chunks')
      .select('id')
      .eq('conversation_id', earlierConversationId)
      .is('deleted_at', null);
    expect(listed.data).toStrictEqual([]);
  });

  it('8. every change from the page is one audit_log row naming the person', async () => {
    const factRows = await db.query<{ actor: string; action: string; entity_type: string }>(
      `select actor, action, entity_type from public.audit_log
       where actor = $1 and entity_type = 'memory_facts' order by created_at`,
      [userId],
    );
    expect(factRows.rows.map((r) => r.action)).toStrictEqual([
      'MEMORY_FACT_ADDED',
      'MEMORY_FACT_FORGOTTEN',
      'MEMORY_FACT_RESTORED',
      'MEMORY_FACT_EDITED',
    ]);

    const chunkRows = await db.query<{ actor: string; action: string; entity_id: string }>(
      `select actor, action, entity_id from public.audit_log
       where actor = $1 and entity_type = 'memory_chunks'`,
      [userId],
    );
    expect(chunkRows.rows).toStrictEqual([
      { actor: userId, action: 'MEMORY_CHUNK_DELETED', entity_id: chunkId },
    ]);

    // The row-level trigger's own rows sit alongside them with actor 'service_role' (the
    // write comes through the service key, so auth.uid() is null): the trigger has the data
    // images, these have the human. Nothing about the deleted SUMMARY is in either — there
    // is no audit trigger on memory_chunks, by design.
    const triggerRows = await db.query<{ n: string }>(
      `select count(*) as n from public.audit_log
       where entity_id = $1 and actor <> $2 and entity_type = 'memory_facts'`,
      [factId, userId],
    );
    expect(Number(triggerRows.rows[0]?.n ?? '0')).toBeGreaterThan(0);

    const chunkTrail = await db.query<{ n: string }>(
      `select count(*) as n from public.audit_log
       where entity_id = $1 and (before::text like $2 or after::text like $2)`,
      [chunkId, `%${CHUNK_MARKER}%`],
    );
    expect(chunkTrail.rows[0]?.n).toBe('0');
  });

  it("D54: editing a TEAMMATE's workspace note supersedes it — one live row per key, whoever wrote it", async () => {
    // The gap this closes: before migration 20260827040000, `upsert_memory_fact` matched on
    // (user_id, scope, key), so a second person's version of the same note inserted a SECOND
    // live row and the model was handed both on every turn, contradicting itself.
    // Run-scoped like every other key this file writes: a workspace note's identity is now
    // global to the table (D54), so a hardcoded one is a collision waiting for a neighbour.
    const key = `writing:teammate-note-${SCOPE_SUFFIX}`;
    const theirs = await db.query<{ id: string }>(
      `insert into public.memory_facts (user_id, scope, key, value)
       values ($1, 'workspace', $2, 'Posts open with a question.') returning id`,
      [teammateId, key],
    );
    const theirId = theirs.rows[0]?.id ?? '';

    const edited = await page({
      action: 'edit',
      factId: theirId,
      value: 'Posts open with the reader’s problem, not a question.',
    });
    expect(edited.status).toBe(200);
    if (edited.status !== 200) return;
    expect(edited.body).toMatchObject({ outcome: 'saved', key, replaced: true });

    const rows = await db.query<{ id: string; user_id: string; superseded_by: string | null }>(
      `select id, user_id, superseded_by from public.memory_facts where key = $1 order by created_at`,
      [key],
    );
    expect(rows.rows).toHaveLength(2);
    const live = rows.rows.filter((r) => r.superseded_by === null);
    expect(live).toHaveLength(1);
    // The teammate's row survives, pointed at the new one; the new one is authored by
    // whoever made the change, so the page and the audit trail agree about who did what.
    expect(rows.rows[0]).toMatchObject({
      id: theirId,
      user_id: teammateId,
      superseded_by: live[0]?.id,
    });
    expect(live[0]?.user_id).toBe(userId);

    // And the database itself refuses a second live one, even bypassing the write path.
    await expect(
      db.query(
        `insert into public.memory_facts (user_id, scope, key, value)
         values ($1, 'workspace', $2, 'a third opinion')`,
        [teammateId, key],
      ),
    ).rejects.toThrow(/memory_facts_live_workspace_key_uniq/);

    await db.query(
      `delete from public.audit_log where entity_id in
         (select id from public.memory_facts where key = $1)`,
      [key],
    );
    await db.query(`delete from public.memory_facts where key = $1`, [key]);
  });

  it('a deactivated member cannot change memory through the page', async () => {
    await db.query(`update public.app_users set is_active = false where user_id = $1`, [userId]);
    try {
      const refused = await page({ action: 'add', text: 'Remember that we are rebranding.' });
      expect(refused.status).toBe(403);
      const rows = await db.query<{ n: string }>(
        `select count(*) as n from public.memory_facts where user_id = $1`,
        [userId],
      );
      // Nothing new landed: still the three rows test 3 left behind.
      expect(rows.rows[0]?.n).toBe('3');
    } finally {
      await db.query(`update public.app_users set is_active = true where user_id = $1`, [userId]);
    }
  });
});
