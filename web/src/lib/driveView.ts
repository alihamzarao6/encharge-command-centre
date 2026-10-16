/**
 * What the Drive section of Settings says (Milestone 5 part 3a). Pure: every sentence and every
 * button is chosen here and unit-tested, and none of it depends on a browser.
 *
 * The one rule this file exists for: THE STATE IS NEVER AMBIGUOUS. Each of the four states has
 * its own headline, and the headline alone answers "is Drive connected, to which account, and
 * does it work". A "connected" that Google could not confirm just now says so; a connection
 * Google stopped honouring says when and why, and how to get it back (D122).
 */
import {
  DISCONNECT_MESSAGES,
  connectOutcomeMessage,
  type ConnectOutcome,
} from '../../../src/lib/drive/limits.js';
import type { DriveStatus } from './driveApi.js';
import { readWhen } from './filesView.js';

export type DriveAction = 'connect' | 'reconnect' | 'disconnect';

export interface DriveSectionView {
  /** One line that answers the whole question. */
  readonly headline: string;
  /** What it means and what can be done, in a sentence or two. */
  readonly detail: string;
  readonly tone: 'neutral' | 'ok' | 'warn' | 'problem';
  readonly actions: readonly DriveAction[];
}

export const DRIVE_SECTION_TEXT = {
  title: 'Google Drive',
  what: 'Pick a file from your Google Drive in the Assistant and ask about it. This app can open only the files you pick, and nothing else in your Drive.',
  checking: 'Checking your Google Drive connection…',
  unavailableHeadline: 'Google Drive is not set up on this Command Centre yet',
  unavailableDetail: 'Files can still be attached from this device.',
  notConnectedHeadline: 'Not connected',
  connect: 'Connect Google Drive',
  reconnect: 'Connect again',
  disconnect: 'Disconnect',
  confirmDisconnect: 'Disconnect Google Drive',
  keep: 'Keep it connected',
  leaving: 'Opening Google…',
  error: "Couldn't check the Google Drive connection just now.",
  retry: 'Try again',
} as const;

export function sectionView(status: DriveStatus, now: number, timeZone?: string): DriveSectionView {
  switch (status.state) {
    case 'unavailable':
      return {
        headline: DRIVE_SECTION_TEXT.unavailableHeadline,
        detail: DRIVE_SECTION_TEXT.unavailableDetail,
        tone: 'neutral',
        actions: [],
      };
    case 'not_connected':
      return {
        headline: DRIVE_SECTION_TEXT.notConnectedHeadline,
        detail: DRIVE_SECTION_TEXT.what,
        tone: 'neutral',
        actions: ['connect'],
      };
    case 'connected': {
      const since = `Connected ${readWhen(status.connectedAt, now, timeZone)}.`;
      return {
        headline: `Connected as ${status.email}`,
        detail: status.checked
          ? `${since} ${DRIVE_SECTION_TEXT.what}`
          : `${since} Google could not be reached just now to confirm it still works; reading a file will tell.`,
        tone: status.checked ? 'ok' : 'warn',
        actions: ['disconnect'],
      };
    }
    case 'broken':
      return {
        headline: `Not working — ${status.email}`,
        detail: `${status.message} Noticed ${readWhen(status.brokenAt, now, timeZone)}. Connect again to go on reading files from Drive.`,
        tone: 'problem',
        actions: ['reconnect', 'disconnect'],
      };
  }
}

/** What arrived in the address bar on the way back from Google (the callback's redirect). */
export type DriveReturn =
  /** Back from Google with something to finish. */
  | { readonly kind: 'returned'; readonly attempt: string }
  /** Back, but the attempt was not usable (expired, replayed, unknown). Nothing to finish. */
  | { readonly kind: 'stale' }
  | { readonly kind: 'none' };

const ATTEMPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseReturn(search: string): DriveReturn {
  const params = new URLSearchParams(search);
  const drive = params.get('drive');
  if (drive === 'stale') return { kind: 'stale' };
  if (drive === 'returned') {
    const attempt = params.get('attempt') ?? '';
    return ATTEMPT.test(attempt) ? { kind: 'returned', attempt } : { kind: 'stale' };
  }
  return { kind: 'none' };
}

/** The sentence shown after a return from Google, before the status below it. */
export function returnMessage(
  outcome: ConnectOutcome,
  message: string,
): { readonly text: string; readonly tone: 'ok' | 'problem' } {
  return { text: message, tone: outcome === 'connected' ? 'ok' : 'problem' };
}

export const STALE_RETURN_TEXT = connectOutcomeMessage('stale');

export const DISCONNECT_CONFIRM_TEXT = DISCONNECT_MESSAGES.confirm;
