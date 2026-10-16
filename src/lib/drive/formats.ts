/**
 * What to do with a file he picked from Drive (Milestone 5 part 3a, D120). Pure.
 *
 * Drive is a new way for bytes to arrive, not a new way to read them: whatever comes out of
 * here is handed to part 1's readers in the browser, unchanged. Google's own files are not
 * files — they have no bytes until they are exported — so each is exported to the format the
 * readers already read best:
 *
 *   Google Docs   → .docx  the Word reader keeps headings and tables; plain text would flatten
 *                          the tables, and Markdown embeds pictures as base64 into the text.
 *   Google Sheets → .xlsx  every sheet, hidden ones flagged, the sheet's own stored formula
 *                          results, totals in code (D92). CSV would be the first sheet only.
 *   Google Slides → PDF    one page per slide, so an answer can say which slide; a slide with
 *                          no text at all becomes a scanned page and is asked about first
 *                          (D90). .pptx has no reader (D83); plain text loses the slides.
 *
 * Every other Google type (Forms, Drawings, Sites, folders, …) is refused by name. Everything
 * that is an ordinary file is downloaded as it is, and the readers decide what it is by its
 * bytes — exactly as for a file chosen on the device, so a type refused there is refused here
 * with the same sentence.
 */
import { FILE_LIMITS } from '../files/limits.js';
import { sanitiseFileName } from '../files/text.js';
import { googleTypeLabel, type DriveRefusalCode } from './limits.js';

export const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

export interface ExportFormat {
  readonly mimeType: string;
  /** Added to the name handed to the reader, so it is read as what it now is. */
  readonly extension: string;
}

export const EXPORTS: Readonly<Record<string, ExportFormat>> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/pdf',
    extension: 'pdf',
  },
};

/** The details of a Drive file this module needs, as Drive's `files.get` reports them. */
export interface DriveFileMeta {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  /** Bytes, for a file that has them. Google's own files have none. */
  readonly size: number | null;
  readonly modifiedTime: string | null;
  readonly trashed: boolean;
  /** False when the owner has turned off downloading for the people it is shared with. */
  readonly canDownload: boolean;
  readonly shortcutTargetId: string | null;
  readonly shortcutTargetMimeType: string | null;
}

export type ReadPlan =
  | { readonly kind: 'export'; readonly format: ExportFormat }
  | { readonly kind: 'download' }
  /** Read the file it points at instead — once; a shortcut to a shortcut is not followed. */
  | { readonly kind: 'shortcut'; readonly targetId: string }
  | {
      readonly kind: 'refuse';
      readonly code: DriveRefusalCode | 'empty' | 'too_large';
      /** What Google calls it (for drive_google_type), or the size (for too_large). */
      readonly label?: string;
      readonly bytes?: number;
    };

export function isGoogleType(mimeType: string): boolean {
  return mimeType.startsWith(GOOGLE_APPS_PREFIX);
}

/**
 * The plan for one file. `followed` is true when this file was reached through a shortcut:
 * a second shortcut is refused rather than followed, so a loop cannot be built.
 */
export function planFor(meta: DriveFileMeta, followed = false): ReadPlan {
  if (meta.trashed) return { kind: 'refuse', code: 'drive_in_bin' };
  if (meta.mimeType === FOLDER_MIME) return { kind: 'refuse', code: 'drive_folder' };
  if (meta.mimeType === SHORTCUT_MIME) {
    if (followed || meta.shortcutTargetId === null) {
      return { kind: 'refuse', code: 'drive_shortcut_target' };
    }
    if (meta.shortcutTargetMimeType === FOLDER_MIME)
      return { kind: 'refuse', code: 'drive_folder' };
    return { kind: 'shortcut', targetId: meta.shortcutTargetId };
  }
  if (!meta.canDownload) return { kind: 'refuse', code: 'drive_download_blocked' };
  const format = EXPORTS[meta.mimeType];
  if (format !== undefined) return { kind: 'export', format };
  if (isGoogleType(meta.mimeType)) {
    return { kind: 'refuse', code: 'drive_google_type', label: googleTypeLabel(meta.mimeType) };
  }
  if (meta.size !== null) {
    if (meta.size === 0) return { kind: 'refuse', code: 'empty' };
    if (meta.size > FILE_LIMITS.maxFileBytes) {
      return { kind: 'refuse', code: 'too_large', bytes: meta.size };
    }
  }
  return { kind: 'download' };
}

/**
 * The name shown in the thread: Drive's name, cleaned like any stranger's file name. An
 * exported file keeps the name he gave it ("Rate sheet"), not one with an extension added.
 */
export function displayName(meta: Pick<DriveFileMeta, 'name'>): string {
  return sanitiseFileName(meta.name);
}

/**
 * The name handed to the browser's reader. For an export it ends in the format's extension,
 * so "Rate sheet" exported as a workbook is read as one. For a download it is Drive's name
 * as it is: the reader decides by the bytes, and uses the extension only to tell a CSV from
 * plain text, exactly as for a file chosen on the device.
 */
export function readerFileName(meta: Pick<DriveFileMeta, 'name'>, plan: ReadPlan): string {
  const base = displayName(meta);
  if (plan.kind !== 'export') return base;
  const suffix = `.${plan.format.extension}`;
  return base.toLowerCase().endsWith(suffix) ? base : `${base}${suffix}`;
}

/**
 * The file's type for a log line or a ledger: a broad group, never anything that could name
 * the file or say what is in it.
 */
export function typeGroup(mimeType: string): string {
  if (EXPORTS[mimeType] !== undefined) {
    return mimeType.slice(GOOGLE_APPS_PREFIX.length) === 'document'
      ? 'google_doc'
      : mimeType.endsWith('spreadsheet')
        ? 'google_sheet'
        : 'google_slides';
  }
  if (isGoogleType(mimeType)) return 'google_other';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'text/csv' || mimeType === 'text/tab-separated-values') return 'csv';
  if (mimeType.startsWith('text/')) return 'text';
  if (mimeType.includes('wordprocessingml') || mimeType === 'application/msword') return 'word';
  if (mimeType.includes('spreadsheetml') || mimeType === 'application/vnd.ms-excel') return 'excel';
  if (mimeType.includes('presentationml') || mimeType === 'application/vnd.ms-powerpoint') {
    return 'powerpoint';
  }
  return 'other';
}
