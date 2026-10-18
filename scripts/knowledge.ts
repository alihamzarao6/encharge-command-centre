/**
 * Learned-knowledge runner (Milestone 5 part 5).
 *
 *   npm run knowledge -- chunk <file>          read a file with the app's own readers and cut it
 *                                              as learning would: chunks, sizes, the pages each
 *                                              section label covers. No network.
 *
 *   <file> is a path, or `stored:<attachment id>` for an attachment's text as the database holds
 *   it (READ with the service key in .env; nothing is written there). The text is never printed.
 *   npm run knowledge -- ask <file> "<question>" [--then "<follow-up>"]… [--fresh]
 *                                              LIVE. Learn the file exactly as the app does — the
 *                                              app's readers, the chunker, the REAL Voyage embedder at
 *                                              the configured pace (the free plan's three a minute
 *                                              by default) — then ask through the REAL chat handler
 *                                              and the real model. With --fresh the question is
 *                                              asked in a brand-new conversation the file was never
 *                                              attached to: the answer can only come from what was
 *                                              learned. Prints each answer, the note the screen
 *                                              would show under it word for word, and what learning
 *                                              and each answer cost.
 *   npm run knowledge -- why <file> [--runs N]  LIVE. Fixed decision 8: asks "break down weak one
 *                                              for me", then three ways of asking why it did not see
 *                                              everything, N times each, judges every reply
 *                                              (knowledge/probe.ts) and saves them to
 *                                              tests/fixtures/knowledge/why-after.json.
 *   npm run knowledge -- record                LIVE. Re-records the retrieval-path injection probes
 *                                              into tests/fixtures/knowledge/recorded/ (protected and
 *                                              control), held by tests/unit/knowledge/injection-live.test.ts.
 *
 * What is NOT the product here, and says so: the vector search runs over an in-memory store
 * (knowledge/local-store.ts) because pgvector cannot run on this machine — the same rules as the
 * database's function, held to the same cases by the tests. The ledgers are in memory too, so a
 * run is under the env caps and needs no database. Everything else is the app's own code.
 *
 * This prints the text of answers about a file to the terminal of the person who supplied it,
 * like `npm run files -- ask`. Nothing here writes a document's text to a log.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { loadSupabaseAuthConfig } from '../src/lib/auth/clients.js';
import type { StaffRow } from '../src/lib/auth/verify.js';
import { ok, type Result } from '../src/lib/errors.js';
import { loadFilesConfig } from '../src/lib/files/config.js';
import {
  createTurnDocuments,
  type TurnFile,
  type TurnKnowledge,
} from '../src/lib/files/context.js';
import { isFileKind } from '../src/lib/files/limits.js';
import { DOCUMENT_RULES_VERSION } from '../src/lib/files/rules.js';
import { sanitiseFileName } from '../src/lib/files/text.js';
import { createHttpClient } from '../src/lib/http.js';
import {
  CHUNKER_VERSION,
  chunkPages,
  embeddingText,
  sectionsNamedIn,
} from '../src/lib/knowledge/chunk.js';
import { loadKnowledgeConfig, type KnowledgeConfig } from '../src/lib/knowledge/config.js';
import {
  captureSource,
  drainKnowledge,
  type DrainReport,
  type KnowledgeIngestDeps,
} from '../src/lib/knowledge/ingest.js';
import {
  createLocalKnowledgeStore,
  unwrap,
  type LocalKnowledgeStore,
} from '../src/lib/knowledge/local-store.js';
import {
  KNOWLEDGE_INJECTION_PROBES,
  judgeCoverageExplanation,
  judgeWithdrawnReply,
  knowledgeProbeRequest,
  unprotectedKnowledgeRequest,
  withdrawnFollowUps,
  withdrawnProbeDocuments,
  withdrawnProbeHistory,
  type WithdrawnCase,
  type WithdrawnMode,
} from '../src/lib/knowledge/probe.js';
import { WITHDRAWN_REPLY_STAND_IN } from '../src/lib/knowledge/withdrawn.js';
import { MAX_QUERY_NAMES, searchTextFor } from '../src/lib/knowledge/query.js';
import { describePages } from '../src/lib/knowledge/select.js';
import { KNOWLEDGE_SUMMARY_OPERATION } from '../src/lib/knowledge/summarise.js';
import {
  createKnowledgeServiceClient,
  supabaseKnowledgeStore,
} from '../src/lib/knowledge/store.js';
import { queryFromEmbedder } from '../src/lib/knowledge/wiring.js';
import {
  handleChatTurn,
  type ChatDeps,
  type ConversationRow,
  type ConversationStore,
  type HistoryMessage,
} from '../src/lib/llm/chat.js';
import {
  createClaudeClient,
  type ClaudeClient,
  type CompletionRequest,
  type UsageRecord,
} from '../src/lib/llm/client.js';
import { loadLlmConfig } from '../src/lib/llm/config.js';
import { RECORDED_PROBE, judgeReply, requestFingerprintSource } from '../src/lib/files/probe.js';
import {
  DOCUMENT_RULES_VERSION as DOC_RULES,
  WEB_RULES_VERSION,
  WITHDRAWN_RULES_VERSION,
} from '../src/lib/files/rules.js';
import { createLogger, logger } from '../src/lib/logger.js';
import { loadVoyageConfig } from '../src/lib/memory/config.js';
import { createVoyageEmbedder, type Embedder } from '../src/lib/memory/embed.js';
import { coverageLines, parseCoverage, parseNames } from '../web/src/lib/coverage.js';
import { extractFile } from '../web/src/lib/files/extract.js';
import type { ExtractEngines } from '../web/src/lib/files/types.js';

const FIXTURES = resolve(import.meta.dirname, '..', 'tests', 'fixtures', 'knowledge');
const USER = '00000000-0000-4000-8000-0000000000c1';
const CONV_ATTACHED = '00000000-0000-4000-8000-00000000c0a1';
const quiet = createLogger({ level: 'error' });
/**
 * The search's own lines — rewrite outcome and time, similarities, pages chosen — to stderr, so a
 * turn that found nothing can be explained. They carry ids, counts and timings, never text.
 */
const searchLog = createLogger({
  level: 'info',
  sink: (line) => {
    process.stderr.write(`${line}\n`);
  },
});

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function note(line: string): void {
  process.stderr.write(`knowledge: ${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`knowledge: ${message}\n`);
  process.exit(1);
}

function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env — rely on the real environment.
  }
}

function nodeEngines(): ExtractEngines {
  return {
    pdf: () => Promise.resolve({ getDocument }),
    pdfAssets: `${join(import.meta.dirname, '..', 'node_modules', 'pdfjs-dist')}/`,
    images: {
      decode: () => Promise.resolve({ base64: '', width: 0, height: 0 }),
      renderPdfPage: () => Promise.resolve(null),
    },
  };
}

interface ReadDocument {
  readonly file: TurnFile;
  readonly hash: string;
  readonly chars: number;
}

/** The one table a stored attachment is looked up in; its pages come through the store. */
interface StoredFileDatabase {
  public: {
    Tables: {
      conversation_files: {
        Row: {
          id: string;
          status: string;
          name: string;
          kind: string;
          content_hash: string | null;
          ready_at: string | null;
        };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
  };
}

const STORED = 'stored:';

/**
 * `stored:<file id>`: an attachment's text as the database holds it — the original is never
 * kept, so this is the only copy once it is attached. Read with the service key in .env (READ
 * only: nothing is written to the database) and learned in memory like a file on disk.
 */
async function readStoredDocument(fileId: string): Promise<ReadDocument> {
  const config = loadSupabaseAuthConfig(process.env);
  if (!config.ok) fail(config.error.message);
  const client = createClient<StoredFileDatabase>(config.value.url, config.value.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const row = await client
    .from('conversation_files')
    .select('id, status, name, kind, content_hash, ready_at')
    .eq('id', fileId)
    .maybeSingle();
  if (row.error !== null) fail(`the attachment could not be read: ${row.error.message}`);
  if (row.data === null) fail('no attachment has that id');
  if (row.data.status !== 'ready') fail(`the attachment is ${row.data.status}, not ready`);
  const kind = row.data.kind;
  if (!isFileKind(kind)) fail(`unknown kind ${kind}`);
  const pages = await supabaseKnowledgeStore(
    createKnowledgeServiceClient(config.value),
  ).pagesOfFile(fileId);
  if (!pages.ok) fail(`its pages could not be read: ${pages.error.message}`);
  if (pages.value === null || pages.value.length === 0) fail('its text is gone');
  return {
    file: {
      id: fileId,
      name: row.data.name,
      kind,
      createdAt: row.data.ready_at ?? new Date().toISOString(),
      pages: pages.value.map((p) => ({ ...p })),
    },
    hash: row.data.content_hash ?? createHash('sha256').update(fileId).digest('hex'),
    chars: pages.value.reduce((n, p) => n + p.content.length, 0),
  };
}

async function readDocument(path: string): Promise<ReadDocument> {
  if (path.startsWith(STORED)) return readStoredDocument(path.slice(STORED.length));
  const bytes = new Uint8Array(readFileSync(resolve(path)));
  const extraction = await extractFile({ name: basename(path), bytes }, nodeEngines());
  if (!extraction.ok) fail(`the app's readers refused this file: ${extraction.refusal.message}`);
  if (extraction.vision.length > 0) {
    fail(
      `${String(extraction.vision.length)} page(s) need reading as images; attach it in the app instead`,
    );
  }
  const pages = extraction.pages.map((page) => ({
    pageNo: page.pageNo,
    label: page.label,
    content: page.text,
    method: page.method,
    legibility: 'full' as const,
  }));
  extraction.dispose();
  return {
    file: {
      id: '00000000-0000-4000-8000-0000000000f1',
      name: sanitiseFileName(basename(path)),
      kind: extraction.kind,
      createdAt: new Date().toISOString(),
      pages,
    },
    hash: createHash('sha256').update(bytes).digest('hex'),
    chars: pages.reduce((n, p) => n + p.content.length, 0),
  };
}

/** One in-memory ledger for both providers, so the env caps hold for the whole run. */
function ledger(): {
  rows: UsageRecord[];
  usage: {
    spentSince: (provider: string) => Promise<Result<number>>;
    record: (row: UsageRecord) => Promise<Result<void>>;
  };
} {
  const rows: UsageRecord[] = [];
  return {
    rows,
    usage: {
      spentSince: (provider) =>
        Promise.resolve(
          ok(rows.filter((r) => r.provider === provider).reduce((s, r) => s + r.costUsd, 0)),
        ),
      record: (row) => {
        rows.push(row);
        return Promise.resolve(ok(undefined));
      },
    },
  };
}

interface Live {
  readonly claude: ClaudeClient;
  readonly requests: CompletionRequest[];
  readonly ingestEmbedder: Embedder;
  readonly queryEmbedder: Embedder;
  readonly knowledge: KnowledgeConfig;
  readonly rows: UsageRecord[];
  readonly cache: VectorCache;
}

function live(cache: VectorCache = openCache(null)): Live {
  const llm = loadLlmConfig(process.env);
  if (!llm.ok) fail(`${llm.error.code}: ${llm.error.message}`);
  const voyage = loadVoyageConfig(process.env);
  if (!voyage.ok) fail(`${voyage.error.code}: ${voyage.error.message}`);
  const knowledge = loadKnowledgeConfig(process.env);
  if (!knowledge.ok) fail(`${knowledge.error.code}: ${knowledge.error.message}`);
  const { rows, usage } = ledger();
  const requests: CompletionRequest[] = [];
  const inner = createClaudeClient({
    config: llm.value,
    http: createHttpClient({ timeoutMs: llm.value.timeoutMs, retries: 0, logger }),
    usage,
    log: quiet,
  });
  const claude: ClaudeClient = {
    complete: (request) => {
      requests.push(request);
      return inner.complete(request);
    },
  };
  const embedder = (timeoutMs: number): Embedder =>
    createVoyageEmbedder({
      config: { ...voyage.value, retries: 0, timeoutMs },
      http: createHttpClient({ timeoutMs, retries: 0, logger: quiet }),
      usage,
      log: quiet,
    });
  return {
    claude,
    requests,
    ingestEmbedder: cached(embedder(knowledge.value.embed.timeoutMs), cache),
    queryEmbedder: cached(embedder(knowledge.value.retrieval.queryTimeoutMs), cache),
    cache,
    knowledge: knowledge.value,
    rows,
  };
}

/**
 * --cache <file>: vectors kept between runs, keyed by the SHA-256 of model, input type and text,
 * so a document is paid for and paced once. OFF by default: for a client's document the file is
 * a local copy of what was learned from it, so asking for it is the person's own decision.
 */
interface VectorCache {
  readonly path: string | null;
  readonly vectors: Map<string, number[]>;
}

function openCache(path: string | null): VectorCache {
  if (path === null) return { path, vectors: new Map() };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number[]>;
    return { path, vectors: new Map(Object.entries(raw)) };
  } catch {
    return { path, vectors: new Map() };
  }
}

function cacheKey(inputType: string, text: string): string {
  return createHash('sha256').update(`voyage-3\u0000${inputType}\u0000${text}`).digest('hex');
}

function cached(inner: Embedder, cache: VectorCache): Embedder {
  return {
    checkBudget: (chars) => inner.checkBudget(chars),
    embed: async (request) => {
      const keys = request.texts.map((t) => cacheKey(request.inputType, t));
      const hits = keys.map((k) => cache.vectors.get(k));
      if (hits.every((v): v is number[] => v !== undefined)) {
        return ok({
          vectors: hits,
          model: 'voyage-3 (cached)',
          totalTokens: 0,
          costUsd: 0,
          attempts: 0,
        });
      }
      // Only what is missing goes to Voyage: a cached document's new summaries are a few
      // thousand characters, not the batch they happen to share with its passages.
      const missing = request.texts.filter((_, i) => hits[i] === undefined);
      const result = await inner.embed({ ...request, texts: missing });
      if (!result.ok) return result;
      const fresh = [...result.value.vectors];
      const vectors = hits.map((hit) => hit ?? fresh.shift() ?? []);
      vectors.forEach((v, i) => {
        const k = keys[i];
        if (k !== undefined) cache.vectors.set(k, [...v]);
      });
      if (cache.path !== null) {
        writeFileSync(cache.path, JSON.stringify(Object.fromEntries(cache.vectors)));
      }
      return ok({ ...result.value, vectors });
    },
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

interface Learned {
  readonly store: LocalKnowledgeStore;
  readonly sourceId: string;
  readonly chunks: number;
  readonly chunkChars: number;
  readonly requests: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly elapsedMs: number;
  readonly refusals: Readonly<Record<string, number>>;
  /** The summary written while it was learned: how much, and what the fast model cost. */
  readonly summary: {
    readonly blocks: number;
    readonly chars: number;
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
  };
}

/**
 * Learn as production does: capture at once, then drain runs a minute apart (the schedule),
 * each under the lease and the configured pace, resting after any refusal.
 */
async function learn(doc: ReadDocument, l: Live): Promise<Learned> {
  const store = createLocalKnowledgeStore({ activeStaff: [USER] });
  const sourceId = store.attach({
    fileId: doc.file.id,
    conversationId: CONV_ATTACHED,
    uploadedBy: USER,
    name: doc.file.name,
    kind: doc.file.kind,
    contentHash: doc.hash,
    learnedAt: doc.file.createdAt,
    pages: doc.file.pages,
  });
  const allCached = chunkPages(doc.file.pages, doc.file.name).every((c) =>
    l.cache.vectors.has(cacheKey('document', embeddingText(doc.file.name, c))),
  );
  const pace = allCached
    ? {
        ...l.knowledge.embed,
        batchChars: 10_000_000,
        batchInputs: 128,
        requestsPerRun: 1_000,
        gapMs: 0,
      }
    : l.knowledge.embed;
  if (allCached) note('every chunk is in the cache: learning without Voyage');
  const deps: KnowledgeIngestDeps = {
    store,
    embedder: l.ingestEmbedder,
    config: pace,
    ...(l.knowledge.summary.enabled
      ? { summaries: { claude: l.claude, config: l.knowledge.summary } }
      : {}),
    log: searchLog,
  };
  const started = Date.now();
  await captureSource(deps, { id: sourceId, fileId: doc.file.id, name: doc.file.name });
  const captured = store.status(sourceId);
  note(
    `captured ${String(captured?.chunkCount ?? 0)} chunks; learning at ${String(l.knowledge.embed.requestsPerRun)} request(s) a run, ${String(l.knowledge.embed.batchChars)} characters a request`,
  );
  let requests = 0;
  const tokensBefore = l.rows
    .filter((r) => r.provider === 'voyage')
    .reduce((n, r) => n + r.inputTokens, 0);
  const refusals: Record<string, number> = {};
  for (let run = 0; run < 400; run += 1) {
    const runStarted = Date.now();
    const drained = await drainKnowledge(deps);
    if (!drained.ok) fail(`drain: ${drained.error.message}`);
    const report: DrainReport = drained.value;
    requests += report.requests;
    if (!['drained', 'more', 'busy'].includes(report.outcome))
      refusals[report.outcome] = (refusals[report.outcome] ?? 0) + 1;
    const state = store.status(sourceId);
    note(
      `run ${String(run + 1)}: ${report.outcome}; ${String(state?.embeddedCount ?? 0)} of ${String(state?.chunkCount ?? 0)} embedded; ${String(Math.round((Date.now() - started) / 1000))} s`,
    );
    if (state?.status === 'ready' || state?.status === 'failed') break;
    // The schedule: the next run starts a minute after this one did, or when the rest ends.
    // A rest Voyage asked for is waited out even when nearly everything is cached.
    const wait =
      report.outcome === 'busy'
        ? (report.waitMs ?? 1_000)
        : allCached
          ? 0
          : Math.max(0, 60_000 - (Date.now() - runStarted));
    await sleep(wait);
  }
  const state = store.status(sourceId);
  if (state?.status !== 'ready')
    fail(`the document did not finish learning (${state?.status ?? 'gone'})`);
  const voyage = l.rows.filter((r) => r.provider === 'voyage');
  const tokens = voyage.reduce((n, r) => n + r.inputTokens, 0) - tokensBefore;
  const summaries = unwrap(await store.summariesOf(sourceId));
  const summaryRows = l.rows.filter((r) => r.operation === KNOWLEDGE_SUMMARY_OPERATION);
  return {
    store,
    sourceId,
    chunks: state.chunkCount,
    chunkChars: chunkPages(doc.file.pages, doc.file.name).reduce((n, c) => n + c.content.length, 0),
    summary: {
      blocks: summaries.length,
      chars: summaries.reduce((n, c) => n + c.content.length, 0),
      calls: summaryRows.length,
      inputTokens: summaryRows.reduce((n, r) => n + r.inputTokens, 0),
      outputTokens: summaryRows.reduce((n, r) => n + r.outputTokens, 0),
      costUsd: summaryRows.reduce((n, r) => n + r.costUsd, 0),
    },
    requests,
    tokens,
    costUsd: voyage.reduce((s, r) => s + r.costUsd, 0),
    elapsedMs: Date.now() - started,
    refusals,
  };
}

function conversations(): ConversationStore {
  const rows = new Map<string, ConversationRow>();
  const history = new Map<string, HistoryMessage[]>();
  let n = 0;
  return {
    get: (id) => Promise.resolve(ok(rows.get(id) ?? null)),
    create: (userId, title) => {
      n += 1;
      const row: ConversationRow = {
        id: n === 1 && !rows.has(CONV_ATTACHED) ? CONV_ATTACHED : crypto.randomUUID(),
        userId,
        scope: 'workspace',
        title,
        deletedAt: null,
      };
      rows.set(row.id, row);
      return Promise.resolve(ok(row));
    },
    recentMessages: (id, limit) => Promise.resolve(ok((history.get(id) ?? []).slice(-limit))),
    appendTurn: (input) => {
      const list = history.get(input.conversation.id) ?? [];
      list.push(
        { role: 'user', content: input.userContent },
        { role: 'assistant', content: input.assistant.content },
      );
      history.set(input.conversation.id, list);
      return Promise.resolve(
        ok({ userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID() }),
      );
    },
  };
}

const STAFF: StaffRow = {
  user_id: USER,
  email: 'terminal@knowledge.local',
  role: 'staff',
  is_active: true,
  is_admin: false,
};

function chatDeps(
  l: Live,
  learned: Learned,
  doc: ReadDocument,
  convs: ConversationStore,
): ChatDeps {
  const files = loadFilesConfig(process.env);
  if (!files.ok) fail(files.error.message);
  const knowledge: TurnKnowledge = {
    sourcesForFiles: (ids) => learned.store.sourcesForFiles(ids),
    match: (q, p) => learned.store.match(q, p),
    neighbours: (s, o) => learned.store.neighbours(s, o),
    summaries: (s) => learned.store.summariesOf(s),
    anyReady: () => learned.store.anyReady(),
    config: l.knowledge.retrieval,
    log: searchLog,
  };
  return {
    verify: {
      getUserFromToken: () => Promise.resolve(ok({ id: USER, email: STAFF.email })),
      getStaffRow: () => Promise.resolve(ok(STAFF)),
    },
    claude: l.claude,
    conversations: convs,
    log: quiet,
    documents: createTurnDocuments(
      {
        forTurn: (conversationId) =>
          Promise.resolve(
            ok(
              conversationId === CONV_ATTACHED
                ? { files: [doc.file], everHadFile: true }
                : { files: [], everHadFile: false },
            ),
          ),
      },
      files.value.contextMaxChars,
      () => new Date(),
      knowledge,
    ),
    query: queryFromEmbedder(
      l.queryEmbedder,
      l.knowledge.retrieval.queryTimeoutMs,
      l.knowledge.retrieval.rewrite
        ? {
            claude: l.claude,
            names: () => learned.store.recentNames(MAX_QUERY_NAMES),
            timeoutMs: l.knowledge.retrieval.rewriteTimeoutMs,
            log: searchLog,
          }
        : undefined,
    ),
  };
}

interface Asked {
  readonly question: string;
  readonly reply: string;
  readonly note: readonly string[];
  readonly coverage: unknown;
  readonly documentChars: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

async function askOnce(
  deps: ChatDeps,
  question: string,
  conversationId: string | null,
): Promise<Asked & { conversationId: string }> {
  const result = await handleChatTurn(deps, {
    token: 'terminal',
    message: question,
    ...(conversationId === null ? {} : { conversationId }),
  });
  if (result.status !== 200)
    fail(`${String(result.status)} ${result.body.error.code}: ${result.body.error.message}`);
  const coverage = parseCoverage(result.body.documents?.coverage);
  return {
    conversationId: result.body.conversationId,
    question,
    reply: result.body.reply,
    note: coverageLines(coverage, parseNames(result.body.documents?.names)),
    coverage: result.body.documents?.coverage ?? null,
    documentChars: result.body.documents?.chars ?? 0,
    inputTokens: result.body.usage.inputTokens,
    outputTokens: result.body.usage.outputTokens,
    costUsd: result.body.costUsd,
  };
}

function flags(argv: readonly string[]): {
  positional: string[];
  then: string[];
  fresh: boolean;
  runs: number;
  cache: string | null;
  rewrite: boolean;
} {
  const positional: string[] = [];
  const then: string[] = [];
  let fresh = false;
  let runs = 3;
  let cache: string | null = null;
  let rewrite = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--fresh') fresh = true;
    else if (arg === '--rewrite') rewrite = true;
    else if (arg === '--then' || arg === '--runs' || arg === '--cache') {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      i += 1;
      if (arg === '--then') then.push(value);
      else if (arg === '--cache') cache = resolve(value);
      else {
        runs = Number(value);
        if (!Number.isInteger(runs) || runs < 1 || runs > 6) fail('--runs is 1 to 6');
      }
    } else positional.push(arg);
  }
  return { positional, then, fresh, runs, cache, rewrite };
}

async function chunkCommand(path: string | undefined): Promise<void> {
  if (path === undefined) fail('usage: npm run knowledge -- chunk <file>');
  const doc = await readDocument(path);
  const chunks = chunkPages(doc.file.pages);
  const sizes = chunks.map((c) => c.content.length);
  // What each section label covers ("Week 3": pages 7–9): a kind and a number, never text.
  const sections = new Map<string, Set<number>>();
  for (const c of chunks) {
    for (const label of c.section?.split(', ') ?? []) {
      const pages = sections.get(label) ?? new Set<number>();
      pages.add(c.pageNo);
      sections.set(label, pages);
    }
  }
  out({
    file: doc.file.name,
    chunker: CHUNKER_VERSION,
    pages: doc.file.pages.length,
    chars: doc.chars,
    chunks: chunks.length,
    chunkChars: sizes.reduce((a, b) => a + b, 0),
    smallest: Math.min(...sizes),
    largest: Math.max(...sizes),
    sections: Object.fromEntries(
      [...sections].map(([label, pages]) => [label, describePages([...pages])]),
    ),
  });
}

async function askCommand(argv: readonly string[]): Promise<void> {
  const f = flags(argv);
  const [path, question] = f.positional;
  if (path === undefined || question === undefined)
    fail('usage: npm run knowledge -- ask <file> "<question>" [--then "<q>"]… [--fresh]');
  const doc = await readDocument(path);
  const l = live(openCache(f.cache));
  const learned = await learn(doc, l);
  const convs = conversations();
  const deps = chatDeps(l, learned, doc, convs);
  // The file is attached to its own conversation; --fresh asks in another, empty one.
  let conversationId: string | null = null;
  if (!f.fresh) {
    const created = await convs.create(USER, 'with the file');
    if (!created.ok) fail('conversation');
    conversationId = created.value.id;
  }
  const turns: Asked[] = [];
  for (const q of [question, ...f.then]) {
    const asked = await askOnce(deps, q, conversationId);
    conversationId = asked.conversationId;
    turns.push(asked);
  }
  const claude = l.rows.filter((r) => r.provider === 'anthropic');
  out({
    file: doc.file.name,
    pages: doc.file.pages.length,
    chars: doc.chars,
    conversation: f.fresh
      ? 'a brand-new conversation the file was never attached to'
      : 'the conversation the file is attached to',
    learning: {
      chunks: learned.chunks,
      chunkChars: learned.chunkChars,
      voyageRequests: learned.requests,
      voyageTokens: learned.tokens,
      voyageCostUsd: learned.costUsd,
      minutes: Number((learned.elapsedMs / 60_000).toFixed(1)),
      refusals: learned.refusals,
      summary: learned.summary,
    },
    turns,
    claudeCostUsd: claude.reduce((s, r) => s + r.costUsd, 0),
    rulesVersion: DOCUMENT_RULES_VERSION,
  });
}

export const WHY_QUESTIONS = [
  'why only four pages?',
  'why did you only look at a few pages of it? I gave you the whole transcript',
  'how come you can only see part of the document?',
] as const;

async function whyCommand(argv: readonly string[]): Promise<void> {
  const f = flags(argv);
  const path = f.positional[0];
  if (path === undefined) fail('usage: npm run knowledge -- why <file> [--runs N]');
  const doc = await readDocument(path);
  const l = live(openCache(f.cache));
  const learned = await learn(doc, l);
  const firstQuestion = 'break down weak one for me';
  const runs: {
    question: string;
    reply: string;
    note: readonly string[];
    verdict: ReturnType<typeof judgeCoverageExplanation>;
  }[] = [];
  // One first turn, then every follow-up in a fresh copy of that conversation: each "why" sees
  // the same history, and the first answer is paid for once.
  const convs = conversations();
  const deps = chatDeps(l, learned, doc, convs);
  const created = await convs.create(USER, 'with the file');
  if (!created.ok) fail('conversation');
  const first = await askOnce(deps, firstQuestion, created.value.id);
  for (const question of WHY_QUESTIONS) {
    for (let i = 0; i < f.runs; i += 1) {
      const copy = conversations();
      const seeded = await copy.create(USER, 'with the file');
      if (!seeded.ok) fail('conversation');
      await copy.appendTurn({
        conversation: seeded.value,
        userContent: firstQuestion,
        assistant: { content: first.reply, model: 'recorded', inputTokens: 0, outputTokens: 0 },
      });
      const asked = await askOnce(chatDeps(l, learned, doc, copy), question, seeded.value.id);
      runs.push({
        question,
        reply: asked.reply,
        note: asked.note,
        verdict: judgeCoverageExplanation(asked.reply),
      });
      note(
        `${question} #${String(i + 1)}: ${runs.at(-1)?.verdict.invented === true ? 'INVENTED' : 'ok'}`,
      );
    }
  }
  const firstReply = first.reply;
  const firstNote = first.note;
  const record = {
    recordedAt: new Date().toISOString(),
    model: l.requests[0] === undefined ? null : 'default route',
    rulesVersion: DOCUMENT_RULES_VERSION,
    document: { name: doc.file.name, pages: doc.file.pages.length, chars: doc.chars },
    firstQuestion,
    firstReply,
    firstNote,
    runs,
    summary: {
      runs: runs.length,
      invented: runs.filter((r) => r.verdict.invented).length,
      trueReason: runs.filter((r) => r.verdict.trueReason).length,
    },
    costUsd: l.rows.filter((r) => r.provider === 'anthropic').reduce((s, r) => s + r.costUsd, 0),
  };
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(join(FIXTURES, 'why-after.json'), `${JSON.stringify(record, null, 2)}\n`);
  out(record.summary);
}

/**
 * The case for `withdrawn`: the recorded lookup reply about the rate page — the real model's
 * own words, real figures — as the answer given while the page was attached.
 */
function withdrawnCase(): WithdrawnCase {
  const path = resolve(
    import.meta.dirname,
    '..',
    'tests',
    'fixtures',
    'files',
    'lookups',
    'page-comparison-at-85.json',
  );
  const recorded = RECORDED_PROBE.parse(JSON.parse(readFileSync(path, 'utf8')));
  return {
    earlierQuestion: recorded.question,
    earlierReply: recorded.reply,
    topic: 'the comparison rate at 85%',
    quotedFigure: '6.47%',
    fromLink: true,
  };
}

/** One conversation whose history is exactly what the store would hand the handler. */
function seededConversations(history: readonly HistoryMessage[]): ConversationStore {
  const row: ConversationRow = {
    id: CONV_ATTACHED,
    userId: USER,
    scope: 'workspace',
    title: 'rates',
    deletedAt: null,
  };
  return {
    get: () => Promise.resolve(ok(row)),
    create: () => Promise.resolve(ok(row)),
    recentMessages: (_id, limit) => Promise.resolve(ok(history.slice(-limit))),
    appendTurn: () =>
      Promise.resolve(
        ok({ userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID() }),
      ),
  };
}

/**
 * A forgotten document speaking from the history (18 Oct 2026): the same follow-ups to the
 * real model, with the earlier reply as said (before) and as withdrawn (after), each reply
 * judged. Saves tests/fixtures/knowledge/withdrawn-before.json and withdrawn-after.json.
 */
async function withdrawnCommand(argv: readonly string[]): Promise<void> {
  const f = flags(argv);
  const l = live();
  const probeCase = withdrawnCase();
  const followUps = withdrawnFollowUps(probeCase);
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
  for (const mode of ['before', 'after'] as const satisfies readonly WithdrawnMode[]) {
    const runs: {
      question: string;
      reply: string;
      requestSha256: string;
      verdict: ReturnType<typeof judgeWithdrawnReply>;
      costUsd: number;
    }[] = [];
    let model: string | null = null;
    for (const question of followUps) {
      for (let i = 0; i < f.runs; i += 1) {
        const deps: ChatDeps = {
          verify: {
            getUserFromToken: () => Promise.resolve(ok({ id: USER, email: STAFF.email })),
            getStaffRow: () => Promise.resolve(ok(STAFF)),
          },
          claude: l.claude,
          conversations: seededConversations(withdrawnProbeHistory(probeCase, mode)),
          log: quiet,
          documents: withdrawnProbeDocuments(probeCase),
        };
        const sent = l.requests.length;
        const result = await handleChatTurn(deps, {
          token: 'terminal',
          message: question,
          conversationId: CONV_ATTACHED,
        });
        if (result.status !== 200)
          fail(`${String(result.status)} ${result.body.error.code}: ${result.body.error.message}`);
        const request = l.requests[sent];
        if (request === undefined) fail('no request was sent');
        model = result.body.model;
        const verdict = judgeWithdrawnReply(result.body.reply, {
          earlierReply: probeCase.earlierReply,
          question,
        });
        runs.push({
          question,
          reply: result.body.reply,
          requestSha256: sha256(requestFingerprintSource(request)),
          verdict,
          costUsd: result.body.costUsd,
        });
        note(
          `${mode} · ${question} #${String(i + 1)}: ${verdict.presentsAsCurrent ? 'PRESENTS AS CURRENT' : 'not current'} · ${verdict.disowns ? 'DISOWNS' : 'owns it'} · ${verdict.withdraws ? 'withdraws' : 'no withdrawal'}`,
        );
      }
    }
    const record = {
      recordedAt: new Date().toISOString(),
      model,
      rulesVersion: {
        documents: DOC_RULES,
        web: WEB_RULES_VERSION,
        withdrawn: WITHDRAWN_RULES_VERSION,
      },
      standInSha256: sha256(WITHDRAWN_REPLY_STAND_IN),
      case: probeCase,
      runs,
      summary: {
        runs: runs.length,
        presentsAsCurrent: runs.filter((r) => r.verdict.presentsAsCurrent).length,
        disowns: runs.filter((r) => r.verdict.disowns).length,
        withdraws: runs.filter((r) => r.verdict.withdraws).length,
      },
      costUsd: runs.reduce((s, r) => s + r.costUsd, 0),
    };
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(join(FIXTURES, `withdrawn-${mode}.json`), `${JSON.stringify(record, null, 2)}\n`);
    out({ mode, ...record.summary, costUsd: record.costUsd });
  }
}

/** The nearest chunks to each question, with their similarity — what the floor is set from. */
async function scoresCommand(argv: readonly string[]): Promise<void> {
  const f = flags(argv);
  const [path, ...questions] = f.positional;
  if (path === undefined || questions.length === 0)
    fail('usage: npm run knowledge -- scores <file> "<q>"… [--cache <file>]');
  const doc = await readDocument(path);
  const l = live(openCache(f.cache));
  const learned = await learn(doc, l);
  const results: unknown[] = [];
  const names = await learned.store.recentNames(MAX_QUERY_NAMES);
  for (const question of questions) {
    // --rewrite: the search text the turn would embed (knowledge/query.ts), as typed otherwise.
    const searched = f.rewrite
      ? await searchTextFor(
          { claude: l.claude, log: quiet, timeoutMs: l.knowledge.retrieval.rewriteTimeoutMs },
          {
            message: question,
            previousUserMessage: null,
            documentNames: names.ok ? names.value : [],
            userId: USER,
            conversationId: null,
          },
          question,
        )
      : { text: question, outcome: 'skipped' as const };
    const key = cacheKey('query', searched.text);
    if (!l.cache.vectors.has(key)) await sleep(21_000); // three a minute
    const embedded = await l.queryEmbedder.embed({
      texts: [searched.text],
      inputType: 'query',
      operation: 'knowledge.scores',
      userId: null,
      conversationId: null,
    });
    if (!embedded.ok) fail(`${question}: ${embedded.error.message}`);
    const vector = embedded.value.vectors[0] ?? [];
    const found = await learned.store.match(vector, {
      userId: USER,
      attachedFileIds: [],
      excludeFileIds: [],
      includeLearned: true,
      sections: sectionsNamedIn(searched.text),
      limit: 8,
      minSimilarity: 0,
      attachedMinSimilarity: 0,
    });
    if (!found.ok) fail('match');
    results.push({
      question,
      searched: searched.text,
      rewrite: searched.outcome,
      top: found.value.map((c) => ({
        page: c.pageNo,
        ordinal: c.ordinal,
        similarity: Number(c.similarity.toFixed(3)),
        named: c.named,
      })),
    });
  }
  out(results);
}

async function recordCommand(): Promise<void> {
  const l = live();
  const dir = join(FIXTURES, 'recorded');
  mkdirSync(dir, { recursive: true });
  const verdicts: unknown[] = [];
  for (const probe of KNOWLEDGE_INJECTION_PROBES) {
    for (const mode of ['protected', 'unprotected'] as const) {
      const request =
        mode === 'protected'
          ? knowledgeProbeRequest(probe).request
          : unprotectedKnowledgeRequest(probe);
      const completed = await l.claude.complete(request);
      if (!completed.ok) fail(`${probe.id}: ${completed.error.message}`);
      const recorded = {
        id: probe.id,
        mode,
        recordedAt: new Date().toISOString(),
        model: completed.value.model,
        rulesVersion: DOCUMENT_RULES_VERSION,
        requestSha256: createHash('sha256').update(requestFingerprintSource(request)).digest('hex'),
        reply: completed.value.text,
        stopReason: completed.value.stopReason,
        usage: completed.value.usage,
        costUsd: completed.value.costUsd,
      };
      writeFileSync(
        join(dir, `${probe.id}.${mode}.json`),
        `${JSON.stringify(recorded, null, 2)}\n`,
      );
      verdicts.push({
        id: probe.id,
        mode,
        verdict: judgeReply(completed.value.text, probe),
        costUsd: completed.value.costUsd,
      });
    }
  }
  out(verdicts);
}

async function main(): Promise<void> {
  loadEnv();
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'chunk':
      await chunkCommand(rest[0]);
      return;
    case 'ask':
      await askCommand(rest);
      return;
    case 'why':
      await whyCommand(rest);
      return;
    case 'record':
      await recordCommand();
      return;
    case 'scores':
      await scoresCommand(rest);
      return;
    case 'withdrawn':
      await withdrawnCommand(rest);
      return;
    case undefined:
    default:
      fail(
        'commands: chunk <file> | ask <file> "<question>" [--then "<q>"]… [--fresh] [--cache <file>] | why <file> [--runs N] [--cache <file>] | scores <file> "<q>"… [--rewrite] [--cache <file>] | record | withdrawn [--runs N]',
      );
  }
}

await main();
