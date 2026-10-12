/**
 * Fakes for the files unit tests: a verified caller, a scripted Claude, a conversation store,
 * and an in-memory file store that behaves as migration 20261012010000's functions do — the
 * same refusals for the same reasons — so the endpoint's handling of each database answer is
 * tested without a database. The functions themselves are tested on a stack
 * (tests/integration/files.test.ts).
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
}

export interface MemoryFileStore extends FileStore {
  readonly files: Map<string, StoredFile>;
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
        const same = live(input.conversationId).find(
          (f) => f.contentHash === input.contentHash && f.record.status === 'ready',
        );
        if (same !== undefined) {
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
            name: input.name,
            kind: input.kind,
            byteSize: input.byteSize,
            pageCount: 0,
            charCount: 0,
            visionPages: input.visionPages,
            status: 'reading',
            createdAt: created.toISOString(),
            expiresAt: new Date(created.getTime() + input.retentionDays * 86_400_000).toISOString(),
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
        if (record.status === 'ready') return ok({ ...view, duplicate: false, already: true });
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
        };
        return ok({
          id: record.id,
          duplicate: false,
          already: false,
          pageCount: file.record.pageCount,
          charCount: chars,
          visionPages: file.record.visionPages,
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
        file.record = { ...file.record, status: 'removed', name: null };
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
          });
        }
        return ok({ files: out, everHadFile: store.everHadFile });
      }),
  };
  return store;
}

export const TEST_FILES_CONFIG: FilesConfig = { ...FILES_DEFAULTS };

export interface Harness {
  readonly deps: FilesPageDeps;
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
  const files = memoryFileStore(conversations);
  const claude = scriptedClaude();
  const h: Harness = {
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
      log,
      now: () => NOW,
    },
  };
  return h;
}

/** A plausible JPEG as base64: the right prefix, valid characters, long enough. */
export const JPEG_BASE64 = `/9j/${'A'.repeat(400)}`;
