/**
 * Google Drive against a real Supabase stack (Milestone 5 part 3a, D119–D127).
 *
 * The production path — the same drive and files endpoints, the same stores and the same chat
 * turn the Edge Functions run — with Google scripted (tests never touch Google) and Anthropic
 * scripted. The unit suites prove the logic against in-memory stores; this file proves what
 * they cannot: that migration 20261016010000 does what the code believes it does.
 *
 *   - its objects exist: three tables with forced row-level security and one false policy
 *     each, the new column, the one `begin_conversation_file`, the purge still scheduled;
 *   - a connection goes in through connect_start → the callback → connect_finish and is stored
 *     SEALED, single-use at every step, refused to a different signed-in person;
 *   - a file read from Drive is attached under Drive's name and the file's one address, kept
 *     thirty days, and a later changed read replaces it;
 *   - a broken grant is recorded; a disconnect deletes the connection and its read records, so
 *     nothing read under it can be attached afterwards;
 *   - the purge clears read records past a day and attempts past their ten minutes;
 *   - a question about the file reaches the model as an attached document, without the web
 *     page rules.
 *
 * Every count is scoped to this run's users, conversations or ids, never to a whole table.
 */
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createServiceClient,
  supabaseVerifyDeps,
  type SupabaseAuthConfig,
} from '../../src/lib/auth/clients.js';
import { SEALED_FOR, importSealKey, open, toBase64Url } from '../../src/lib/drive/crypto.js';
import { DRIVE_FILE_SCOPE, driveFileUrl } from '../../src/lib/drive/limits.js';
import {
  handleDriveCallback,
  handleDriveRequest,
  type DrivePageDeps,
  type DrivePageResult,
  type DriveReadReply,
} from '../../src/lib/drive/page.js';
import { createDriveServiceClient, supabaseDriveStore } from '../../src/lib/drive/store.js';
import { FILES_DEFAULTS } from '../../src/lib/files/config.js';
import { createTurnDocuments } from '../../src/lib/files/context.js';
import {
  handleFilesRequest,
  type FilesPageDeps,
  type FilesReply,
} from '../../src/lib/files/page.js';
import { createFilesServiceClient, supabaseFileStore } from '../../src/lib/files/store.js';
import { createHttpClient, type FetchLike } from '../../src/lib/http.js';
import { handleChatTurn, type ChatDeps } from '../../src/lib/llm/chat.js';
import { createClaudeClient } from '../../src/lib/llm/client.js';
import type { LlmConfig } from '../../src/lib/llm/config.js';
import { DEFAULT_PRICING } from '../../src/lib/llm/pricing.js';
import { supabaseConversationStore, supabaseUsageStore } from '../../src/lib/llm/store.js';
import { createLogger } from '../../src/lib/logger.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';
import { scriptedClaude, scriptedPages } from '../unit/files/helpers.js';
import {
  AUTH_CODE,
  REFRESH_TOKEN,
  callsTo,
  pdfMeta,
  scriptedGoogle,
} from '../unit/drive/helpers.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);
const KEY = toBase64Url(new Uint8Array(32).fill(13));
const APP = 'http://localhost:5173';
const DOC_TEXT = `Two year fixed 5.79% p.a. CANARY-DRIVE-${RUN}`;
const DRIVE_NAME = `Rate sheet CANARY-NAME-${RUN}`;
const FILE_ID = `DriveDocFile${RUN}`;
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

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface TestUser {
  id: string;
  email: string;
  token: string;
}

function llmConfig(): LlmConfig {
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
    caps: { dailyUsd: 5, monthlyUsd: 1_000, warnFraction: 0.8 },
    pricing: DEFAULT_PRICING,
  };
}

describe.skipIf(env === null)('Google Drive (requires a running Supabase stack)', () => {
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
  const store = supabaseDriveStore(createDriveServiceClient(cfg));
  const google = scriptedGoogle();
  const logLines: string[] = [];
  const log = createLogger({
    level: 'debug',
    sink: (line) => {
      logLines.push(line);
    },
  });
  let sealKey: CryptoKey;

  const modelRequests: { system: string; firstUserText: string }[] = [];
  const fixtureFetch: FetchLike = (_url, init) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
      system?: { text?: string }[];
      messages?: { role: string; content: unknown }[];
    };
    const first = body.messages?.[0]?.content;
    modelRequests.push({
      system: (body.system ?? []).map((block) => block.text ?? '').join('\n'),
      firstUserText: Array.isArray(first)
        ? (first as { text?: string }[]).map((b) => b.text ?? '').join('\n')
        : typeof first === 'string'
          ? first
          : '',
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ...ANTHROPIC_FIXTURE,
          content: [{ type: 'text', text: 'The two year fixed is 5.79% p.a.' }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  };

  function driveDeps(): DrivePageDeps {
    return {
      verify: supabaseVerifyDeps(service),
      drive: {
        config: {
          clientId: '123456789012-abcdefgh.apps.googleusercontent.com',
          clientSecret: 'not-a-real-secret-for-the-stack',
          sealKey,
          redirectUri: 'http://127.0.0.1:54321/functions/v1/drive/callback',
          responseMode: 'form_post',
          appOrigin: APP,
        },
        google,
        store,
      },
      log,
    };
  }

  function filesDeps(): FilesPageDeps {
    return {
      verify: supabaseVerifyDeps(service),
      conversations: supabaseConversationStore(service),
      files,
      vision: { claude: scriptedClaude(), route: 'default', maxTokens: 512, log },
      usage: supabaseUsageStore(service),
      caps: llmConfig().caps,
      visionPricing: DEFAULT_PRICING['claude-sonnet-5'] ?? {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheWritePerMTok: 3.75,
        cacheReadPerMTok: 0.3,
      },
      config: FILES_DEFAULTS,
      pages: scriptedPages(),
      log,
    };
  }

  function chatDeps(): ChatDeps {
    const client = createClaudeClient({
      config: llmConfig(),
      http: createHttpClient({ fetch: fixtureFetch, retries: 0, logger: log }),
      usage: supabaseUsageStore(service),
      log,
    });
    return {
      verify: supabaseVerifyDeps(service),
      claude: { complete: client.complete.bind(client) },
      conversations: supabaseConversationStore(service),
      documents: createTurnDocuments(files, FILES_DEFAULTS.contextMaxChars),
      log,
    };
  }

  const drive = (user: TestUser, body: Record<string, unknown>): Promise<DrivePageResult> =>
    handleDriveRequest(driveDeps(), { token: user.token, body });

  async function filesOk<A extends FilesReply['action']>(
    user: TestUser,
    body: { action: A } & Record<string, unknown>,
  ): Promise<Extract<FilesReply, { action: A }>> {
    const result = await handleFilesRequest(filesDeps(), { token: user.token, body });
    if (result.status !== 200 || 'bytes' in result) {
      throw new Error(`${body.action} → ${String(result.status)} ${JSON.stringify(result.body)}`);
    }
    return result.body as Extract<FilesReply, { action: A }>;
  }

  /** connect_start → Google's callback (form_post) → connect_finish, as the app does. */
  async function connect(user: TestUser, finisher: TestUser = user): Promise<DrivePageResult> {
    const started = await drive(user, { action: 'connect_start' });
    const url = new URL((started.body as { authorizeUrl: string }).authorizeUrl);
    const back = await handleDriveCallback(driveDeps(), {
      state: url.searchParams.get('state') ?? '',
      code: AUTH_CODE,
    });
    if (back.status !== 303) throw new Error('the callback did not redirect');
    const attempt = new URL(back.location).searchParams.get('attempt') ?? '';
    return drive(finisher, { action: 'connect_finish', attempt });
  }

  /** read_file, then what the browser does: read the text, and attach it against the read. */
  async function readAndAttach(user: TestUser, conversationId: string | null, text: string) {
    const bytes = new TextEncoder().encode(text);
    google.files.set(FILE_ID, {
      ok: true,
      value: pdfMeta({ id: FILE_ID, name: DRIVE_NAME, mimeType: 'text/plain', size: bytes.length }),
    });
    google.content.set(FILE_ID, { ok: true, value: { bytes, contentType: 'text/plain' } });
    const read = await drive(user, {
      action: 'read_file',
      requestId: crypto.randomUUID(),
      fileId: FILE_ID,
    });
    if (!('bytes' in read))
      throw new Error(`read_file → ${String(read.status)} ${JSON.stringify(read.body)}`);
    const meta: DriveReadReply = read.body;
    expect(meta.contentHash).toBe(sha256(read.bytes));
    const begun = await filesOk(user, {
      action: 'begin',
      requestId: crypto.randomUUID(),
      conversationId,
      name: 'what the browser called it.txt',
      kind: 'text',
      byteSize: read.bytes.length,
      contentHash: meta.contentHash,
      totalPages: 1,
      visionPages: 0,
      driveReadId: meta.readId,
    });
    if (begun.duplicate) return { meta, begun, finished: null };
    await filesOk(user, {
      action: 'append',
      fileId: begun.fileId,
      pages: [{ pageNo: 1, label: 'Part 1', text }],
    });
    const finished = await filesOk(user, { action: 'finish', fileId: begun.fileId });
    return { meta, begun, finished };
  }

  const created: TestUser[] = [];
  let ross: TestUser;
  let colleague: TestUser;

  async function createUser(label: string): Promise<TestUser> {
    const email = `drive-${label}-${RUN}@example.com`;
    const password = `Fixture-${crypto.randomUUID()}`;
    const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (result.error !== null) throw new Error(`createUser ${label}: ${result.error.message}`);
    const id = result.data.user.id;
    await db.query(
      `insert into public.app_users (user_id, email, role, is_active) values ($1, $2, 'staff', true)`,
      [id, email],
    );
    const signIn = await anon.auth.signInWithPassword({ email, password });
    if (signIn.error !== null) throw new Error(`signIn ${label}: ${signIn.error.message}`);
    const user = { id, email, token: signIn.data.session.access_token };
    created.push(user);
    return user;
  }

  beforeAll(async () => {
    const imported = await importSealKey(KEY);
    if (!imported.ok) throw imported.error;
    sealKey = imported.value;
    await db.connect();
    ross = await createUser('ross');
    colleague = await createUser('colleague');
  }, 60_000);

  afterAll(async () => {
    const ids = created.map((user) => user.id);
    await db.query(`delete from public.drive_oauth_states where user_id = any($1::uuid[])`, [ids]);
    await db.query(`delete from public.drive_connections where user_id = any($1::uuid[])`, [ids]);
    await db.query(`delete from public.api_usage where user_id = any($1::uuid[])`, [ids]);
    await db.query(
      `delete from public.messages where conversation_id in (select id from public.conversations where user_id = any($1::uuid[]))`,
      [ids],
    );
    await db.query(
      `delete from public.memory_chunks where conversation_id in (select id from public.conversations where user_id = any($1::uuid[]))`,
      [ids],
    );
    await db.query(`delete from public.conversations where user_id = any($1::uuid[])`, [ids]);
    for (const user of created) {
      await db.query(`delete from public.app_users where user_id = $1`, [user.id]);
      await admin.auth.admin.deleteUser(user.id);
    }
    await db.end();
  }, 60_000);

  it('the migration left its objects in place', async () => {
    const tables = await db.query<{ relname: string; rls: boolean; force: boolean }>(
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('drive_connections', 'drive_oauth_states', 'drive_reads')
        order by c.relname`,
    );
    expect(tables.rows).toEqual([
      { relname: 'drive_connections', rls: true, force: true },
      { relname: 'drive_oauth_states', rls: true, force: true },
      { relname: 'drive_reads', rls: true, force: true },
    ]);
    const column = await db.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'conversation_files' and column_name = 'drive_file_id'`,
    );
    expect(column.rows).toEqual([{ is_nullable: 'YES' }]);
    const begin = await db.query<{ args: string }>(
      `select pg_get_function_identity_arguments(p.oid) as args from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'begin_conversation_file'`,
    );
    expect(begin.rows).toHaveLength(1);
    expect(begin.rows[0]?.args).toMatch(/p_fetch_id uuid, p_drive_read_id uuid$/);
    const job = await db.query<{ command: string; active: boolean }>(
      `select command, active from cron.job where jobname = 'purge-conversation-files'`,
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]?.active).toBe(true);
  });

  it('a connection goes in through Connect, the callback and finish, and is stored SEALED', async () => {
    const result = await connect(ross);
    expect(result.body).toMatchObject({
      outcome: 'connected',
      message: 'Google Drive is connected as broker@example.com.',
    });
    const row = await db.query<{
      token_id: string;
      refresh_token_sealed: string;
      google_email: string;
      granted_scope: string;
    }>(
      `select token_id, refresh_token_sealed, google_email, granted_scope from public.drive_connections where user_id = $1`,
      [ross.id],
    );
    expect(row.rows).toHaveLength(1);
    const stored = row.rows[0];
    expect(stored?.refresh_token_sealed).not.toContain(REFRESH_TOKEN);
    expect(stored?.granted_scope).toBe(DRIVE_FILE_SCOPE);
    const opened = await open(
      sealKey,
      stored?.refresh_token_sealed ?? '',
      SEALED_FOR.refreshToken(ross.id, stored?.token_id ?? ''),
    );
    expect(opened.ok && opened.value).toBe(REFRESH_TOKEN);
    // The attempt is gone, and the audit row names no address.
    expect(
      (await db.query(`select 1 from public.drive_oauth_states where user_id = $1`, [ross.id]))
        .rowCount,
    ).toBe(0);
    const audit = await db.query<{ after: Record<string, unknown> }>(
      `select after from public.audit_log where action = 'DRIVE_CONNECTED' and entity_id = $1`,
      [ross.id],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.rows)).not.toContain('@');
    const status = await drive(ross, { action: 'status' });
    expect(status.body).toMatchObject({
      state: 'connected',
      email: 'broker@example.com',
      checked: true,
    });
  });

  it("every step is single-use, and a different signed-in person cannot finish someone else's Connect", async () => {
    const started = await drive(colleague, { action: 'connect_start' });
    const state =
      new URL((started.body as { authorizeUrl: string }).authorizeUrl).searchParams.get('state') ??
      '';
    const first = await handleDriveCallback(driveDeps(), { state, code: AUTH_CODE });
    const second = await handleDriveCallback(driveDeps(), { state, code: 'replayed-code' });
    expect(second).toEqual({ status: 303, location: `${APP}/settings?drive=stale` });
    const attempt =
      first.status === 303 ? (new URL(first.location).searchParams.get('attempt') ?? '') : '';
    const exchangesBefore = callsTo(google, 'exchangeCode').length;
    const stolen = await drive(ross, { action: 'connect_finish', attempt });
    expect(stolen.body).toMatchObject({ outcome: 'wrong_user' });
    expect(callsTo(google, 'exchangeCode')).toHaveLength(exchangesBefore);
    expect(
      (await db.query(`select 1 from public.drive_connections where user_id = $1`, [colleague.id]))
        .rowCount,
    ).toBe(0);
    const late = await drive(colleague, { action: 'connect_finish', attempt });
    expect(late.body).toMatchObject({ outcome: 'stale' });
  });

  it("a file read from Drive is attached under Drive's name and its one address, for thirty days", async () => {
    const { finished } = await readAndAttach(ross, null, DOC_TEXT);
    expect(finished?.file).toMatchObject({
      name: DRIVE_NAME,
      kind: 'text',
      sourceUrl: driveFileUrl(FILE_ID),
      sourceHost: 'drive.google.com',
      driveFileId: FILE_ID,
    });
    const row = await db.query<{ days: number; uploaded_by: string }>(
      `select extract(day from expires_at - created_at)::int as days, uploaded_by from public.conversation_files where id = $1`,
      [finished?.file.id],
    );
    expect(row.rows[0]).toEqual({ days: 30, uploaded_by: ross.id });
    const audit = await db.query<{ source: string }>(
      `select after->>'source' as source from public.audit_log where action = 'FILE_ATTACHED' and entity_id = $1`,
      [finished?.file.id],
    );
    expect(audit.rows).toEqual([{ source: 'drive' }]);
  });

  it('read again after a change in Drive: the newer copy replaces the older one', async () => {
    const first = await readAndAttach(ross, null, `${DOC_TEXT} (first)`);
    const conversationId = first.begun.conversationId;
    const second = await readAndAttach(ross, conversationId, `${DOC_TEXT} (changed)`);
    expect(second.finished?.replaced).toBe(1);
    const old = await db.query<{
      status: string;
      drive_file_id: string | null;
      source_url: string | null;
    }>(`select status, drive_file_id, source_url from public.conversation_files where id = $1`, [
      first.begun.fileId,
    ]);
    expect(old.rows[0]).toEqual({ status: 'removed', drive_file_id: null, source_url: null });
  });

  it('a question about it reaches the model as an attached document, without the web-page rules', async () => {
    const { begun } = await readAndAttach(ross, null, DOC_TEXT);
    modelRequests.length = 0;
    const turn = await handleChatTurn(chatDeps(), {
      token: ross.token,
      message: 'What is the two year fixed rate?',
      conversationId: begun.conversationId,
    });
    expect(turn.status).toBe(200);
    const request = modelRequests.at(-1);
    expect(request?.firstUserText).toContain(`CANARY-DRIVE-${RUN}`);
    expect(request?.firstUserText).toContain('<untrusted_document');
    expect(request?.firstUserText).not.toContain('source="drive.google.com"');
    expect(request?.system).not.toContain('# Pages read from a link');
  });

  it('a broken grant is recorded, and said', async () => {
    google.refreshes = [{ ok: false, error: { kind: 'grant_invalid' } }];
    const status = await drive(ross, { action: 'status' });
    expect(status.body).toMatchObject({ state: 'broken', reason: 'grant_revoked' });
    const row = await db.query<{ status: string; broken_reason: string }>(
      `select status, broken_reason from public.drive_connections where user_id = $1`,
      [ross.id],
    );
    expect(row.rows[0]).toEqual({ status: 'broken', broken_reason: 'grant_revoked' });
    google.refreshes = [{ ok: true, value: { accessToken: 'ignored' } }];
    // A fresh Connect clears it.
    await connect(ross);
    expect(
      (
        await db.query<{ status: string }>(
          `select status from public.drive_connections where user_id = $1`,
          [ross.id],
        )
      ).rows[0]?.status,
    ).toBe('active');
  });

  it('disconnect revokes at Google, deletes the connection AND its reads: nothing read under it attaches', async () => {
    const bytes = new TextEncoder().encode(DOC_TEXT);
    google.files.set(FILE_ID, {
      ok: true,
      value: pdfMeta({ id: FILE_ID, name: DRIVE_NAME, mimeType: 'text/plain', size: bytes.length }),
    });
    google.content.set(FILE_ID, { ok: true, value: { bytes, contentType: 'text/plain' } });
    const read = await drive(ross, {
      action: 'read_file',
      requestId: crypto.randomUUID(),
      fileId: FILE_ID,
    });
    if (!('bytes' in read)) throw new Error('read failed');
    const revokesBefore = callsTo(google, 'revoke').length;
    const result = await drive(ross, { action: 'disconnect' });
    expect(result.body).toMatchObject({ disconnected: true });
    expect(callsTo(google, 'revoke').length).toBe(revokesBefore + 1);
    expect(
      (await db.query(`select 1 from public.drive_connections where user_id = $1`, [ross.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (await db.query(`select 1 from public.drive_reads where user_id = $1`, [ross.id])).rowCount,
    ).toBe(0);
    const late = await handleFilesRequest(filesDeps(), {
      token: ross.token,
      body: {
        action: 'begin',
        requestId: crypto.randomUUID(),
        conversationId: null,
        name: 'x.txt',
        kind: 'text',
        byteSize: read.bytes.length,
        contentHash: read.body.contentHash,
        totalPages: 1,
        visionPages: 0,
        driveReadId: read.body.readId,
      },
    });
    expect(late.status).toBe(409);
    const status = await drive(ross, { action: 'status' });
    expect(status.body).toMatchObject({ state: 'not_connected' });
  });

  it("the purge clears read records past a day and attempts past their ten minutes — this run's only", async () => {
    await connect(colleague);
    const readId = crypto.randomUUID();
    await db.query(`select * from public.claim_drive_read($1, $2, $3, 20)`, [
      readId,
      colleague.id,
      FILE_ID,
    ]);
    await db.query(
      `update public.drive_reads set created_at = now() - interval '25 hours' where id = $1`,
      [readId],
    );
    const started = await drive(colleague, { action: 'connect_start' });
    expect(started.status).toBe(200);
    await db.query(
      `update public.drive_oauth_states set expires_at = now() - interval '1 minute' where user_id = $1`,
      [colleague.id],
    );
    await db.query(`select * from public.purge_conversation_files(15)`);
    expect(
      (await db.query(`select 1 from public.drive_reads where id = $1`, [readId])).rowCount,
    ).toBe(0);
    expect(
      (await db.query(`select 1 from public.drive_oauth_states where user_id = $1`, [colleague.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (await db.query(`select 1 from public.drive_connections where user_id = $1`, [colleague.id]))
        .rowCount,
    ).toBe(1);
  });

  it("no log line carries a token, a code, the file's name or its content", () => {
    const text = logLines.join('\n');
    expect(text).not.toContain(REFRESH_TOKEN);
    expect(text).not.toContain(AUTH_CODE);
    expect(text).not.toContain('CANARY-NAME');
    expect(text).not.toContain('CANARY-DRIVE');
  });
});
