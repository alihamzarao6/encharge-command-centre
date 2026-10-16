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
 *
 * Milestone 5 part 2 adds `fetchPage`: ask OUR server to fetch a web page the person pointed
 * at, and take delivery of its bytes. The browser never contacts the site. The reply is the
 * one in this file that is not JSON — the page's bytes, with what the server measured about
 * them in a header — and it is checked before it is believed: the length and the SHA-256 the
 * server reported must be the length and the SHA-256 of what arrived.
 */
import {
  isRefusalCode,
  type FileKind,
  type Legibility,
  type RefusalCode,
} from '../../../src/lib/files/limits.js';
import { PAGE_META_HEADER, decodePageMeta } from '../../../src/lib/files/meta.js';
import { READ_REGION } from '../../../src/lib/pages/limits.js';

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
  /** From a link: the address read, its host and when. All null for an uploaded file. */
  readonly sourceUrl: string | null;
  readonly sourceHost: string | null;
  readonly fetchedAt: string | null;
  /** Figures the page left for a script to fill in, found empty. */
  readonly valuesMissing: number;
  /** The page shows nothing until its scripts run, and was read as the site sent it. */
  readonly readAsSent: boolean;
  /** Why a removed file went: taken back, timed out, or read again. Null while it is here. */
  readonly removedReason: 'user' | 'expired' | 'replaced' | null;
  /** Milestone 5 part 3a: the Google Drive file it was read from. Null otherwise. */
  readonly driveFileId: string | null;
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
      /** A page that was fetched: the server's record of the fetch, and the page's title. */
      readonly fetchId?: string;
      readonly title?: string;
      /** A file read from Google Drive: the server's record of that read. */
      readonly driveReadId?: string;
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
      readonly fetchId?: string;
      readonly driveReadId?: string;
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
  /** Older reads of the same address that this one took the place of. */
  readonly replaced?: number;
  readonly file: AttachedFile;
}

/** A web page as it arrives from our server: its bytes, and what the server says of them. */
export interface FetchedPage {
  readonly fetchId: string;
  /** The host that answered, after redirects. */
  readonly host: string;
  /** The last piece of the address: a hint for the reader, never shown as a name. */
  readonly fileName: string;
  readonly contentType: string | null;
  readonly contentHash: string;
  readonly bytes: Uint8Array;
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

/** A page fetch: the server allows the site 20 s, and a large document takes time to arrive. */
export const FILES_FETCH_PAGE_TIMEOUT_MS = 120_000;

export const FILES_API_MESSAGES = {
  incompletePage: 'The page did not arrive whole, so it was not read. Try again.',
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

/**
 * A file as the endpoint describes it, made whole: a server that has not yet learned about
 * links (the minutes between a web deploy and a function deploy) sends no source fields, and
 * a file with none is simply a file that was uploaded.
 */
function completeFile(file: AttachedFile): AttachedFile {
  const loose = file as Partial<AttachedFile>;
  return {
    ...file,
    sourceUrl: typeof loose.sourceUrl === 'string' ? loose.sourceUrl : null,
    sourceHost: typeof loose.sourceHost === 'string' ? loose.sourceHost : null,
    fetchedAt: typeof loose.fetchedAt === 'string' ? loose.fetchedAt : null,
    valuesMissing: typeof loose.valuesMissing === 'number' ? loose.valuesMissing : 0,
    readAsSent: loose.readAsSent === true,
    removedReason: null,
    driveFileId: typeof loose.driveFileId === 'string' ? loose.driveFileId : null,
  };
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
  if (!complete[action]) return null;
  if (isFileView(body['file'])) {
    return { ...body, file: completeFile(body['file']) } as ReplyFor<A>;
  }
  return body as ReplyFor<A>;
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
  return interpretFilesFailure(status, body);
}

/** What a refusal or a failure from the endpoint means for the person, whatever was asked. */
export function interpretFilesFailure(status: number, body: unknown): FilesFailure {
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

function hexOf(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The body of a response, read as it arrives so that a slow connection shows progress. */
async function readBytes(
  response: Response,
  expected: number,
  onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    received += step.value.length;
    onProgress?.(received, expected);
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export interface FetchPageDeps extends FilesDeps {
  /** SHA-256 of the bytes, hex. Injected so the check runs the same under Node. */
  readonly hash?: (bytes: Uint8Array) => Promise<string>;
}

/**
 * Ask our server to fetch one page. Never throws. The read runs in the region where
 * Australian sites answer (the probe: 200 from Sydney, 403 from elsewhere), whichever
 * region is nearest the person asking.
 */
export async function fetchPage(
  deps: FetchPageDeps,
  accessToken: string,
  request: { readonly requestId: string; readonly url: string },
  signal?: AbortSignal,
  onProgress?: (received: number, total: number) => void,
): Promise<FilesOutcome<FetchedPage>> {
  const controller = new AbortController();
  const clock = { timedOut: false };
  const timer = setTimeout(() => {
    clock.timedOut = true;
    controller.abort();
  }, deps.timeoutMs ?? FILES_FETCH_PAGE_TIMEOUT_MS);
  const onAbort = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', onAbort);
  try {
    const response = await deps.fetch(`${deps.filesUrl}?forceFunctionRegion=${READ_REGION}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        apikey: deps.anonKey,
      },
      body: JSON.stringify({
        action: 'fetch_page',
        requestId: request.requestId,
        url: request.url,
      }),
      signal: controller.signal,
    });
    const meta =
      response.status === 200 ? decodePageMeta(response.headers.get(PAGE_META_HEADER)) : null;
    if (meta === null) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      // A 200 that is not a page is not a success, whatever it is.
      return response.status === 200
        ? failure('retryable', FILES_API_MESSAGES.unknown, 'BAD_RESPONSE', 200)
        : interpretFilesFailure(response.status, body);
    }
    const fetchId = meta['fetchId'];
    const host = meta['host'];
    const fileName = meta['fileName'];
    const byteSize = meta['byteSize'];
    const contentHash = meta['contentHash'];
    const contentType = meta['contentType'];
    if (
      typeof fetchId !== 'string' ||
      typeof host !== 'string' ||
      typeof fileName !== 'string' ||
      typeof byteSize !== 'number' ||
      typeof contentHash !== 'string'
    ) {
      return failure('retryable', FILES_API_MESSAGES.unknown, 'BAD_RESPONSE', 200);
    }
    const bytes = await readBytes(response, byteSize, onProgress);
    // What arrived must be what the server fetched: a page cut short on the way here is not
    // read as if it were whole, and `begin` would refuse it anyway.
    const digest =
      deps.hash === undefined
        ? hexOf(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))
        : await deps.hash(bytes);
    if (bytes.length !== byteSize || digest !== contentHash) {
      return failure('retryable', FILES_API_MESSAGES.incompletePage, 'INCOMPLETE_PAGE', 200);
    }
    return {
      kind: 'ok',
      reply: {
        fetchId,
        host,
        fileName,
        contentType: typeof contentType === 'string' ? contentType : null,
        contentHash,
        bytes,
      },
    };
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
  source_url: string | null;
  source_host: string | null;
  fetched_at: string | null;
  values_missing: number;
  read_as_sent: boolean;
  removed_reason: string | null;
  drive_file_id: string | null;
};

export const CONVERSATION_FILE_COLUMNS =
  'id, conversation_id, uploaded_by, name, kind, byte_size, page_count, vision_pages, status, created_at, expires_at, source_url, source_host, fetched_at, values_missing, read_as_sent, removed_reason, drive_file_id';

const KINDS: readonly string[] = ['pdf', 'docx', 'xlsx', 'csv', 'text', 'image', 'html'];

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
      sourceUrl: row.source_url,
      sourceHost: row.source_host,
      fetchedAt: row.fetched_at,
      valuesMissing: row.values_missing,
      readAsSent: row.read_as_sent,
      removedReason:
        row.removed_reason === 'user' ||
        row.removed_reason === 'expired' ||
        row.removed_reason === 'replaced'
          ? row.removed_reason
          : null,
      driveFileId: typeof row.drive_file_id === 'string' ? row.drive_file_id : null,
    });
  }
  return out;
}
