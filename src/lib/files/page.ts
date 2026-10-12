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
 *
 * Order in every action: who is asking (401/403 before any work), then the input, then
 * whether they may touch THIS conversation or file — and "not yours" answers exactly as "not
 * found", so the endpoint is not an oracle for which ids exist.
 *
 * Logging (CLAUDE.md rule 20 and this part's hard boundary): ids, kinds, sizes, counts,
 * durations, outcomes. Never a file's name, never a word of its content — not in a log line,
 * not in an error message, not in a thrown error's context.
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
import { meaningfulChars, sanitiseExtractedText, sanitiseFileName } from './text.js';
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
  readonly file: FileView;
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
  readonly log: Logger;
  readonly now?: () => Date;
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
    name: sanitiseFileName(request.name),
    kind: request.kind,
    byteSize: request.byteSize,
    contentHash: request.contentHash,
    expectedPages: request.totalPages,
    visionPages: request.visionPages,
    retentionDays: deps.config.retentionDays,
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
  });
  return {
    status: 200,
    body: { action: 'finish', duplicate: done.value.duplicate, file: toView(stored.value) },
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

function refusedByBrowser(ctx: Ctx, request: ActionRequest<'refused'>): FilesPageResult {
  ctx.log.info('file upload refused', {
    userId: ctx.user.userId,
    kind: request.kind,
    byteSize: request.byteSize,
    reason: request.reason,
    extractMs: request.extractMs ?? null,
    at: 'browser',
  });
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
