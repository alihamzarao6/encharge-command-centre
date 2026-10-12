/**
 * The limits and the words for reading files (Milestone 5 part 1) — imported by the browser
 * AND by the Edge Function, so a number the interface promises is the number the server
 * enforces (the pattern `crm/notes.ts` and `memory/access.ts` set). Pure constants and pure
 * functions; nothing here reads an environment or touches a network.
 *
 * Every refusal is a sentence the person can act on. A file that is not read is never a
 * silent failure: the code says which rule refused it, the sentence says what to do next.
 *
 * Milestone 5 part 2 adds one kind (`html`, a web page read from a link) and the reasons a
 * page is not read. Those reasons and their sentences live in pages/limits.ts and are part of
 * the same list here, so a page that is refused travels the same path as a file that is.
 */
import {
  PAGE_REFUSAL_CODES,
  isPageRefusalCode,
  pageRefusalMessage,
  type PageRefusalCode,
} from '../pages/limits.js';

/**
 * Put at the start of a table row whose cells could not be matched to columns: the row has
 * fewer cells than the rows around it and nothing on the page says which column each one
 * belongs to. The rules tell the model to quote such a row as it stands and never to present
 * one of its figures under a column heading (rules.ts).
 */
export const UNCERTAIN_COLUMNS_MARK = '[columns uncertain]';

/**
 * Written in place of an empty table cell that the reader restored by position. A bare tab
 * would do for a parser; it does not for a model, which loses count of consecutive tabs
 * (measured 12 Oct: a fee after two empty cells was reported as blank). A visible word in
 * every column keeps each value under its own heading.
 */
export const EMPTY_CELL_MARK = '(blank)';

export const FILE_KINDS = ['pdf', 'docx', 'xlsx', 'csv', 'text', 'image', 'html'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/**
 * How a page's text was obtained — the `extraction_method` half of provenance (CLAUDE.md
 * rule 12). `claude_vision` is written by the server only; a browser can never claim it.
 */
export const EXTRACTION_METHODS = [
  'pdf_text_layer',
  'claude_vision',
  'docx_xml',
  'xlsx_xml',
  'csv_parse',
  'plain_text',
  'html_text',
] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

/** The method a browser may send for each kind. Vision pages never arrive as text. */
export const BROWSER_METHOD: Readonly<Record<FileKind, ExtractionMethod | null>> = {
  pdf: 'pdf_text_layer',
  docx: 'docx_xml',
  xlsx: 'xlsx_xml',
  csv: 'csv_parse',
  text: 'plain_text',
  image: null,
  html: 'html_text',
};

/** Deterministic parses are exact; a transcription is only as good as the page was legible. */
export const PARSED_CONFIDENCE = 1;
export const VISION_CONFIDENCE = { full: 0.9, partial: 0.6, none: 0 } as const;
export type Legibility = keyof typeof VISION_CONFIDENCE;

const MB = 1024 * 1024;

export const FILE_LIMITS = {
  maxFileBytes: 20 * MB,
  maxFilesPerConversation: 10,
  /** Pages of a PDF, sheets-parts of a workbook, parts of a text file. */
  maxPages: 500,
  maxFileChars: 1_500_000,
  /** One stored page. A sheet or a text file is split into parts below this. */
  maxPageChars: 60_000,
  /** Photos and scanned pages read through vision, per file (D90). */
  maxVisionPages: 50,
  /** From this many vision pages up, the person is shown the page count and the cost first. */
  visionConfirmFromPages: 2,
  maxNameChars: 120,
  /** One page image as base64. A 2,048 px JPEG of a text page is 0.4–1.2 MB of it. */
  maxImageBase64Chars: 4_000_000,
  retentionDays: 30,
  abandonedAfterMinutes: 15,
  /** One `append` request. */
  appendBatchPages: 40,
  appendBatchChars: 240_000,
} as const;

/** The long edge a page image is scaled to before it is sent (px). */
export const VISION_IMAGE_LONG_EDGE = 2_048;

export const REFUSAL_CODES = [
  'empty',
  'too_large',
  'password_pdf',
  'legacy_office',
  'presentation',
  'archive',
  'active_content',
  'executable',
  'media',
  'unsupported',
  'corrupt',
  'expands_too_far',
  'heic_unsupported',
  'image_undecodable',
  'no_text',
  'too_many_pages',
  'too_long',
  'too_many_scanned_pages',
  'too_many_files',
  ...PAGE_REFUSAL_CODES,
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface Refusal {
  readonly code: RefusalCode;
  /** Plain words for the person holding the phone. Never contains the file's content. */
  readonly message: string;
}

/** "214 KB", "3.4 MB" — binary units, the way a phone's Files app shows them. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 bytes';
  if (bytes < 1024) return `${String(Math.round(bytes))} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < MB) return `${String(Math.round(bytes / 1024))} KB`;
  const mb = bytes / MB;
  return `${mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1)} MB`;
}

const LIMIT_MB = String(FILE_LIMITS.maxFileBytes / MB);

const FIXED_REFUSALS: Readonly<
  Record<
    Exclude<
      RefusalCode,
      'too_large' | 'too_many_pages' | 'too_many_scanned_pages' | PageRefusalCode
    >,
    string
  >
> = {
  empty: 'This file is empty (0 bytes), so there is nothing to read.',
  password_pdf:
    "This PDF is password-protected, so it can't be opened. Save a copy without the password and send that.",
  legacy_office:
    'This is an old-format Office file (.doc, .xls or .ppt), or one protected with a password. Save it as .docx, .xlsx or PDF, without a password, and send that.',
  presentation: "PowerPoint files aren't read. Save the slides as a PDF and send that.",
  archive: "Archives (.zip and the like) aren't accepted. Send the files inside it one at a time.",
  active_content:
    "This is a web page or an SVG file, which can carry scripts, so it isn't read. Save it as a PDF and send that.",
  executable: "This is a program, not a document, so it isn't read.",
  media: "Audio and video files aren't read.",
  unsupported:
    "This isn't a kind of file the assistant can read. It reads PDF, Word (.docx), Excel (.xlsx), CSV, text files and photos.",
  corrupt:
    "This file is damaged or incomplete and couldn't be opened. Try exporting or downloading it again.",
  expands_too_far:
    'This file unpacks to far more data than its size suggests, so it was not opened.',
  heic_unsupported:
    "This is an iPhone HEIC photo, which this browser can't open. Send it from the iPhone itself, or save it as a JPEG first.",
  image_undecodable: "This picture couldn't be opened. Try saving it as a JPEG or PNG.",
  no_text: 'Nothing readable was found in this file, so it was not attached.',
  too_long: `This document is too long to keep (over ${(FILE_LIMITS.maxFileChars / 1_000_000).toFixed(1)} million characters). Split it and send the part you need.`,
  too_many_files: `This conversation already has ${String(FILE_LIMITS.maxFilesPerConversation)} files attached. Remove one first.`,
};

/** `detail` is the measured number the sentence quotes: a byte size or a page count. */
export function refusal(code: RefusalCode, detail = 0): Refusal {
  if (isPageRefusalCode(code)) return { code, message: pageRefusalMessage(code, detail) };
  if (code === 'too_large') {
    return {
      code,
      message: `This file is ${formatBytes(detail)}, which is over the ${LIMIT_MB} MB limit.`,
    };
  }
  if (code === 'too_many_pages') {
    return {
      code,
      message: `This document has ${String(detail)} pages. The limit is ${String(FILE_LIMITS.maxPages)}. Split it and send the part you need.`,
    };
  }
  if (code === 'too_many_scanned_pages') {
    return {
      code,
      message: `This is a scan with ${String(detail)} pages that would have to be read as images. Up to ${String(FILE_LIMITS.maxVisionPages)} can be read from one file. Split it and send the pages that matter.`,
    };
  }
  return { code, message: FIXED_REFUSALS[code] };
}

export function isRefusalCode(value: unknown): value is RefusalCode {
  return typeof value === 'string' && (REFUSAL_CODES as readonly string[]).includes(value);
}

export function isFileKind(value: unknown): value is FileKind {
  return typeof value === 'string' && (FILE_KINDS as readonly string[]).includes(value);
}

/** What a kind is called on screen and in the block the model reads. */
export const KIND_LABEL: Readonly<Record<FileKind, string>> = {
  pdf: 'PDF',
  docx: 'Word document',
  xlsx: 'Excel workbook',
  csv: 'CSV',
  text: 'Text file',
  image: 'Photo',
  html: 'Web page',
};

/** The `accept` list for the file input. A hint to the picker; the bytes decide (sniff.ts). */
export const ACCEPT_ATTRIBUTE =
  '.pdf,.docx,.docm,.xlsx,.xlsm,.csv,.tsv,.txt,.md,image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif';
