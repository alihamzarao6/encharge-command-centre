/**
 * A file from Google Drive arriving through the files endpoint (Milestone 5 part 3a): `begin`
 * attaches it only against the server's record of the Drive read (`drive_reads`), takes its
 * name, address and time from that record and never from the browser, keeps it like an upload
 * (D121), and a later read of the same Drive file replaces the older copy. Part 1's readers and
 * steps are otherwise exactly as they were — that is the point of decision 3 in the brief.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { driveFileUrl } from '../../../src/lib/drive/limits.js';
import { FILE_LIMITS } from '../../../src/lib/files/limits.js';
import {
  FILES_MESSAGES,
  handleFilesRequest,
  type FilesPageResult,
  type FilesReply,
} from '../../../src/lib/files/page.js';
import type { DriveReadReceipt } from '../../../src/lib/files/store.js';
import { capturingLogger } from '../llm/helpers.js';
import { CONV_ID, OTHER_ID, USER_ID, harness, uuid, type Harness } from './helpers.js';

const DRIVE_FILE = '1DocAbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function call(h: Harness, body: unknown): Promise<FilesPageResult> {
  return handleFilesRequest(h.deps, { token: 'session', body });
}

function reply<A extends FilesReply['action']>(
  result: FilesPageResult,
  action: A,
): Extract<FilesReply, { action: A }> {
  if (result.status !== 200 || 'bytes' in result || result.body.action !== action) {
    throw new Error(
      `expected ${action}, got ${String(result.status)} ${JSON.stringify(result.body)}`,
    );
  }
  return result.body as Extract<FilesReply, { action: A }>;
}

function errorOf(result: FilesPageResult): {
  status: number;
  code: string;
  message: string;
  refusal?: string;
} {
  if (result.status === 200) throw new Error('expected an error');
  return { status: result.status, ...result.body.error };
}

/** What the drive endpoint leaves behind after handing over `content`'s bytes. */
function receipt(
  h: Harness,
  content: string,
  overrides: Partial<DriveReadReceipt> = {},
): DriveReadReceipt {
  const row: DriveReadReceipt = {
    id: uuid(),
    userId: USER_ID,
    driveFileId: DRIVE_FILE,
    status: 'fetched',
    name: 'Rate sheet',
    byteSize: new TextEncoder().encode(content).length,
    contentHash: sha(content),
    fetchedAt: new Date(h.clock.at).toISOString(),
    ...overrides,
  };
  h.files.driveReads.set(row.id, row);
  return row;
}

function beginBody(
  row: DriveReadReceipt,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: 'begin',
    requestId: uuid(),
    conversationId: CONV_ID,
    name: 'whatever the browser says.docx',
    kind: 'docx',
    byteSize: row.byteSize,
    contentHash: row.contentHash,
    totalPages: 1,
    visionPages: 0,
    driveReadId: row.id,
    ...overrides,
  };
}

async function attach(
  h: Harness,
  row: DriveReadReceipt,
  text: string,
): Promise<Extract<FilesReply, { action: 'finish' }>> {
  const begun = reply(await call(h, beginBody(row)), 'begin');
  reply(
    await call(h, {
      action: 'append',
      fileId: begun.fileId,
      pages: [{ pageNo: 1, label: 'Part 1', text }],
    }),
    'append',
  );
  return reply(await call(h, { action: 'finish', fileId: begun.fileId }), 'finish');
}

describe("begin — a Drive file is attached only against the server's record of the read", () => {
  it("takes Drive's name, the one address of the file and the read time; kept like an upload", async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const row = receipt(h, 'docx bytes');
    const finish = await attach(h, row, 'Variable 6.04% p.a.');
    expect(finish.file).toMatchObject({
      name: 'Rate sheet',
      kind: 'docx',
      sourceUrl: driveFileUrl(DRIVE_FILE),
      sourceHost: 'drive.google.com',
      fetchedAt: row.fetchedAt,
      driveFileId: DRIVE_FILE,
      status: 'ready',
    });
    // Kept 30 days, like an uploaded file (D121) — not a web page's one day.
    expect(Date.parse(finish.file.expiresAt) - Date.parse(finish.file.createdAt)).toBe(
      FILE_LIMITS.retentionDays * 86_400_000,
    );
  });

  it.each([
    ["somebody else's read", { userId: OTHER_ID }],
    ['a read that was refused', { status: 'refused' as const, name: null }],
    ['a read that never finished', { status: 'started' as const, name: null }],
  ])('%s is "read it from Drive again", one answer for all', async (_label, change) => {
    const { log } = capturingLogger();
    const h = harness(log);
    const row = receipt(h, 'docx bytes', change);
    const result = await call(h, beginBody(row));
    expect(errorOf(result)).toMatchObject({
      status: 409,
      code: 'FETCH_EXPIRED',
      message: FILES_MESSAGES.readAgainDrive,
    });
  });

  it('a read gone with a DISCONNECT (its record deleted) cannot be attached afterwards', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const row = receipt(h, 'docx bytes');
    h.files.driveReads.delete(row.id);
    expect(errorOf(await call(h, beginBody(row)))).toMatchObject({
      status: 409,
      code: 'FETCH_EXPIRED',
    });
  });

  it.each([
    ['a different hash', { contentHash: sha('something else') }],
    ['a different size', { byteSize: 3 }],
  ])('%s from the bytes Drive handed over is refused', async (_label, lie) => {
    const { log } = capturingLogger();
    const h = harness(log);
    const row = receipt(h, 'docx bytes');
    expect(errorOf(await call(h, beginBody(row, lie)))).toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
    });
  });

  it('a read older than the window is refused by the database even with the right bytes', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const row = receipt(h, 'docx bytes');
    h.clock.at += (FILE_LIMITS.abandonedAfterMinutes + 1) * 60_000;
    expect(errorOf(await call(h, beginBody(row)))).toMatchObject({
      status: 409,
      code: 'FETCH_EXPIRED',
    });
  });

  it('a web page never comes from Drive: an html file there is refused as an uploaded one is', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const row = receipt(h, '<html>');
    const result = await call(h, beginBody(row, { kind: 'html' }));
    expect(errorOf(result)).toMatchObject({ status: 422, refusal: 'active_content' });
  });

  it('a file is from a link or from Drive, never both', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const row = receipt(h, 'docx bytes');
    const result = await call(h, beginBody(row, { fetchId: uuid() }));
    expect(errorOf(result)).toMatchObject({ status: 400 });
  });
});

describe('a Drive file read again', () => {
  it('changed in Drive: the new read replaces the older copy, which then names nothing', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const first = await attach(h, receipt(h, 'version one'), 'Variable 6.04% p.a.');
    h.clock.at += 60 * 60_000;
    const second = await attach(h, receipt(h, 'version two'), 'Variable 6.09% p.a.');
    expect(second.replaced).toBe(1);
    expect(h.files.files.get(first.file.id)?.record).toMatchObject({
      status: 'removed',
      name: null,
      sourceUrl: null,
      driveFileId: null,
    });
    const turn = await h.files.forTurn(CONV_ID);
    expect(turn.ok && turn.value.files.map((file) => file.pages[0]?.content)).toEqual([
      'Variable 6.09% p.a.',
    ]);
  });

  it('unchanged, but RENAMED in Drive: the same attachment, now current, under its new name', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const first = await attach(h, receipt(h, 'same bytes'), 'text');
    h.clock.at += 2 * 60 * 60_000;
    const again = reply(
      await call(h, beginBody(receipt(h, 'same bytes', { name: 'Rate sheet (Oct)' }))),
      'begin',
    );
    expect(again).toMatchObject({ duplicate: true, fileId: first.file.id });
    expect(again.file).toMatchObject({
      name: 'Rate sheet (Oct)',
      fetchedAt: new Date(h.clock.at).toISOString(),
    });
  });

  it('a different Drive file in the same conversation is left alone', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    await attach(h, receipt(h, 'one'), 'one');
    const second = await attach(
      h,
      receipt(h, 'two', { driveFileId: '1OtherFileAbCdEfGhIjKlMnOp' }),
      'two',
    );
    expect(second.replaced).toBe(0);
  });
});

describe('what the model and the log see', () => {
  it('a Drive file reads to the model as an upload does: no web source, no web-page rules', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    await attach(h, receipt(h, 'docx bytes'), 'text');
    const turn = await h.files.forTurn(CONV_ID);
    expect(turn.ok && turn.value.files[0]).not.toHaveProperty('source');
    expect(turn.ok && turn.value.everHadPage).toBe(false);
  });

  it('logs the source as drive — never the name', async () => {
    const { log, lines } = capturingLogger();
    const h = harness(log);
    await attach(h, receipt(h, 'docx bytes', { name: 'CANARY-DRIVE-NAME-0c1e statement' }), 'text');
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.find((line) => line['msg'] === 'file upload started')).toMatchObject({
      source: 'drive',
    });
    expect(parsed.find((line) => line['msg'] === 'file upload finished')).toMatchObject({
      source: 'drive',
    });
    expect(lines.join('\n')).not.toContain('CANARY-DRIVE-NAME');
  });

  it('a Drive file the browser refused is logged as such', async () => {
    const { log, lines } = capturingLogger();
    const h = harness(log);
    const row = receipt(h, 'pptx bytes');
    reply(
      await call(h, {
        action: 'refused',
        kind: null,
        byteSize: 10,
        reason: 'presentation',
        driveReadId: row.id,
      }),
      'refused',
    );
    const line = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l['msg'] === 'file upload refused');
    expect(line).toMatchObject({ source: 'drive', driveReadId: row.id, reason: 'presentation' });
  });
});
