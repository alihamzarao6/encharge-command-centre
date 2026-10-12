/**
 * What the interface says about files (Milestone 5 part 1). Pure: every sentence a person
 * reads about an upload or an attached file is chosen here and unit-tested, and none of it
 * depends on a browser.
 *
 * The thread is a TIMELINE of messages and files: a file sits where it was attached, so an
 * answer about a payslip is read just below the payslip it was about. A removed file leaves
 * a line saying a file was here — never its name, which went with it.
 *
 * Milestone 5 part 2 adds the words for a LINK and for a page read from one: what the strip
 * beside the message box offers for each link in the draft (read it, reading, read at such a
 * time, could not be read and why), and what a page says of itself in the thread — its site,
 * when it was read, and plainly when it was read only in part. "Was this page read or not"
 * must have an answer a person can see without asking.
 */
import { canRemoveFile } from '../../../src/lib/files/access.js';
import { FILE_LIMITS, KIND_LABEL, formatBytes } from '../../../src/lib/files/limits.js';
import type { MemoryActor } from '../../../src/lib/memory/access.js';
import type { AttachedFile, VisionEstimate } from './filesApi.js';
import type { ThreadMessage } from './thread.js';
import { findLinks, offered, type DraftLink } from './links.js';
import { money, type UploadItem, type UploadsState } from './uploads.js';

export const REMOVED_FILE_TEXT = 'A file was attached here and has since been removed.';
export const EXPIRED_FILE_TEXT =
  'A file was attached here. It was removed automatically after 30 days.';

export const REMOVED_PAGE_TEXT = 'A web page was read here and has since been removed.';
export const EXPIRED_PAGE_TEXT =
  'A web page was read here. Pages are kept for a day, so it has been removed. Read it again for the current version.';
export const REPLACED_PAGE_TEXT =
  'A web page was read here and has been read again since. This earlier copy was removed.';

export const READ_PAGE_LABEL = 'Read this page';
export const READ_AGAIN_LABEL = 'Read again';

/** The line left where a file or a page used to be. It never says which one it was. */
export function goneText(
  file: Pick<AttachedFile, 'kind' | 'status' | 'removedReason' | 'expiresAt'>,
  now: number,
): string {
  const page = file.kind === 'html';
  if (file.status !== 'removed') {
    // Past its date, and the nightly purge has not been round yet.
    return page ? EXPIRED_PAGE_TEXT : EXPIRED_FILE_TEXT;
  }
  if (file.removedReason === 'replaced') return REPLACED_PAGE_TEXT;
  if (file.removedReason === 'expired' || isExpired(file, now)) {
    return page ? EXPIRED_PAGE_TEXT : EXPIRED_FILE_TEXT;
  }
  return page ? REMOVED_PAGE_TEXT : REMOVED_FILE_TEXT;
}

export const RETENTION_HINT = `Files are read on this device, kept for ${String(FILE_LIMITS.retentionDays)} days, then removed.`;

export const ATTACH_LABEL = 'Attach a file';

/**
 * "today at 2:14 pm", "yesterday at 9:05 am", "3 Oct at 4:40 pm" — in the reader's own time.
 * `timeZone` is for tests; a browser uses the device's.
 */
export function readWhen(iso: string, now: number, timeZone?: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'at an unknown time';
  const zone = timeZone === undefined ? {} : { timeZone };
  const clock = new Intl.DateTimeFormat('en-AU', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...zone,
  })
    .format(at)
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const day = (instant: number): string =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...zone,
    }).format(instant);
  if (day(at) === day(now)) return `today at ${clock}`;
  if (day(at) === day(now - DAY_MS)) return `yesterday at ${clock}`;
  const date = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', ...zone }).format(
    at,
  );
  return `${date} at ${clock}`;
}

/** "Web page · westpac.com.au · read today at 2:14 pm". */
export function pageSummary(
  file: Pick<AttachedFile, 'sourceHost' | 'fetchedAt'>,
  now: number,
  timeZone?: string,
): string {
  const host = (file.sourceHost ?? '').replace(/^www\./, '');
  const when = file.fetchedAt === null ? '' : `read ${readWhen(file.fetchedAt, now, timeZone)}`;
  return [KIND_LABEL.html, host, when].filter((part) => part !== '').join(' · ');
}

/** For a PDF or other document that was reached by a link: where it came from, and when. */
export function sourceNote(
  file: Pick<AttachedFile, 'sourceHost' | 'fetchedAt'>,
  now: number,
  timeZone?: string,
): string | null {
  if (file.sourceHost === null || file.fetchedAt === null) return null;
  return `from ${file.sourceHost.replace(/^www\./, '')}, read ${readWhen(file.fetchedAt, now, timeZone)}`;
}

/** Said under a page whose figures were left for a script to fill in. Null when none were. */
export function missingNote(file: Pick<AttachedFile, 'valuesMissing'>): string | null {
  const count = file.valuesMissing;
  if (count <= 0) return null;
  return `Read in part: ${count === 1 ? '1 figure on this page is' : `${String(count)} figures on this page are`} filled in by the site after it loads, and could not be read. To get them, save the page as a PDF and attach it.`;
}

/**
 * Said under a page that shows nothing until its scripts run. It was read as the site sent
 * it, which can include text a visitor never sees: the person needs to know that on screen,
 * not only to have it read out once.
 */
export const READ_AS_SENT_TEXT =
  'Read as the site sent it: this page shows its content only after its scripts run, so what was read may differ from what you see on the page. Check anything important against the page itself.';

export function sentNote(file: Pick<AttachedFile, 'readAsSent'>): string | null {
  return file.readAsSent ? READ_AS_SENT_TEXT : null;
}

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
  const link = item.source === 'link';
  switch (item.phase) {
    case 'waiting':
      return link ? 'Waiting for the one before it…' : 'Waiting for the file before it…';
    case 'fetching':
      // Before the first byte there is nothing to measure; after it, there is.
      return item.total > 0
        ? `Downloading… ${formatBytes(item.done)} of ${formatBytes(item.total)}`
        : 'Opening the page…';
    case 'reading':
      if (link) return item.total > 1 ? `Reading it… page${of}` : 'Reading the page…';
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
  if (
    item.phase !== 'fetching' &&
    item.phase !== 'reading' &&
    item.phase !== 'sending' &&
    item.phase !== 'looking'
  ) {
    return null;
  }
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
  if (active.phase === 'confirm') return `Choose whether to read ${active.name} before you send.`;
  return active.source === 'link'
    ? `Wait for the page from ${active.name} to be read before you send.`
    : `Wait for ${active.name} to finish before you send.`;
}

// ---------------------------------------------------------------------------------------
// Links in the draft (Milestone 5 part 2)
// ---------------------------------------------------------------------------------------

export type LinkOfferState =
  /** A link that could be read and has not been. */
  | 'unread'
  /** An address that will not be opened; the sentence says why. */
  | 'refused'
  /** On its way in. */
  | 'reading'
  /** In this conversation now. */
  | 'read'
  /** Tried, and not read; the sentence says why. */
  | 'failed';

export interface LinkOffer {
  readonly link: DraftLink;
  readonly state: LinkOfferState;
  /** The sentence under the link: when it was read, why it was not, what is happening. */
  readonly detail: string | null;
  /** Whether "Try again" would be worth offering. */
  readonly retryable: boolean;
}

const IN_PROGRESS: readonly UploadItem['phase'][] = [
  'waiting',
  'fetching',
  'reading',
  'confirm',
  'sending',
  'looking',
  'finishing',
];

/**
 * What to offer for each link in the draft, given what this conversation already holds.
 * Pure: the strip beside the message box is this, drawn.
 */
export function linkOffers(
  draft: string,
  state: Pick<UploadsState, 'uploads' | 'files' | 'readLinks'>,
  now: number,
  timeZone?: string,
): { readonly offers: readonly LinkOffer[]; readonly more: number } {
  const { shown, more } = offered(findLinks(draft));
  const offers = shown.map((link): LinkOffer => {
    if (link.refusal !== null) {
      return { link, state: 'refused', detail: link.refusal.message, retryable: false };
    }
    const item = state.uploads.find((upload) => upload.url === link.url);
    if (item !== undefined && IN_PROGRESS.includes(item.phase)) {
      return { link, state: 'reading', detail: uploadStatus(item), retryable: false };
    }
    if (item !== undefined) {
      return {
        link,
        state: 'failed',
        detail: item.message,
        retryable: item.phase === 'failed' && item.retryable,
      };
    }
    // Read already: stored under the address it ENDED at, or remembered under the one typed.
    const remembered = Object.hasOwn(state.readLinks, link.url)
      ? state.readLinks[link.url]
      : undefined;
    const file = state.files.find(
      (candidate) =>
        candidate.status === 'ready' &&
        !isExpired(candidate, now) &&
        (candidate.sourceUrl === link.url || candidate.id === remembered),
    );
    if (file !== undefined) {
      return {
        link,
        state: 'read',
        detail:
          file.fetchedAt === null ? 'Read' : `Read ${readWhen(file.fetchedAt, now, timeZone)}`,
        retryable: false,
      };
    }
    return { link, state: 'unread', detail: null, retryable: false };
  });
  return { offers, more };
}

/** The question asked once when Send is pressed with a link that has not been read. */
export function unreadAsk(
  unread: number,
  hasWords: boolean,
): { readonly text: string; readonly read: string; readonly skip: string } {
  const pages = unread === 1 ? 'page' : `${String(unread)} pages`;
  if (!hasWords) {
    return {
      text:
        unread === 1
          ? 'This link has not been read, and there is nothing else in the message. Read the page, then ask about it.'
          : 'These links have not been read, and there is nothing else in the message. Read the pages, then ask about them.',
      read: unread === 1 ? READ_PAGE_LABEL : `Read ${pages}`,
      skip: 'Send it as it is',
    };
  }
  return {
    text:
      unread === 1
        ? 'This message has a link that has not been read. The assistant cannot open it, and will say so unless the page is read first.'
        : `This message has ${String(unread)} links that have not been read. The assistant cannot open them, and will say so unless the pages are read first.`,
    read: unread === 1 ? 'Read it, then send' : `Read ${pages}, then send`,
    skip: 'Send without reading',
  };
}
