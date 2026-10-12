/**
 * The calls the browser makes to attach a file (Milestone 5 part 1): POSTs to our files
 * endpoint. The LIST of a conversation's files is a PostgREST select under RLS as the
 * signed-in person (see supabase.ts); everything that changes anything goes through here.
 *
 * What is sent is never the file. The browser reads it (web/src/lib/files) and sends text,
 * page by page — or, for a photo or a scanned page, one JPEG of that page.
 *
 * Pure where it can be — request shapes, response reading, plain-language messages — so what
 * a person sees when an upload is refused or fails is unit-tested without a browser, exactly
 * as crmApi.ts and memoryApi.ts are. The server's own sentence is kept wherever it sent one:
 * they are written for the person holding the phone (src/lib/files/page.ts).
 */
import {
  isRefusalCode,
  type FileKind,
  type Legibility,
  type RefusalCode,
} from '../../../src/lib/files/limits.js';

/** A file as the interface shows it — the columns the browser may read. No text, ever. */
export interface AttachedFile {
  readonly id: string;
  readonly conversationId: string;
  readonly uploadedBy: string;
  /** Null once removed. */
  readonly name: string | null;
  readonly kind: FileKind;
  readonly byteSize: number;
  readonly pageCount: number;
  readonly visionPages: number;
  readonly status: 'ready' | 'removed';
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface VisionEstimate {
  readonly pages: number;
  readonly perPageUsd: number;
  readonly estimateUsd: number;
  readonly dailyCapUsd: number;
  readonly spentTodayUsd: number;
  readonly affordable: boolean;
}

export type FilesRequest =
  | { readonly action: 'estimate'; readonly visionPages: number }
  | {
      readonly action: 'begin';
      readonly requestId: string;
      readonly conversationId: string | null;
      readonly name: string;
      readonly kind: FileKind;
      readonly byteSize: number;
      readonly contentHash: string;
      readonly totalPages: number;
      readonly visionPages: number;
      readonly extractMs: number;
    }
  | {
      readonly action: 'append';
      readonly fileId: string;
      readonly pages: readonly {
        readonly pageNo: number;
        readonly label: string;
        readonly text: string;
      }[];
    }
  | {
      readonly action: 'read_page';
      readonly fileId: string;
      readonly pageNo: number;
      readonly label: string;
      readonly imageBase64: string;
    }
  | { readonly action: 'finish'; readonly fileId: string }
  | { readonly action: 'remove'; readonly fileId: string }
  | {
      readonly action: 'refused';
      readonly kind: FileKind | null;
      readonly byteSize: number;
      readonly reason: RefusalCode;
      readonly extractMs: number;
    };

export interface BeginReply {
  readonly action: 'begin';
  readonly fileId: string;
  readonly conversationId: string;
  readonly status: 'reading' | 'ready' | 'removed';
  readonly duplicate: boolean;
  readonly pagesStored: readonly number[];
}

export interface ReadPageReply {
  readonly action: 'read_page';
  readonly pageNo: number;
  readonly legibility: Legibility;
  readonly pageKind: 'document' | 'photo' | 'blank' | null;
}

export interface FinishReply {
  readonly action: 'finish';
  readonly duplicate: boolean;
  readonly file: AttachedFile;
}

export type FilesReply =
  | ({ readonly action: 'estimate' } & VisionEstimate)
  | BeginReply
  | { readonly action: 'append'; readonly stored: number }
  | ReadPageReply
  | FinishReply
  | { readonly action: 'remove'; readonly removed: boolean }
  | { readonly action: 'refused' };

export type ReplyFor<A extends FilesRequest['action']> = Extract<FilesReply, { action: A }>;

export type FilesFailureKind =
  /** Sign in again. */
  | 'unauthenticated'
  /** The account is not allowed in, or may not do this. */
  | 'forbidden'
  /** The FILE was refused: the sentence says why and what to do. Retrying will not help. */
  | 'refused'
  /** The budget refused the call before anything was sent. */
  | 'cap'
  /** Try again; an upload resumes where it stopped. */
  | 'retryable'
  /** Retrying will not help. */
  | 'fatal';

export interface FilesFailure {
  readonly kind: 'error';
  readonly failure: FilesFailureKind;
  /** Plain words, written for the person holding the phone. */
  readonly message: string;
  readonly code: string;
  readonly status: number | null;
  readonly refusal?: RefusalCode;
}

export type FilesOutcome<R> = { readonly kind: 'ok'; readonly reply: R } | FilesFailure;

export const FILES_CLIENT_TIMEOUT_MS = 60_000;
/** One page read by the model: the server allows it 60 s of silence, twice (one retry). */
export const FILES_READ_PAGE_TIMEOUT_MS = 150_000;

export const FILES_API_MESSAGES = {
  sessionExpired: 'Your session has expired. Sign in again, then attach the file again.',
  forbidden: 'This account does not have access.',
  network: "Couldn't reach the Command Centre. Check your connection and try again.",
  timeout: 'That took too long. Nothing was attached. Try again.',
  unknown: 'Something went wrong on our side. Nothing was attached. Try again.',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function failure(
  kind: FilesFailureKind,
  message: string,
  code: string,
  status: number | null,
  refusal?: RefusalCode,
): FilesFailure {
  return {
    kind: 'error',
    failure: kind,
    message,
    code,
    status,
    ...(refusal === undefined ? {} : { refusal }),
  };
}

function isFileView(value: unknown): value is AttachedFile {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['conversationId'] === 'string' &&
    typeof value['kind'] === 'string' &&
    typeof value['byteSize'] === 'number' &&
    typeof value['pageCount'] === 'number' &&
    (value['status'] === 'ready' || value['status'] === 'removed')
  );
}

/** Is this body the reply the action promised? A 200 with the wrong shape is not a success. */
function readReply<A extends FilesRequest['action']>(action: A, body: unknown): ReplyFor<A> | null {
  if (!isRecord(body) || body['action'] !== action) return null;
  // The fields the upload queue acts on. A reply missing one is treated as no reply.
  const complete: Readonly<Record<FilesRequest['action'], boolean>> = {
    estimate: typeof body['estimateUsd'] === 'number' && typeof body['affordable'] === 'boolean',
    begin:
      typeof body['fileId'] === 'string' &&
      typeof body['conversationId'] === 'string' &&
      Array.isArray(body['pagesStored']),
    append: true,
    read_page: typeof body['pageNo'] === 'number',
    finish: isFileView(body['file']),
    remove: true,
    refused: true,
  };
  return complete[action] ? (body as ReplyFor<A>) : null;
}

/**
 * Turn an HTTP status and body into what the interface should do. Wherever the server sent a
 * sentence it is used as written; the words chosen here cover what the server could not say
 * (it was never reached) or would not (a 401 is the same sentence everywhere in the app).
 */
export function interpretFilesResponse<A extends FilesRequest['action']>(
  action: A,
  status: number,
  body: unknown,
): FilesOutcome<ReplyFor<A>> {
  if (status === 200) {
    const reply = readReply(action, body);
    return reply === null
      ? failure('retryable', FILES_API_MESSAGES.unknown, 'BAD_RESPONSE', status)
      : { kind: 'ok', reply };
  }
  const error = isRecord(body) && isRecord(body['error']) ? body['error'] : null;
  const code = typeof error?.['code'] === 'string' ? error['code'] : `HTTP_${String(status)}`;
  const said = typeof error?.['message'] === 'string' ? error['message'] : null;
  const refusal = isRefusalCode(error?.['refusal']) ? error['refusal'] : undefined;
  const retryable = error?.['retryable'] === true;
  switch (status) {
    case 401:
      return failure('unauthenticated', FILES_API_MESSAGES.sessionExpired, code, status);
    case 403:
      return failure('forbidden', said ?? FILES_API_MESSAGES.forbidden, code, status);
    case 402:
      return failure('cap', said ?? FILES_API_MESSAGES.unknown, code, status);
    case 422:
      return failure('refused', said ?? FILES_API_MESSAGES.unknown, code, status, refusal);
    case 400:
    case 404:
      return failure('fatal', said ?? FILES_API_MESSAGES.unknown, code, status);
    default:
      return failure(
        retryable || status >= 500 || status === 429 || status === 409 ? 'retryable' : 'fatal',
        said ?? FILES_API_MESSAGES.unknown,
        code,
        status,
      );
  }
}

export interface FilesDeps {
  readonly filesUrl: string;
  readonly anonKey: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

/** One call. Never throws: a transport failure is a retryable outcome. */
export async function callFiles<R extends FilesRequest>(
  deps: FilesDeps,
  accessToken: string,
  request: R,
  signal?: AbortSignal,
): Promise<FilesOutcome<ReplyFor<R['action']>>> {
  const controller = new AbortController();
  const limit =
    deps.timeoutMs ??
    (request.action === 'read_page' ? FILES_READ_PAGE_TIMEOUT_MS : FILES_CLIENT_TIMEOUT_MS);
  // A holder, not a `let`: an assignment inside the callback is invisible to narrowing.
  const clock = { timedOut: false };
  const timer = setTimeout(() => {
    clock.timedOut = true;
    controller.abort();
  }, limit);
  const onAbort = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', onAbort);
  try {
    const response = await deps.fetch(deps.filesUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        apikey: deps.anonKey,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return interpretFilesResponse<R['action']>(request.action, response.status, body);
  } catch {
    return failure(
      'retryable',
      clock.timedOut ? FILES_API_MESSAGES.timeout : FILES_API_MESSAGES.network,
      clock.timedOut ? 'CLIENT_TIMEOUT' : 'NETWORK',
      null,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * A row of `conversation_files` as PostgREST returns it. A type alias, not an interface:
 * supabase-js matches the schema structurally and an interface here collapses every query
 * result in the app to `never` (see WebDatabase in supabase.ts).
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see above
export type ConversationFileRow = {
  id: string;
  conversation_id: string;
  uploaded_by: string;
  name: string | null;
  kind: string;
  byte_size: number;
  page_count: number;
  vision_pages: number;
  status: string;
  created_at: string;
  expires_at: string;
};

export const CONVERSATION_FILE_COLUMNS =
  'id, conversation_id, uploaded_by, name, kind, byte_size, page_count, vision_pages, status, created_at, expires_at';

const KINDS: readonly string[] = ['pdf', 'docx', 'xlsx', 'csv', 'text', 'image'];

/** Rows → files, dropping anything that is not a ready or removed file of a known kind. */
export function toAttachedFiles(rows: readonly ConversationFileRow[]): readonly AttachedFile[] {
  const out: AttachedFile[] = [];
  for (const row of rows) {
    if ((row.status !== 'ready' && row.status !== 'removed') || !KINDS.includes(row.kind)) continue;
    out.push({
      id: row.id,
      conversationId: row.conversation_id,
      uploadedBy: row.uploaded_by,
      name: row.name,
      kind: row.kind as FileKind,
      byteSize: row.byte_size,
      pageCount: row.page_count,
      visionPages: row.vision_pages,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    });
  }
  return out;
}
