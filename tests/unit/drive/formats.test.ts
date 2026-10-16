/**
 * What happens to a picked Drive file (src/lib/drive/formats.ts, D120): Google's three editor
 * types are exported to what part 1 reads; every other Google type is refused by name; an
 * ordinary file is downloaded and left to the readers; a shortcut is followed once, never twice.
 */
import { describe, expect, it } from 'vitest';

import {
  EXPORTS,
  displayName,
  planFor,
  readerFileName,
  typeGroup,
  type DriveFileMeta,
} from '../../../src/lib/drive/formats.js';
import { FILE_LIMITS } from '../../../src/lib/files/limits.js';

function meta(overrides: Partial<DriveFileMeta>): DriveFileMeta {
  return {
    id: '1AbCdEfGhIjKlMnOp',
    name: 'Rate sheet',
    mimeType: 'application/pdf',
    size: 1234,
    modifiedTime: '2026-10-15T01:00:00.000Z',
    trashed: false,
    canDownload: true,
    shortcutTargetId: null,
    shortcutTargetMimeType: null,
    ...overrides,
  };
}

describe('planFor', () => {
  it.each([
    [
      'application/vnd.google-apps.document',
      'docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    [
      'application/vnd.google-apps.spreadsheet',
      'xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    ['application/vnd.google-apps.presentation', 'pdf', 'application/pdf'],
  ])('exports %s as .%s', (mimeType, extension, exported) => {
    const plan = planFor(meta({ mimeType, size: null }));
    expect(plan).toEqual({ kind: 'export', format: { mimeType: exported, extension } });
  });

  it('exports exactly three Google types: Docs, Sheets and Slides', () => {
    expect(Object.keys(EXPORTS).sort()).toEqual([
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.presentation',
      'application/vnd.google-apps.spreadsheet',
    ]);
  });

  it.each([
    ['application/vnd.google-apps.form', 'Google Form'],
    ['application/vnd.google-apps.drawing', 'Google Drawing'],
    ['application/vnd.google-apps.site', 'Google Site'],
    ['application/vnd.google-apps.jam', 'Jamboard'],
    ['application/vnd.google-apps.script', 'Apps Script project'],
    ['application/vnd.google-apps.vid', 'Google Vids video'],
    ['application/vnd.google-apps.something-new', 'Google file of a kind that has no download'],
  ])('refuses %s by name', (mimeType, label) => {
    expect(planFor(meta({ mimeType, size: null }))).toEqual({
      kind: 'refuse',
      code: 'drive_google_type',
      label,
    });
  });

  it.each([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain',
    'image/jpeg',
    // A type part 1 refuses is still downloaded: the readers refuse it with the same sentence
    // an upload of it would get (a .pptx: "Save the slides as a PDF").
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/octet-stream',
  ])('downloads an ordinary %s and leaves it to the readers', (mimeType) => {
    expect(planFor(meta({ mimeType }))).toEqual({ kind: 'download' });
  });

  it('refuses a folder', () => {
    expect(planFor(meta({ mimeType: 'application/vnd.google-apps.folder', size: null }))).toEqual({
      kind: 'refuse',
      code: 'drive_folder',
    });
  });

  it('refuses a file in the bin, whatever it is', () => {
    expect(planFor(meta({ trashed: true }))).toEqual({ kind: 'refuse', code: 'drive_in_bin' });
    expect(
      planFor(meta({ trashed: true, mimeType: 'application/vnd.google-apps.document' })),
    ).toEqual({ kind: 'refuse', code: 'drive_in_bin' });
  });

  it('refuses a file whose owner turned off downloading', () => {
    expect(planFor(meta({ canDownload: false }))).toEqual({
      kind: 'refuse',
      code: 'drive_download_blocked',
    });
    expect(
      planFor(meta({ canDownload: false, mimeType: 'application/vnd.google-apps.spreadsheet' })),
    ).toEqual({ kind: 'refuse', code: 'drive_download_blocked' });
  });

  it("refuses a zero-byte file and one over part 1's limit, before downloading it", () => {
    expect(planFor(meta({ size: 0 }))).toEqual({ kind: 'refuse', code: 'empty' });
    const over = FILE_LIMITS.maxFileBytes + 1;
    expect(planFor(meta({ size: over }))).toEqual({
      kind: 'refuse',
      code: 'too_large',
      bytes: over,
    });
    expect(planFor(meta({ size: FILE_LIMITS.maxFileBytes }))).toEqual({ kind: 'download' });
  });

  it('downloads a file whose size Drive did not report, and counts it on the way in', () => {
    expect(planFor(meta({ size: null }))).toEqual({ kind: 'download' });
  });

  it('follows a shortcut once, and refuses a shortcut reached through a shortcut', () => {
    const shortcut = meta({
      mimeType: 'application/vnd.google-apps.shortcut',
      size: null,
      shortcutTargetId: 'targetFile12345',
      shortcutTargetMimeType: 'application/pdf',
    });
    expect(planFor(shortcut)).toEqual({ kind: 'shortcut', targetId: 'targetFile12345' });
    expect(planFor(shortcut, true)).toEqual({ kind: 'refuse', code: 'drive_shortcut_target' });
  });

  it('refuses a shortcut to a folder, and one with no target', () => {
    const base = { mimeType: 'application/vnd.google-apps.shortcut', size: null } as const;
    expect(
      planFor(
        meta({
          ...base,
          shortcutTargetId: 'folder123456',
          shortcutTargetMimeType: 'application/vnd.google-apps.folder',
        }),
      ),
    ).toEqual({ kind: 'refuse', code: 'drive_folder' });
    expect(planFor(meta({ ...base }))).toEqual({ kind: 'refuse', code: 'drive_shortcut_target' });
  });
});

describe('names', () => {
  it("shows Drive's name, cleaned like any stranger's file name", () => {
    expect(displayName({ name: 'Rate sheet' })).toBe('Rate sheet');
    expect(displayName({ name: '../../etc/<b>passwd</b>\u{202E}' })).not.toMatch(/[<>/\u{202E}]/u);
  });

  it("gives the reader the export's extension, once", () => {
    const docx = planFor(meta({ mimeType: 'application/vnd.google-apps.document', size: null }));
    expect(readerFileName({ name: 'Rate sheet' }, docx)).toBe('Rate sheet.docx');
    expect(readerFileName({ name: 'Rate sheet.DOCX' }, docx)).toBe('Rate sheet.DOCX');
    const sheet = planFor(
      meta({ mimeType: 'application/vnd.google-apps.spreadsheet', size: null }),
    );
    expect(readerFileName({ name: 'Rates' }, sheet)).toBe('Rates.xlsx');
  });

  it("leaves a downloaded file's name as it is (the reader decides by the bytes)", () => {
    expect(readerFileName({ name: 'rates.csv' }, { kind: 'download' })).toBe('rates.csv');
    expect(readerFileName({ name: 'Payslip' }, { kind: 'download' })).toBe('Payslip');
  });
});

describe('typeGroup', () => {
  it.each([
    ['application/vnd.google-apps.document', 'google_doc'],
    ['application/vnd.google-apps.spreadsheet', 'google_sheet'],
    ['application/vnd.google-apps.presentation', 'google_slides'],
    ['application/vnd.google-apps.form', 'google_other'],
    ['application/pdf', 'pdf'],
    ['image/heic', 'image'],
    ['text/csv', 'csv'],
    ['text/tab-separated-values', 'csv'],
    ['text/plain', 'text'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'word'],
    ['application/msword', 'word'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'excel'],
    ['application/vnd.ms-excel', 'excel'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'powerpoint'],
    ['application/zip', 'other'],
  ])('logs %s as %s — a group, never a name', (mimeType, group) => {
    expect(typeGroup(mimeType)).toBe(group);
  });
});
