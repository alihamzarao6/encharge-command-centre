/**
 * The limits and the words for reading a file from Google Drive (Milestone 5 part 3a) —
 * imported by the browser AND by the `drive` Edge Function, as files/limits.ts and
 * pages/limits.ts are, so a sentence the interface shows is the sentence the server meant.
 * Pure constants and pure functions; nothing here reads an environment or touches a network.
 *
 * Every sentence is in two halves: what happened, and what he can do about it. A broken
 * connection in particular is never silence (D122): wherever it is found, it is said, with
 * the way back.
 */
import { FILE_LIMITS } from '../files/limits.js';

const MB = 1024 * 1024;

export const DRIVE_LIMITS = {
  /** Drive files one person may read in a minute. Two picked together is two. */
  readsPerMinute: 20,
  /** How long a press of Connect stays usable: Google's code lives about as long. */
  connectAttemptSeconds: 600,
  /** Connection attempts one person may have open at once. */
  maxOpenAttempts: 5,
  /** The token, the account, a file's details: small answers. */
  metadataTimeoutMs: 10_000,
  /** To the first byte of a download or an export. Google prepares an export before it sends. */
  contentFirstByteMs: 45_000,
  /**
   * A download or an export, start to finish. The Edge Function itself is stopped at 150 s on
   * the platform's free plan; this leaves room to record the read either way.
   */
  contentTotalMs: 90_000,
  /** The same limit as a file chosen on the device (FILE_LIMITS.maxFileBytes). */
  maxBytes: FILE_LIMITS.maxFileBytes,
  /** Google's own ceiling on an exported Doc, Sheet or Slides deck (files.export). */
  exportMaxBytes: 10 * MB,
  /** Retries of a request Google answered as busy, before saying so. */
  busyRetries: 2,
  /** How long the server's record of a read may wait to be attached (the same as a page's). */
  receiptMinutes: FILE_LIMITS.abandonedAfterMinutes,
} as const;

/** The one scope this part asks for (the brief's decision 1). Nothing wider, ever. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Where Google sends a person to remove this app's access by hand. */
export const GOOGLE_ACCOUNT_CONNECTIONS_URL = 'https://myaccount.google.com/connections';

/** What the person is told a file is, by Google's own type. */
export const GOOGLE_TYPE_LABEL: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.document': 'Google Doc',
  'application/vnd.google-apps.spreadsheet': 'Google Sheet',
  'application/vnd.google-apps.presentation': 'Google Slides deck',
  'application/vnd.google-apps.form': 'Google Form',
  'application/vnd.google-apps.drawing': 'Google Drawing',
  'application/vnd.google-apps.site': 'Google Site',
  'application/vnd.google-apps.jam': 'Jamboard',
  'application/vnd.google-apps.map': 'Google My Map',
  'application/vnd.google-apps.script': 'Apps Script project',
  'application/vnd.google-apps.vid': 'Google Vids video',
  'application/vnd.google-apps.folder': 'folder',
  'application/vnd.google-apps.shortcut': 'shortcut',
};

/** A Google file that is not a Doc, Sheet or Slides deck: what it is called, in plain words. */
export function googleTypeLabel(mimeType: string): string {
  return GOOGLE_TYPE_LABEL[mimeType] ?? 'Google file of a kind that has no download';
}

/** The file was refused. Retrying will not help; the sentence says what will. */
export const DRIVE_REFUSAL_CODES = [
  'drive_file_gone',
  'drive_in_bin',
  'drive_folder',
  'drive_google_type',
  'drive_export_too_large',
  'drive_download_blocked',
  'drive_shortcut_target',
  'drive_domain_policy',
] as const;
export type DriveRefusalCode = (typeof DRIVE_REFUSAL_CODES)[number];

export function isDriveRefusalCode(value: unknown): value is DriveRefusalCode {
  return typeof value === 'string' && (DRIVE_REFUSAL_CODES as readonly string[]).includes(value);
}

const SUPPORTED =
  'It reads Google Docs, Sheets and Slides, and PDF, Word (.docx), Excel (.xlsx), CSV, text files and photos.';

/** `label` is what Google calls the file's type, for the one sentence that names it. */
export function driveRefusalMessage(code: DriveRefusalCode, label = ''): string {
  switch (code) {
    case 'drive_file_gone':
      return 'That file is no longer in your Google Drive, or this app was not given access to it. Pick it again from Drive.';
    case 'drive_in_bin':
      return 'That file is in your Google Drive bin. Restore it in Drive, then pick it again.';
    case 'drive_folder':
      return 'That is a folder. Open it in the picker and choose a file inside it.';
    case 'drive_google_type':
      return `That is a ${label === '' ? 'Google file' : label}, which can't be read. ${SUPPORTED}`;
    case 'drive_export_too_large':
      return `Google hands over at most ${String(DRIVE_LIMITS.exportMaxBytes / MB)} MB of a Google Doc, Sheet or Slides deck, and this one is bigger. Split it, or download it from Drive as a PDF and attach that.`;
    case 'drive_download_blocked':
      return "The owner of this file has turned off downloading for the people it is shared with, so it can't be read. Ask the owner for a copy, or to turn downloading back on.";
    case 'drive_shortcut_target':
      return 'That is a shortcut, and the file it points to has not been opened through this app. Pick the original file instead.';
    case 'drive_domain_policy':
      return 'Your Google Workspace administrator does not allow this app to read files from Drive. Ask them to allow "Fundd Command Centre", or attach the file from this device.';
  }
}

/** Not read this time; may be next time. */
export const DRIVE_RETRY_CODES = [
  'drive_busy',
  'drive_unreachable',
  'drive_timeout',
  'drive_too_many_reads',
] as const;
export type DriveRetryCode = (typeof DRIVE_RETRY_CODES)[number];

export const DRIVE_RETRY_MESSAGES: Readonly<Record<DriveRetryCode, string>> = {
  drive_busy:
    'Google Drive is busy right now, so the file was not read. Wait a moment and try again.',
  drive_unreachable: 'Google Drive could not be reached, so the file was not read. Try again.',
  drive_timeout:
    'Google took too long to hand over this file, so it was not read. Try again; a large Google Doc or Sheet can take a while to prepare.',
  drive_too_many_reads:
    'That is a lot of files from Drive in one minute. Wait a moment, then try again.',
};

/**
 * The connection itself is the problem: no file can be read until it is fixed, and the way to
 * fix it is the Drive section of Settings. Each carries that way back.
 */
export const DRIVE_CONNECTION_CODES = [
  'not_configured',
  'not_connected',
  'connection_broken',
] as const;
export type DriveConnectionCode = (typeof DRIVE_CONNECTION_CODES)[number];

export const DRIVE_CONNECTION_MESSAGES: Readonly<Record<DriveConnectionCode, string>> = {
  not_configured:
    'Google Drive is not set up on this Command Centre yet, so nothing can be read from it. Attach the file from this device instead.',
  not_connected:
    'Google Drive is not connected, so nothing was read. Connect it in Settings, then pick the file again.',
  connection_broken:
    "Google Drive is no longer connected: Google stopped accepting this app's access. It may have been removed in your Google account, or not used for six months. Nothing was read. Connect it again in Settings.",
};

/** Why Google stopped honouring a connection, as stored (`broken_reason`). */
export const BROKEN_REASONS = ['grant_revoked', 'access_lost', 'unreadable'] as const;
export type BrokenReason = (typeof BROKEN_REASONS)[number];

/** Said on the Drive page about a broken connection, after when it broke. */
export function brokenReasonText(reason: string): string {
  switch (reason) {
    case 'grant_revoked':
      return "Google stopped accepting this app's access. It may have been removed in your Google account, ended by your administrator, or not used for six months.";
    case 'access_lost':
      return "Google refused this app's access when a file was read.";
    case 'unreadable':
      return 'The stored permission could not be read on this server.';
    default:
      return "Google stopped accepting this app's access.";
  }
}

/** How a press of Connect ended, as the Drive page says it. */
export const CONNECT_OUTCOMES = [
  'connected',
  'cancelled',
  'scope_missing',
  'stale',
  'wrong_user',
  'no_lasting_access',
  'switch_failed',
  'changed',
  'google_unreachable',
  'google_refused',
  'scope_wider',
] as const;
export type ConnectOutcome = (typeof CONNECT_OUTCOMES)[number];

/**
 * `detail` is the account address for `connected`, and Google's own error code for
 * `google_refused` (such as `admin_policy_enforced`) — a code, never anything of his.
 */
export function connectOutcomeMessage(outcome: ConnectOutcome, detail = ''): string {
  const email = detail;
  switch (outcome) {
    case 'connected':
      return email === '' ? 'Google Drive is connected.' : `Google Drive is connected as ${email}.`;
    case 'cancelled':
      return 'You cancelled at Google, so Drive was not connected. Nothing was changed.';
    case 'scope_missing':
      return 'Google was not given permission to open the files you choose, so Drive was not connected. Connect again and leave the Drive box ticked.';
    case 'stale':
      return 'That connection attempt had expired or was already used, so nothing was changed. Connect again if Drive is not connected below.';
    case 'wrong_user':
      return 'That Google approval was started from a different Command Centre account, so it was not used. Nothing was connected.';
    case 'no_lasting_access':
      return 'Google did not grant lasting access, so Drive was not connected. Try again.';
    case 'switch_failed':
      return 'Your other Google account could not be disconnected at Google just now, so nothing was changed. Try again.';
    case 'changed':
      return 'Drive was connected from somewhere else at the same moment, so this attempt changed nothing. The status below is current.';
    case 'google_unreachable':
      return 'Google could not be reached to finish connecting, so Drive was not connected. Try again.';
    case 'google_refused':
      return detail === ''
        ? 'Google refused the connection, so Drive was not connected.'
        : `Google refused the connection (it said "${detail}"), so Drive was not connected. If your Google account belongs to an organisation, its administrator may need to allow this app.`;
    case 'scope_wider':
      return 'Google granted more access than this app asks for, so none of it was kept and Google was told to remove it. Nothing was connected.';
  }
}

/** Added to "connected" when the previous account's access could not be removed for him. */
export const SWITCH_LEFTOVER_NOTE = `Your previous Google account's access could not be removed automatically. To be sure it is gone, remove "Fundd Command Centre" at ${GOOGLE_ACCOUNT_CONNECTIONS_URL} while signed in to that account.`;

export const DISCONNECT_MESSAGES = {
  done: "Google Drive is disconnected, and Google has removed this app's access. Files already added to conversations stay there until they are removed, or for 30 days.",
  notConnected: 'Google Drive was not connected, so there was nothing to disconnect.',
  googleUnreachable:
    "Google could not be reached, so Drive is still connected and Google still holds this app's access. Try again.",
  unreadable: `The stored permission could not be read, so Google could not be told. The connection was removed here; to be sure Google has let go too, remove "Fundd Command Centre" at ${GOOGLE_ACCOUNT_CONNECTIONS_URL}.`,
  confirm:
    "Disconnecting tells Google to remove this app's access to your Drive. Files already added to conversations stay until they are removed, or for 30 days.",
} as const;

/** The Drive file id's shape: what Google issues, and nothing that could be a path trick. */
export const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{8,200}$/;

export function isDriveFileId(value: unknown): value is string {
  return typeof value === 'string' && DRIVE_FILE_ID.test(value);
}

/** The one address of a Drive file, whatever its type: what the database keys a re-read on. */
export function driveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

export const DRIVE_HOST = 'drive.google.com';
