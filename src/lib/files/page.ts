/**
 * The files endpoint (Milestone 5 part 1): everything the browser does to attach a file, read
 * a page image, or take a file back. Runtime-agnostic and never throws — the Edge Function
 * maps the returned status and body straight onto its response, as chat, memory and crm do.
 *
 * An upload is a short conversation, not one request, because the reading happens in the
 * browser (D84) and a scan is read a page at a time:
 *
 *   estimate   how many pages will be read as images and what that costs against today's
 *              cap — shown to the person BEFORE anything is spent (D90).
 *   begin      claim the upload. Idempotent on the request id; the same file already attached
 *              comes back as that attachment; creates the conversation when there is none.
 *   append     pages of text the browser extracted. Cleaned again here; the browser is not
 *              trusted to have done it.
 *   read_page  one page IMAGE, read by Claude and stored as text. The image is not stored.
 *              Idempotent per page: a page already read is answered from the record, so a
 *              retry after a dropped response is never paid for twice.
 *   finish     every declared page is in → the file becomes usable. Not before: a file is
 *              attached whole or not at all.
 *   remove     the person who attached it, or an administrator.
 *   refused    the browser refused a file before sending anything; recorded so "why did his
 *              upload fail" has an answer in the logs.
 *   fetch_page (Milestone 5 part 2) fetch ONE web page the person pointed at and hand its
 *              bytes back to be read by the same readers. The address goes through the SSRF
 *              guard, the per-person and per-host limits and the site's robots.txt before
 *              anything is requested (src/lib/pages/). The server records what it fetched —
 *              address, time, size, SHA-256 — and `begin` then accepts those bytes and no
 *              others, taking the address and the time from that record: the browser reads
 *              the page, but it never gets to say where the page came from.
 *
 * Order in every action: who is asking (401/403 before any work), then the input, then
 * whether they may touch THIS conversation or file — and "not yours" answers exactly as "not
 * found", so the endpoint is not an oracle for which ids exist.
 *
 * Logging (CLAUDE.md rule 20 and this part's hard boundary): ids, kinds, sizes, counts,
 * durations, outcomes. Never a file's name, never a word of its content — not in a log line,
 * not in an error message, not in a thrown error's context. For a page: the HOST, the status,
 * the content type, the size, the time and the outcome. Never the path or the query (a query
 * string can name a person), never the title, never a byte of the page.
 */
import { z } from 'zod';

import { verifyStaffAccess, type StaffIdentity, type VerifyDeps } from '../auth/verify.js';
import type { AppError } from '../errors.js';
import type { ConversationStore } from '../llm/chat.js';
import type { LlmError, UsageStore } from '../llm/client.js';
import {
  IMAGE_WORST_CASE_TOKENS,
  costUsd,
  estimateWorstCaseUsd,
  roundUsd,
  type ModelPricing,
} from '../llm/pricing.js';
import { utcDayStart, utcMonthStart, type SpendCaps } from '../llm/spend.js';
import type { Logger } from '../logger.js';
import type { PageFetcher } from '../pages/fetch.js';
import { parsePublicUrl, type PublicUrl } from '../pages/guard.js';
import {
  PAGE_LIMITS,
  PAGE_RETRY_MESSAGES,
  pageRefusalMessage,
  type PageRefusalCode,
  type PageRetryCode,
} from '../pages/limits.js';
import { FILE_REMOVAL_DENIED_MESSAGE, canRemoveFile, canSeeConversationFiles } from './access.js';
import type { FilesConfig } from './config.js';
import {
  BROWSER_METHOD,
  FILE_KINDS,
  FILE_LIMITS,
  PARSED_CONFIDENCE,
  REFUSAL_CODES,
  refusal,
  type Legibility,
  type RefusalCode,
} from './limits.js';
import {
  fileStoreReason,
  type FileRecord,
  type FileStatus,
  type FileStore,
  type FileView,
  type PageInsert,
} from './store.js';
import { meaningfulChars, sanitiseExtractedText, sanitiseFileName, sanitiseTitle } from './text.js';
import {
  VISION_PROMPT_TOKENS,
  VISION_SYSTEM_PROMPT,
  VISION_TYPICAL_OUTPUT_TOKENS,
  transcribePage,
  type PageKind,
  type VisionDeps,
} from './vision.js';

export interface FilesPageInput {
  readonly token: string | null | undefined;
  readonly body: unknown;
}

export interface FilesEstimateReply {
  readonly action: 'estimate';
  readonly pages: number;
  readonly perPageUsd: number;
  readonly estimateUsd: number;
  readonly dailyCapUsd: number;
  readonly spentTodayUsd: number;
  /** False: today's (or this month's) budget cannot cover it, and nothing should be started. */
  readonly affordable: boolean;
}

export interface FilesBeginReply {
  readonly action: 'begin';
  readonly fileId: string;
  readonly conversationId: string;
  readonly status: FileStatus;
  /** The same file is already attached here; `file` is that attachment. */
  readonly duplicate: boolean;
  /** Pages already stored for this upload — where a resumed upload picks up. */
  readonly pagesStored: readonly number[];
  readonly file: FileView | null;
}

export interface FilesAppendReply {
  readonly action: 'append';
  readonly fileId: string;
  readonly stored: number;
}

export interface FilesReadPageReply {
  readonly action: 'read_page';
  readonly fileId: string;
  readonly pageNo: number;
  /** Null when the page was already read and is answered from the record. */
  readonly pageKind: PageKind | null;
  readonly legibility: Legibility;
  readonly chars: number;
  readonly replayed: boolean;
}

export interface FilesFinishReply {
  readonly action: 'finish';
  readonly duplicate: boolean;
  /** Older reads of the same address that this one took the place of. */
  readonly replaced: number;
  readonly file: FileView;
}

/**
 * What comes back WITH the bytes of a fetched page. Nothing here is the page's own words:
 * the host and the file name are from the address, the rest is measured.
 */
export interface FilesFetchReply {
  readonly action: 'fetch_page';
  /** The server's record of this fetch; `begin` must quote it. */
  readonly fetchId: string;
  /** The host that answered, after redirects. */
  readonly host: string;
  /** The last piece of the address, as a hint to the reader (".csv" is a table, not prose). */
  readonly fileName: string;
  readonly contentType: string | null;
  readonly byteSize: number;
  readonly contentHash: string;
}

export interface FilesRemoveReply {
  readonly action: 'remove';
  readonly fileId: string;
  readonly removed: boolean;
}

export interface FilesRefusedReply {
  readonly action: 'refused';
  readonly logged: true;
}

export type FilesReply =
  | FilesEstimateReply
  | FilesBeginReply
  | FilesAppendReply
  | FilesReadPageReply
  | FilesFinishReply
  | FilesRemoveReply
  | FilesRefusedReply;

export interface FilesErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    /** Set when the file itself was refused: the browser shows the same sentence it would have. */
    readonly refusal?: RefusalCode;
  };
}

export type FilesErrorStatus =
  400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503 | 504;

export type FilesPageResult =
  | { readonly status: 200; readonly body: FilesReply }
  /** The one reply that is not JSON: the page's bytes, with `body` carried in a header. */
  | { readonly status: 200; readonly body: FilesFetchReply; readonly bytes: Uint8Array }
  | { readonly status: FilesErrorStatus; readonly body: FilesErrorBody };

export interface FilesPageDeps {
  readonly verify: VerifyDeps;
  readonly conversations: Pick<ConversationStore, 'get' | 'create'>;
  readonly files: FileStore;
  readonly vision: VisionDeps;
  /** The cap's ledger, read for the estimate. The cap itself is enforced in client.ts. */
  readonly usage: Pick<UsageStore, 'spentSince'>;
  readonly caps: SpendCaps;
  /** The price of the model that reads page images. */
  readonly visionPricing: ModelPricing;
  readonly config: FilesConfig;
  /** Milestone 5 part 2: the guarded fetch of one page (src/lib/pages/fetch.ts). */
  readonly pages: PageFetcher;
  /**
   * Milestone 5 part 5: learn an attachment that just became ready (knowledge/ingest.ts
   * `learnAttachment`). Never rejects. Absent without a Voyage key.
   */
  readonly learn?: (fileId: string) => Promise<void>;
  /** Keeps `learn` alive after the response: `EdgeRuntime.waitUntil` on Supabase. */
  readonly waitUntil?: (work: Promise<void>) => void;
  readonly log: Logger;
  readonly now?: () => Date;
  /** For the pause between two reads of one host. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export const FILES_MESSAGES = {
  notFound: 'That file or conversation is no longer available.',
  storeDown: 'The file could not be saved just now. Nothing was kept. Try again.',
  incomplete: 'Not every page of this file arrived, so it was not attached. Try again.',
  closed: 'This upload has already finished or was removed. Attach the file again.',
  pageUnreadable: 'This page could not be read reliably, so the file was not attached. Try again.',
  pageDeclined: 'The assistant declined to read this page, so the file was not attached.',
  pageTimeout: 'Reading this page took too long. Nothing was attached. Try again.',
  upstream:
    'The assistant could not be reached to read this page. Nothing was attached. Try again.',
  rateLimited: 'The assistant is busy right now. Wait a moment and try again.',
  capDay:
    "Today's budget for the assistant has been used up, so this page was not read and the file was not attached. It resets at midnight UTC.",
  capMonth:
    "This month's budget for the assistant has been used up, so this page was not read and the file was not attached.",
  readAgain: 'That page has to be opened again before it can be attached. Try again.',
  readAgainDrive:
    'That file has to be read from Google Drive again before it can be attached. Try again.',
  siteJustRead: 'That site was opened a moment ago. Wait a few seconds, then try again.',
  pageNotSaved:
    'The page was opened but could not be recorded just now, so it was not read. Try again.',
} as const;

function failure(
  status: FilesErrorStatus,
  code: string,
  message: string,
  retryable = false,
  refused?: RefusalCode,
): FilesPageResult {
  return {
    status,
    body: {
      error: { code, message, retryable, ...(refused === undefined ? {} : { refusal: refused }) },
    },
  };
}

function refuse(code: RefusalCode, detail = 0): FilesPageResult {
  return failure(422, 'FILE_REFUSED', refusal(code, detail).message, false, code);
}

function bad(message: string): FilesPageResult {
  return failure(400, 'BAD_REQUEST', message);
}

/** The page will not be read as it stands: the same sentence the browser would have shown. */
function refusePage(code: PageRefusalCode, detail = 0): FilesPageResult {
  return failure(422, 'PAGE_REFUSED', pageRefusalMessage(code, detail), false, code);
}

const RETRY_STATUS: Readonly<Record<PageRetryCode, FilesErrorStatus>> = {
  page_timeout: 504,
  site_unreachable: 502,
  site_error: 502,
  site_resting: 503,
  robots_unavailable: 503,
  too_many_reads: 429,
};

/** The page was not read this time, and may be next time. */
function retryPage(code: PageRetryCode): FilesPageResult {
  return failure(RETRY_STATUS[code], 'PAGE_NOT_READ', PAGE_RETRY_MESSAGES[code], true);
}

const UUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const KIND = z.enum(FILE_KINDS);
// Anything a browser could have measured; the limits are applied in the handler so that
// "too big" is a sentence about the file, not a schema error.
const COUNT = z.number().int().min(0).max(1_000_000_000);

const REQUEST = z.discriminatedUnion('action', [
  z.object({ action: z.literal('estimate'), visionPages: COUNT }),
  z.object({
    action: z.literal('begin'),
    requestId: UUID,
    conversationId: UUID.nullable().optional(),
    name: z.string().max(2_000),
    kind: KIND,
    byteSize: COUNT,
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    totalPages: COUNT,
    visionPages: COUNT,
    extractMs: z.number().min(0).max(86_400_000).optional(),
    /** Milestone 5 part 2: the fetch these bytes came from, and the page's own title. */
    fetchId: UUID.optional(),
    title: z.string().max(2_000).optional(),
    /** Milestone 5 part 3a: the Drive read these bytes came from. */
    driveReadId: UUID.optional(),
  }),
  z.object({
    action: z.literal('fetch_page'),
    requestId: UUID,
    // The limit on an address is applied by the guard, so "too long" is a sentence.
    url: z.string().max(8_192),
  }),
  z.object({
    action: z.literal('append'),
    fileId: UUID,
    pages: z
      .array(z.object({ pageNo: COUNT, label: z.string().max(2_000), text: z.string() }))
      .min(1)
      .max(FILE_LIMITS.appendBatchPages),
  }),
  z.object({
    action: z.literal('read_page'),
    fileId: UUID,
    pageNo: COUNT,
    label: z.string().max(2_000),
    imageBase64: z.string(),
  }),
  z.object({ action: z.literal('finish'), fileId: UUID }),
  z.object({ action: z.literal('remove'), fileId: UUID }),
  z.object({
    action: z.literal('refused'),
    kind: KIND.nullable(),
    byteSize: COUNT,
    reason: z.enum(REFUSAL_CODES),
    extractMs: z.number().min(0).max(86_400_000).optional(),
    /** The fetch that handed the browser the page it then refused. */
    fetchId: UUID.optional(),
    /** The Drive read that handed the browser the file it then refused. */
    driveReadId: UUID.optional(),
  }),
]);

type FilesRequest = z.infer<typeof REQUEST>;
type ActionRequest<A extends FilesRequest['action']> = Extract<FilesRequest, { action: A }>;

function toView(record: FileRecord): FileView {
  return {
    id: record.id,
    conversationId: record.conversationId,
    uploadedBy: record.uploadedBy,
    name: record.name,
    kind: record.kind,
    byteSize: record.byteSize,
    pageCount: record.pageCount,
    charCount: record.charCount,
    visionPages: record.visionPages,
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    sourceUrl: record.sourceUrl,
    sourceHost: record.sourceHost,
    fetchedAt: record.fetchedAt,
    valuesMissing: record.valuesMissing,
    readAsSent: record.readAsSent,
    driveFileId: record.driveFileId,
  };
}

/** A page label as one clean line. Never trusted to be short or printable. */
function cleanLabel(raw: string, pageNo: number): string {
  const label = sanitiseExtractedText(raw).replace(/\s+/g, ' ').slice(0, 200).trim();
  return label === '' ? `Part ${String(pageNo)}` : label;
}

/** What one vision page is expected to cost, and the most the cap will reserve for it. */
export function visionPageCosts(
  pricing: ModelPricing,
  maxTokens: number,
): { readonly typicalUsd: number; readonly reservedUsd: number } {
  return {
    typicalUsd: costUsd(pricing, {
      inputTokens: IMAGE_WORST_CASE_TOKENS + VISION_PROMPT_TOKENS,
      outputTokens: VISION_TYPICAL_OUTPUT_TOKENS,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    reservedUsd: estimateWorstCaseUsd(
      pricing,
      VISION_SYSTEM_PROMPT.length + 64,
      maxTokens,
      IMAGE_WORST_CASE_TOKENS,
    ),
  };
}

/** A Claude-side failure while reading a page → a status and a sentence about the FILE. */
export function mapVisionError(error: LlmError): FilesPageResult {
  switch (error.code) {
    case 'SPEND_CAP':
      return failure(
        402,
        'SPEND_CAP',
        error.context['window'] === 'day' ? FILES_MESSAGES.capDay : FILES_MESSAGES.capMonth,
      );
    case 'RATE_LIMITED':
      return failure(429, 'RATE_LIMITED', FILES_MESSAGES.rateLimited, true);
    case 'MODEL_REFUSAL':
      return failure(422, 'MODEL_REFUSAL', FILES_MESSAGES.pageDeclined);
    case 'TIMEOUT':
      return failure(504, 'TIMEOUT', FILES_MESSAGES.pageTimeout, true);
    case 'VALIDATION':
      return failure(502, 'PAGE_UNREADABLE', FILES_MESSAGES.pageUnreadable, true);
    case 'NETWORK':
    case 'CIRCUIT_OPEN':
    case 'HTTP_STATUS':
      return failure(
        error.code === 'HTTP_STATUS' ? 502 : 503,
        'UPSTREAM',
        FILES_MESSAGES.upstream,
        true,
      );
    case 'CONFIG':
      return failure(500, 'CONFIG', 'The file service is misconfigured.');
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
    case 'CONFLICT':
    case 'UNKNOWN_THROWN':
    case 'INTERNAL':
      return failure(500, 'INTERNAL', 'Internal error.');
  }
}

/** A database answer → a status and a sentence. Anything unrecognised is "try again". */
function mapStoreError(error: AppError): FilesPageResult {
  switch (fileStoreReason(error)) {
    case 'not_found':
      return failure(404, 'NOT_FOUND', FILES_MESSAGES.notFound);
    case 'too_many_files':
      return refuse('too_many_files');
    case 'not_reading':
      return failure(409, 'UPLOAD_CLOSED', FILES_MESSAGES.closed);
    case 'page_out_of_range':
      return bad('pageNo is outside the pages this upload declared.');
    case 'incomplete':
      return failure(409, 'INCOMPLETE', FILES_MESSAGES.incomplete, true);
    case 'no_text':
      return refuse('no_text');
    case 'too_long':
      return refuse('too_long');
    case 'bad_receipt':
      return failure(409, 'FETCH_EXPIRED', FILES_MESSAGES.readAgain, true);
    case 'too_many_reads':
      return retryPage('too_many_reads');
    case null:
      return failure(503, error.code, FILES_MESSAGES.storeDown, true);
  }
}

interface Ctx {
  readonly deps: FilesPageDeps;
  readonly user: StaffIdentity;
  readonly log: Logger;
  readonly now: () => Date;
}

/** The file, if it exists AND this person may see its conversation. Otherwise a 404. */
async function visibleFile(
  ctx: Ctx,
  fileId: string,
): Promise<
  | { readonly ok: true; readonly file: FileRecord }
  | { readonly ok: false; readonly result: FilesPageResult }
> {
  const found = await ctx.deps.files.get(fileId);
  if (!found.ok) {
    ctx.log.error('file read failed', { fileId, error: found.error });
    return { ok: false, result: mapStoreError(found.error) };
  }
  const file = found.value;
  if (file === null || !canSeeConversationFiles(file, ctx.user.userId)) {
    return { ok: false, result: failure(404, 'NOT_FOUND', FILES_MESSAGES.notFound) };
  }
  return { ok: true, file };
}

async function estimate(ctx: Ctx, request: ActionRequest<'estimate'>): Promise<FilesPageResult> {
  const pages = request.visionPages;
  if (pages < 1) return bad('visionPages must be at least 1.');
  if (pages > FILE_LIMITS.maxVisionPages) return refuse('too_many_scanned_pages', pages);
  const at = ctx.now();
  const day = await ctx.deps.usage.spentSince('anthropic', utcDayStart(at));
  const month = day.ok ? await ctx.deps.usage.spentSince('anthropic', utcMonthStart(at)) : day;
  if (!day.ok || !month.ok) {
    // The same rule the cap itself follows: spend that cannot be read is not guessed at.
    ctx.log.error('spend-to-date unavailable for a file estimate', {
      error: day.ok ? (month.ok ? null : month.error) : day.error,
    });
    return failure(503, 'SPEND_UNAVAILABLE', FILES_MESSAGES.storeDown, true);
  }
  const { typicalUsd, reservedUsd } = visionPageCosts(
    ctx.deps.visionPricing,
    ctx.deps.config.visionMaxTokens,
  );
  const estimateUsd = roundUsd(typicalUsd * pages);
  // The last page still has to pass the cap's own check, which reserves the worst case.
  const needed = typicalUsd * (pages - 1) + reservedUsd;
  return {
    status: 200,
    body: {
      action: 'estimate',
      pages,
      perPageUsd: typicalUsd,
      estimateUsd,
      dailyCapUsd: ctx.deps.caps.dailyUsd,
      spentTodayUsd: day.value,
      affordable:
        day.value + needed <= ctx.deps.caps.dailyUsd &&
        month.value + needed <= ctx.deps.caps.monthlyUsd,
    },
  };
}

async function begin(ctx: Ctx, request: ActionRequest<'begin'>): Promise<FilesPageResult> {
  const { deps, user, log } = ctx;
  const refusedHere = (code: RefusalCode, detail = 0): FilesPageResult => {
    log.info('file upload refused', {
      userId: user.userId,
      kind: request.kind,
      byteSize: request.byteSize,
      reason: code,
      extractMs: request.extractMs ?? null,
      at: 'server',
    });
    return refuse(code, detail);
  };

  if (request.byteSize < 1) return refusedHere('empty');
  if (request.byteSize > FILE_LIMITS.maxFileBytes)
    return refusedHere('too_large', request.byteSize);
  if (request.totalPages < 1) return refusedHere('no_text');
  if (request.totalPages > FILE_LIMITS.maxPages) {
    return refusedHere(request.kind === 'pdf' ? 'too_many_pages' : 'too_long', request.totalPages);
  }
  if (request.visionPages > FILE_LIMITS.maxVisionPages) {
    return refusedHere('too_many_scanned_pages', request.visionPages);
  }
  if (request.visionPages > request.totalPages) return bad('visionPages cannot exceed totalPages.');
  // Only a picture or a PDF has pages to look at; a picture is exactly one of them.
  if (request.kind === 'image' && (request.totalPages !== 1 || request.visionPages !== 1)) {
    return bad('An image is one page, read as an image.');
  }
  if (request.kind !== 'image' && request.kind !== 'pdf' && request.visionPages !== 0) {
    return bad('Only a PDF or an image can have pages read as images.');
  }

  // From a link (Milestone 5 part 2)? Then only against the server's own record of having
  // fetched exactly these bytes. The database checks again, under a lock (FL007); this check
  // is here so that each way of failing gets its own sentence. From Drive (part 3a): the same,
  // against the record of the read — and the name is Drive's, never the browser's.
  let sourceHost: string | null = null;
  let driveName: string | null = null;
  if (request.fetchId !== undefined && request.driveReadId !== undefined) {
    return bad('A file comes from a link or from Drive, not both.');
  }
  if (request.driveReadId !== undefined) {
    if (request.kind === 'html') return refusedHere('active_content');
    const found = await deps.files.getDriveRead(request.driveReadId);
    if (!found.ok) {
      log.error('drive read record unavailable for an upload', { error: found.error });
      return failure(503, found.error.code, FILES_MESSAGES.storeDown, true);
    }
    const receipt = found.value;
    // "Never read", "somebody else's", "refused" and "gone with a disconnect" are one answer.
    const usable = receipt?.userId === user.userId && receipt.status === 'fetched' ? receipt : null;
    if (usable?.name == null) {
      return failure(409, 'FETCH_EXPIRED', FILES_MESSAGES.readAgainDrive, true);
    }
    if (usable.byteSize !== request.byteSize || usable.contentHash !== request.contentHash) {
      return bad('What was sent is not the file that was read from Drive.');
    }
    driveName = usable.name;
  } else if (request.fetchId !== undefined) {
    const found = await deps.files.getFetch(request.fetchId);
    if (!found.ok) {
      log.error('fetch record unavailable for an upload', { error: found.error });
      return failure(503, found.error.code, FILES_MESSAGES.storeDown, true);
    }
    const receipt = found.value;
    // "Never fetched", "somebody else's" and "refused" are one answer: read it again.
    const usable = receipt?.userId === user.userId && receipt.status === 'fetched' ? receipt : null;
    if (usable?.finalHost == null) {
      return failure(409, 'FETCH_EXPIRED', FILES_MESSAGES.readAgain, true);
    }
    if (usable.byteSize !== request.byteSize || usable.contentHash !== request.contentHash) {
      return bad('What was sent is not the page that was fetched.');
    }
    sourceHost = usable.finalHost;
  } else if (request.kind === 'html') {
    // A web page that was uploaded rather than fetched is still refused (D83).
    return refusedHere('active_content');
  }

  let conversationId: string;
  if (request.conversationId === undefined || request.conversationId === null) {
    // Attaching first and asking second is the natural order, so an upload may open the
    // conversation. It is titled from the first message, as any other (llm/store.ts).
    const created = await deps.conversations.create(user.userId, null);
    if (!created.ok) {
      log.error('conversation create failed for an upload', { error: created.error });
      return failure(503, created.error.code, FILES_MESSAGES.storeDown, true);
    }
    conversationId = created.value.id;
  } else {
    const found = await deps.conversations.get(request.conversationId);
    if (!found.ok) {
      log.error('conversation read failed for an upload', { error: found.error });
      return failure(503, found.error.code, FILES_MESSAGES.storeDown, true);
    }
    const row = found.value;
    // "Does not exist", "was deleted" and "not yours" are one answer: no existence oracle.
    if (row === null) return failure(404, 'NOT_FOUND', FILES_MESSAGES.notFound);
    const visible =
      row.deletedAt === null &&
      canSeeConversationFiles({ conversationAuthorId: row.userId, scope: row.scope }, user.userId);
    if (!visible) return failure(404, 'NOT_FOUND', FILES_MESSAGES.notFound);
    conversationId = row.id;
  }

  const begun = await deps.files.begin({
    conversationId,
    uploadedBy: user.userId,
    requestId: request.requestId,
    // A page is named by its own title where it has one, and by its host where it has not;
    // either way the words are the page's, and are cleaned like a stranger's file name. A
    // Drive file is named as Drive named it when it was read (the database insists too).
    name:
      driveName ??
      (sourceHost === null
        ? sanitiseFileName(request.name)
        : sanitiseTitle(request.title ?? request.name, sourceHost)),
    kind: request.kind,
    byteSize: request.byteSize,
    contentHash: request.contentHash,
    expectedPages: request.totalPages,
    visionPages: request.visionPages,
    // A web page goes stale in a day (D95); a document reached by a link is a document.
    retentionDays:
      request.kind === 'html' ? deps.config.pageRetentionDays : deps.config.retentionDays,
    ...(request.fetchId === undefined ? {} : { fetchId: request.fetchId }),
    ...(request.driveReadId === undefined ? {} : { driveReadId: request.driveReadId }),
  });
  if (!begun.ok) {
    if (fileStoreReason(begun.error) === 'too_many_files') return refusedHere('too_many_files');
    log.error('file upload could not be started', { conversationId, error: begun.error });
    return mapStoreError(begun.error);
  }

  let file: FileView | null = null;
  if (begun.value.status === 'ready') {
    const existing = await deps.files.get(begun.value.id);
    if (existing.ok && existing.value !== null) file = toView(existing.value);
  }
  log.info('file upload started', {
    userId: user.userId,
    conversationId,
    fileId: begun.value.id,
    kind: request.kind,
    byteSize: request.byteSize,
    pages: request.totalPages,
    visionPages: request.visionPages,
    extractMs: request.extractMs ?? null,
    resumed: begun.value.existing && !begun.value.duplicate,
    duplicate: begun.value.duplicate,
    source: driveName !== null ? 'drive' : sourceHost === null ? 'upload' : 'link',
  });
  return {
    status: 200,
    body: {
      action: 'begin',
      fileId: begun.value.id,
      conversationId,
      status: begun.value.status,
      duplicate: begun.value.duplicate,
      pagesStored: begun.value.pagesStored,
      file,
    },
  };
}

async function append(ctx: Ctx, request: ActionRequest<'append'>): Promise<FilesPageResult> {
  const seen = await visibleFile(ctx, request.fileId);
  if (!seen.ok) return seen.result;
  const { file } = seen;
  if (file.status !== 'reading') return failure(409, 'UPLOAD_CLOSED', FILES_MESSAGES.closed);
  const method = BROWSER_METHOD[file.kind];
  if (method === null) return bad('This kind of file has no text pages; send it with read_page.');

  const pages: PageInsert[] = [];
  let chars = 0;
  for (const page of request.pages) {
    if (page.pageNo < 1 || page.pageNo > file.expectedPages) {
      return bad('pageNo is outside the pages this upload declared.');
    }
    // Cleaned here whatever the browser did: this text is about to be stored and shown to a
    // model, and the browser is not the last line of anything.
    const content = sanitiseExtractedText(page.text);
    if (content === '') return bad('A page with no text cannot be stored.');
    if (content.length > FILE_LIMITS.maxPageChars) return refuse('too_long');
    chars += content.length;
    pages.push({
      pageNo: page.pageNo,
      label: cleanLabel(page.label, page.pageNo),
      content,
      method,
      confidence: PARSED_CONFIDENCE,
      legibility: 'full',
      letterCount: meaningfulChars(content),
    });
  }
  if (chars > FILE_LIMITS.appendBatchChars) return bad('Too much text in one request.');

  const stored = await ctx.deps.files.appendPages(file.id, pages);
  if (!stored.ok) {
    ctx.log.error('file pages could not be stored', { fileId: file.id, error: stored.error });
    return mapStoreError(stored.error);
  }
  return { status: 200, body: { action: 'append', fileId: file.id, stored: stored.value } };
}

// A JPEG's first three bytes (FF D8 FF) are always "/9j/" in base64.
const JPEG_BASE64_PREFIX = '/9j/';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const BLANK_PAGE_TEXT = '(This page is blank.)';
export const UNREADABLE_PAGE_TEXT = '(This page could not be read.)';
export const PHOTO_LABEL_NOTE = 'a description of a picture, not a document';

async function readPage(ctx: Ctx, request: ActionRequest<'read_page'>): Promise<FilesPageResult> {
  const { deps, user, log } = ctx;
  const seen = await visibleFile(ctx, request.fileId);
  if (!seen.ok) return seen.result;
  const { file } = seen;
  if (file.status !== 'reading') return failure(409, 'UPLOAD_CLOSED', FILES_MESSAGES.closed);
  if (file.kind !== 'pdf' && file.kind !== 'image') {
    return bad('Only a PDF or an image has pages that are read as images.');
  }
  if (request.pageNo < 1 || request.pageNo > file.expectedPages) {
    return bad('pageNo is outside the pages this upload declared.');
  }
  const image = request.imageBase64;
  if (
    image.length < 64 ||
    image.length > FILE_LIMITS.maxImageBase64Chars ||
    !image.startsWith(JPEG_BASE64_PREFIX) ||
    !BASE64.test(image)
  ) {
    return bad('imageBase64 must be a JPEG, base64-encoded, within the size limit.');
  }

  // Already read? Answer from the record. A retry after a dropped response must not be paid
  // for twice, and the page a person is waiting on is the same page either way.
  const existing = await deps.files.pageInfo(file.id, request.pageNo);
  if (!existing.ok) {
    log.error('file page lookup failed', { fileId: file.id, error: existing.error });
    return mapStoreError(existing.error);
  }
  if (existing.value !== null) {
    return {
      status: 200,
      body: {
        action: 'read_page',
        fileId: file.id,
        pageNo: request.pageNo,
        pageKind: null,
        legibility: existing.value.legibility,
        chars: existing.value.chars,
        replayed: true,
      },
    };
  }

  // The declared number of image pages is the most this upload may spend on.
  const used = await deps.files.visionPagesStored(file.id);
  if (!used.ok) {
    log.error('file page count failed', { fileId: file.id, error: used.error });
    return mapStoreError(used.error);
  }
  if (used.value >= Math.min(file.visionPages, FILE_LIMITS.maxVisionPages)) {
    return refuse('too_many_scanned_pages', used.value + 1);
  }

  const started = ctx.now().getTime();
  const read = await transcribePage(deps.vision, {
    imageBase64: image,
    userId: user.userId,
    conversationId: file.conversationId,
  });
  const ms = ctx.now().getTime() - started;
  if (!read.ok) {
    log.error('file page not read', {
      fileId: file.id,
      pageNo: request.pageNo,
      code: read.error.code,
      ms,
    });
    return mapVisionError(read.error);
  }
  const page = read.value;
  const baseLabel = cleanLabel(request.label, request.pageNo);
  const content =
    page.kind === 'blank'
      ? BLANK_PAGE_TEXT
      : page.text.trim() === ''
        ? UNREADABLE_PAGE_TEXT
        : page.text.slice(0, FILE_LIMITS.maxPageChars);
  const stored = await deps.files.appendPages(file.id, [
    {
      pageNo: request.pageNo,
      label: page.kind === 'photo' ? `${baseLabel} (${PHOTO_LABEL_NOTE})` : baseLabel,
      content,
      method: 'claude_vision',
      confidence: page.confidence,
      legibility: page.legibility,
      // A blank or unreadable page contributes nothing to "is there anything here".
      letterCount: page.kind === 'blank' || page.text.trim() === '' ? 0 : page.letterCount,
    },
  ]);
  if (!stored.ok) {
    log.error('file page read but not stored', { fileId: file.id, error: stored.error });
    return mapStoreError(stored.error);
  }
  log.info('file page read', {
    fileId: file.id,
    pageNo: request.pageNo,
    pageKind: page.kind,
    legibility: page.legibility,
    chars: content.length,
    truncated: page.truncated,
    attempts: page.attempts,
    costUsd: page.costUsd,
    ms,
  });
  return {
    status: 200,
    body: {
      action: 'read_page',
      fileId: file.id,
      pageNo: request.pageNo,
      pageKind: page.kind,
      legibility: page.legibility,
      chars: content.length,
      replayed: false,
    },
  };
}

/**
 * Milestone 5 part 5: an attached file starts being learned the moment it is ready — cut into
 * chunks at once (so a page's one-day text cannot be purged first), then embedded as fast as
 * Voyage allows. AFTER the answer: `waitUntil` keeps it alive past the response, and nothing it
 * does or fails to do can change whether the file was attached. Without a Voyage key there is
 * no `learn` and the schedule has nothing to embed with either.
 */
function scheduleLearning(deps: FilesPageDeps, fileId: string): void {
  if (deps.learn === undefined) return;
  const work = deps.learn(fileId).catch((caught: unknown) => {
    deps.log.error('learning a new attachment rejected', {
      fileId,
      errorName: caught instanceof Error ? caught.name : typeof caught,
    });
  });
  deps.waitUntil?.(work);
}

async function finish(ctx: Ctx, request: ActionRequest<'finish'>): Promise<FilesPageResult> {
  const { deps, user, log } = ctx;
  const seen = await visibleFile(ctx, request.fileId);
  if (!seen.ok) return seen.result;
  const { file } = seen;
  if (file.status === 'removed') return failure(409, 'UPLOAD_CLOSED', FILES_MESSAGES.closed);

  const done = await deps.files.finish(file.id, user.userId);
  if (!done.ok) {
    const reason = fileStoreReason(done.error);
    log.info('file upload failed', {
      userId: user.userId,
      conversationId: file.conversationId,
      fileId: file.id,
      kind: file.kind,
      byteSize: file.byteSize,
      outcome: reason ?? done.error.code,
    });
    if (reason === 'no_text' || reason === 'too_long') {
      // Nothing usable came out of it. The half-stored upload goes now rather than in fifteen
      // minutes: there must be no file a person can see but not use.
      const removed = await deps.files.remove(file.id, user.userId);
      if (!removed.ok)
        log.error('unusable upload not removed', { fileId: file.id, error: removed.error });
    }
    return mapStoreError(done.error);
  }

  const stored = await deps.files.get(done.value.id);
  if (!stored.ok || stored.value === null) {
    log.error('finished file could not be read back', {
      fileId: done.value.id,
      error: stored.ok ? null : stored.error,
    });
    return failure(503, 'INTERNAL', FILES_MESSAGES.storeDown, true);
  }
  log.info('file upload finished', {
    userId: user.userId,
    conversationId: file.conversationId,
    fileId: done.value.id,
    kind: file.kind,
    byteSize: file.byteSize,
    pages: done.value.pageCount,
    chars: done.value.charCount,
    visionPages: done.value.visionPages,
    totalMs: ctx.now().getTime() - new Date(file.createdAt).getTime(),
    outcome: done.value.duplicate ? 'duplicate' : done.value.already ? 'already' : 'attached',
    source:
      stored.value.driveFileId !== null
        ? 'drive'
        : stored.value.sourceHost === null
          ? 'upload'
          : 'link',
    valuesMissing: stored.value.valuesMissing,
    readAsSent: stored.value.readAsSent,
    replaced: done.value.replaced,
  });
  if (!done.value.duplicate && !done.value.already) scheduleLearning(deps, done.value.id);
  return {
    status: 200,
    body: {
      action: 'finish',
      duplicate: done.value.duplicate,
      replaced: done.value.replaced,
      file: toView(stored.value),
    },
  };
}

// ---------------------------------------------------------------------------------------
// fetch_page (Milestone 5 part 2)
// ---------------------------------------------------------------------------------------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The last piece of an address, as a name for the reader: `rates.csv` is read as a table and
 * `rates` as prose (web/src/lib/files/sniff.ts). From the address only, never from the page.
 */
export function fileNameFromUrl(url: PublicUrl): string {
  const path = url.pathAndQuery.split('?')[0] ?? '';
  const last =
    path
      .split('/')
      .filter((piece) => piece !== '')
      .pop() ?? '';
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // Not valid percent-encoding: the raw piece is still a usable hint.
  }
  return decoded === '' ? url.host : sanitiseFileName(decoded);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchPage(ctx: Ctx, request: ActionRequest<'fetch_page'>): Promise<FilesPageResult> {
  const { deps, user, log } = ctx;
  const fetchId = request.requestId;

  // The address rules first. An address that would never be opened is not counted against
  // anyone and not recorded: there is nothing to record but a refusal.
  const parsed = parsePublicUrl(request.url);
  if (!parsed.ok) {
    log.info('page not read', {
      userId: user.userId,
      fetchId,
      host: null,
      outcome: parsed.refusal,
      at: 'address',
    });
    return refusePage(parsed.refusal);
  }
  const url = parsed.url;

  // May this read go ahead? Per person, and per host (SECURITY.md §10).
  const claimInput = {
    id: fetchId,
    userId: user.userId,
    url: url.href,
    host: url.host,
    perMinute: PAGE_LIMITS.readsPerMinute,
    hostGapMs: PAGE_LIMITS.hostGapMs,
  };
  let claim = await deps.files.claimFetch(claimInput);
  if (claim.ok && !claim.value.claimed && !claim.value.spent) {
    // Somebody read this site a moment ago. Wait it out once rather than send him away.
    await (deps.sleep ?? defaultSleep)(Math.min(claim.value.waitMs, PAGE_LIMITS.hostGapMs));
    claim = await deps.files.claimFetch(claimInput);
  }
  if (!claim.ok) {
    const reason = fileStoreReason(claim.error);
    if (reason === 'too_many_reads') {
      log.info('page not read', {
        userId: user.userId,
        fetchId,
        host: url.host,
        outcome: 'too_many_reads',
        at: 'limit',
      });
    } else {
      log.error('page read could not be claimed', { fetchId, host: url.host, error: claim.error });
    }
    return mapStoreError(claim.error);
  }
  if (!claim.value.claimed) {
    const spent = claim.value.spent;
    log.info('page not read', {
      userId: user.userId,
      fetchId,
      host: url.host,
      outcome: spent ? 'read_id_spent' : 'site_just_read',
      at: 'limit',
    });
    // One id opens one page, once. A repeat opens nothing — it is not a way round the limits
    // — and the browser is told to ask again, which it does under a new id.
    return spent
      ? failure(409, 'FETCH_EXPIRED', FILES_MESSAGES.readAgain, true)
      : failure(429, 'PAGE_NOT_READ', FILES_MESSAGES.siteJustRead, true);
  }

  const result = await deps.pages.read(url.href);
  const facts = result.facts;
  // One line per read, whatever happened. Host, status, type, size, time, outcome — and
  // whether there was a query, but never the query, the path or anything from the page.
  const line = {
    userId: user.userId,
    fetchId,
    host: url.host,
    finalHost: facts.finalHost,
    hops: facts.hops,
    httpStatus: facts.httpStatus,
    contentType: facts.contentType,
    bytes: facts.bytes,
    ms: facts.ms,
    hadQuery: url.hasQuery,
  };

  if (!result.ok) {
    const recorded = await deps.files.completeFetch({
      id: fetchId,
      userId: user.userId,
      status: result.kind === 'refused' ? 'refused' : 'failed',
      outcome: result.code,
      finalHost: facts.finalHost,
      httpStatus: facts.httpStatus,
      contentType: facts.contentType,
      hops: facts.hops,
      durationMs: facts.ms,
    });
    if (!recorded.ok) {
      log.error('page outcome not recorded', { fetchId, error: recorded.error });
    }
    log.info('page not read', { ...line, outcome: result.code, at: 'site' });
    return result.kind === 'refused'
      ? refusePage(result.code, result.detail)
      : retryPage(result.code);
  }

  const { page } = result;
  const contentHash = await sha256Hex(page.bytes);
  const recorded = await deps.files.completeFetch({
    id: fetchId,
    userId: user.userId,
    status: 'fetched',
    outcome: null,
    finalUrl: page.final.href,
    finalHost: page.final.host,
    httpStatus: facts.httpStatus,
    contentType: page.contentType,
    byteSize: page.bytes.length,
    contentHash,
    hops: facts.hops,
    durationMs: facts.ms,
  });
  if (!recorded.ok || !recorded.value) {
    // Without the record these bytes could never be attached. Better to say so now than
    // to hand over a page that `begin` will then refuse.
    log.error('page fetched but not recorded', {
      fetchId,
      host: url.host,
      error: recorded.ok ? null : recorded.error,
    });
    return failure(503, 'PAGE_NOT_READ', FILES_MESSAGES.pageNotSaved, true);
  }
  log.info('page fetched', { ...line, outcome: 'fetched' });
  return {
    status: 200,
    body: {
      action: 'fetch_page',
      fetchId,
      host: page.final.host,
      fileName: fileNameFromUrl(page.final),
      contentType: page.contentType,
      byteSize: page.bytes.length,
      contentHash,
    },
    bytes: page.bytes,
  };
}

async function remove(ctx: Ctx, request: ActionRequest<'remove'>): Promise<FilesPageResult> {
  const { deps, user, log } = ctx;
  const seen = await visibleFile(ctx, request.fileId);
  if (!seen.ok) return seen.result;
  const { file } = seen;
  const verdict = canRemoveFile(file, { userId: user.userId, isAdmin: user.isAdmin });
  if (!verdict.allowed) return failure(403, 'FORBIDDEN', FILE_REMOVAL_DENIED_MESSAGE);

  const removed = await deps.files.remove(file.id, user.userId);
  if (!removed.ok) {
    log.error('file could not be removed', { fileId: file.id, error: removed.error });
    return mapStoreError(removed.error);
  }
  log.info('file removed', {
    userId: user.userId,
    conversationId: file.conversationId,
    fileId: file.id,
    kind: file.kind,
    wasStatus: file.status,
    because: verdict.because,
    changed: removed.value,
  });
  return { status: 200, body: { action: 'remove', fileId: file.id, removed: removed.value } };
}

async function refusedByBrowser(
  ctx: Ctx,
  request: ActionRequest<'refused'>,
): Promise<FilesPageResult> {
  ctx.log.info('file upload refused', {
    userId: ctx.user.userId,
    kind: request.kind,
    byteSize: request.byteSize,
    reason: request.reason,
    extractMs: request.extractMs ?? null,
    at: 'browser',
    ...(request.fetchId === undefined ? {} : { fetchId: request.fetchId, source: 'link' }),
    // The Drive record is not closed here: it is checked byte for byte at `begin`, these
    // bytes were refused, and it expires with the read's fifteen minutes in any case.
    ...(request.driveReadId === undefined
      ? {}
      : { driveReadId: request.driveReadId, source: 'drive' }),
  });
  if (request.fetchId !== undefined) {
    // The page was fetched and then found to be a paywall, a login page, nothing at all.
    // Closing the record means those bytes can no longer be attached by anyone. Best effort:
    // the refusal has been shown either way, and the record expires on its own.
    const closed = await ctx.deps.files.completeFetch({
      id: request.fetchId,
      userId: ctx.user.userId,
      status: 'refused',
      outcome: request.reason,
    });
    if (!closed.ok) {
      ctx.log.error('refused page not recorded', { fetchId: request.fetchId, error: closed.error });
    }
  }
  return { status: 200, body: { action: 'refused', logged: true } };
}

async function route(deps: FilesPageDeps, input: FilesPageInput): Promise<FilesPageResult> {
  const log = deps.log.child({ component: 'files' });

  const access = await verifyStaffAccess(deps.verify, input.token);
  if (!access.ok) {
    log.error('caller verification unavailable', { error: access.error });
    return failure(503, access.error.code, 'Service temporarily unavailable', true);
  }
  if (access.value.kind === 'unauthenticated') {
    return failure(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  }
  if (access.value.kind === 'forbidden') {
    return failure(403, 'FORBIDDEN', 'This account does not have access.');
  }

  const parsed = REQUEST.safeParse(input.body);
  if (!parsed.success) {
    // The path of the first problem, never the value: a body here may hold a page of text.
    const first = parsed.error.issues[0];
    const where = first === undefined || first.path.length === 0 ? 'body' : first.path.join('.');
    return bad(`Invalid request: ${where}.`);
  }
  const ctx: Ctx = {
    deps,
    user: access.value.user,
    log,
    now: deps.now ?? ((): Date => new Date()),
  };
  const request = parsed.data;
  switch (request.action) {
    case 'estimate':
      return estimate(ctx, request);
    case 'begin':
      return begin(ctx, request);
    case 'fetch_page':
      return fetchPage(ctx, request);
    case 'append':
      return append(ctx, request);
    case 'read_page':
      return readPage(ctx, request);
    case 'finish':
      return finish(ctx, request);
    case 'remove':
      return remove(ctx, request);
    case 'refused':
      return refusedByBrowser(ctx, request);
  }
}

export async function handleFilesRequest(
  deps: FilesPageDeps,
  input: FilesPageInput,
): Promise<FilesPageResult> {
  try {
    return await route(deps, input);
  } catch (caught: unknown) {
    // Nothing above is supposed to throw. If it does it is a 500 with the cause's NAME
    // logged — not the cause itself, which could be holding a request body.
    deps.log.error('files request threw', {
      errorName: caught instanceof Error ? caught.name : typeof caught,
    });
    return failure(500, 'INTERNAL', 'Internal error.');
  }
}
