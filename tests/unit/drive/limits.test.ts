/**
 * The words and limits shared by the drive endpoint and the browser (src/lib/drive/limits.ts):
 * every refusal and every connection state is a sentence that says what happened and what to
 * do, none mentions a file's contents, and the numbers are the ones decided (D119–D122).
 */
import { describe, expect, it } from 'vitest';

import {
  decodeDriveMeta,
  encodeDriveMeta,
  DRIVE_META_HEADER,
} from '../../../src/lib/drive/meta.js';
import {
  BROKEN_REASONS,
  CONNECT_OUTCOMES,
  DISCONNECT_MESSAGES,
  DRIVE_CONNECTION_CODES,
  DRIVE_CONNECTION_MESSAGES,
  DRIVE_FILE_SCOPE,
  DRIVE_LIMITS,
  DRIVE_REFUSAL_CODES,
  DRIVE_RETRY_CODES,
  DRIVE_RETRY_MESSAGES,
  brokenReasonText,
  connectOutcomeMessage,
  driveFileUrl,
  driveRefusalMessage,
  googleTypeLabel,
  isDriveFileId,
  isDriveRefusalCode,
} from '../../../src/lib/drive/limits.js';
import { FILE_LIMITS } from '../../../src/lib/files/limits.js';

describe('limits', () => {
  it('one scope, drive.file, and nothing wider', () => {
    expect(DRIVE_FILE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  });

  it("the file size limit is part 1's, and Google's export ceiling is 10 MB", () => {
    expect(DRIVE_LIMITS.maxBytes).toBe(FILE_LIMITS.maxFileBytes);
    expect(DRIVE_LIMITS.exportMaxBytes).toBe(10 * 1024 * 1024);
    expect(DRIVE_LIMITS.receiptMinutes).toBe(FILE_LIMITS.abandonedAfterMinutes);
  });

  it("a read fits inside the Edge Function's 150 s, with room to record it", () => {
    expect(DRIVE_LIMITS.contentTotalMs).toBeLessThan(150_000 - 30_000);
    expect(DRIVE_LIMITS.contentFirstByteMs).toBeLessThan(DRIVE_LIMITS.contentTotalMs);
  });
});

describe('sentences', () => {
  it.each(DRIVE_REFUSAL_CODES)('the refusal %s says what happened and what to do', (code) => {
    const message = driveRefusalMessage(code, 'Google Form');
    expect(message.length).toBeGreaterThan(40);
    expect(message).not.toMatch(/undefined|null|\$\{/);
    // Two halves: at least two sentences, or a sentence with a way out in it.
    expect(
      message.split(/(?<=[.!?])\s/).length +
        (/(Pick|Restore|Open|Split|Ask|attach)/.test(message) ? 1 : 0),
    ).toBeGreaterThan(1);
  });

  it('names the Google type it refuses', () => {
    expect(driveRefusalMessage('drive_google_type', 'Google Form')).toMatch(
      /^That is a Google Form, which can't be read\./,
    );
    expect(driveRefusalMessage('drive_google_type')).toMatch(/^That is a Google file/);
  });

  it.each(DRIVE_RETRY_CODES)('the retry %s says to try again', (code) => {
    expect(DRIVE_RETRY_MESSAGES[code]).toMatch(/try again|Wait a moment/i);
  });

  it.each(DRIVE_CONNECTION_CODES)('the connection state %s gives the way back', (code) => {
    const message = DRIVE_CONNECTION_MESSAGES[code];
    expect(message).toMatch(/Settings|this device/);
  });

  it('a broken connection is never silence: it says it is no longer connected, and how to fix it', () => {
    expect(DRIVE_CONNECTION_MESSAGES.connection_broken).toMatch(/no longer connected/);
    expect(DRIVE_CONNECTION_MESSAGES.connection_broken).toMatch(/Nothing was read/);
    expect(DRIVE_CONNECTION_MESSAGES.connection_broken).toMatch(/Connect it again in Settings/);
  });

  it.each(BROKEN_REASONS)('the broken reason %s has its own words', (reason) => {
    expect(brokenReasonText(reason)).not.toBe(brokenReasonText('unknown-reason'));
  });

  it.each(CONNECT_OUTCOMES)('the connect outcome %s is a sentence', (outcome) => {
    const message = connectOutcomeMessage(outcome, 'broker@example.com');
    expect(message.length).toBeGreaterThan(20);
    expect(message).not.toMatch(/undefined|\$\{/);
  });

  it("connected names the account, and Google's refusal carries Google's code", () => {
    expect(connectOutcomeMessage('connected', 'broker@example.com')).toBe(
      'Google Drive is connected as broker@example.com.',
    );
    expect(connectOutcomeMessage('connected')).toBe('Google Drive is connected.');
    expect(connectOutcomeMessage('google_refused', 'admin_policy_enforced')).toContain(
      '"admin_policy_enforced"',
    );
    expect(connectOutcomeMessage('google_refused')).toBe(
      'Google refused the connection, so Drive was not connected.',
    );
  });

  it('disconnecting says that Google is told, and what happens to files already attached', () => {
    expect(DISCONNECT_MESSAGES.confirm).toMatch(/tells Google to remove/);
    expect(DISCONNECT_MESSAGES.confirm).toMatch(/30 days/);
    expect(DISCONNECT_MESSAGES.done).toMatch(/30 days/);
    expect(DISCONNECT_MESSAGES.googleUnreachable).toMatch(/still connected/);
    expect(DISCONNECT_MESSAGES.unreadable).toContain('https://myaccount.google.com/connections');
  });
});

describe('small helpers', () => {
  it('knows its own refusal codes', () => {
    expect(isDriveRefusalCode('drive_in_bin')).toBe(true);
    expect(isDriveRefusalCode('empty')).toBe(false);
    expect(isDriveRefusalCode(3)).toBe(false);
  });

  it('labels Google types, with a fallback for one it has never seen', () => {
    expect(googleTypeLabel('application/vnd.google-apps.form')).toBe('Google Form');
    expect(googleTypeLabel('application/vnd.google-apps.new-thing')).toMatch(/no download/);
  });

  it('a Drive file has one address, whatever it is', () => {
    expect(driveFileUrl('1AbC_d-9xyz')).toBe('https://drive.google.com/file/d/1AbC_d-9xyz/view');
  });

  it.each([
    ['1DocAbCdEfGhIjKlMnOp', true],
    ['short', false],
    ['../../etc/passwd', false],
    ['has space in it', false],
    ['x'.repeat(201), false],
    [42, false],
  ])('%s is a Drive file id: %s', (value, expected) => {
    expect(isDriveFileId(value)).toBe(expected);
  });

  it('the meta header round-trips a non-ASCII name and refuses junk', () => {
    const meta = { readId: 'r', name: 'Résumé — taux 6,04 %', byteSize: 3 };
    const header = encodeDriveMeta(meta);
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeDriveMeta(header)).toEqual(meta);
    expect(decodeDriveMeta('not base64!')).toBeNull();
    expect(decodeDriveMeta(null)).toBeNull();
    expect(DRIVE_META_HEADER).toBe('x-drive-meta');
  });
});
