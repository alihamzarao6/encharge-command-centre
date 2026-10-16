/**
 * supabase-js adapter for attached files (Milestone 5 part 1): the five functions migration
 * 20261012010000 added, and the reads a turn and the endpoint need. Server-side only —
 * service role, the one path that may read `conversation_file_pages` at all. Same discipline
 * as the other stores: a hard fetch timeout, no blind retries of writes, every failure a
 * typed Result.
 *
 * The database decides the things that must not be decided twice: whether an upload is
 * complete, whether a conversation is full, whether the same file is already attached. This
 * adapter turns its answers (SQLSTATE FL001–FL007, WF001, 02000) into a `reason` the endpoint
 * maps to a sentence.
 *
 * Milestone 5 part 2 adds the server's record of each page it fetched (`web_fetches`,
 * migration 20261012020000): claimed before the fetch, completed after it, and the only place
 * an attachment's address and read time are ever taken from.
 *
 * Nothing here ever puts a file's name or a word of its text into an error or a log field.
 * Postgres error messages from these functions carry ids and counts only, by construction.
 */
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';

import { fetchWithTimeout, type SupabaseAuthConfig } from '../auth/clients.js';
import { AppError, NetworkError, ensureError, err, ok, type Result } from '../errors.js';
import { NOT_LOADED_MARK, READ_AS_SENT_MARK } from '../pages/limits.js';
import type { TurnFile, TurnFileSource, TurnPage } from './context.js';
import {
  EXTRACTION_METHODS,
  FILE_LIMITS,
  isFileKind,
  type ExtractionMethod,
  type FileKind,
  type Legibility,
} from './limits.js';

export type FileStatus = 'reading' | 'ready' | 'removed';

/* eslint-disable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style -- supabase-js schema shape (auth/clients.ts) */
type FileDbRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  scope: string;
  uploaded_by: string;
  request_id: string;
  name: string | null;
  kind: string;
  byte_size: number;
  content_hash: string | null;
  expected_pages: number;
  vision_pages: number;
  page_count: number;
  char_count: number;
  confidence: number | null;
  status: string;
  created_at: string;
  ready_at: string | null;
  expires_at: string;
  removed_at: string | null;
  removed_by: string | null;
  removed_reason: string | null;
  source_url: string | null;
  source_host: string | null;
  fetched_at: string | null;
  values_missing: number;
  read_as_sent: boolean;
  drive_file_id: string | null;
};

type DriveReadDbRow = {
  id: string;
  user_id: string;
  drive_file_id: string;
  status: string;
  name: string | null;
  byte_size: number | null;
  content_hash: string | null;
  fetched_at: string | null;
};

type FetchDbRow = {
  id: string;
  user_id: string;
  requested_url: string;
  requested_host: string;
  final_url: string | null;
  final_host: string | null;
  status: string;
  outcome: string | null;
  http_status: number | null;
  content_type: string | null;
  byte_size: number | null;
  content_hash: string | null;
  hops: number | null;
  duration_ms: number | null;
  created_at: string;
  fetched_at: string | null;
};

type PageDbRow = {
  file_id: string;
  page_no: number;
  label: string;
  content: string;
  extraction_method: string;
  confidence: number;
  legibility: string;
  letter_count: number;
  extracted_at: string;
};

export type FilesDatabase = {
  public: {
    Tables: {
      conversation_files: {
        Row: FileDbRow;
        Insert: Partial<FileDbRow>;
        Update: Partial<FileDbRow>;
        Relationships: [];
      };
      conversation_file_pages: {
        Row: PageDbRow;
        Insert: Partial<PageDbRow>;
        Update: Partial<PageDbRow>;
        Relationships: [];
      };
      web_fetches: {
        Row: FetchDbRow;
        Insert: Partial<FetchDbRow>;
        Update: Partial<FetchDbRow>;
        Relationships: [];
      };
      drive_reads: {
        Row: DriveReadDbRow;
        Insert: Partial<DriveReadDbRow>;
        Update: Partial<DriveReadDbRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      begin_conversation_file: {
        Args: {
          p_conversation_id: string;
          p_uploaded_by: string;
          p_request_id: string;
          p_name: string;
          p_kind: string;
          p_byte_size: number;
          p_content_hash: string;
          p_expected_pages: number;
          p_vision_pages: number;
          p_retention_days: number;
          p_max_files: number;
          p_abandoned_minutes: number;
          p_fetch_id?: string;
          p_drive_read_id?: string;
        };
        Returns: {
          id: string;
          status: string;
          existing: boolean;
          duplicate: boolean;
          expected_pages: number;
          pages_stored: number[];
        }[];
      };
      append_conversation_file_pages: {
        Args: { p_file_id: string; p_pages: PageInsertJson[] };
        Returns: number;
      };
      finish_conversation_file: {
        Args: {
          p_file_id: string;
          p_actor: string;
          p_max_chars: number;
          p_gap_mark?: string;
          p_sent_mark?: string;
        };
        Returns: {
          id: string;
          duplicate: boolean;
          already: boolean;
          page_count: number;
          char_count: number;
          vision_pages: number;
          confidence: number | null;
          replaced: number;
        }[];
      };
      claim_web_fetch: {
        Args: {
          p_id: string;
          p_user_id: string;
          p_url: string;
          p_host: string;
          p_per_minute: number;
          p_host_gap_ms: number;
        };
        Returns: { claimed: boolean; existing: boolean; wait_ms: number }[];
      };
      complete_web_fetch: {
        Args: {
          p_id: string;
          p_user_id: string;
          p_status: string;
          p_outcome: string | null;
          p_final_url: string | null;
          p_final_host: string | null;
          p_http_status: number | null;
          p_content_type: string | null;
          p_byte_size: number | null;
          p_content_hash: string | null;
          p_hops: number | null;
          p_duration_ms: number | null;
        };
        Returns: boolean;
      };
      remove_conversation_file: {
        Args: { p_file_id: string; p_actor: string; p_reason: string };
        Returns: boolean;
      };
      purge_conversation_files: {
        Args: { p_abandoned_minutes: number };
        Returns: { abandoned: number; expired: number }[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

type PageInsertJson = {
  page_no: number;
  label: string;
  content: string;
  extraction_method: string;
  confidence: number;
  legibility: string;
  letter_count: number;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style */

export type FilesServiceClient = SupabaseClient<FilesDatabase>;

export const DEFAULT_FILES_STORE_TIMEOUT_MS = 20_000;

export function createFilesServiceClient(config: SupabaseAuthConfig): FilesServiceClient {
  return createClient<FilesDatabase>(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout(config.timeoutMs ?? DEFAULT_FILES_STORE_TIMEOUT_MS) },
  });
}

// ---------------------------------------------------------------------------------------
// The shapes the rest of the module works in
// ---------------------------------------------------------------------------------------

/** What the interface shows for a file. No text, and no hash. */
export interface FileView {
  readonly id: string;
  readonly conversationId: string;
  readonly uploadedBy: string;
  /** Null once removed. */
  readonly name: string | null;
  readonly kind: FileKind;
  readonly byteSize: number;
  readonly pageCount: number;
  readonly charCount: number;
  readonly visionPages: number;
  readonly status: FileStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** From a link: the address read, its host and when. All null for an uploaded file. */
  readonly sourceUrl: string | null;
  readonly sourceHost: string | null;
  readonly fetchedAt: string | null;
  /** Places the page left for a script to fill in, found empty. */
  readonly valuesMissing: number;
  /** The page shows nothing until its scripts run, and was read as the site sent it. */
  readonly readAsSent: boolean;
  /** Milestone 5 part 3a: the Google Drive file it was read from. Null otherwise. */
  readonly driveFileId: string | null;
}

/** A file as the endpoint needs it to decide what a request may do. */
export interface FileRecord extends FileView {
  readonly expectedPages: number;
  /** The conversation's author and scope, for the same visibility rule the chat uses. */
  readonly conversationAuthorId: string;
  readonly scope: 'user' | 'workspace';
}

export interface BeginFileInput {
  readonly conversationId: string;
  readonly uploadedBy: string;
  readonly requestId: string;
  readonly name: string;
  readonly kind: FileKind;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly expectedPages: number;
  readonly visionPages: number;
  readonly retentionDays: number;
  /** Set for a page that was fetched: the database checks the attachment against it. */
  readonly fetchId?: string;
  /** Set for a file read from Drive: the same, against the record of that read. */
  readonly driveReadId?: string;
}

export interface BeginFileResult {
  readonly id: string;
  readonly status: FileStatus;
  /** This request id, or this content, was already known. */
  readonly existing: boolean;
  /** The same file is already attached and ready: nothing more to send. */
  readonly duplicate: boolean;
  readonly expectedPages: number;
  readonly pagesStored: readonly number[];
}

export interface PageInsert {
  readonly pageNo: number;
  readonly label: string;
  readonly content: string;
  readonly method: ExtractionMethod;
  readonly confidence: number;
  readonly legibility: Legibility;
  readonly letterCount: number;
}

export interface StoredPageInfo {
  readonly pageNo: number;
  readonly method: ExtractionMethod;
  readonly legibility: Legibility;
  readonly chars: number;
  readonly letterCount: number;
}

export interface FinishFileResult {
  readonly id: string;
  readonly duplicate: boolean;
  readonly already: boolean;
  readonly pageCount: number;
  readonly charCount: number;
  readonly visionPages: number;
  /** Older reads of the same address that this one replaced. */
  readonly replaced: number;
}

/** What the server recorded about one page it was asked to read. */
export interface FetchReceipt {
  readonly id: string;
  readonly userId: string;
  readonly status: 'started' | 'fetched' | 'refused' | 'failed';
  readonly finalUrl: string | null;
  readonly finalHost: string | null;
  readonly byteSize: number | null;
  readonly contentHash: string | null;
  readonly fetchedAt: string | null;
}

/** What the server recorded about one file it read from Drive for someone. */
export interface DriveReadReceipt {
  readonly id: string;
  readonly userId: string;
  readonly driveFileId: string;
  readonly status: 'started' | 'fetched' | 'refused' | 'failed';
  /** Drive's name for the file when it was read, cleaned. */
  readonly name: string | null;
  readonly byteSize: number | null;
  readonly contentHash: string | null;
  readonly fetchedAt: string | null;
}

export interface ClaimFetchInput {
  readonly id: string;
  readonly userId: string;
  readonly url: string;
  readonly host: string;
  readonly perMinute: number;
  readonly hostGapMs: number;
}

export type ClaimFetchResult =
  /** Go ahead: this read is now on record. */
  | { readonly claimed: true }
  /**
   * This id has already been used for a read. One id opens one page, once: were a repeat let
   * through, the same id sent again and again would be unlimited requests to a site, past
   * both limits. The caller opens nothing; the browser asks again under a new id.
   */
  | { readonly claimed: false; readonly spent: true }
  /** The host was read a moment ago: wait this long and ask again. */
  | { readonly claimed: false; readonly spent: false; readonly waitMs: number };

export interface CompleteFetchInput {
  readonly id: string;
  readonly userId: string;
  readonly status: 'fetched' | 'refused' | 'failed';
  /** A reason code. Never a sentence. */
  readonly outcome: string | null;
  readonly finalUrl?: string | null;
  readonly finalHost?: string | null;
  readonly httpStatus?: number | null;
  readonly contentType?: string | null;
  readonly byteSize?: number | null;
  readonly contentHash?: string | null;
  readonly hops?: number | null;
  readonly durationMs?: number | null;
}

/** Why the database refused. Read by the endpoint to choose a status and a sentence. */
export type FileStoreReason =
  | 'not_found'
  | 'too_many_files'
  | 'not_reading'
  | 'page_out_of_range'
  | 'incomplete'
  | 'no_text'
  | 'too_long'
  /** The attachment does not match the server's record of the fetch. */
  | 'bad_receipt'
  /** This person has opened too many pages in the last minute. */
  | 'too_many_reads';

const REASON_BY_SQLSTATE: Readonly<Record<string, FileStoreReason>> = {
  '02000': 'not_found',
  FL001: 'too_many_files',
  FL002: 'not_reading',
  FL003: 'page_out_of_range',
  FL004: 'incomplete',
  FL005: 'no_text',
  FL006: 'too_long',
  FL007: 'bad_receipt',
  WF001: 'too_many_reads',
};

export function fileStoreReason(error: AppError): FileStoreReason | null {
  const reason = error.context['reason'];
  return typeof reason === 'string' &&
    Object.values(REASON_BY_SQLSTATE).includes(reason as FileStoreReason)
    ? (reason as FileStoreReason)
    : null;
}

export interface FileStore extends TurnFileSource {
  begin(input: BeginFileInput): Promise<Result<BeginFileResult>>;
  get(fileId: string): Promise<Result<FileRecord | null>>;
  appendPages(fileId: string, pages: readonly PageInsert[]): Promise<Result<number>>;
  /** What is stored for one page, without its text. Null when it is not stored yet. */
  pageInfo(fileId: string, pageNo: number): Promise<Result<StoredPageInfo | null>>;
  /** How many pages of this file were read through vision so far. */
  visionPagesStored(fileId: string): Promise<Result<number>>;
  finish(fileId: string, actor: string): Promise<Result<FinishFileResult>>;
  remove(fileId: string, actor: string): Promise<Result<boolean>>;
  purge(): Promise<Result<{ readonly abandoned: number; readonly expired: number }>>;
  /** May this read go ahead? Applies the per-person and per-host limits atomically. */
  claimFetch(input: ClaimFetchInput): Promise<Result<ClaimFetchResult>>;
  /** How a read ended. False when the record is not this person's. */
  completeFetch(input: CompleteFetchInput): Promise<Result<boolean>>;
  getFetch(fetchId: string): Promise<Result<FetchReceipt | null>>;
  /** Milestone 5 part 3a: the record of a Drive read, for `begin` to check against. */
  getDriveRead(readId: string): Promise<Result<DriveReadReceipt | null>>;
}

function mapPostgrest(error: PostgrestError, operation: string): AppError {
  if (error.code === '') {
    return new NetworkError(`${operation}: transport failure`, { context: { operation } });
  }
  const reason = Object.hasOwn(REASON_BY_SQLSTATE, error.code)
    ? REASON_BY_SQLSTATE[error.code]
    : undefined;
  if (reason !== undefined) {
    // A definite answer from the database, never retried. The Postgres message is not kept:
    // the reason says everything a caller acts on.
    return new AppError('CONFLICT', `${operation}: ${reason}`, {
      context: { operation, reason, supabaseCode: error.code },
    });
  }
  return new AppError('HTTP_STATUS', `${operation}: database error ${error.code}`, {
    context: { operation, supabaseCode: error.code },
  });
}

function mapThrown(caught: unknown, operation: string): AppError {
  return new NetworkError(`${operation}: transport failure`, {
    context: { operation },
    cause: ensureError(caught),
  });
}

function asStatus(value: string): FileStatus | null {
  return value === 'reading' || value === 'ready' || value === 'removed' ? value : null;
}

function asMethod(value: string): ExtractionMethod | null {
  return (EXTRACTION_METHODS as readonly string[]).includes(value)
    ? (value as ExtractionMethod)
    : null;
}

function asLegibility(value: string): Legibility {
  return value === 'partial' || value === 'none' ? value : 'full';
}

const FILE_COLUMNS =
  'id, conversation_id, user_id, scope, uploaded_by, name, kind, byte_size, expected_pages, vision_pages, page_count, char_count, status, created_at, expires_at, source_url, source_host, fetched_at, values_missing, read_as_sent, drive_file_id';

type FileColumns = Pick<
  FileDbRow,
  | 'id'
  | 'conversation_id'
  | 'user_id'
  | 'scope'
  | 'uploaded_by'
  | 'name'
  | 'kind'
  | 'byte_size'
  | 'expected_pages'
  | 'vision_pages'
  | 'page_count'
  | 'char_count'
  | 'status'
  | 'created_at'
  | 'expires_at'
  | 'source_url'
  | 'source_host'
  | 'fetched_at'
  | 'values_missing'
  | 'read_as_sent'
  | 'drive_file_id'
>;

function toRecord(row: FileColumns): Result<FileRecord> {
  const status = asStatus(row.status);
  if (
    status === null ||
    !isFileKind(row.kind) ||
    (row.scope !== 'user' && row.scope !== 'workspace')
  ) {
    return err(
      new AppError('INTERNAL', 'conversation_files row outside its check constraints', {
        context: { fileId: row.id },
      }),
    );
  }
  return ok({
    id: row.id,
    conversationId: row.conversation_id,
    uploadedBy: row.uploaded_by,
    name: row.name,
    kind: row.kind,
    byteSize: row.byte_size,
    pageCount: row.page_count,
    charCount: row.char_count,
    visionPages: row.vision_pages,
    status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    sourceUrl: row.source_url,
    sourceHost: row.source_host,
    fetchedAt: row.fetched_at,
    valuesMissing: row.values_missing,
    readAsSent: row.read_as_sent,
    driveFileId: row.drive_file_id,
    expectedPages: row.expected_pages,
    conversationAuthorId: row.user_id,
    scope: row.scope,
  });
}

/** PostgREST caps a response at `max_rows`; pages are read in slices until a short one. */
const PAGE_FETCH = 500;
/** More pages than any conversation can hold: a loop that never ends is a bug, not a wait. */
const PAGE_FETCH_LIMIT = FILE_LIMITS.maxFilesPerConversation * FILE_LIMITS.maxPages + PAGE_FETCH;

export function supabaseFileStore(
  client: FilesServiceClient,
  now: () => Date = () => new Date(),
): FileStore {
  return {
    begin: async (input) => {
      try {
        const { data, error } = await client.rpc('begin_conversation_file', {
          p_conversation_id: input.conversationId,
          p_uploaded_by: input.uploadedBy,
          p_request_id: input.requestId,
          p_name: input.name,
          p_kind: input.kind,
          p_byte_size: input.byteSize,
          p_content_hash: input.contentHash,
          p_expected_pages: input.expectedPages,
          p_vision_pages: input.visionPages,
          p_retention_days: input.retentionDays,
          p_max_files: FILE_LIMITS.maxFilesPerConversation,
          p_abandoned_minutes: FILE_LIMITS.abandonedAfterMinutes,
          ...(input.fetchId === undefined ? {} : { p_fetch_id: input.fetchId }),
          ...(input.driveReadId === undefined ? {} : { p_drive_read_id: input.driveReadId }),
        });
        if (error !== null) return err(mapPostgrest(error, 'begin_conversation_file'));
        const row = data[0];
        const status = row === undefined ? null : asStatus(row.status);
        if (row === undefined || status === null) {
          return err(new AppError('INTERNAL', 'begin_conversation_file returned no usable row'));
        }
        return ok({
          id: row.id,
          status,
          existing: row.existing,
          duplicate: row.duplicate,
          expectedPages: row.expected_pages,
          pagesStored: row.pages_stored,
        });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'begin_conversation_file'));
      }
    },

    get: async (fileId) => {
      try {
        const { data, error } = await client
          .from('conversation_files')
          .select(FILE_COLUMNS)
          .eq('id', fileId)
          .limit(1);
        if (error !== null) return err(mapPostgrest(error, 'conversation_files.get'));
        const row = data[0];
        return row === undefined ? ok(null) : toRecord(row);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'conversation_files.get'));
      }
    },

    appendPages: async (fileId, pages) => {
      try {
        const { data, error } = await client.rpc('append_conversation_file_pages', {
          p_file_id: fileId,
          p_pages: pages.map((page) => ({
            page_no: page.pageNo,
            label: page.label,
            content: page.content,
            extraction_method: page.method,
            confidence: page.confidence,
            legibility: page.legibility,
            letter_count: page.letterCount,
          })),
        });
        if (error !== null) return err(mapPostgrest(error, 'append_conversation_file_pages'));
        return ok(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'append_conversation_file_pages'));
      }
    },

    pageInfo: async (fileId, pageNo) => {
      try {
        // The text itself is not selected: this answers "is it there", not "what does it say".
        const { data, error } = await client
          .from('conversation_file_pages')
          .select('page_no, extraction_method, legibility, letter_count, content')
          .eq('file_id', fileId)
          .eq('page_no', pageNo)
          .limit(1);
        if (error !== null) return err(mapPostgrest(error, 'conversation_file_pages.get'));
        const row = data[0];
        if (row === undefined) return ok(null);
        const method = asMethod(row.extraction_method);
        if (method === null) {
          return err(
            new AppError('INTERNAL', 'conversation_file_pages row outside its constraints'),
          );
        }
        return ok({
          pageNo: row.page_no,
          method,
          legibility: asLegibility(row.legibility),
          chars: row.content.length,
          letterCount: row.letter_count,
        });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'conversation_file_pages.get'));
      }
    },

    visionPagesStored: async (fileId) => {
      try {
        const { count, error } = await client
          .from('conversation_file_pages')
          .select('page_no', { count: 'exact', head: true })
          .eq('file_id', fileId)
          .eq('extraction_method', 'claude_vision');
        if (error !== null) return err(mapPostgrest(error, 'conversation_file_pages.count'));
        return ok(count ?? 0);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'conversation_file_pages.count'));
      }
    },

    finish: async (fileId, actor) => {
      try {
        const { data, error } = await client.rpc('finish_conversation_file', {
          p_file_id: fileId,
          p_actor: actor,
          p_max_chars: FILE_LIMITS.maxFileChars,
          p_gap_mark: NOT_LOADED_MARK,
          p_sent_mark: READ_AS_SENT_MARK,
        });
        if (error !== null) return err(mapPostgrest(error, 'finish_conversation_file'));
        const row = data[0];
        if (row === undefined) {
          return err(new AppError('INTERNAL', 'finish_conversation_file returned no row'));
        }
        return ok({
          id: row.id,
          duplicate: row.duplicate,
          already: row.already,
          pageCount: row.page_count,
          charCount: row.char_count,
          visionPages: row.vision_pages,
          replaced: row.replaced,
        });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'finish_conversation_file'));
      }
    },

    remove: async (fileId, actor) => {
      try {
        const { data, error } = await client.rpc('remove_conversation_file', {
          p_file_id: fileId,
          p_actor: actor,
          p_reason: 'user',
        });
        if (error !== null) return err(mapPostgrest(error, 'remove_conversation_file'));
        return ok(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'remove_conversation_file'));
      }
    },

    purge: async () => {
      try {
        const { data, error } = await client.rpc('purge_conversation_files', {
          p_abandoned_minutes: FILE_LIMITS.abandonedAfterMinutes,
        });
        if (error !== null) return err(mapPostgrest(error, 'purge_conversation_files'));
        const row = data[0];
        return ok({ abandoned: row?.abandoned ?? 0, expired: row?.expired ?? 0 });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'purge_conversation_files'));
      }
    },

    forTurn: async (conversationId) => {
      try {
        const files = await client
          .from('conversation_files')
          .select(
            'id, name, kind, status, created_at, expires_at, source_host, fetched_at, values_missing, read_as_sent, drive_file_id',
          )
          .eq('conversation_id', conversationId)
          .in('status', ['ready', 'removed'])
          .order('created_at', { ascending: false })
          .limit(200);
        if (files.error !== null)
          return err(mapPostgrest(files.error, 'conversation_files.forTurn'));
        const everHadFile = files.data.length > 0;
        // A removed page keeps its kind and loses its address, so `html` is what says a page
        // was ever read here; a live document from a link still has its host. A file from
        // Drive is his own document, not a page anyone in the world can write: it reads to the
        // model exactly as an upload does, without the web-page rules (Milestone 5 part 3a).
        const fromLink = (row: {
          source_host: string | null;
          drive_file_id: string | null;
        }): boolean => typeof row.source_host === 'string' && typeof row.drive_file_id !== 'string';
        const everHadPage = files.data.some((row) => row.kind === 'html' || fromLink(row));
        // Past its date but not yet purged: already not usable. The schedule removes the row;
        // this makes the promise true in the hours before it runs.
        // Compared as instants, not as text: the database writes "+00:00" where JavaScript
        // writes "Z", and two spellings of one moment must not disagree about which is later.
        const cutoff = now().getTime();
        const live = files.data.filter(
          (row) =>
            row.status === 'ready' && Date.parse(row.expires_at) > cutoff && isFileKind(row.kind),
        );
        if (live.length === 0) return ok({ files: [], everHadFile, everHadPage });

        const byFile = new Map<string, TurnPage[]>();
        const ids = live.map((row) => row.id);
        for (let offset = 0; offset < PAGE_FETCH_LIMIT; offset += PAGE_FETCH) {
          const pages = await client
            .from('conversation_file_pages')
            .select('file_id, page_no, label, content, extraction_method, legibility')
            .in('file_id', ids)
            .order('file_id', { ascending: true })
            .order('page_no', { ascending: true })
            .range(offset, offset + PAGE_FETCH - 1);
          if (pages.error !== null) {
            return err(mapPostgrest(pages.error, 'conversation_file_pages.forTurn'));
          }
          for (const row of pages.data) {
            const method = asMethod(row.extraction_method);
            if (method === null) continue;
            const list = byFile.get(row.file_id) ?? [];
            list.push({
              pageNo: row.page_no,
              label: row.label,
              content: row.content,
              method,
              legibility: asLegibility(row.legibility),
            });
            byFile.set(row.file_id, list);
          }
          if (pages.data.length < PAGE_FETCH) break;
        }

        const out: TurnFile[] = [];
        for (const row of live) {
          if (!isFileKind(row.kind) || row.name === null) continue;
          out.push({
            id: row.id,
            name: row.name,
            kind: row.kind,
            createdAt: row.created_at,
            pages: byFile.get(row.id) ?? [],
            ...(fromLink(row) &&
            typeof row.source_host === 'string' &&
            typeof row.fetched_at === 'string'
              ? {
                  source: {
                    host: row.source_host,
                    fetchedAt: row.fetched_at,
                    valuesMissing: row.values_missing,
                    readAsSent: row.read_as_sent,
                  },
                }
              : {}),
          });
        }
        return ok({ files: out, everHadFile, everHadPage });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'conversation_files.forTurn'));
      }
    },

    claimFetch: async (input) => {
      try {
        const { data, error } = await client.rpc('claim_web_fetch', {
          p_id: input.id,
          p_user_id: input.userId,
          p_url: input.url,
          p_host: input.host,
          p_per_minute: input.perMinute,
          p_host_gap_ms: input.hostGapMs,
        });
        if (error !== null) return err(mapPostgrest(error, 'claim_web_fetch'));
        const row = data[0];
        if (row === undefined) {
          return err(new AppError('INTERNAL', 'claim_web_fetch returned no row'));
        }
        if (row.claimed) return ok({ claimed: true });
        return ok(
          row.existing
            ? { claimed: false, spent: true }
            : { claimed: false, spent: false, waitMs: Math.max(0, row.wait_ms) },
        );
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'claim_web_fetch'));
      }
    },

    completeFetch: async (input) => {
      try {
        const { data, error } = await client.rpc('complete_web_fetch', {
          p_id: input.id,
          p_user_id: input.userId,
          p_status: input.status,
          p_outcome: input.outcome,
          p_final_url: input.finalUrl ?? null,
          p_final_host: input.finalHost ?? null,
          p_http_status: input.httpStatus ?? null,
          p_content_type: input.contentType ?? null,
          p_byte_size: input.byteSize ?? null,
          p_content_hash: input.contentHash ?? null,
          p_hops: input.hops ?? null,
          p_duration_ms: input.durationMs ?? null,
        });
        if (error !== null) return err(mapPostgrest(error, 'complete_web_fetch'));
        return ok(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'complete_web_fetch'));
      }
    },

    getFetch: async (fetchId) => {
      try {
        const { data, error } = await client
          .from('web_fetches')
          .select('id, user_id, status, final_url, final_host, byte_size, content_hash, fetched_at')
          .eq('id', fetchId)
          .limit(1);
        if (error !== null) return err(mapPostgrest(error, 'web_fetches.get'));
        const row = data[0];
        if (row === undefined) return ok(null);
        const status = row.status;
        if (
          status !== 'started' &&
          status !== 'fetched' &&
          status !== 'refused' &&
          status !== 'failed'
        ) {
          return err(new AppError('INTERNAL', 'web_fetches row outside its check constraints'));
        }
        return ok({
          id: row.id,
          userId: row.user_id,
          status,
          finalUrl: row.final_url,
          finalHost: row.final_host,
          byteSize: row.byte_size,
          contentHash: row.content_hash,
          fetchedAt: row.fetched_at,
        });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'web_fetches.get'));
      }
    },

    getDriveRead: async (readId) => {
      try {
        const { data, error } = await client
          .from('drive_reads')
          .select('id, user_id, drive_file_id, status, name, byte_size, content_hash, fetched_at')
          .eq('id', readId)
          .limit(1);
        if (error !== null) return err(mapPostgrest(error, 'drive_reads.get'));
        const row = data[0];
        if (row === undefined) return ok(null);
        const status = row.status;
        if (
          status !== 'started' &&
          status !== 'fetched' &&
          status !== 'refused' &&
          status !== 'failed'
        ) {
          return err(new AppError('INTERNAL', 'drive_reads row outside its check constraints'));
        }
        return ok({
          id: row.id,
          userId: row.user_id,
          driveFileId: row.drive_file_id,
          status,
          name: row.name,
          byteSize: row.byte_size,
          contentHash: row.content_hash,
          fetchedAt: row.fetched_at,
        });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'drive_reads.get'));
      }
    },
  };
}
