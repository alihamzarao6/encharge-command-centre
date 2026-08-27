/**
 * Memory-layer runner (Stage 3 part 1).
 *
 *   npm run memory -- flush <conversationId>     summarise the whole uncovered tail NOW
 *                                                (the "force a summarisation" path — no
 *                                                fifty-message conversation needed)
 *   npm run memory -- sweep [--limit N]          idle conversations → tail chunks (what a
 *                                                scheduler will call from part 5)
 *   npm run memory -- preview <transcript.json>  summarise a transcript file with the live
 *                                                model and print the note, usage and cost —
 *                                                no database, no Voyage; the way to read
 *                                                what a summary looks like before trusting it
 *
 * Part 2 (facts + retrieval), all as the staff account in CHAT_EMAIL / STAFF_ADMIN_EMAIL:
 *   npm run memory -- recall "<message>" [--conversation <id>]
 *                                                run the recall step for that message exactly
 *                                                as a turn would and print the assembled
 *                                                below-breakpoint block, the chunks with their
 *                                                similarity, and the size in characters/tokens.
 *                                                Nothing is sent to Claude; the query embedding
 *                                                is metered as in production. Refuses a
 *                                                "remember that…" message — use `remember`.
 *   npm run memory -- remember "<statement>"     store a fact by hand through the same
 *                                                extractor and guards a chat turn uses
 *                                                (source_message_id null: there is no message)
 *   npm run memory -- facts [--all]              list the caller's live facts (`--all`
 *                                                includes superseded rows with their pointer)
 *
 * `flush` and `sweep` run the production wiring (createChatDeps → createMemoryDeps): the
 * same caps, ledger, stores and Edge-Function code path, from a terminal. They need the
 * server environment (.env is loaded if present): SUPABASE_*, ANTHROPIC_* and VOYAGE_API_KEY.
 * `preview` needs only the Anthropic side and meters through an in-memory ledger so the
 * env caps still hold.
 *
 * Output is JSON on stdout and contains no secret; ids only, never message text — except
 * `preview`, whose whole point is to show the summary text of a transcript YOU supplied.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { createServiceClient, loadSupabaseAuthConfig } from '../src/lib/auth/clients.js';
import { ok, type Result } from '../src/lib/errors.js';
import { createHttpClient } from '../src/lib/http.js';
import { createClaudeClient, type ClaudeClient, type UsageRecord } from '../src/lib/llm/client.js';
import { loadLlmConfig } from '../src/lib/llm/config.js';
import { supabaseUsageStore } from '../src/lib/llm/store.js';
import { createMemoryDeps } from '../src/lib/llm/wiring.js';
import { captureFact, isExplicitMemoryRequest } from '../src/lib/memory/capture.js';
import { loadMemoryConfig, loadMemoryPolicy, type MemoryConfig } from '../src/lib/memory/config.js';
import { supabaseFactStore } from '../src/lib/memory/facts.js';
import { recallForTurn, supabaseChunkSearch } from '../src/lib/memory/retrieve.js';
import { summariseMessages } from '../src/lib/memory/summarise.js';
import {
  summariseConversation,
  sweepIdleConversations,
  type MemoryDeps,
} from '../src/lib/memory/trigger.js';
import { logger } from '../src/lib/logger.js';

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`memory: ${message}\n`);
  process.exit(1);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TRANSCRIPT_SCHEMA = z.array(
  z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1) }),
);

function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env — rely on the real environment.
  }
}

function claudeWithLedger(): { claude: ClaudeClient; rows: UsageRecord[] } {
  const config = loadLlmConfig(process.env);
  if (!config.ok) fail(`${config.error.code}: ${config.error.message}`);
  const rows: UsageRecord[] = [];
  const claude = createClaudeClient({
    config: config.value,
    http: createHttpClient({ timeoutMs: config.value.timeoutMs, retries: 0, logger }),
    usage: {
      spentSince: (): Promise<Result<number>> =>
        Promise.resolve(ok(rows.reduce((sum, r) => sum + r.costUsd, 0))),
      record: (row): Promise<Result<void>> => {
        rows.push(row);
        return Promise.resolve(ok(undefined));
      },
    },
    log: logger,
  });
  return { claude, rows };
}

function productionDeps(): MemoryDeps {
  const supabase = loadSupabaseAuthConfig(process.env);
  if (!supabase.ok) fail(`${supabase.error.code}: ${supabase.error.message}`);
  const llm = loadLlmConfig(process.env);
  if (!llm.ok) fail(`${llm.error.code}: ${llm.error.message}`);
  const memory = loadMemoryConfig(process.env);
  if (!memory.ok) fail(`${memory.error.code}: ${memory.error.message}`);
  const service = createServiceClient(supabase.value);
  const claude = createClaudeClient({
    config: llm.value,
    http: createHttpClient({ timeoutMs: llm.value.timeoutMs, retries: 0, logger }),
    usage: supabaseUsageStore(service),
    log: logger,
  });
  return createMemoryDeps(memory.value, service, claude, logger);
}

async function flush(conversationId: string | undefined): Promise<void> {
  if (conversationId === undefined || !UUID.test(conversationId)) {
    fail('usage: npm run memory -- flush <conversationId>');
  }
  const deps = productionDeps();
  const supabase = loadSupabaseAuthConfig(process.env);
  if (!supabase.ok) fail(supabase.error.message);
  const service = createServiceClient(supabase.value);
  const found = await service
    .from('conversations')
    .select('id, user_id, scope, title, deleted_at')
    .eq('id', conversationId)
    .limit(1);
  const row = found.data?.[0];
  if (found.error !== null || row === undefined) fail('conversation not found');
  if (row.deleted_at !== null) fail('conversation is deleted');
  if (row.scope !== 'user' && row.scope !== 'workspace') fail('conversation scope is invalid');
  const outcome = await summariseConversation(
    deps,
    { id: row.id, userId: row.user_id, scope: row.scope, title: row.title },
    { freshMessages: 0, force: true },
  );
  if (!outcome.ok) fail(`${outcome.error.code}: ${outcome.error.message}`);
  out(outcome.value);
  process.exit(outcome.value.chunks.some((c) => c.result === 'failed') ? 2 : 0);
}

async function sweep(limitArg: string | undefined): Promise<void> {
  const limit = limitArg === undefined ? 20 : Number(limitArg);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('--limit must be 1..200');
  const deps = productionDeps();
  const outcome = await sweepIdleConversations(deps, limit);
  if (!outcome.ok) fail(`${outcome.error.code}: ${outcome.error.message}`);
  out(outcome.value);
}

async function preview(file: string | undefined): Promise<void> {
  if (file === undefined) fail('usage: npm run memory -- preview <transcript.json>');
  const raw: unknown = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const parsed = TRANSCRIPT_SCHEMA.safeParse(raw);
  if (!parsed.success) fail('transcript must be [{ role: user|assistant, content }]');
  const policy = loadMemoryPolicy(process.env);
  if (!policy.ok) fail(policy.error.message);
  const { claude, rows } = claudeWithLedger();
  const messages = parsed.data.map((m, i) => ({
    ordinal: i + 1,
    role: m.role,
    content: m.content,
  }));
  const summary = await summariseMessages(
    claude,
    {
      messages,
      range: { lo: 1, hi: messages.length + 1 },
      maxChars: policy.value.summaryMaxChars,
      userId: null,
      conversationId: null,
    },
    logger,
  );
  if (!summary.ok) fail(`${summary.error.code}: ${summary.error.message}`);
  out({
    summary: summary.value.text,
    words: summary.value.text.split(/\s+/).length,
    chars: summary.value.text.length,
    model: summary.value.model,
    usage: summary.value.usage,
    costUsd: summary.value.costUsd,
    attempts: summary.value.attempts,
    ledger: rows.map((r) => ({ operation: r.operation, model: r.model, costUsd: r.costUsd })),
  });
}

// ---------------------------------------------------------------------------------------
// Part 2: facts and retrieval, as one staff account.
// ---------------------------------------------------------------------------------------

interface Caller {
  readonly userId: string;
  readonly deps: MemoryDeps;
  readonly config: MemoryConfig;
  readonly service: ReturnType<typeof createServiceClient>;
}

/** The staff account in CHAT_EMAIL / STAFF_ADMIN_EMAIL, resolved through app_users. */
async function caller(): Promise<Caller> {
  const email = readEnv('CHAT_EMAIL') ?? readEnv('STAFF_ADMIN_EMAIL');
  if (email === undefined) fail('set CHAT_EMAIL (or STAFF_ADMIN_EMAIL) to the staff account');
  const supabase = loadSupabaseAuthConfig(process.env);
  if (!supabase.ok) fail(supabase.error.message);
  const memory = loadMemoryConfig(process.env);
  if (!memory.ok) fail(`${memory.error.code}: ${memory.error.message}`);
  const service = createServiceClient(supabase.value);
  const found = await service
    .from('app_users')
    .select('user_id, is_active')
    .eq('email', email)
    .limit(1);
  const row = found.data?.[0];
  if (found.error !== null || row === undefined) fail('no app_users row for that email');
  if (!row.is_active) fail('that account is deactivated');
  return { userId: row.user_id, deps: productionDeps(), config: memory.value, service };
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

async function recall(args: readonly string[]): Promise<void> {
  const at = args.indexOf('--conversation');
  const conversationId = at === -1 ? null : (args[at + 1] ?? null);
  if (conversationId !== null && !UUID.test(conversationId)) fail('--conversation needs a UUID');
  const message = (at === -1 ? args : args.filter((_, i) => i !== at && i !== at + 1))
    .join(' ')
    .trim();
  if (message === '') fail('usage: npm run memory -- recall "<message>" [--conversation <id>]');
  if (isExplicitMemoryRequest(message)) {
    fail('that reads as a "remember that…" request and would store a fact — use `remember`');
  }
  const c = await caller();
  const facts = supabaseFactStore(c.service);
  const started = Date.now();
  const outcome = await recallForTurn(
    {
      claude: c.deps.claude,
      embedder: c.deps.embedder,
      facts,
      search: supabaseChunkSearch(c.service),
      config: c.config.retrieval,
      log: logger,
    },
    {
      userId: c.userId,
      scope: 'workspace',
      conversationId,
      historyMessages: 0,
      message,
      previousUserMessage: null,
    },
  );
  out({
    elapsedMs: Date.now() - started,
    summary: outcome.summary,
    belowBreakpoint: outcome.belowBreakpoint,
  });
}

async function remember(args: readonly string[]): Promise<void> {
  const message = args.join(' ').trim();
  if (message === '') fail('usage: npm run memory -- remember "<statement>"');
  const c = await caller();
  const facts = supabaseFactStore(c.service);
  const existing = await facts.currentFacts(c.userId, c.config.retrieval.maxFacts * 4);
  if (!existing.ok) fail(`${existing.error.code}: ${existing.error.message}`);
  const result = await captureFact(
    { claude: c.deps.claude, facts, log: logger },
    {
      message,
      userId: c.userId,
      scope: 'workspace',
      conversationId: null,
      existing: existing.value,
    },
  );
  out(result.kind === 'failed' ? { kind: 'failed', error: result.error.toJSON() } : result);
  process.exit(result.kind === 'saved' ? 0 : 2);
}

async function listFacts(args: readonly string[]): Promise<void> {
  const c = await caller();
  let query = c.service
    .from('memory_facts')
    .select('id, scope, key, value, confidence, source_message_id, superseded_by, created_at')
    .or(`scope.eq.workspace,user_id.eq.${c.userId}`)
    .order('created_at', { ascending: false });
  if (!args.includes('--all')) query = query.is('superseded_by', null);
  const { data, error } = await query;
  if (error !== null) fail(error.message);
  out(data);
}

async function main(): Promise<void> {
  loadEnv();
  const [mode, ...rest] = process.argv.slice(2);
  switch (mode) {
    case 'recall':
      await recall(rest);
      return;
    case 'remember':
      await remember(rest);
      return;
    case 'facts':
      await listFacts(rest);
      return;
    case 'flush':
      await flush(rest[0]);
      return;
    case 'sweep': {
      const at = rest.indexOf('--limit');
      await sweep(at === -1 ? undefined : rest[at + 1]);
      return;
    }
    case 'preview':
      await preview(rest[0]);
      return;
    case undefined:
    default:
      fail(
        'usage: npm run memory -- flush <conversationId> | sweep [--limit N] | preview <transcript.json> | recall "<message>" [--conversation <id>] | remember "<statement>" | facts [--all]',
      );
  }
}

main().catch((caught: unknown) => {
  fail(caught instanceof Error ? caught.message : String(caught));
});
