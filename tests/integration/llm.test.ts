/**
 * Claude layer against a real Supabase stack (Stage 2 part 4) — the production code path
 * (wiring is the same createClaudeClient / supabase stores / verify deps the Edge Function
 * uses), with ONE substitution: fetch to Anthropic is a scripted fixture, so CI spends no
 * money and needs no key. What is proven here is the database half of Part C:
 *
 *   3. one successful turn → exactly one api_usage row for that conversation, non-zero
 *      tokens, cost equal to the arithmetic, user_id and conversation_id set;
 *      the conversation row exists for the caller and the two messages carry the
 *      trigger-synced scope;
 *   1. the cap set to zero → 402, no fetch, and NO new api_usage row for that conversation;
 *   6/7. an unauthenticated caller and a DEACTIVATED user (real GoTrue token, real
 *      app_users row) → 401 / 403, no fetch, no rows;
 *   +  spentSince paginates past PostgREST's 1,000-row page.
 *
 * Counts are scoped to this run's conversation / user ids, never the whole table (the
 * part-3 CI lesson). Fixtures are synthetic and removed.
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
import { createLogger } from '../../src/lib/logger.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);
const FAKE_KEY = 'sk-ant-integration-not-a-real-key-000000';

const cfg: SupabaseAuthConfig = {
  url: env?.url ?? 'http://stack-not-running.invalid',
  anonKey: env?.anonKey ?? 'unset',
  serviceRoleKey: env?.serviceRoleKey ?? 'unset',
};

const FIXTURE = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'anthropic', 'messages-ok.json'),
  'utf8',
);

function llmConfig(dailyUsd: number): LlmConfig {
  return {
    apiKey: FAKE_KEY,
    baseUrl: 'https://anthropic.test',
    apiVersion: '2023-06-01',
    models: { default: 'claude-sonnet-5', fast: 'claude-haiku-4-5-20251001' },
    maxTokens: 256,
    timeoutMs: 5_000,
    retries: 0,
    thinking: 'disabled',
    history: { maxMessages: 20, maxChars: 24_000 },
    caps: { dailyUsd, monthlyUsd: 1_000, warnFraction: 0.8 },
    pricing: DEFAULT_PRICING,
  };
}

interface TestUser {
  id: string;
  email: string;
  token: string;
}

describe.skipIf(env === null)('Claude layer against a real stack', () => {
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
  const fixtureFetch: FetchLike = (url) => {
    fetchCalls.push(url);
    return Promise.resolve(
      new Response(FIXTURE, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };

  const created: TestUser[] = [];
  let active: TestUser;
  let deactivated: TestUser;
  let conversationId = '';

  function depsWith(dailyUsd: number): ChatDeps {
    return {
      verify: supabaseVerifyDeps(service),
      claude: createClaudeClient({
        config: llmConfig(dailyUsd),
        http: createHttpClient({ fetch: fixtureFetch, retries: 0, logger: log }),
        usage: supabaseUsageStore(service),
        log,
      }),
      conversations: supabaseConversationStore(service),
      log,
    };
  }

  async function createUser(label: string, isActive: boolean): Promise<TestUser> {
    const email = `llm-${label}-${RUN}@example.com`;
    const password = `Fixture-${crypto.randomUUID()}`;
    const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (result.error !== null) throw new Error(`createUser ${label}: ${result.error.message}`);
    const id = result.data.user.id;
    created.push({ id, email, token: '' });
    await db.query(
      `insert into public.app_users (user_id, email, role, is_active) values ($1, $2, 'staff', $3)`,
      [id, email, isActive],
    );
    const signIn = await anon.auth.signInWithPassword({ email, password });
    if (signIn.error !== null) throw new Error(`signIn ${label}: ${signIn.error.message}`);
    const user = { id, email, token: signIn.data.session.access_token };
    created[created.length - 1] = user;
    return user;
  }

  beforeAll(async () => {
    await db.connect();
    active = await createUser('active', true);
    // Deactivated AFTER sign-in so the token is real and still valid — the refusal must
    // come from the allowlist row, not from the token.
    deactivated = await createUser('deactivated', true);
    await db.query(`update public.app_users set is_active = false where user_id = $1`, [
      deactivated.id,
    ]);
  });

  afterAll(async () => {
    for (const user of created) {
      await db.query(`delete from public.api_usage where user_id = $1`, [user.id]);
      await db.query(
        `delete from public.messages where conversation_id in (select id from public.conversations where user_id = $1)`,
        [user.id],
      );
      await db.query(`delete from public.conversations where user_id = $1`, [user.id]);
      await db.query(`delete from public.app_users where user_id = $1`, [user.id]);
      await admin.auth.admin.deleteUser(user.id);
    }
    await db.end();
  });

  it('3. one turn → one api_usage row with real tokens and cost, a conversation, two scope-synced messages', async () => {
    const result = await handleChatTurn(depsWith(5), {
      token: active.token,
      message: `integration hello ${RUN}`,
    });
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    conversationId = result.body.conversationId;
    expect(fetchCalls).toEqual(['https://anthropic.test/v1/messages']);

    const usage = await db.query(
      `select provider, operation, model, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, cost_usd::text as cost_usd, user_id, conversation_id
         from public.api_usage where conversation_id = $1`,
      [conversationId],
    );
    expect(usage.rowCount).toBe(1);
    expect(usage.rows[0]).toEqual({
      provider: 'anthropic',
      operation: 'chat.turn',
      model: 'claude-sonnet-5',
      input_tokens: 168,
      output_tokens: 118,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      // 168 × 3/1e6 + 118 × 15/1e6 = 0.000504 + 0.00177
      cost_usd: '0.002274',
      user_id: active.id,
      conversation_id: conversationId,
    });

    const conv = await db.query(
      `select user_id, scope, deleted_at from public.conversations where id = $1`,
      [conversationId],
    );
    expect(conv.rows).toEqual([{ user_id: active.id, scope: 'workspace', deleted_at: null }]);

    const messages = await db.query(
      `select role, content, model, input_tokens, output_tokens, user_id, scope
         from public.messages where conversation_id = $1 order by created_at, role desc`,
      [conversationId],
    );
    expect(messages.rows).toEqual([
      {
        role: 'user',
        content: `integration hello ${RUN}`,
        model: null,
        input_tokens: null,
        output_tokens: null,
        user_id: active.id,
        scope: 'workspace',
      },
      {
        role: 'assistant',
        content: result.body.reply,
        model: 'claude-sonnet-5',
        input_tokens: 168,
        output_tokens: 118,
        user_id: active.id,
        scope: 'workspace',
      },
    ]);
  });

  it('1. cap already spent (daily cap 0) → 402, no fetch, no new api_usage row', async () => {
    const before = fetchCalls.length;
    const result = await handleChatTurn(depsWith(0), {
      token: active.token,
      message: 'should be refused',
      conversationId,
    });
    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({ error: { code: 'SPEND_CAP' } });
    expect(fetchCalls.length).toBe(before);
    const usage = await db.query(
      `select count(*)::int as n from public.api_usage where conversation_id = $1`,
      [conversationId],
    );
    expect(usage.rows[0]).toEqual({ n: 1 });
  });

  it('6. unauthenticated caller → 401, no fetch, nothing written', async () => {
    const before = fetchCalls.length;
    const result = await handleChatTurn(depsWith(5), { token: null, message: 'stranger' });
    expect(result.status).toBe(401);
    expect(fetchCalls.length).toBe(before);
    const tampered = await handleChatTurn(depsWith(5), {
      token: `${active.token.slice(0, -4)}AAAA`,
      message: 'stranger',
    });
    expect(tampered.status).toBe(401);
    expect(fetchCalls.length).toBe(before);
  });

  it('7. deactivated user with a still-valid token → 403, no fetch, no rows', async () => {
    const before = fetchCalls.length;
    const result = await handleChatTurn(depsWith(5), {
      token: deactivated.token,
      message: 'deactivated',
    });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(fetchCalls.length).toBe(before);
    const rows = await db.query(
      `select (select count(*) from public.api_usage where user_id = $1)::int as usage,
              (select count(*) from public.conversations where user_id = $1)::int as conversations`,
      [deactivated.id],
    );
    expect(rows.rows[0]).toEqual({ usage: 0, conversations: 0 });
  });

  it('spentSince paginates past 1,000 rows (a cap that reads one page is blind)', async () => {
    const since = new Date();
    const values = Array.from(
      { length: 1_001 },
      (_, i) => `($1, 'pagination', 0.000001, $2, $${i + 3})`,
    );
    const params: unknown[] = ['anthropic', active.id, ...Array.from({ length: 1_001 }, () => 'm')];
    await db.query(
      `insert into public.api_usage (provider, operation, cost_usd, user_id, model) values ${values.join(',')}`,
      params,
    );
    const spent = await supabaseUsageStore(service).spentSince('anthropic', since);
    expect(spent.ok).toBe(true);
    if (!spent.ok) return;
    // Lower bound, not equality: other suites may write to the same ledger concurrently.
    expect(spent.value).toBeGreaterThanOrEqual(0.001001);
  });

  it('5. the key appears in no log line written during the run', () => {
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line, line).not.toContain(FAKE_KEY);
    }
  });
});
