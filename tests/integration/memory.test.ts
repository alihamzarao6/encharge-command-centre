/**
 * Memory layer against a real Supabase stack (Stage 3 part 1) — the production code path
 * (createMemoryDeps: the real Claude client, the real Voyage adapter, the supabase stores)
 * with ONE substitution: fetch to Anthropic and Voyage is a scripted fixture, so CI spends
 * no money and needs no key. What is proven here is the database half of Part C:
 *
 *   1. ten messages in a conversation → exactly one memory_chunks row, turn_range [1,11),
 *      user_id/scope equal to the conversation's;
 *   2. the same run again → still one row, no fetch, no new api_usage row;
 *   3. the stored embedding has 1,024 dimensions and a non-zero norm;
 *   4. the run wrote exactly one voyage row and one anthropic row to api_usage, with the
 *      fixture's token counts and the arithmetic's cost;
 *   5. Voyage cap 0 on a fresh conversation → nothing fetched, nothing written;
 *   8. through handleChatTurn: the hook running against a broken Voyage endpoint does not
 *      change the 200 the user gets.
 *
 * Counts are scoped to this run's conversation ids, never the whole table.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createServiceClient,
  supabaseVerifyDeps,
  type SupabaseAuthConfig,
} from '../../src/lib/auth/clients.js';
import { createHttpClient, type FetchLike } from '../../src/lib/http.js';
import { handleChatTurn, type ChatDeps } from '../../src/lib/llm/chat.js';
import { createClaudeClient } from '../../src/lib/llm/client.js';
import type { LlmConfig } from '../../src/lib/llm/config.js';
import { DEFAULT_PRICING } from '../../src/lib/llm/pricing.js';
import { supabaseConversationStore, supabaseUsageStore } from '../../src/lib/llm/store.js';
import { supabaseChunkStore } from '../../src/lib/memory/chunks.js';
import {
  POLICY_DEFAULTS,
  RETRIEVAL_DEFAULTS,
  type MemoryConfig,
} from '../../src/lib/memory/config.js';
import { createVoyageEmbedder } from '../../src/lib/memory/embed.js';
import {
  createAfterTurnHook,
  summariseConversation,
  type MemoryDeps,
} from '../../src/lib/memory/trigger.js';
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

function memoryConfig(voyageDailyCap: number): MemoryConfig {
  return {
    voyage: {
      apiKey: FAKE_VOYAGE_KEY,
      baseUrl: 'https://voyage.test',
      model: 'voyage-3',
      dimensions: 1024,
      timeoutMs: 5_000,
      retries: 0,
      pricePerMTok: 0.06,
      caps: { dailyUsd: voyageDailyCap, monthlyUsd: 5, warnFraction: 0.8 },
    },
    policy: POLICY_DEFAULTS,
    retrieval: RETRIEVAL_DEFAULTS,
  };
}

describe.skipIf(env === null)('memory layer against a real stack', () => {
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

  const logLines: string[] = [];
  const log = createLogger({
    level: 'debug',
    sink: (line) => {
      logLines.push(line);
    },
  });
  const fetchCalls: string[] = [];
  let voyageBroken = false;
  const fixtureFetch: FetchLike = (url) => {
    fetchCalls.push(url);
    if (url.startsWith('https://anthropic.test')) {
      return Promise.resolve(
        new Response(fixture('anthropic', 'summary-ok'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (voyageBroken) return Promise.reject(new TypeError('voyage unreachable'));
    return Promise.resolve(
      new Response(fixture('voyage', 'embeddings-ok'), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  function memoryDeps(voyageDailyCap: number): MemoryDeps {
    const config = memoryConfig(voyageDailyCap);
    const http = createHttpClient({ fetch: fixtureFetch, retries: 0, logger: log });
    const claude = createClaudeClient({
      config: llmConfig,
      http,
      usage: supabaseUsageStore(service),
      log,
    });
    return {
      claude,
      embedder: createVoyageEmbedder({
        config: config.voyage,
        http,
        usage: supabaseUsageStore(service),
        log,
      }),
      chunks: supabaseChunkStore(service),
      policy: config.policy,
      log,
    };
  }

  let userId = '';
  let token = '';
  let conversationId = '';

  async function seedConversation(messages: number, title: string): Promise<string> {
    const conv = await db.query<{ id: string }>(
      `insert into public.conversations (user_id, scope, title) values ($1, 'workspace', $2) returning id`,
      [userId, title],
    );
    const id = conv.rows[0]?.id ?? '';
    for (let i = 0; i < messages; i += 1) {
      await db.query(
        `insert into public.messages (conversation_id, user_id, scope, role, content, created_at)
         values ($1, $2, 'workspace', $3, $4, now() - make_interval(mins => $5))`,
        [
          id,
          userId,
          i % 2 === 0 ? 'user' : 'assistant',
          `memory-int-${RUN} message ${i + 1} about offset accounts`,
          messages - i,
        ],
      );
    }
    return id;
  }

  beforeAll(async () => {
    await db.connect();
    const email = `memory-${RUN}@example.com`;
    const password = `Fixture-${crypto.randomUUID()}`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error !== null) throw new Error(created.error.message);
    userId = created.data.user.id;
    await db.query(
      `insert into public.app_users (user_id, email, role, is_active) values ($1, $2, 'staff', true)`,
      [userId, email],
    );
    const signIn = await anon.auth.signInWithPassword({ email, password });
    if (signIn.error !== null) throw new Error(signIn.error.message);
    token = signIn.data.session.access_token;
    conversationId = await seedConversation(10, `memory-int-${RUN} ten`);
  }, 60_000);

  afterAll(async () => {
    await db.query(`delete from public.api_usage where user_id = $1`, [userId]);
    await db.query(
      `delete from public.memory_chunks where conversation_id in (select id from public.conversations where user_id = $1)`,
      [userId],
    );
    await db.query(
      `delete from public.messages where conversation_id in (select id from public.conversations where user_id = $1)`,
      [userId],
    );
    await db.query(`delete from public.conversations where user_id = $1`, [userId]);
    await db.query(`delete from public.app_users where user_id = $1`, [userId]);
    await admin.auth.admin.deleteUser(userId);
    await db.end();
  }, 60_000);

  it('1. ten messages → exactly one chunk, turn_range [1,11), ownership from the conversation', async () => {
    const conversation = {
      id: conversationId,
      userId,
      scope: 'workspace' as const,
      title: `memory-int-${RUN} ten`,
    };
    const result = await summariseConversation(memoryDeps(0.5), conversation, {
      freshMessages: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.planned).toEqual([{ lo: 1, hi: 11 }]);
    expect(result.value.chunks.map((c) => c.result)).toEqual(['inserted']);

    const rows = await db.query<{
      turn_range: string;
      user_id: string;
      scope: string;
      summary: string;
    }>(
      `select turn_range::text, user_id, scope, summary
       from public.memory_chunks where conversation_id = $1`,
      [conversationId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      turn_range: '[1,11)',
      user_id: userId,
      scope: 'workspace',
    });
    expect(rows.rows[0]?.summary).toContain('The user is a mortgage broker');
    expect(rows.rows[0]?.summary).not.toContain(`memory-int-${RUN}`);
  });

  it('2. the same run again → still one chunk, no fetch, no new api_usage row', async () => {
    const before = fetchCalls.length;
    const usageBefore = await db.query<{ n: number }>(
      `select count(*)::int as n from public.api_usage where conversation_id = $1`,
      [conversationId],
    );
    const result = await summariseConversation(
      memoryDeps(0.5),
      { id: conversationId, userId, scope: 'workspace', title: null },
      { freshMessages: 2 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.planned).toEqual([]);
    expect(fetchCalls.length).toBe(before);
    const chunks = await db.query<{ n: number }>(
      `select count(*)::int as n from public.memory_chunks where conversation_id = $1`,
      [conversationId],
    );
    expect(chunks.rows[0]).toEqual({ n: 1 });
    const usageAfter = await db.query<{ n: number }>(
      `select count(*)::int as n from public.api_usage where conversation_id = $1`,
      [conversationId],
    );
    expect(usageAfter.rows[0]).toEqual(usageBefore.rows[0]);
  });

  it('3. the stored embedding is 1,024 dimensions with a non-zero norm', async () => {
    const rows = await db.query<{ dims: number; norm: string }>(
      `select vector_dims(embedding) as dims, vector_norm(embedding)::text as norm
       from public.memory_chunks where conversation_id = $1`,
      [conversationId],
    );
    expect(rows.rows[0]?.dims).toBe(1024);
    expect(Number(rows.rows[0]?.norm)).toBeGreaterThan(0);
  });

  it('4. one voyage row and one anthropic row in api_usage, with real tokens and cost', async () => {
    const rows = await db.query(
      `select provider, operation, model, input_tokens, output_tokens, cost_usd::text as cost_usd,
              user_id, conversation_id
         from public.api_usage where conversation_id = $1 order by provider`,
      [conversationId],
    );
    expect(rows.rows).toEqual([
      {
        provider: 'anthropic',
        operation: 'memory.summarise',
        model: 'claude-haiku-4-5-20251001',
        input_tokens: 915,
        output_tokens: 241,
        // 915 × $1/M + 241 × $5/M
        cost_usd: '0.002120',
        user_id: userId,
        conversation_id: conversationId,
      },
      {
        provider: 'voyage',
        operation: 'memory.embed',
        model: 'voyage-3',
        input_tokens: 212,
        output_tokens: 0,
        // 212 × $0.06/M
        cost_usd: '0.000013',
        user_id: userId,
        conversation_id: conversationId,
      },
    ]);
  });

  it('5. Voyage cap 0 → nothing fetched, nothing written, range left uncovered', async () => {
    const fresh = await seedConversation(10, `memory-int-${RUN} capped`);
    const before = fetchCalls.length;
    const result = await summariseConversation(
      memoryDeps(0),
      { id: fresh, userId, scope: 'workspace', title: null },
      { freshMessages: 2 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.chunks[0]?.error?.code).toBe('SPEND_CAP');
    expect(fetchCalls.length).toBe(before);
    const rows = await db.query<{ chunks: number; usage: number }>(
      `select (select count(*) from public.memory_chunks where conversation_id = $1)::int as chunks,
              (select count(*) from public.api_usage where conversation_id = $1)::int as usage`,
      [fresh],
    );
    expect(rows.rows[0]).toEqual({ chunks: 0, usage: 0 });
  });

  it('8. through handleChatTurn: a broken Voyage does not change the 200; the turn is saved', async () => {
    voyageBroken = true;
    try {
      const memory = memoryDeps(0.5);
      const scheduled: Promise<void>[] = [];
      const deps: ChatDeps = {
        verify: supabaseVerifyDeps(service),
        claude: createClaudeClient({
          config: llmConfig,
          http: createHttpClient({ fetch: fixtureFetch, retries: 0, logger: log }),
          usage: supabaseUsageStore(service),
          log,
        }),
        conversations: supabaseConversationStore(service),
        log,
        afterTurn: createAfterTurnHook(memory),
        waitUntil: (work) => {
          scheduled.push(work);
        },
      };
      // A conversation with 8 messages: this turn makes 10 and trips the size rule.
      const eight = await seedConversation(8, `memory-int-${RUN} eight`);
      const result = await handleChatTurn(deps, {
        token,
        message: `memory-int-${RUN} message 9 about offset accounts`,
        conversationId: eight,
      });
      expect(result.status).toBe(200);
      expect(scheduled).toHaveLength(1);
      await expect(scheduled[0]).resolves.toBeUndefined();

      // CHANGED 30 Aug (D70). This used to assert `chunks: 0` — a broken Voyage threw away
      // the summary that Haiku had already been paid for, and left the range uncovered so
      // the next sweep bought the same text again. Now the note is KEPT with a null
      // embedding and the range is covered.
      //
      // The 200 and the saved turn are unchanged, which is the point of Part C item 8: a
      // memory failure never reaches the user.
      const rows = await db.query<{
        messages: number;
        chunks: number;
        unembedded: number;
        range: string | null;
      }>(
        `select (select count(*) from public.messages where conversation_id = $1)::int as messages,
                (select count(*) from public.memory_chunks where conversation_id = $1)::int as chunks,
                (select count(*) from public.memory_chunks
                   where conversation_id = $1 and embedding is null and deleted_at is null)::int as unembedded,
                (select turn_range::text from public.memory_chunks where conversation_id = $1) as range`,
        [eight],
      );
      expect(rows.rows[0]).toEqual({
        messages: 10,
        chunks: 1,
        unembedded: 1,
        range: '[1,11)',
      });
      expect(logLines.some((l) => l.includes('keeping the summary and covering the range'))).toBe(
        true,
      );

      // And the range really is claimed: a second pass plans nothing and spends nothing.
      const before = await db.query<{ n: number }>(
        `select count(*)::int as n from public.api_usage where operation = 'memory.summarise'`,
      );
      const again = await summariseConversation(
        memory,
        { id: eight, userId, scope: 'workspace', title: `memory-int-${RUN} eight` },
        { freshMessages: 0, force: true },
      );
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.value.chunks).toStrictEqual([]);
      const after = await db.query<{ n: number }>(
        `select count(*)::int as n from public.api_usage where operation = 'memory.summarise'`,
      );
      expect(after.rows[0]?.n, 'Haiku is never paid twice for the same text').toBe(
        before.rows[0]?.n,
      );
    } finally {
      voyageBroken = false;
    }
  });

  it('7. neither key appears in any log line written during the run', () => {
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line, line).not.toContain(FAKE_VOYAGE_KEY);
      expect(line, line).not.toContain(FAKE_ANTHROPIC_KEY);
    }
  });
});
