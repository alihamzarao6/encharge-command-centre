/**
 * Fakes for the files unit tests: a verified caller, a scripted Claude, a conversation store,
 * and an in-memory file store that behaves as migration 20261012010000's functions do — the
 * same refusals for the same reasons — so the endpoint's handling of each database answer is
 * tested without a database. The functions themselves are tested on a stack
 * (tests/integration/files.test.ts).
 *
 * Milestone 5 part 2: the store also keeps the server's record of each page fetch, as
 * migration 20261012020000 does — the per-person limit, the per-host gap, an attachment
 * checked against the bytes that were fetched, an older read of the same address replaced —
 * and the harness has a scripted page fetcher in place of the network.
 */
import type { AuthTokenUser, StaffRow, VerifyDeps } from '../../../src/lib/auth/verify.js';
import { AppError, err, ok, type Result } from '../../../src/lib/errors.js';
import type { FilesConfig } from '../../../src/lib/files/config.js';
import { FILES_DEFAULTS } from '../../../src/lib/files/config.js';
import type { TurnFile } from '../../../src/lib/files/context.js';
import { FILE_LIMITS } from '../../../src/lib/files/limits.js';
import type { FilesPageDeps } from '../../../src/lib/files/page.js';
import type {
  BeginFileInput,
  BeginFileResult,
  ClaimFetchResult,
  DriveReadReceipt,
  FetchReceipt,
  FinishFileResult,
  FileRecord,
  FileStore,
  FileStoreReason,
  PageInsert,
} from '../../../src/lib/files/store.js';
import type { ConversationRow, ConversationStore } from '../../../src/lib/llm/chat.js';
import type {
  ChatMessage,
  ClaudeClient,
  Completion,
  CompletionRequest,
  LlmError,
} from '../../../src/lib/llm/client.js';
import { DEFAULT_PRICING } from '../../../src/lib/llm/pricing.js';
import type { Logger } from '../../../src/lib/logger.js';
import type { PageFetchResult, PageFetcher } from '../../../src/lib/pages/fetch.js';
import { parsePublicUrl } from '../../../src/lib/pages/guard.js';
import { NOT_LOADED_MARK, READ_AS_SENT_MARK } from '../../../src/lib/pages/limits.js';

export const USER_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_ID = '22222222-2222-4222-8222-222222222222';
export const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
export const CONV_ID = 'c0000000-0000-4000-8000-000000000001';
export const PRIVATE_CONV_ID = 'c0000000-0000-4000-8000-000000000002';
export const NOW = new Date('2026-10-12T04:00:00Z');

/** Strings that must never appear in a log line, an error message or an audit field. */
export const CANARY_TEXT = 'CANARY-CONTENT-7f3a91-net-pay-2887';
export const CANARY_NAME = 'Sample-Person-CANARY-NAME-41c2.pdf';

export const HASH = (digit: string): string => digit.repeat(64);

/** Every text block of a message, joined — or the message itself when it is a plain string. */
export function textOfMessage(content: ChatMessage['content'] | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

let sequence = 0;
export function uuid(): string {
  sequence += 1;
  return `f0000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

export function verifyAs(
  userId: string | null,
  options: { isAdmin?: boolean; isActive?: boolean; allowlisted?: boolean } = {},
): VerifyDeps {
  const user: Result<AuthTokenUser | null> = ok(
    userId === null ? null : { id: userId, email: `${userId.slice(0, 4)}@example.test` },
  );
  const row: StaffRow | null =
    userId === null || options.allowlisted === false
      ? null
      : {
          user_id: userId,
          email: `${userId.slice(0, 4)}@example.test`,
          role: 'staff',
          is_active: options.isActive ?? true,
          is_admin: options.isAdmin ?? false,
        };
  return {
    getUserFromToken: () => Promise.resolve(user),
    getStaffRow: () => Promise.resolve(ok(row)),
  };
}

export function completion(text: string, overrides: Partial<Completion> = {}): Completion {
  return {
    text,
    model: 'claude-sonnet-5',
    stopReason: 'end_turn',
    usage: { inputTokens: 5000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0.021,
    requestId: 'req_test',
    attempts: 1,
    ...overrides,
  };
}

export interface ScriptedClaude extends ClaudeClient {
  readonly calls: CompletionRequest[];
  readonly queue: Result<Completion, LlmError>[];
}

/** Answers from a queue, in order; when the queue is empty, repeats `fallback`. */
export function scriptedClaude(
  fallback: Result<Completion, LlmError> = ok(
    completion('KIND: document\nLEGIBILITY: full\n---\nA page.'),
  ),
): ScriptedClaude {
  const calls: CompletionRequest[] = [];
  const queue: Result<Completion, LlmError>[] = [];
  const answer = (request: CompletionRequest): Promise<Result<Completion, LlmError>> => {
    calls.push(request);
    return Promise.resolve(queue.shift() ?? fallback);
  };
  return { calls, queue, complete: answer, stream: (request) => answer(request) };
}

export interface FakeConversations extends Pick<ConversationStore, 'get' | 'create'> {
  readonly rows: Map<string, ConversationRow>;
  readonly created: string[];
  fail: AppError | null;
}

export function fakeConversations(): FakeConversations {
  const rows = new Map<string, ConversationRow>([
    [
      CONV_ID,
      { id: CONV_ID, userId: USER_ID, scope: 'workspace', title: 'shared', deletedAt: null },
    ],
    [
      PRIVATE_CONV_ID,
      { id: PRIVATE_CONV_ID, userId: OTHER_ID, scope: 'user', title: 'private', deletedAt: null },
    ],
  ]);
  const store: FakeConversations = {
    rows,
    created: [],
    fail: null,
    get: (id) => Promise.resolve(store.fail === null ? ok(rows.get(id) ?? null) : err(store.fail)),
    create: (userId, title) => {
      if (store.fail !== null) return Promise.resolve(err(store.fail));
      const row: ConversationRow = {
        id: uuid(),
        userId,
        scope: 'workspace',
        title,
        deletedAt: null,
      };
      rows.set(row.id, row);
      store.created.push(row.id);
      return Promise.resolve(ok(row));
    },
  };
  return store;
}

interface StoredFile {
  record: FileRecord;
  requestId: string;
  contentHash: string | null;
  pages: Map<number, PageInsert>;
  removedReason?: 'user' | 'replaced';
}

/** A row of `web_fetches`, as the store keeps it. */
export interface StoredFetch extends FetchReceipt {
  readonly requestedHost: string;
  readonly createdAt: number;
  readonly outcome: string | null;
}

export interface MemoryFileStore extends FileStore {
  readonly files: Map<string, StoredFile>;
  readonly fetches: Map<string, StoredFetch>;
  /** Milestone 5 part 3a: `drive_reads`, as the drive endpoint leaves it. */
  readonly driveReads: Map<string, DriveReadReceipt>;
  /** Fail the next call of a method with this error, once. */
  readonly failOnce: Map<keyof FileStore, AppError>;
  readonly calls: string[];
  everHadFile: boolean;
  textOf(fileId: string): string;
}

function refused(reason: FileStoreReason): AppError {
  return new AppError('CONFLICT', `test store: ${reason}`, { context: { reason } });
}

export function memoryFileStore(
  conversations: FakeConversations,
  now: () => Date = () => NOW,
): MemoryFileStore {
  const files = new Map<string, StoredFile>();
  const fetches = new Map<string, StoredFetch>();
  const driveReads = new Map<string, DriveReadReceipt>();
  const failOnce = new Map<keyof FileStore, AppError>();
  const calls: string[] = [];
  const gate = <T>(method: keyof FileStore, run: () => Result<T>): Promise<Result<T>> => {
    calls.push(method);
    const planned = failOnce.get(method);
    if (planned !== undefined) {
      failOnce.delete(method);
      return Promise.resolve(err(planned));
    }
    return Promise.resolve(run());
  };
  const live = (conversationId: string): StoredFile[] =>
    [...files.values()].filter(
      (f) => f.record.conversationId === conversationId && f.record.status !== 'removed',
    );

  const store: MemoryFileStore = {
    files,
    fetches,
    driveReads,
    failOnce,
    calls,
    everHadFile: false,
    textOf: (fileId) =>
      [...(files.get(fileId)?.pages.values() ?? [])].map((page) => page.content).join('\n'),

    begin: (input: BeginFileInput) =>
      gate('begin', (): Result<BeginFileResult> => {
        const conversation = conversations.rows.get(input.conversationId);
        if (conversation === undefined) return err(refused('not_found'));
        if (conversation.deletedAt !== null) return err(refused('not_found'));
        const replay = [...files.values()].find((f) => f.requestId === input.requestId);
        if (replay !== undefined) {
          return ok({
            id: replay.record.id,
            status: replay.record.status,
            existing: true,
            duplicate: false,
            expectedPages: replay.record.expectedPages,
            pagesStored: [...replay.pages.keys()].sort((a, b) => a - b),
          });
        }
        // From a link: only against the server's own record of those bytes (FL007).
        const receipt = input.fetchId === undefined ? null : (fetches.get(input.fetchId) ?? null);
        // From Drive: the same, against the record of the read (migration 20261016010000).
        const drive =
          input.driveReadId === undefined ? null : (driveReads.get(input.driveReadId) ?? null);
        if (input.fetchId !== undefined && input.driveReadId !== undefined) {
          return err(refused('bad_receipt'));
        }
        if (input.driveReadId !== undefined) {
          const fetchedAt = drive?.fetchedAt ?? null;
          const fresh =
            fetchedAt !== null &&
            now().getTime() - Date.parse(fetchedAt) < FILE_LIMITS.abandonedAfterMinutes * 60_000;
          if (
            drive?.userId !== input.uploadedBy ||
            drive.status !== 'fetched' ||
            !fresh ||
            drive.contentHash !== input.contentHash ||
            drive.byteSize !== input.byteSize ||
            input.kind === 'html'
          ) {
            return err(refused('bad_receipt'));
          }
        } else if (input.fetchId !== undefined) {
          const fetchedAt = receipt?.fetchedAt ?? null;
          const fresh =
            fetchedAt !== null &&
            now().getTime() - Date.parse(fetchedAt) < FILE_LIMITS.abandonedAfterMinutes * 60_000;
          if (
            receipt?.userId !== input.uploadedBy ||
            receipt.status !== 'fetched' ||
            !fresh ||
            receipt.contentHash !== input.contentHash ||
            receipt.byteSize !== input.byteSize
          ) {
            return err(refused('bad_receipt'));
          }
        } else if (input.kind === 'html') {
          return err(refused('bad_receipt'));
        }
        const same = live(input.conversationId).find(
          (f) => f.contentHash === input.contentHash && f.record.status === 'ready',
        );
        if (same !== undefined) {
          const readAt = receipt?.fetchedAt ?? drive?.fetchedAt ?? null;
          if (readAt !== null && same.record.sourceUrl !== null) {
            // Asked again and the same bytes came back: current as of this read — and a Drive
            // file takes the name Drive gives it now.
            same.record = {
              ...same.record,
              fetchedAt: readAt,
              expiresAt: new Date(now().getTime() + input.retentionDays * 86_400_000).toISOString(),
              name:
                drive !== null && same.record.driveFileId === drive.driveFileId
                  ? drive.name
                  : same.record.name,
            };
          }
          return ok({
            id: same.record.id,
            status: 'ready',
            existing: true,
            duplicate: true,
            expectedPages: same.record.expectedPages,
            pagesStored: [],
          });
        }
        for (const [id, f] of files) {
          if (
            f.record.conversationId === input.conversationId &&
            f.record.status === 'reading' &&
            f.record.uploadedBy === input.uploadedBy &&
            f.contentHash === input.contentHash
          ) {
            files.delete(id);
          }
        }
        if (live(input.conversationId).length >= FILE_LIMITS.maxFilesPerConversation) {
          return err(refused('too_many_files'));
        }
        const id = uuid();
        const created = now();
        files.set(id, {
          requestId: input.requestId,
          contentHash: input.contentHash,
          pages: new Map(),
          record: {
            id,
            conversationId: input.conversationId,
            uploadedBy: input.uploadedBy,
            name: drive === null ? input.name : drive.name,
            kind: input.kind,
            byteSize: input.byteSize,
            pageCount: 0,
            charCount: 0,
            visionPages: input.visionPages,
            status: 'reading',
            createdAt: created.toISOString(),
            expiresAt: new Date(created.getTime() + input.retentionDays * 86_400_000).toISOString(),
            sourceUrl:
              drive === null
                ? (receipt?.finalUrl ?? null)
                : `https://drive.google.com/file/d/${drive.driveFileId}/view`,
            sourceHost: drive === null ? (receipt?.finalHost ?? null) : 'drive.google.com',
            fetchedAt: drive === null ? (receipt?.fetchedAt ?? null) : drive.fetchedAt,
            valuesMissing: 0,
            readAsSent: false,
            driveFileId: drive?.driveFileId ?? null,
            expectedPages: input.expectedPages,
            conversationAuthorId: conversation.userId,
            scope: conversation.scope,
          },
        });
        store.everHadFile = true;
        return ok({
          id,
          status: 'reading',
          existing: false,
          duplicate: false,
          expectedPages: input.expectedPages,
          pagesStored: [],
        });
      }),

    get: (fileId) => gate('get', () => ok(files.get(fileId)?.record ?? null)),

    appendPages: (fileId, pages) =>
      gate('appendPages', () => {
        const file = files.get(fileId);
        if (file === undefined) return err(refused('not_found'));
        if (file.record.status !== 'reading') return err(refused('not_reading'));
        if (pages.some((page) => page.pageNo < 1 || page.pageNo > file.record.expectedPages)) {
          return err(refused('page_out_of_range'));
        }
        for (const page of pages) file.pages.set(page.pageNo, page);
        return ok(file.pages.size);
      }),

    pageInfo: (fileId, pageNo) =>
      gate('pageInfo', () => {
        const page = files.get(fileId)?.pages.get(pageNo);
        return ok(
          page === undefined
            ? null
            : {
                pageNo,
                method: page.method,
                legibility: page.legibility,
                chars: page.content.length,
                letterCount: page.letterCount,
              },
        );
      }),

    visionPagesStored: (fileId) =>
      gate('visionPagesStored', () =>
        ok(
          [...(files.get(fileId)?.pages.values() ?? [])].filter(
            (page) => page.method === 'claude_vision',
          ).length,
        ),
      ),

    finish: (fileId) =>
      gate('finish', (): Result<FinishFileResult> => {
        const file = files.get(fileId);
        if (file === undefined) return err(refused('not_found'));
        const { record } = file;
        const pages = [...file.pages.values()];
        const view = {
          id: record.id,
          pageCount: record.pageCount,
          charCount: record.charCount,
          visionPages: record.visionPages,
        };
        if (record.status === 'ready') {
          return ok({ ...view, duplicate: false, already: true, replaced: 0 });
        }
        if (record.status !== 'reading') return err(refused('not_reading'));
        if (pages.length !== record.expectedPages) return err(refused('incomplete'));
        if (pages.reduce((sum, page) => sum + page.letterCount, 0) === 0)
          return err(refused('no_text'));
        const chars = pages.reduce((sum, page) => sum + page.content.length, 0);
        if (chars > FILE_LIMITS.maxFileChars) return err(refused('too_long'));
        file.record = {
          ...record,
          status: 'ready',
          pageCount: pages.length,
          charCount: chars,
          visionPages: pages.filter((page) => page.method === 'claude_vision').length,
          valuesMissing: pages.reduce(
            (sum, page) => sum + (page.content.split(NOT_LOADED_MARK).length - 1),
            0,
          ),
          // As finish_conversation_file does: the reader's own line, found in the stored text.
          readAsSent: pages.some((page) => page.content.includes(READ_AS_SENT_MARK)),
        };
        // An older read of the same address, in this conversation, goes now.
        let replaced = 0;
        if (record.sourceUrl !== null) {
          for (const other of files.values()) {
            if (
              other.record.id !== record.id &&
              other.record.conversationId === record.conversationId &&
              other.record.status === 'ready' &&
              other.record.sourceUrl === record.sourceUrl
            ) {
              other.pages.clear();
              other.contentHash = null;
              other.removedReason = 'replaced';
              other.record = {
                ...other.record,
                status: 'removed',
                name: null,
                sourceUrl: null,
                sourceHost: null,
                fetchedAt: null,
                driveFileId: null,
              };
              replaced += 1;
            }
          }
        }
        return ok({
          id: record.id,
          duplicate: false,
          already: false,
          pageCount: file.record.pageCount,
          charCount: chars,
          visionPages: file.record.visionPages,
          replaced,
        });
      }),

    remove: (fileId) =>
      gate('remove', () => {
        const file = files.get(fileId);
        if (file === undefined || file.record.status === 'removed') return ok(false);
        if (file.record.status === 'reading') {
          files.delete(fileId);
          return ok(true);
        }
        file.pages.clear();
        file.contentHash = null;
        file.removedReason = 'user';
        // The tombstone names nothing — not the address, not the Drive file either.
        file.record = {
          ...file.record,
          status: 'removed',
          name: null,
          sourceUrl: null,
          sourceHost: null,
          fetchedAt: null,
          driveFileId: null,
        };
        return ok(true);
      }),

    purge: () => gate('purge', () => ok({ abandoned: 0, expired: 0 })),

    forTurn: (conversationId) =>
      gate('forTurn', () => {
        const cutoff = now().toISOString();
        const out: TurnFile[] = [];
        for (const file of files.values()) {
          const { record } = file;
          if (
            record.conversationId !== conversationId ||
            record.status !== 'ready' ||
            record.name === null ||
            record.expiresAt <= cutoff
          ) {
            continue;
          }
          out.push({
            id: record.id,
            name: record.name,
            kind: record.kind,
            createdAt: record.createdAt,
            pages: [...file.pages.values()]
              .sort((a, b) => a.pageNo - b.pageNo)
              .map((page) => ({
                pageNo: page.pageNo,
                label: page.label,
                content: page.content,
                method: page.method,
                legibility: page.legibility,
              })),
            ...(record.sourceHost === null ||
            record.fetchedAt === null ||
            record.driveFileId !== null
              ? {}
              : {
                  source: {
                    host: record.sourceHost,
                    fetchedAt: record.fetchedAt,
                    valuesMissing: record.valuesMissing,
                    readAsSent: record.readAsSent,
                  },
                }),
          });
        }
        const everHadPage = [...files.values()].some(
          (file) =>
            file.record.conversationId === conversationId &&
            (file.record.kind === 'html' ||
              (file.record.sourceHost !== null && file.record.driveFileId === null)),
        );
        return ok({ files: out, everHadFile: store.everHadFile, everHadPage });
      }),

    claimFetch: (input) =>
      gate('claimFetch', (): Result<ClaimFetchResult> => {
        const at = now().getTime();
        // One id opens one page, once — whoever the id belongs to.
        if (fetches.has(input.id)) return ok({ claimed: false, spent: true });
        const recent = [...fetches.values()].filter(
          (row) => row.userId === input.userId && at - row.createdAt < 60_000,
        );
        if (recent.length >= input.perMinute) return err(refused('too_many_reads'));
        const last = Math.max(
          -Infinity,
          ...[...fetches.values()]
            .filter((row) => row.requestedHost === input.host || row.finalHost === input.host)
            .map((row) => row.createdAt),
        );
        if (at - last < input.hostGapMs) {
          return ok({ claimed: false, spent: false, waitMs: input.hostGapMs - (at - last) });
        }
        fetches.set(input.id, {
          id: input.id,
          userId: input.userId,
          status: 'started',
          finalUrl: null,
          finalHost: null,
          byteSize: null,
          contentHash: null,
          fetchedAt: null,
          requestedHost: input.host,
          createdAt: at,
          outcome: null,
        });
        return ok({ claimed: true });
      }),

    completeFetch: (input) =>
      gate('completeFetch', () => {
        const row = fetches.get(input.id);
        if (row?.userId !== input.userId) return ok(false);
        fetches.set(input.id, {
          ...row,
          status: input.status,
          outcome: input.outcome,
          finalUrl: input.finalUrl ?? row.finalUrl,
          finalHost: input.finalHost ?? row.finalHost,
          byteSize: input.byteSize ?? row.byteSize,
          contentHash: input.contentHash ?? row.contentHash,
          fetchedAt: input.status === 'fetched' ? now().toISOString() : row.fetchedAt,
        });
        return ok(true);
      }),

    getFetch: (fetchId) => gate('getFetch', () => ok(fetches.get(fetchId) ?? null)),

    getDriveRead: (readId) => gate('getDriveRead', () => ok(driveReads.get(readId) ?? null)),
  };
  return store;
}

/** What the scripted page fetcher answers with for one address. */
export type ScriptedPage =
  | {
      readonly body: string | Uint8Array;
      readonly contentType?: string | null;
      readonly finalUrl?: string;
    }
  | {
      readonly refused: Extract<PageFetchResult, { kind: 'refused' }>['code'];
      readonly detail?: number;
    }
  | { readonly retry: Extract<PageFetchResult, { kind: 'retry' }>['code'] };

export interface ScriptedPages extends PageFetcher {
  /** Addresses asked for, in order. */
  readonly asked: string[];
  readonly routes: Map<string, ScriptedPage>;
}

/**
 * The guarded fetch, scripted. An address is still parsed by the REAL guard (so a test can
 * show the endpoint never reaches the fetcher with a refused address), and then answered
 * from `routes`. An address with no route is a site that could not be reached.
 */
export function scriptedPages(routes: Readonly<Record<string, ScriptedPage>> = {}): ScriptedPages {
  const asked: string[] = [];
  const table = new Map<string, ScriptedPage>(Object.entries(routes));
  return {
    asked,
    routes: table,
    read: (rawUrl) => {
      const parsed = parsePublicUrl(rawUrl);
      const blank = {
        host: parsed.ok ? parsed.url.host : null,
        finalHost: parsed.ok ? parsed.url.host : null,
        hops: 0,
        httpStatus: null as number | null,
        contentType: null as string | null,
        bytes: 0,
        ms: 12,
        hadQuery: parsed.ok ? parsed.url.hasQuery : false,
      };
      if (!parsed.ok) {
        return Promise.resolve({
          ok: false,
          kind: 'refused',
          code: parsed.refusal,
          detail: 0,
          facts: blank,
        });
      }
      asked.push(parsed.url.href);
      const route = table.get(parsed.url.href);
      if (route === undefined) {
        return Promise.resolve({
          ok: false,
          kind: 'retry',
          code: 'site_unreachable',
          facts: blank,
        });
      }
      if ('refused' in route) {
        return Promise.resolve({
          ok: false,
          kind: 'refused',
          code: route.refused,
          detail: route.detail ?? 0,
          facts: { ...blank, httpStatus: 404 },
        });
      }
      if ('retry' in route) {
        return Promise.resolve({ ok: false, kind: 'retry', code: route.retry, facts: blank });
      }
      const bytes =
        typeof route.body === 'string' ? new TextEncoder().encode(route.body) : route.body;
      const final = route.finalUrl === undefined ? parsed : parsePublicUrl(route.finalUrl);
      if (!final.ok) throw new Error('scriptedPages: finalUrl must be a public address');
      const contentType =
        route.contentType === undefined ? 'text/html; charset=utf-8' : route.contentType;
      return Promise.resolve({
        ok: true,
        page: { requested: parsed.url, final: final.url, contentType, bytes },
        facts: {
          ...blank,
          finalHost: final.url.host,
          hops: final.url.href === parsed.url.href ? 0 : 1,
          httpStatus: 200,
          contentType,
          bytes: bytes.length,
        },
      });
    },
  };
}

export const TEST_FILES_CONFIG: FilesConfig = { ...FILES_DEFAULTS };

export interface Harness {
  readonly deps: FilesPageDeps;
  readonly pages: ScriptedPages;
  /** Every pause the endpoint asked for, in milliseconds. */
  readonly slept: number[];
  /** The time the endpoint and the store both see. A pause moves it forward. */
  readonly clock: { at: number };
  readonly claude: ScriptedClaude;
  readonly conversations: FakeConversations;
  readonly files: MemoryFileStore;
  spent: { day: number; month: number };
  failSpent: AppError | null;
}

export function harness(
  log: Logger,
  options: {
    userId?: string | null;
    isAdmin?: boolean;
    isActive?: boolean;
    allowlisted?: boolean;
  } = {},
): Harness {
  const conversations = fakeConversations();
  const clock = { at: NOW.getTime() };
  const files = memoryFileStore(conversations, () => new Date(clock.at));
  const claude = scriptedClaude();
  const pages = scriptedPages();
  const slept: number[] = [];
  const h: Harness = {
    pages,
    slept,
    clock,
    claude,
    conversations,
    files,
    spent: { day: 0, month: 0 },
    failSpent: null,
    deps: {
      verify: verifyAs(options.userId === undefined ? USER_ID : options.userId, options),
      conversations,
      files,
      vision: { claude, route: 'default', maxTokens: 4096, log },
      usage: {
        spentSince: (_provider, since) => {
          if (h.failSpent !== null) return Promise.resolve(err(h.failSpent));
          return Promise.resolve(ok(since.getUTCDate() === 1 ? h.spent.month : h.spent.day));
        },
      },
      caps: { dailyUsd: 5, monthlyUsd: 50, warnFraction: 0.8 },
      visionPricing: DEFAULT_PRICING['claude-sonnet-5'] ?? {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheWritePerMTok: 3.75,
        cacheReadPerMTok: 0.3,
      },
      config: TEST_FILES_CONFIG,
      pages,
      sleep: (ms) => {
        slept.push(ms);
        clock.at += ms;
        return Promise.resolve();
      },
      log,
      now: () => new Date(clock.at),
    },
  };
  return h;
}

/** A plausible JPEG as base64: the right prefix, valid characters, long enough. */
export const JPEG_BASE64 = `/9j/${'A'.repeat(400)}`;
