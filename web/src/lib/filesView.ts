/**
 * What the interface says about files (Milestone 5 part 1). Pure: every sentence a person
 * reads about an upload or an attached file is chosen here and unit-tested, and none of it
 * depends on a browser.
 *
 * The thread is a TIMELINE of messages and files: a file sits where it was attached, so an
 * answer about a payslip is read just below the payslip it was about. A removed file leaves
 * a line saying a file was here — never its name, which went with it.
 */
import { canRemoveFile } from '../../../src/lib/files/access.js';
import { FILE_LIMITS, KIND_LABEL, formatBytes } from '../../../src/lib/files/limits.js';
import type { MemoryActor } from '../../../src/lib/memory/access.js';
import type { AttachedFile, VisionEstimate } from './filesApi.js';
import type { ThreadMessage } from './thread.js';
import { money, type UploadItem } from './uploads.js';

export const REMOVED_FILE_TEXT = 'A file was attached here and has since been removed.';
export const EXPIRED_FILE_TEXT =
  'A file was attached here. It was removed automatically after 30 days.';

export const RETENTION_HINT = `Files are read on this device, kept for ${String(FILE_LIMITS.retentionDays)} days, then removed.`;

export const ATTACH_LABEL = 'Attach a file';

/** "PDF · 2 pages · 214 KB", with what was read from images when any was. */
export function fileSummary(
  file: Pick<AttachedFile, 'kind' | 'pageCount' | 'byteSize' | 'visionPages'>,
): string {
  const unit = file.kind === 'pdf' || file.kind === 'image' ? 'page' : 'part';
  const parts = [
    KIND_LABEL[file.kind],
    `${String(file.pageCount)} ${unit}${file.pageCount === 1 ? '' : 's'}`,
    formatBytes(file.byteSize),
  ];
  if (file.visionPages > 0 && file.kind !== 'image') {
    parts.push(
      `${String(file.visionPages)} read from ${file.visionPages === 1 ? 'an image' : 'images'}`,
    );
  }
  if (file.kind === 'image') parts.push('read from the image');
  return parts.join(' · ');
}

const DAY_MS = 86_400_000;

/** True once a file is past its date, whether or not the nightly purge has run yet. */
export function isExpired(file: Pick<AttachedFile, 'expiresAt'>, now: number): boolean {
  const at = Date.parse(file.expiresAt);
  return Number.isFinite(at) && at <= now;
}

/** "Kept for 30 more days" … "Removed tomorrow" … "Removed today". */
export function retentionText(file: Pick<AttachedFile, 'expiresAt'>, now: number): string {
  const at = Date.parse(file.expiresAt);
  if (!Number.isFinite(at)) return '';
  const days = Math.ceil((at - now) / DAY_MS);
  if (days <= 0) return 'Removed today';
  if (days === 1) return 'Removed tomorrow';
  return `Kept for ${String(days)} more days`;
}

export function canRemove(file: Pick<AttachedFile, 'uploadedBy'>, actor: MemoryActor): boolean {
  return canRemoveFile(file, actor).allowed;
}

/** The question asked before a scan is read (D90): how many pages, what it costs, against what. */
export function confirmText(estimate: VisionEstimate): string {
  const share =
    estimate.dailyCapUsd > 0 ? Math.round((estimate.estimateUsd / estimate.dailyCapUsd) * 100) : 0;
  const used =
    estimate.spentTodayUsd > 0
      ? ` ${money(estimate.spentTodayUsd)} of it has been used today.`
      : '';
  return `This is a scan. ${String(estimate.pages)} pages will be read as images, which costs about ${money(estimate.estimateUsd)} — around ${String(Math.max(1, share))}% of today's ${money(estimate.dailyCapUsd)} budget.${used}`;
}

export function confirmButtonText(estimate: VisionEstimate): string {
  return `Read ${String(estimate.pages)} pages`;
}

/** One line for an upload in progress. Null for a stopped one — its `message` is shown instead. */
export function uploadStatus(item: UploadItem): string | null {
  const of =
    item.total > 0
      ? ` ${String(Math.min(item.done + 1, item.total))} of ${String(item.total)}`
      : '';
  switch (item.phase) {
    case 'waiting':
      return 'Waiting for the file before it…';
    case 'reading':
      return item.total > 1 ? `Reading the file… page${of}` : 'Reading the file…';
    case 'confirm':
      return null;
    case 'sending':
      return item.total > 1 ? `Sending… part${of}` : 'Sending…';
    case 'looking':
      return `Reading page${of} as an image…`;
    case 'finishing':
      return 'Finishing…';
    case 'failed':
    case 'refused':
      return null;
  }
}

/** 0–100 for the progress bar; null when there is nothing honest to show yet. */
export function uploadPercent(item: UploadItem): number | null {
  if (item.total <= 0) return null;
  if (item.phase !== 'reading' && item.phase !== 'sending' && item.phase !== 'looking') return null;
  return Math.max(0, Math.min(100, Math.round((item.done / item.total) * 100)));
}

export type TimelineEntry =
  | { readonly type: 'message'; readonly key: string; readonly message: ThreadMessage }
  | { readonly type: 'file'; readonly key: string; readonly file: AttachedFile };

/**
 * Messages and files in the order they happened. A saved message carries its time; one that
 * was only just sent (or is still arriving) has none and belongs at the end, after every file
 * already attached — which is where it is: the file came first, then the question.
 */
export function timeline(
  messages: readonly ThreadMessage[],
  files: readonly AttachedFile[],
): readonly TimelineEntry[] {
  const fileEntries = [...files]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((file): TimelineEntry => ({ type: 'file', key: `file-${file.id}`, file }));
  const out: TimelineEntry[] = [];
  let next = 0;
  for (const message of messages) {
    const at = message.createdAt;
    if (at !== undefined) {
      while (next < fileEntries.length) {
        const entry = fileEntries[next];
        if (entry?.type !== 'file' || entry.file.createdAt > at) break;
        out.push(entry);
        next += 1;
      }
    } else {
      // Everything attached so far came before a message that has no time yet.
      out.push(...fileEntries.slice(next));
      next = fileEntries.length;
    }
    out.push({ type: 'message', key: `message-${message.localId}`, message });
  }
  out.push(...fileEntries.slice(next));
  return out;
}

/** Why Send is disabled while a file is still on its way in. */
export function busyNote(uploads: readonly UploadItem[]): string | null {
  const active = uploads.find((item) => item.phase !== 'failed' && item.phase !== 'refused');
  if (active === undefined) return null;
  return active.phase === 'confirm'
    ? `Choose whether to read ${active.name} before you send.`
    : `Wait for ${active.name} to finish before you send.`;
}
