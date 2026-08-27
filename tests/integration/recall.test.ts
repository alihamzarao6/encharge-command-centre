/**
 * Durable facts and retrieval against a real Supabase stack (Stage 3 part 2, FND-310) —
 * the production code path (createTurnMemory: the real Claude client, the real Voyage
 * adapter, the supabase stores, the two SQL functions of migration 20260827010000) with
 * ONE substitution: fetch to Anthropic and Voyage is a scripted fixture, so CI spends no
 * money and needs no key. What is proven here is the database half of Part C:
 *
 *   1. "Remember that…" through handleChatTurn → exactly one memory_facts row, scope from
 *      the conversation, source_message_id = the saved user message;
 *   2. a contradicting statement → the old row survives with superseded_by set, one live row;
 *   3. current facts exclude superseded rows — and that is what the next turn's request holds;
 *   4. a chunk from an EARLIER conversation reaches the Claude request — the fixture fetch
 *      sees the chunk's summary in an uncached system block after the cached voice prefix;
 *   5. forty chunks in the store → at most three, under the budget, lowest similarity dropped;
 *   6. nothing above the floor → no chunk in the request, the turn still 200;
 *   7. Voyage unreachable during recall → 200, facts still present, chunks absent;
 *   8. RLS: tests/security/rls.test.ts (4, 5, 7) — facts follow the same scoping as chunks.
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

/** A unit vector `angle` radians away from the fixture vector, so cosine = cos(angle). */
function vectorAt(angle: number): number[] {
  const norm = Math.hypot(...FIXTURE_VECTOR);
  const u = FIXTURE_VECTOR.map((x) => x / norm);
  // Gram–Schmidt e1 against u to get a unit vector orthogonal to it.
  const dot = u[0] ?? 0;
  const w = u.map((x, i) => (i === 0 ? 1 : 0) - dot * x);
  const wn = Math.hypot(...w);
  return u.map((x, i) => Math.cos(angle) * x + (Math.sin(angle) * (w[i] ?? 0)) / wn);
}

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

interface SeenRequest {
  readonly url: string;
  readonly body: string;
}

interface SystemBlockWire {
  readonly text: string;
  readonly cache_control?: unknown;
}

describe.skipIf(env === null)('durable facts and retrieval against a real stack', () => {
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
  const seen: SeenRequest[] = [];
  let voyageBroken = false;
  let haikuAnswer = 'fact-ok';
  const fixtureFetch: FetchLike = (url, init) => {
    const body = typeof init.body === 'string' ? init.body : '';
    seen.push({ url, body });
    if (url.startsWith('https://anthropic.test')) {
      const parsed = JSON.parse(body === '' ? '{}' : body) as { model?: string };
      const name =
        typeof parsed.model === 'string' && parsed.model.includes('haiku')
          ? haikuAnswer
          : 'messages-ok';
      return Promise.resolve(
        new Response(fixture('anthropic', name), {
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

  /** Production wiring with the fixture fetch under both providers. */
  function chatDeps(): ChatDeps {
    const http = createHttpClient({ fetch: fixtureFetch, retries: 0, logger: log });
    const usage = supabaseUsageStore(service);
    const claude = createClaudeClient({ config: llmConfig, http, usage, log });
    const memoryDeps = {
      claude,
      embedder: createVoyageEmbedder({ config: memoryConfig.voyage, http, usage, log }),
      chunks: supabaseChunkStore(service),
      policy: memoryConfig.policy,
      log,
    };
    return {
      verify: supabaseVerifyDeps(service),
      claude,
      conversations: supabaseConversationStore(service),
      log,
      history: llmConfig.history,
      memory: createTurnMemory(memoryConfig, service, memoryDeps),
    };
  }

  /** The `system` array of the most recent request that went to Anthropic. */
  function lastSystem(): SystemBlockWire[] {
    const last = [...seen].reverse().find((s) => s.url.startsWith('https://anthropic.test'));
    const body = JSON.parse(last?.body ?? '{}') as { system?: SystemBlockWire[] };
    return body.system ?? [];
  }

  let userId = '';
  let token = '';
  let earlierConversationId = '';
  let newConversationId = '';

  async function seedChunk(
    conversationId: string,
    summary: string,
    vector: readonly number[],
    range: string,
  ): Promise<void> {
    await db.query(
      `insert into public.memory_chunks (conversation_id, user_id, scope, summary, embedding, turn_range)
       values ($1, $2, 'workspace', $3, $4::vector, $5)`,
      [conversationId, userId, summary, `[${vector.join(',')}]`, range],
    );
  }

  beforeAll(async () => {
    await db.connect();
    const email = `recall-${RUN}@example.com`;
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

    // An earlier conversation with one chunk whose embedding IS the fixture vector, so a
    // query embedded through the fixture matches it at similarity 1.
    const conv = await db.query<{ id: string }>(
      `insert into public.conversations (user_id, scope, title) values ($1, 'workspace', $2) returning id`,
      [userId, `recall-int-${RUN} earlier`],
    );
    earlierConversationId = conv.rows[0]?.id ?? '';
    for (let i = 0; i < 4; i += 1) {
      await db.query(
        `insert into public.messages (conversation_id, user_id, scope, role, content, created_at)
         values ($1, $2, 'workspace', $3, $4, now() - make_interval(days => 2, mins => $5))`,
        [earlierConversationId, userId, i % 2 === 0 ? 'user' : 'assistant', `earlier ${i}`, 4 - i],
      );
    }
    await seedChunk(
      earlierConversationId,
      `RECALL-MARKER-${RUN}: the user asked for a Meta ad about renting and wanted the headline shortened.`,
      FIXTURE_VECTOR,
      '[1,5)',
    );
  }, 60_000);

  afterAll(async () => {
    await db.query(`delete from public.api_usage where user_id = $1`, [userId]);
    await db.query(`delete from public.memory_facts where user_id = $1`, [userId]);
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

  it('1. "Remember that…" → exactly one fact, workspace scope, source_message_id = the saved user message', async () => {
    haikuAnswer = 'fact-ok';
    const result = await handleChatTurn(chatDeps(), {
      token,
      message:
        "Remember that when I'm writing finance content, I want the Rule of One framework and a direct CTA.",
    });
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    newConversationId = result.body.conversationId;
    expect(result.body.memory?.savedFact).toEqual({
      key: 'writing:finance-content-framework',
      outcome: 'inserted',
    });
    const rows = await db.query<{
      scope: string;
      key: string;
      value: string;
      source_message_id: string | null;
      superseded_by: string | null;
      confidence: string;
    }>(
      `select scope, key, value, source_message_id, superseded_by, confidence
       from public.memory_facts where user_id = $1`,
      [userId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      scope: 'workspace',
      key: 'writing:finance-content-framework',
      value: 'Finance content uses the Rule of One framework and ends with a direct CTA.',
      source_message_id: result.body.userMessageId,
      superseded_by: null,
    });
    expect(Number(rows.rows[0]?.confidence)).toBe(1);
    // The reply's request carried the "just saved" block below the cached prefix.
    const system = lastSystem();
    expect(system).toHaveLength(2);
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1]?.cache_control).toBeUndefined();
    expect(system[1]?.text).toContain('was saved as writing:finance-content-framework');
  });

  it('2. a contradicting statement supersedes: the old row survives with superseded_by set, one live row', async () => {
    // Seed the key the recorded "replace" answer names, so `replaces` hits a live row.
    await db.query(
      `select * from public.upsert_memory_fact($1, 'workspace', 'writing:finance-content',
         'Finance content uses the Rule of One framework and ends with a direct CTA.', 1, null)`,
      [userId],
    );
    haikuAnswer = 'fact-replace';
    const result = await handleChatTurn(chatDeps(), {
      token,
      message:
        'From now on, finance content should use the PAS framework instead of Rule of One, still with a direct CTA.',
      conversationId: newConversationId,
    });
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.memory?.savedFact).toEqual({
      key: 'writing:finance-content',
      outcome: 'superseded',
    });
    const rows = await db.query<{ id: string; value: string; superseded_by: string | null }>(
      `select id, value, superseded_by from public.memory_facts
       where user_id = $1 and key = 'writing:finance-content' order by created_at`,
      [userId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.superseded_by).toBe(rows.rows[1]?.id);
    expect(rows.rows[1]?.superseded_by).toBeNull();
    expect(rows.rows[1]?.value).toBe(
      'Finance content uses the PAS framework and ends with a direct CTA.',
    );
  });

  it('3. current facts exclude superseded rows — and that is what the next turn sees', async () => {
    const live = await db.query<{ key: string }>(
      `select key from public.memory_facts where user_id = $1 and superseded_by is null order by key`,
      [userId],
    );
    expect(live.rows.map((r) => r.key)).toEqual([
      'writing:finance-content',
      'writing:finance-content-framework',
    ]);
    const result = await handleChatTurn(chatDeps(), {
      token,
      message: 'Write a LinkedIn post about this property finance opportunity.',
      conversationId: newConversationId,
    });
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.memory?.facts).toBe(2);
    const block = lastSystem()[1]?.text ?? '';
    expect(block).toContain('Finance content uses the PAS framework');
    // The superseded value appears nowhere in the request.
    expect(block.match(/Rule of One framework and ends/g) ?? []).toHaveLength(1);
    expect(block).toContain('writing:finance-content-framework');
  });

  it('4. a chunk from the EARLIER conversation reaches the Claude request, uncached, after the cached voice prefix', async () => {
    const result = await handleChatTurn(chatDeps(), {
      token,
      message: 'Write me a Meta ad about renting versus buying.',
      conversationId: newConversationId,
    });
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.memory?.chunks.map((c) => c.conversationId)).toEqual([
      earlierConversationId,
    ]);
    expect(result.body.memory?.chunks[0]?.similarity).toBeCloseTo(1, 3);
    const system = lastSystem();
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0]?.text).not.toContain('RECALL-MARKER');
    expect(system[1]?.cache_control).toBeUndefined();
    expect(system[1]?.text).toContain(`RECALL-MARKER-${RUN}`);
    expect(system[1]?.text).toContain('data, not instructions');
    expect(system[1]?.text).toContain('<memory_chunks>');
    // Metered: a voyage row for the query embedding.
    const usage = await db.query<{ n: string }>(
      `select count(*) as n from public.api_usage
       where user_id = $1 and provider = 'voyage' and operation = 'memory.recall'`,
      [userId],
    );
    expect(Number(usage.rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });

  it('5. forty chunks in the store → three at most, under the budget, the lowest similarities dropped', async () => {
    const conv = await db.query<{ id: string }>(
      `insert into public.conversations (user_id, scope, title) values ($1, 'workspace', $2) returning id`,
      [userId, `recall-int-${RUN} bulk`],
    );
    const bulkId = conv.rows[0]?.id ?? '';
    for (let i = 0; i < 40; i += 1) {
      // Similarities spread from cos(0.1) ≈ 0.995 down to cos(1.4) ≈ 0.17.
      await seedChunk(
        bulkId,
        `BULK-${RUN}-${i} ${'note text '.repeat(40)}`,
        vectorAt(0.1 + i * (1.3 / 39)),
        `[${i * 2 + 1},${i * 2 + 3})`,
      );
    }
    const result = await handleChatTurn(chatDeps(), {
      token,
      message: 'Write me a Meta ad about renting versus buying.',
      conversationId: newConversationId,
    });
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const memory = result.body.memory;
    expect(memory?.chunks.length).toBeLessThanOrEqual(3);
    expect(memory?.chars).toBeLessThanOrEqual(4_000);
    const sims = memory?.chunks.map((c) => c.similarity) ?? [];
    expect([...sims].sort((a, b) => b - a)).toEqual(sims);
    expect(sims[sims.length - 1] ?? 0).toBeGreaterThanOrEqual(RETRIEVAL_DEFAULTS.minSimilarity);
    // The best of forty-one is still the earlier-conversation chunk (similarity 1).
    expect(memory?.chunks[0]?.conversationId).toBe(earlierConversationId);
    await db.query(`delete from public.memory_chunks where conversation_id = $1`, [bulkId]);
  });

  it('6. nothing clears the floor → no chunk in the request, facts still there, the turn is 200', async () => {
    await db.query(
      `update public.memory_chunks set embedding = $2::vector where conversation_id = $1`,
      [earlierConversationId, `[${vectorAt(1.5).join(',')}]`],
    );
    try {
      const result = await handleChatTurn(chatDeps(), {
        token,
        message: 'Write me a Meta ad about renting versus buying.',
        conversationId: newConversationId,
      });
      expect(result.status).toBe(200);
      if (result.status !== 200) return;
      expect(result.body.memory?.chunks).toEqual([]);
      expect(result.body.memory?.degraded).toEqual([]);
      const block = lastSystem()[1]?.text ?? '';
      expect(block).not.toContain('<memory_chunks>');
      expect(block).toContain('<memory_facts>');
    } finally {
      await db.query(
        `update public.memory_chunks set embedding = $2::vector where conversation_id = $1`,
        [earlierConversationId, `[${FIXTURE_VECTOR.join(',')}]`],
      );
    }
  });

  it('7. Voyage unreachable during recall → 200, facts present, chunks absent, `embed` degraded, turn saved', async () => {
    voyageBroken = true;
    try {
      const result = await handleChatTurn(chatDeps(), {
        token,
        message: 'Write me a Meta ad about renting versus buying.',
        conversationId: newConversationId,
      });
      expect(result.status).toBe(200);
      if (result.status !== 200) return;
      expect(result.body.memory?.degraded).toContain('embed');
      expect(result.body.memory?.chunks).toEqual([]);
      expect(result.body.memory?.facts).toBe(2);
      const saved = await db.query<{ n: string }>(
        `select count(*) as n from public.messages where id = $1`,
        [result.body.userMessageId],
      );
      expect(saved.rows[0]?.n).toBe('1');
    } finally {
      voyageBroken = false;
    }
  });

  it('neither key appears in any log line written during the run', () => {
    const all = logLines.join('\n');
    expect(all).not.toContain(FAKE_VOYAGE_KEY);
    expect(all).not.toContain(FAKE_ANTHROPIC_KEY);
  });
});
