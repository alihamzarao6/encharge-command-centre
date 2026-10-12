/**
 * Attached files against a real Supabase stack (Milestone 5 part 1, D83–D92).
 *
 * The production path — the same files endpoint, stores and chat turn the Edge Functions run
 * — with ONE substitution: fetch to Anthropic is scripted, so CI spends nothing and needs no
 * key. The unit suites prove the logic against an in-memory store; this file proves the half
 * they cannot: that migration 20261012010000 does what the code believes it does.
 *
 *   - its objects exist, and the nightly purge is actually scheduled;
 *   - a typed file and a scanned page go in through the endpoint and come out as rows with
 *     provenance on every page, and a page read by the model is charged to the same ledger
 *     the spend cap reads;
 *   - a question about the file reaches the model with the text wrapped as data, both rows of
 *     that turn are flagged, and the shared-memory summariser is given placeholders for them;
 *   - an upload is all or nothing: an incomplete one cannot be finished and is invisible
 *     meanwhile; a retried one is the same upload; the same file twice is one attachment;
 *   - the limits and the removals the database owns: ten files, the tombstone, expiry before
 *     and after the purge, an abandoned upload, a deleted conversation;
 *   - visibility follows the conversation, in both directions, through a REAL session.
 *
 * Every count is scoped to this run's conversation or file ids, never to a whole table. All
 * fixtures are invented (example.com users, a made-up payslip line) and removed afterwards.
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
import { FILES_DEFAULTS } from '../../src/lib/files/config.js';
import { createTurnDocuments } from '../../src/lib/files/context.js';
import { FILE_LIMITS } from '../../src/lib/files/limits.js';
import {
  handleFilesRequest,
  type FilesErrorBody,
  type FilesPageDeps,
  type FilesReply,
} from '../../src/lib/files/page.js';
import { DOCUMENT_RULES } from '../../src/lib/files/rules.js';
import { createFilesServiceClient, supabaseFileStore } from '../../src/lib/files/store.js';
import { VISION_OPERATION } from '../../src/lib/files/vision.js';
import { createHttpClient, type FetchLike } from '../../src/lib/http.js';
import { handleChatTurn, type ChatDeps } from '../../src/lib/llm/chat.js';
import { createClaudeClient } from '../../src/lib/llm/client.js';
import type { LlmConfig } from '../../src/lib/llm/config.js';
import { DEFAULT_PRICING, pricingFor, type ModelPricing } from '../../src/lib/llm/pricing.js';
import { supabaseConversationStore, supabaseUsageStore } from '../../src/lib/llm/store.js';
import { createLogger } from '../../src/lib/logger.js';
import { supabaseChunkStore } from '../../src/lib/memory/chunks.js';
import { DOCUMENT_TURN_PLACEHOLDER, toTranscript } from '../../src/lib/memory/trigger.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);
const FAKE_KEY = 'sk-ant-integration-not-a-real-key-000000';

const cfg: SupabaseAuthConfig = {
  url: env?.url ?? 'http://stack-not-running.invalid',
  anonKey: env?.anonKey ?? 'unset',
  serviceRoleKey: env?.serviceRoleKey ?? 'unset',
};

const ANTHROPIC_FIXTURE = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', 'fixtures', 'anthropic', 'messages-ok.json'),
    'utf8',
  ),
) as { content: { type: string; text: string }[] };

/** Invented, and distinctive enough that finding it anywhere it should not be is a failure. */
const PAYSLIP_LINE = `Net pay 2,887.38 CANARY-TEXT-${RUN}`;
const SCAN_LINE = `Closing balance 4,154.50 CANARY-SCAN-${RUN}`;
const CANARY_NAME = `Sample-Person-CANARY-NAME-${RUN}`;
const CHAT_REPLY = `The payslip shows a net pay of 2,887.38. CANARY-REPLY-${RUN}`;
/** A JPEG as far as the endpoint is concerned: the right first bytes, valid base64. */
const JPEG_BASE64 = `/9j/${'A'.repeat(400)}`;

const hash = (seed: number): string => seed.toString(16).padStart(2, '0').repeat(32);

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

interface ModelRequest {
  readonly vision: boolean;
  readonly system: string;
  readonly messages: string;
  readonly firstUserText: string;
  /** Whether the request offered the model any tool at all. */
  readonly tools: boolean;
}

type ReplyOf<A extends FilesReply['action']> = Extract<FilesReply, { action: A }>;

describe.skipIf(env === null)('attached files (requires a running Supabase stack)', () => {
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
  const files = supabaseFileStore(createFilesServiceClient(cfg));

  const logLines: string[] = [];
  const log = createLogger({
    level: 'debug',
    sink: (line) => {
      logLines.push(line);
    },
  });

  const modelRequests: ModelRequest[] = [];
  const fixtureFetch: FetchLike = (_url, init) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
      system?: { text?: string }[];
      messages?: { role: string; content: unknown }[];
    };
    const messages = JSON.stringify(body.messages ?? []);
    const vision = messages.includes('"type":"image"');
    const first = body.messages?.[0]?.content;
    modelRequests.push({
      tools: 'tools' in body,
      vision,
      system: (body.system ?? []).map((block) => block.text ?? '').join('\n'),
      messages,
      firstUserText: Array.isArray(first)
        ? (first as { text?: string }[]).map((block) => block.text ?? '').join('\n')
        : typeof first === 'string'
          ? first
          : '',
    });
    const text = vision ? `KIND: document\nLEGIBILITY: full\n---\n${SCAN_LINE}` : CHAT_REPLY;
    return Promise.resolve(
      new Response(JSON.stringify({ ...ANTHROPIC_FIXTURE, content: [{ type: 'text', text }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  function claude(dailyUsd: number) {
    const client = createClaudeClient({
      config: llmConfig(dailyUsd),
      http: createHttpClient({ fetch: fixtureFetch, retries: 0, logger: log }),
      usage: supabaseUsageStore(service),
      log,
    });
    // `complete` only: the scripted reply is one JSON body, not an event stream.
    return { complete: client.complete.bind(client) };
  }

  function sonnetPricing(): ModelPricing {
    const pricing = pricingFor(DEFAULT_PRICING, 'claude-sonnet-5');
    if (!pricing.ok) throw new Error('claude-sonnet-5 has no price in the default table');
    return pricing.value;
  }

  function filesDeps(dailyUsd = 5): FilesPageDeps {
    return {
      verify: supabaseVerifyDeps(service),
      conversations: supabaseConversationStore(service),
      files,
      vision: { claude: claude(dailyUsd), route: 'default', maxTokens: 1_024, log },
      usage: supabaseUsageStore(service),
      caps: llmConfig(dailyUsd).caps,
      visionPricing: sonnetPricing(),
      config: FILES_DEFAULTS,
      // Part 1 attaches files, not links: a page fetch here is a bug, and fails as one.
      pages: {
        read: () => Promise.reject(new Error('files.test.ts does not fetch pages')),
      },
      log,
    };
  }

  function chatDeps(): ChatDeps {
    return {
      verify: supabaseVerifyDeps(service),
      claude: claude(5),
      conversations: supabaseConversationStore(service),
      documents: createTurnDocuments(files, FILES_DEFAULTS.contextMaxChars),
      log,
    };
  }

  /** A real signed-in session: the anon key plus one person's JWT, exactly what a browser holds. */
  function session(user: TestUser) {
    return createClient(cfg.url, cfg.anonKey, {
      global: { headers: { Authorization: `Bearer ${user.token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async function ok<A extends FilesReply['action']>(
    user: TestUser,
    body: { action: A } & Record<string, unknown>,
    deps: FilesPageDeps = filesDeps(),
  ): Promise<ReplyOf<A>> {
    const result = await handleFilesRequest(deps, { token: user.token, body });
    if (result.status !== 200) {
      throw new Error(
        `${body.action} → ${String(result.status)} ${result.body.error.code}: ${result.body.error.message}`,
      );
    }
    return result.body as ReplyOf<A>;
  }

  async function refusedWith(
    user: TestUser,
    body: Record<string, unknown>,
    deps: FilesPageDeps = filesDeps(),
  ): Promise<{ status: number; error: FilesErrorBody['error'] }> {
    const result = await handleFilesRequest(deps, { token: user.token, body });
    if (result.status === 200) throw new Error(`${String(body['action'])} was not refused`);
    return { status: result.status, error: result.body.error };
  }

  let seed = 0;
  /** A claimed upload of `pages` typed pages, not yet finished. */
  async function beginText(
    user: TestUser,
    conversationId: string | null,
    pages: number,
    name = `payslip-${RUN}.pdf`,
  ): Promise<ReplyOf<'begin'>> {
    seed += 1;
    return ok(user, {
      action: 'begin',
      requestId: crypto.randomUUID(),
      conversationId,
      name,
      kind: 'pdf',
      byteSize: 4_651,
      contentHash: hash(seed),
      totalPages: pages,
      visionPages: 0,
      extractMs: 12,
    });
  }

  /** A ready, typed file of two pages. */
  async function attach(
    user: TestUser,
    conversationId: string | null,
    name?: string,
  ): Promise<{ fileId: string; conversationId: string }> {
    const begun = await beginText(user, conversationId, 2, name);
    await ok(user, {
      action: 'append',
      fileId: begun.fileId,
      pages: [
        { pageNo: 1, label: 'Page 1', text: `Payslip - Harbour Lane Plumbing\n${PAYSLIP_LINE}` },
        { pageNo: 2, label: 'Page 2', text: 'Year to date\nGross 41,990.00' },
      ],
    });
    await ok(user, { action: 'finish', fileId: begun.fileId });
    return { fileId: begun.fileId, conversationId: begun.conversationId };
  }

  const created: TestUser[] = [];
  let author: TestUser;
  let colleague: TestUser;

  async function createUser(label: string): Promise<TestUser> {
    const email = `files-${label}-${RUN}@example.com`;
    const password = `Fixture-${crypto.randomUUID()}`;
    const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (result.error !== null) throw new Error(`createUser ${label}: ${result.error.message}`);
    const id = result.data.user.id;
    created.push({ id, email, token: '' });
    await db.query(
      `insert into public.app_users (user_id, email, role, is_active) values ($1, $2, 'staff', true)`,
      [id, email],
    );
    const signIn = await anon.auth.signInWithPassword({ email, password });
    if (signIn.error !== null) throw new Error(`signIn ${label}: ${signIn.error.message}`);
    const user = { id, email, token: signIn.data.session.access_token };
    created[created.length - 1] = user;
    return user;
  }

  beforeAll(async () => {
    await db.connect();
    author = await createUser('author');
    colleague = await createUser('colleague');
  }, 60_000);

  afterAll(async () => {
    const ids = created.map((user) => user.id);
    // Children first, for every user, before any user goes: a file row names both the
    // conversation's author and whoever uploaded it. Deleting a conversation cascades to its
    // files and their pages.
    await db.query(`delete from public.api_usage where user_id = any($1::uuid[])`, [ids]);
    await db.query(
      `delete from public.memory_chunks where conversation_id in
         (select id from public.conversations where user_id = any($1::uuid[]))`,
      [ids],
    );
    await db.query(
      `delete from public.messages where conversation_id in
         (select id from public.conversations where user_id = any($1::uuid[]))`,
      [ids],
    );
    await db.query(`delete from public.conversations where user_id = any($1::uuid[])`, [ids]);
    for (const user of created) {
      await db.query(`delete from public.app_users where user_id = $1`, [user.id]);
      await admin.auth.admin.deleteUser(user.id);
    }
    await db.end();
  }, 60_000);

  it('the migration left its objects in place, and the nightly purge is scheduled', async () => {
    const tables = await db.query<{ relname: string; rls: boolean; force: boolean }>(
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('conversation_files', 'conversation_file_pages')
        order by c.relname`,
    );
    expect(tables.rows).toEqual([
      { relname: 'conversation_file_pages', rls: true, force: true },
      { relname: 'conversation_files', rls: true, force: true },
    ]);

    const flag = await db.query<{ is_nullable: string; column_default: string }>(
      `select is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'messages' and column_name = 'document_context'`,
    );
    expect(flag.rows).toEqual([{ is_nullable: 'NO', column_default: 'false' }]);

    // Retention is a promise only if something keeps it without anyone opening the app.
    const job = await db.query<{ schedule: string; command: string; active: boolean }>(
      `select schedule, command, active from cron.job where jobname = 'purge-conversation-files'`,
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]?.schedule).toBe('17 3 * * *');
    expect(job.rows[0]?.command).toContain('public.purge_conversation_files()');
    expect(job.rows[0]?.active).toBe(true);

    // The text has no policy at all: there is nothing to widen by mistake.
    const policies = await db.query<{ tablename: string; policyname: string; cmd: string }>(
      `select tablename, policyname, cmd from pg_policies
        where schemaname = 'public' and tablename in ('conversation_files', 'conversation_file_pages')`,
    );
    expect(policies.rows).toEqual([
      { tablename: 'conversation_files', policyname: 'conversation_files_read', cmd: 'SELECT' },
    ]);
  });

  it('a typed file goes in through the endpoint and is stored as text with provenance, never as a file', async () => {
    const begun = await beginText(author, null, 2, `../../etc/<b>${CANARY_NAME}<i>.pdf`);
    expect(begun).toMatchObject({ status: 'reading', duplicate: false, pagesStored: [] });
    const stored = await ok(author, {
      action: 'append',
      fileId: begun.fileId,
      pages: [
        { pageNo: 1, label: 'Page 1', text: `Payslip - Harbour Lane Plumbing\n${PAYSLIP_LINE}` },
        { pageNo: 2, label: 'Page 2', text: 'Year to date\nGross 41,990.00' },
      ],
    });
    expect(stored.stored).toBe(2);
    const finished = await ok(author, { action: 'finish', fileId: begun.fileId });
    expect(finished.file).toMatchObject({
      id: begun.fileId,
      conversationId: begun.conversationId,
      uploadedBy: author.id,
      kind: 'pdf',
      byteSize: 4_651,
      pageCount: 2,
      visionPages: 0,
      status: 'ready',
    });
    // A label, not a path and not markup.
    expect(finished.file.name).toBe(`(b)${CANARY_NAME}(i).pdf`);

    const row = await db.query(
      `select user_id, scope, uploaded_by, status, page_count, char_count, confidence::text as confidence,
              content_hash ~ '^[0-9a-f]{64}$' as hashed, ready_at is not null as ready,
              round(extract(epoch from (expires_at - created_at)) / 86400) as days
         from public.conversation_files where id = $1`,
      [begun.fileId],
    );
    expect(row.rows).toEqual([
      {
        user_id: author.id,
        scope: 'workspace',
        uploaded_by: author.id,
        status: 'ready',
        page_count: 2,
        char_count: finished.file.charCount,
        confidence: '1.00',
        hashed: true,
        ready: true,
        days: '30',
      },
    ]);

    const pages = await db.query(
      `select page_no, label, extraction_method, confidence::text as confidence, legibility,
              letter_count > 0 as has_letters, extracted_at is not null as stamped,
              position($2 in content) > 0 as has_line
         from public.conversation_file_pages where file_id = $1 order by page_no`,
      [begun.fileId, PAYSLIP_LINE],
    );
    expect(pages.rows).toEqual([
      {
        page_no: 1,
        label: 'Page 1',
        extraction_method: 'pdf_text_layer',
        confidence: '1.00',
        legibility: 'full',
        has_letters: true,
        stamped: true,
        has_line: true,
      },
      {
        page_no: 2,
        label: 'Page 2',
        extraction_method: 'pdf_text_layer',
        confidence: '1.00',
        legibility: 'full',
        has_letters: true,
        stamped: true,
        has_line: false,
      },
    ]);

    // The audit row says a file was attached, with ids and counts. Not its name, not a word of it.
    const audit = await db.query<{ actor: string; after: string }>(
      `select actor, after::text as after from public.audit_log
        where action = 'FILE_ATTACHED' and entity_id = $1`,
      [begun.fileId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor).toBe(author.id);
    expect(audit.rows[0]?.after).toContain('"page_count": 2');
    expect(audit.rows[0]?.after).not.toContain(CANARY_NAME);
    expect(audit.rows[0]?.after).not.toContain(`CANARY-TEXT-${RUN}`);
    // No model was involved in reading a typed file.
    expect(modelRequests.filter((request) => request.vision)).toHaveLength(0);
  });

  it('a scanned page is read by the model once, charged to the ledger the cap reads, and stored as a transcription', async () => {
    const before = modelRequests.length;
    seed += 1;
    const begun = await ok(author, {
      action: 'begin',
      requestId: crypto.randomUUID(),
      conversationId: null,
      name: `statement-scan-${RUN}.pdf`,
      kind: 'pdf',
      byteSize: 102_519,
      contentHash: hash(seed),
      totalPages: 1,
      visionPages: 1,
    });
    const page = { action: 'read_page', fileId: begun.fileId, pageNo: 1, label: 'Page 1' } as const;
    const read = await ok(author, { ...page, imageBase64: JPEG_BASE64 });
    expect(read).toMatchObject({ pageKind: 'document', legibility: 'full', replayed: false });

    // The same page again (a retry after a dropped reply): answered from the record, not paid for twice.
    const again = await ok(author, { ...page, imageBase64: JPEG_BASE64 });
    expect(again).toMatchObject({ replayed: true, pageKind: null });
    expect(modelRequests.slice(before).filter((request) => request.vision)).toHaveLength(1);

    const usage = await db.query(
      `select operation, model, user_id, cost_usd > 0 as charged
         from public.api_usage where conversation_id = $1`,
      [begun.conversationId],
    );
    expect(usage.rows).toEqual([
      { operation: VISION_OPERATION, model: 'claude-sonnet-5', user_id: author.id, charged: true },
    ]);

    const finished = await ok(author, { action: 'finish', fileId: begun.fileId });
    expect(finished.file).toMatchObject({ pageCount: 1, visionPages: 1, status: 'ready' });
    const stored = await db.query(
      `select extraction_method, confidence::text as confidence, legibility, content
         from public.conversation_file_pages where file_id = $1`,
      [begun.fileId],
    );
    expect(stored.rows).toEqual([
      {
        extraction_method: 'claude_vision',
        // Read by a model, not parsed: it says so, and is not claimed to be exact.
        confidence: '0.90',
        legibility: 'full',
        content: SCAN_LINE,
      },
    ]);
    const file = await db.query(
      `select confidence::text as confidence from public.conversation_files where id = $1`,
      [begun.fileId],
    );
    expect(file.rows).toEqual([{ confidence: '0.90' }]);
    // The image itself went to the model and nowhere else: nothing here holds it.
    expect(JSON.stringify(stored.rows)).not.toContain('/9j/');
  });

  it('with the budget spent, a page is not read, nothing is stored, and no model call is made', async () => {
    const before = modelRequests.length;
    seed += 1;
    const begun = await ok(author, {
      action: 'begin',
      requestId: crypto.randomUUID(),
      conversationId: null,
      name: `capped-${RUN}.pdf`,
      kind: 'pdf',
      byteSize: 50_000,
      contentHash: hash(seed),
      totalPages: 1,
      visionPages: 1,
    });
    const refused = await refusedWith(
      author,
      {
        action: 'read_page',
        fileId: begun.fileId,
        pageNo: 1,
        label: 'Page 1',
        imageBase64: JPEG_BASE64,
      },
      filesDeps(0),
    );
    expect(refused.status).toBe(402);
    expect(refused.error.code).toBe('SPEND_CAP');
    expect(modelRequests.length).toBe(before);
    const pages = await db.query(
      `select page_no from public.conversation_file_pages where file_id = $1`,
      [begun.fileId],
    );
    expect(pages.rows).toEqual([]);
    // …and a file with a missing page cannot be finished into something that looks whole.
    const finish = await refusedWith(author, { action: 'finish', fileId: begun.fileId });
    expect(finish).toMatchObject({ status: 409, error: { code: 'INCOMPLETE', retryable: true } });
  });

  it('a question about the file: the text reaches the model as data, the turn is flagged, and shared memory is given placeholders', async () => {
    const { conversationId } = await attach(author, null);
    const before = modelRequests.length;
    const result = await handleChatTurn(chatDeps(), {
      token: author.token,
      message: 'What is the net pay on the payslip?',
      conversationId,
    });
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.reply).toBe(CHAT_REPLY);

    const sent = modelRequests.slice(before);
    expect(sent).toHaveLength(1);
    // The document is in the USER turn, wrapped and labelled; our rules are in the system
    // prompt. A document can never be where an instruction is read from.
    expect(sent[0]?.firstUserText).toContain('<attached_documents count="1">');
    expect(sent[0]?.firstUserText).toContain('<untrusted_document');
    expect(sent[0]?.firstUserText).toContain(PAYSLIP_LINE);
    expect(sent[0]?.system).toContain(DOCUMENT_RULES);
    expect(sent[0]?.system).not.toContain(PAYSLIP_LINE);
    // Nothing a document says can be acted on: the model is given no tool to act with.
    expect(sent[0]?.tools).toBe(false);

    const rows = await db.query<{ role: string; document_context: boolean }>(
      `select role, document_context from public.messages
        where conversation_id = $1 order by created_at, role desc`,
      [conversationId],
    );
    expect(rows.rows).toEqual([
      { role: 'user', document_context: true },
      { role: 'assistant', document_context: true },
    ]);

    // What the summariser is handed for that turn (D89): that a file was discussed. Not the
    // question, and not the figure read off the payslip.
    const loaded = await supabaseChunkStore(service).messagesInRange(conversationId, {
      lo: 1,
      hi: 3,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const transcript = toTranscript(loaded.value);
    expect(transcript.map((message) => message.content)).toEqual([
      DOCUMENT_TURN_PLACEHOLDER.user,
      DOCUMENT_TURN_PLACEHOLDER.assistant,
    ]);
    expect(JSON.stringify(transcript)).not.toContain('2,887.38');
  });

  it('an ordinary turn, in a conversation with no file, is not flagged and sends no document rules', async () => {
    const before = modelRequests.length;
    const result = await handleChatTurn(chatDeps(), {
      token: author.token,
      message: `no file here ${RUN}`,
    });
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const sent = modelRequests.slice(before);
    expect(sent[0]?.system).not.toContain(DOCUMENT_RULES);
    expect(sent[0]?.messages).not.toContain('attached_documents');
    const rows = await db.query<{ document_context: boolean }>(
      `select document_context from public.messages where conversation_id = $1`,
      [result.body.conversationId],
    );
    expect(rows.rows.map((row) => row.document_context)).toEqual([false, false]);
  });

  it('an upload is all or nothing: not finishable while a page is missing, and invisible until it is whole', async () => {
    const begun = await beginText(author, null, 3);
    await ok(author, {
      action: 'append',
      fileId: begun.fileId,
      pages: [
        { pageNo: 1, label: 'Page 1', text: 'one' },
        { pageNo: 2, label: 'Page 2', text: 'two' },
      ],
    });
    const early = await refusedWith(author, { action: 'finish', fileId: begun.fileId });
    expect(early).toMatchObject({ status: 409, error: { code: 'INCOMPLETE' } });

    // Its own uploader's session cannot see it yet, and neither can a turn.
    const seen = await session(author)
      .from('conversation_files')
      .select('id')
      .eq('id', begun.fileId);
    expect(seen.error).toBeNull();
    expect(seen.data).toEqual([]);
    const turn = await files.forTurn(begun.conversationId);
    expect(turn.ok && turn.value).toEqual({
      files: [],
      everHadFile: false,
      everHadPage: false,
    });

    // A page outside what was declared is refused; the same page sent twice is stored once.
    const beyond = await refusedWith(author, {
      action: 'append',
      fileId: begun.fileId,
      pages: [{ pageNo: 4, label: 'Page 4', text: 'four' }],
    });
    expect(beyond.status).toBe(400);
    const repeat = await ok(author, {
      action: 'append',
      fileId: begun.fileId,
      pages: [
        { pageNo: 2, label: 'Page 2', text: 'two' },
        { pageNo: 3, label: 'Page 3', text: 'three' },
      ],
    });
    expect(repeat.stored).toBe(3);
    const finished = await ok(author, { action: 'finish', fileId: begun.fileId });
    expect(finished.file).toMatchObject({ pageCount: 3, status: 'ready' });
    // Finishing again is the same answer, not a second file or a second audit row.
    const twice = await ok(author, { action: 'finish', fileId: begun.fileId });
    expect(twice.file.id).toBe(begun.fileId);
    const audit = await db.query(
      `select 1 from public.audit_log where action = 'FILE_ATTACHED' and entity_id = $1`,
      [begun.fileId],
    );
    expect(audit.rowCount).toBe(1);
    // …and once whole, nothing more can be added to it.
    const late = await refusedWith(author, {
      action: 'append',
      fileId: begun.fileId,
      pages: [{ pageNo: 1, label: 'Page 1', text: 'rewritten' }],
    });
    expect(late.status).toBe(409);
  });

  it('a file with nothing readable in it is not attached, and leaves nothing behind', async () => {
    const begun = await beginText(author, null, 1);
    await ok(author, {
      action: 'append',
      fileId: begun.fileId,
      // Rules and punctuation, as a page of ruled lines extracts: text, but nothing to read.
      pages: [{ pageNo: 1, label: 'Page 1', text: '--- *** ---' }],
    });
    const refused = await refusedWith(author, { action: 'finish', fileId: begun.fileId });
    expect(refused).toMatchObject({ status: 422, error: { refusal: 'no_text' } });
    // "Extraction fails after the file is stored": no orphan — no row, and so no pages.
    const left = await db.query(`select 1 from public.conversation_files where id = $1`, [
      begun.fileId,
    ]);
    expect(left.rowCount).toBe(0);
    const pages = await db.query(
      `select 1 from public.conversation_file_pages where file_id = $1`,
      [begun.fileId],
    );
    expect(pages.rowCount).toBe(0);
  });

  it('a retried claim is the same upload, and the same file sent twice is one attachment', async () => {
    seed += 1;
    const request = {
      action: 'begin',
      requestId: crypto.randomUUID(),
      conversationId: null as string | null,
      name: `rates-${RUN}.csv`,
      kind: 'csv',
      byteSize: 420,
      contentHash: hash(seed),
      totalPages: 2,
      visionPages: 0,
    } as const;
    const first = await ok(author, request);
    await ok(author, {
      action: 'append',
      fileId: first.fileId,
      pages: [{ pageNo: 1, label: 'Rows 1 to 40', text: 'Date\tAmount\n2026-09-01\t10' }],
    });
    // The reply to `begin` was lost and the browser asks again with the same request id.
    const replay = await ok(author, { ...request, conversationId: first.conversationId });
    expect(replay).toMatchObject({ fileId: first.fileId, duplicate: false, pagesStored: [1] });
    await ok(author, {
      action: 'append',
      fileId: first.fileId,
      pages: [{ pageNo: 2, label: 'Rows 41 to 80', text: '2026-09-02\t20' }],
    });
    await ok(author, { action: 'finish', fileId: first.fileId });

    // The same bytes, chosen again later (a new gesture, so a new request id).
    const second = await ok(author, {
      ...request,
      requestId: crypto.randomUUID(),
      conversationId: first.conversationId,
    });
    expect(second).toMatchObject({ fileId: first.fileId, duplicate: true, status: 'ready' });
    expect(second.file?.id).toBe(first.fileId);
    const rows = await db.query(
      `select 1 from public.conversation_files where conversation_id = $1`,
      [first.conversationId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('a conversation holds ten files; the eleventh is refused in words, and removing one makes room', async () => {
    const first = await beginText(author, null, 1);
    const ids = [first.fileId];
    for (let i = 1; i < FILE_LIMITS.maxFilesPerConversation; i += 1) {
      ids.push((await beginText(author, first.conversationId, 1)).fileId);
    }
    seed += 1;
    const eleventh = {
      action: 'begin',
      requestId: crypto.randomUUID(),
      conversationId: first.conversationId,
      name: `eleventh-${RUN}.pdf`,
      kind: 'pdf',
      byteSize: 100,
      contentHash: hash(seed),
      totalPages: 1,
      visionPages: 0,
    } as const;
    const refused = await refusedWith(author, eleventh);
    expect(refused).toMatchObject({ status: 422, error: { refusal: 'too_many_files' } });
    expect(refused.error.message).toBe(
      `This conversation already has ${String(FILE_LIMITS.maxFilesPerConversation)} files attached. Remove one first.`,
    );
    const held = await db.query(
      `select 1 from public.conversation_files where conversation_id = $1`,
      [first.conversationId],
    );
    expect(held.rowCount).toBe(FILE_LIMITS.maxFilesPerConversation);

    const removed = await ok(author, { action: 'remove', fileId: ids[0] ?? '' });
    expect(removed.removed).toBe(true);
    const now = await ok(author, { ...eleventh, requestId: crypto.randomUUID() });
    expect(now.status).toBe('reading');
  });

  it('removing a file destroys its text, its name and its hash and leaves a tombstone; only the uploader may', async () => {
    const { fileId, conversationId } = await attach(author, null, `${CANARY_NAME}-remove.pdf`);

    // A colleague can see it (the conversation is shared) but it is not theirs to remove.
    const theirs = await session(colleague)
      .from('conversation_files')
      .select('id, name, status')
      .eq('id', fileId);
    expect(theirs.data).toEqual([
      { id: fileId, name: `${CANARY_NAME}-remove.pdf`, status: 'ready' },
    ]);
    const denied = await refusedWith(colleague, { action: 'remove', fileId });
    expect(denied.status).toBe(403);
    const still = await db.query(`select status from public.conversation_files where id = $1`, [
      fileId,
    ]);
    expect(still.rows).toEqual([{ status: 'ready' }]);

    const removed = await ok(author, { action: 'remove', fileId });
    expect(removed.removed).toBe(true);
    const row = await db.query(
      `select status, name, content_hash, removed_by, removed_reason, removed_at is not null as stamped
         from public.conversation_files where id = $1`,
      [fileId],
    );
    expect(row.rows).toEqual([
      {
        status: 'removed',
        name: null,
        content_hash: null,
        removed_by: author.id,
        removed_reason: 'user',
        stamped: true,
      },
    ]);
    const pages = await db.query(
      `select 1 from public.conversation_file_pages where file_id = $1`,
      [fileId],
    );
    expect(pages.rowCount).toBe(0);
    const audit = await db.query<{ before: string }>(
      `select before::text as before from public.audit_log
        where action = 'FILE_REMOVED' and entity_id = $1`,
      [fileId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.before).not.toContain(CANARY_NAME);

    // The thread can still say a file was here; it cannot say which.
    const tombstone = await session(colleague)
      .from('conversation_files')
      .select('id, name, status')
      .eq('id', fileId);
    expect(tombstone.data).toEqual([{ id: fileId, name: null, status: 'removed' }]);
    // A turn no longer gets it, but knows there was one (so it says so rather than guessing).
    const turn = await files.forTurn(conversationId);
    expect(turn.ok && turn.value).toEqual({
      files: [],
      everHadFile: true,
      everHadPage: false,
    });
    // Removing it again is not an error and not a second audit row.
    const again = await ok(author, { action: 'remove', fileId });
    expect(again.removed).toBe(false);

    // The tombstone is the database's guarantee, not the function's good behaviour.
    const { fileId: other } = await attach(author, conversationId);
    await expect(
      db.query(
        `update public.conversation_files set status = 'removed', removed_at = now() where id = $1`,
        [other],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('thirty days: a file past its date is not given to the model even before the purge, and the purge destroys it', async () => {
    const { fileId, conversationId } = await attach(author, null);
    const reading = await beginText(author, conversationId, 2);
    await db.query(
      `update public.conversation_files set expires_at = now() - interval '1 minute' where id = $1`,
      [fileId],
    );
    await db.query(
      `update public.conversation_files set created_at = now() - interval '16 minutes' where id = $1`,
      [reading.fileId],
    );

    // Before the schedule has run: already not usable.
    const turn = await files.forTurn(conversationId);
    expect(turn.ok && turn.value).toEqual({
      files: [],
      everHadFile: true,
      everHadPage: false,
    });

    const purged = await files.purge();
    expect(purged.ok).toBe(true);
    // Other suites share this database: at least this run's rows, never an exact total.
    expect(purged.ok && purged.value.expired).toBeGreaterThanOrEqual(1);
    expect(purged.ok && purged.value.abandoned).toBeGreaterThanOrEqual(1);

    const row = await db.query(
      `select status, name, content_hash, removed_by, removed_reason
         from public.conversation_files where id = $1`,
      [fileId],
    );
    expect(row.rows).toEqual([
      {
        status: 'removed',
        name: null,
        content_hash: null,
        removed_by: null,
        removed_reason: 'expired',
      },
    ]);
    const pages = await db.query(
      `select 1 from public.conversation_file_pages where file_id = $1`,
      [fileId],
    );
    expect(pages.rowCount).toBe(0);
    const audit = await db.query<{ actor: string }>(
      `select actor from public.audit_log where action = 'FILE_EXPIRED' and entity_id = $1`,
      [fileId],
    );
    expect(audit.rows).toEqual([{ actor: 'system' }]);
    // The upload nobody finished is gone outright: it was never a file.
    const abandoned = await db.query(`select 1 from public.conversation_files where id = $1`, [
      reading.fileId,
    ]);
    expect(abandoned.rowCount).toBe(0);
  });

  it('a file follows its conversation: private when it is private, shared again when it is shared', async () => {
    const { fileId, conversationId } = await attach(author, null);
    const read = () => session(colleague).from('conversation_files').select('id').eq('id', fileId);
    expect((await read()).data).toEqual([{ id: fileId }]);

    await db.query(`update public.conversations set scope = 'user' where id = $1`, [
      conversationId,
    ]);
    const scoped = await db.query(`select scope from public.conversation_files where id = $1`, [
      fileId,
    ]);
    expect(scoped.rows).toEqual([{ scope: 'user' }]);
    // At the database, through a real session — not hidden by the interface.
    const hidden = await read();
    expect(hidden.error).toBeNull();
    expect(hidden.data).toEqual([]);
    expect(
      (await session(author).from('conversation_files').select('id').eq('id', fileId)).data,
    ).toEqual([{ id: fileId }]);
    // And the endpoint agrees with the database: no attaching to, or removing from, a
    // conversation you cannot see — answered as "not found", not as "forbidden".
    seed += 1;
    const attempt = await refusedWith(colleague, {
      action: 'begin',
      requestId: crypto.randomUUID(),
      conversationId,
      name: `intruder-${RUN}.pdf`,
      kind: 'pdf',
      byteSize: 100,
      contentHash: hash(seed),
      totalPages: 1,
      visionPages: 0,
    });
    expect(attempt.status).toBe(404);
    expect((await refusedWith(colleague, { action: 'remove', fileId })).status).toBe(404);

    await db.query(`update public.conversations set scope = 'workspace' where id = $1`, [
      conversationId,
    ]);
    expect((await read()).data).toEqual([{ id: fileId }]);
  });

  it('nobody reads the text through the Data API — not its uploader, not a colleague', async () => {
    const { fileId } = await attach(author, null);
    for (const who of [author, colleague]) {
      const pages = await session(who)
        .from('conversation_file_pages')
        .select('page_no, content')
        .eq('file_id', fileId);
      expect(pages.error).toBeNull();
      expect(pages.data).toEqual([]);
    }
    // It is there: the server's read finds both pages.
    const turn = await files.forTurn(
      (
        await db.query<{ conversation_id: string }>(
          `select conversation_id from public.conversation_files where id = $1`,
          [fileId],
        )
      ).rows[0]?.conversation_id ?? '',
    );
    expect(turn.ok && turn.value.files[0]?.pages).toHaveLength(2);
  });

  it('deleting a conversation destroys its files outright, and nothing can be attached to it afterwards', async () => {
    const { fileId, conversationId } = await attach(author, null);
    await db.query(`select * from public.delete_conversation($1, $2)`, [conversationId, author.id]);
    const rows = await db.query(
      `select 1 from public.conversation_files where conversation_id = $1`,
      [conversationId],
    );
    expect(rows.rowCount).toBe(0);
    const pages = await db.query(
      `select 1 from public.conversation_file_pages where file_id = $1`,
      [fileId],
    );
    expect(pages.rowCount).toBe(0);
    seed += 1;
    const after = await refusedWith(author, {
      action: 'begin',
      requestId: crypto.randomUUID(),
      conversationId,
      name: `late-${RUN}.pdf`,
      kind: 'pdf',
      byteSize: 100,
      contentHash: hash(seed),
      totalPages: 1,
      visionPages: 0,
    });
    expect(after.status).toBe(404);
  });

  it('nothing written to the log during the run holds a word of a file, its name, a reply or a key', () => {
    const all = logLines.join('\n');
    // The uploads were logged — who, what kind, how big, how long, whether it worked.
    expect(all).toContain('file upload finished');
    expect(all).toContain('file page read');
    expect(all).toContain('file removed');
    expect(all).toContain(author.id);
    expect(all).not.toContain(`CANARY-TEXT-${RUN}`);
    expect(all).not.toContain(`CANARY-SCAN-${RUN}`);
    expect(all).not.toContain(`CANARY-REPLY-${RUN}`);
    expect(all).not.toContain(CANARY_NAME);
    expect(all).not.toContain(`payslip-${RUN}`);
    expect(all).not.toContain('2,887.38');
    expect(all).not.toContain('/9j/');
    expect(all).not.toContain(FAKE_KEY);
    expect(all).not.toContain(cfg.serviceRoleKey);
  });
});
