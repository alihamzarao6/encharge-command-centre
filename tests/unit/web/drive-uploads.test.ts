/**
 * A file from Google Drive in the upload queue (web/src/lib/uploads.ts, Milestone 5 part 3a),
 * every dependency scripted. Drive is one more source in the SAME queue, so what is tested here
 * is what Drive adds — the read at the front, the server's record of it carried into `begin`,
 * Drive's own name, a connection failure that points at Settings — and that the rest (one at a
 * time, the scan question, the budget, whole or not at all) is unchanged for it.
 *
 * Part C, "the run" and "the file", as far as the browser's half goes: two files picked at
 * once · the same file picked twice · renamed between picking and reading · a type the readers
 * refuse · a broken connection · disconnected in flight · the spend cap reached mid-read.
 */
import { describe, expect, it } from 'vitest';

import { DRIVE_CONNECTION_MESSAGES, DRIVE_RETRY_MESSAGES } from '../../../src/lib/drive/limits.js';
import { refusal } from '../../../src/lib/files/limits.js';
import type { DriveFailure, DriveFile, DriveOutcome } from '../../../web/src/lib/driveApi.js';
import type {
  AttachedFile,
  FilesFailure,
  FilesOutcome,
  FilesRequest,
  ReplyFor,
} from '../../../web/src/lib/filesApi.js';
import type { Extraction, ExtractionOk } from '../../../web/src/lib/files/types.js';
import { createUploadsStore, isBusy, type UploadsStore } from '../../../web/src/lib/uploads.js';

const CONV = 'c0000000-0000-4000-8000-000000000001';
const HASH = 'd'.repeat(64);
const BYTES = new TextEncoder().encode('PK docx bytes');

function wordDoc(): ExtractionOk {
  return {
    ok: true,
    kind: 'docx',
    totalPages: 1,
    pages: [{ pageNo: 1, label: 'Part 1', text: 'Two year fixed 5.79% p.a.', method: 'docx_xml' }],
    vision: [],
    notes: [],
    dispose: () => undefined,
  };
}

function scannedDeck(pages: number): ExtractionOk {
  return {
    ok: true,
    kind: 'pdf',
    totalPages: pages,
    pages: [],
    vision: Array.from({ length: pages }, (_unused, i) => ({
      pageNo: i + 1,
      label: `Page ${String(i + 1)}`,
      image: () =>
        Promise.resolve({ base64: `/9j/slide${String(i + 1)}`, width: 1448, height: 2048 }),
    })),
    notes: [],
    dispose: () => undefined,
  };
}

const view = (id: string, overrides: Partial<AttachedFile> = {}): AttachedFile => ({
  id,
  conversationId: CONV,
  uploadedBy: 'u1',
  name: 'Rate sheet',
  kind: 'docx',
  byteSize: BYTES.length,
  pageCount: 1,
  visionPages: 0,
  status: 'ready',
  createdAt: '2026-10-16T02:00:00Z',
  expiresAt: '2026-11-15T02:00:00Z',
  sourceUrl: 'https://drive.google.com/file/d/DocFileId0001/view',
  sourceHost: 'drive.google.com',
  fetchedAt: '2026-10-16T02:00:00Z',
  valuesMissing: 0,
  readAsSent: false,
  removedReason: null,
  driveFileId: 'DocFileId0001',
  ...overrides,
});

function driveFailure(
  code: string,
  message: string,
  failure: FilesFailure['failure'],
  reconnect = false,
  status = 409,
): DriveFailure {
  return { kind: 'error', failure, message, code, status, reconnect };
}

function filesFailure(
  failure: FilesFailure['failure'],
  message: string,
  code: string,
  status: number | null = 503,
): FilesFailure {
  return { kind: 'error', failure, message, code, status };
}

interface Rig {
  readonly store: UploadsStore;
  readonly requests: FilesRequest[];
  readonly reads: { requestId: string; fileId: string }[];
  readonly extracts: {
    name: string;
    fromLink: boolean | undefined;
    contentType: string | null | undefined;
  }[];
  readonly announced: string[];
  /** Answers to readDrive, in order; when empty, a good read of the asked file. */
  readonly driveAnswers: DriveOutcome<DriveFile>[];
  extractions: Extraction[];
  handler: (request: FilesRequest) => FilesOutcome<unknown> | undefined;
  settle(): Promise<void>;
}

function goodRead(fileId: string, name = 'Rate sheet', readSeq = 1): DriveOutcome<DriveFile> {
  return {
    kind: 'ok',
    reply: {
      readId: `r0000000-0000-4000-8000-${String(readSeq).padStart(12, '0')}`,
      name,
      fileName: `${name}.docx`,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      contentHash: HASH,
      googleType: 'Google Doc',
      fileId,
      bytes: BYTES,
    },
  };
}

function rig(): Rig {
  let fileSeq = 0;
  let requestSeq = 0;
  let readSeq = 0;
  const r: Rig = {
    requests: [],
    reads: [],
    extracts: [],
    announced: [],
    driveAnswers: [],
    extractions: [],
    handler: () => undefined,
    settle: async () => {
      for (let i = 0; i < 60; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    store: createUploadsStore({
      readDrive: (request, _signal, onProgress) => {
        r.reads.push(request);
        readSeq += 1;
        const scripted = r.driveAnswers.shift();
        if (scripted !== undefined) return Promise.resolve(scripted);
        onProgress(BYTES.length, BYTES.length);
        return Promise.resolve(goodRead(request.fileId, 'Rate sheet', readSeq));
      },
      fetchPage: () => Promise.reject(new Error('drive-uploads.test.ts does not read links')),
      extract: (input, onProgress) => {
        r.extracts.push({
          name: input.name,
          fromLink: input.fromLink,
          contentType: input.contentType,
        });
        onProgress(1, 1);
        return Promise.resolve(r.extractions.shift() ?? wordDoc());
      },
      hash: () =>
        Promise.reject(new Error('a Drive file is never hashed here: the server already did')),
      call: <R extends FilesRequest>(request: R): Promise<FilesOutcome<ReplyFor<R['action']>>> => {
        r.requests.push(request);
        const scripted = r.handler(request);
        if (scripted !== undefined)
          return Promise.resolve(scripted as FilesOutcome<ReplyFor<R['action']>>);
        const ok = (reply: unknown): Promise<FilesOutcome<ReplyFor<R['action']>>> =>
          Promise.resolve({ kind: 'ok', reply } as FilesOutcome<ReplyFor<R['action']>>);
        switch (request.action) {
          case 'estimate':
            return ok({
              action: 'estimate',
              pages: request.visionPages,
              perPageUsd: 0.027,
              estimateUsd: 0.081,
              dailyCapUsd: 5,
              spentTodayUsd: 1,
              affordable: true,
            });
          case 'begin':
            fileSeq += 1;
            return ok({
              action: 'begin',
              fileId: `file-${String(fileSeq)}`,
              conversationId: request.conversationId ?? CONV,
              status: 'reading',
              duplicate: false,
              pagesStored: [],
            });
          case 'append':
            return ok({ action: 'append', stored: request.pages.length });
          case 'read_page':
            return ok({
              action: 'read_page',
              pageNo: request.pageNo,
              legibility: 'full',
              pageKind: 'document',
            });
          case 'finish':
            return ok({
              action: 'finish',
              duplicate: false,
              replaced: 0,
              file: view(request.fileId),
            });
          case 'remove':
            return ok({ action: 'remove', removed: true });
          case 'refused':
            return ok({ action: 'refused' });
        }
      },
      loadFiles: () => Promise.resolve([]),
      newRequestId: () => {
        requestSeq += 1;
        return `req-${String(requestSeq)}`;
      },
      now: () => 1000,
      adoptConversation: () => undefined,
      onSessionExpired: () => Promise.resolve(),
    }),
  };
  r.store.subscribe(() => {
    const said = r.store.getState().announcement;
    if (said !== '' && r.announced.at(-1) !== said) r.announced.push(said);
  });
  r.store.setConversation(CONV);
  return r;
}

const begins = (r: Rig): Extract<FilesRequest, { action: 'begin' }>[] =>
  r.requests.filter(
    (request): request is Extract<FilesRequest, { action: 'begin' }> => request.action === 'begin',
  );

describe('a file from Google Drive', () => {
  it('our server reads it, this device reads it as a FILE, and it is attached against the read', async () => {
    const r = rig();
    r.store.addDrive([{ fileId: 'DocFileId0001', name: 'Rate sheet' }]);
    expect(r.store.getState().uploads[0]).toMatchObject({
      source: 'drive',
      driveFileId: 'DocFileId0001',
      phase: 'fetching',
    });
    expect(isBusy(r.store.getState())).toBe(true);
    await r.settle();
    expect(r.reads).toEqual([{ requestId: 'req-2', fileId: 'DocFileId0001' }]);
    // Read as what it is, with the export's name — and never as a web page.
    expect(r.extracts).toEqual([
      {
        name: 'Rate sheet.docx',
        fromLink: undefined,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ]);
    expect(r.requests.map((request) => request.action)).toEqual(['begin', 'append', 'finish']);
    expect(begins(r)[0]).toMatchObject({
      name: 'Rate sheet',
      kind: 'docx',
      byteSize: BYTES.length,
      contentHash: HASH,
      driveReadId: 'r0000000-0000-4000-8000-000000000001',
    });
    expect(begins(r)[0]).not.toHaveProperty('fetchId');
    expect(r.store.getState().uploads).toEqual([]);
    expect(r.store.getState().files.map((file) => file.driveFileId)).toEqual(['DocFileId0001']);
    expect(r.announced).toEqual([
      'Getting Rate sheet from Google Drive.',
      'Reading Rate sheet.',
      'Rate sheet attached from Google Drive: 1 part.',
    ]);
  });

  it('RENAMED between picking and reading: the name Drive gives it when it is read is the one shown', async () => {
    const r = rig();
    r.driveAnswers.push(goodRead('DocFileId0001', 'Rate sheet (renamed)'));
    r.store.addDrive([{ fileId: 'DocFileId0001', name: 'Rate sheet' }]);
    await r.settle();
    expect(begins(r)[0]?.name).toBe('Rate sheet (renamed)');
    expect(r.extracts[0]?.name).toBe('Rate sheet (renamed).docx');
  });

  it('TWO FILES PICKED AT ONCE are read one after the other, never at the same time', async () => {
    const r = rig();
    r.store.addDrive([
      { fileId: 'FirstFile0001', name: 'One' },
      { fileId: 'SecondFile001', name: 'Two' },
    ]);
    expect(r.store.getState().uploads.map((item) => item.phase)).toEqual(['fetching', 'waiting']);
    await r.settle();
    expect(r.reads.map((read) => read.fileId)).toEqual(['FirstFile0001', 'SecondFile001']);
    expect(begins(r)).toHaveLength(2);
  });

  it('THE SAME FILE PICKED TWICE is read once', async () => {
    const r = rig();
    r.store.addDrive([
      { fileId: 'DocFileId0001', name: 'Rate sheet' },
      { fileId: 'DocFileId0001', name: 'Rate sheet' },
    ]);
    r.store.addDrive([{ fileId: 'DocFileId0001', name: 'Rate sheet' }]);
    await r.settle();
    expect(r.reads).toHaveLength(1);
  });

  it('an id that is not a Drive file id is not even asked for', async () => {
    const r = rig();
    r.store.addDrive([
      { fileId: '../../etc', name: 'x' },
      { fileId: 'short', name: null },
    ]);
    await r.settle();
    expect(r.reads).toHaveLength(0);
    expect(r.store.getState().uploads).toEqual([]);
  });

  it("a type the readers refuse is refused with part 1's sentence, and the refusal is logged with the read", async () => {
    const r = rig();
    r.extractions.push({ ok: false, kind: null, refusal: refusal('presentation') });
    r.store.addDrive([{ fileId: 'PptxFile00001', name: 'Deck.pptx' }]);
    await r.settle();
    expect(r.store.getState().uploads[0]).toMatchObject({
      phase: 'refused',
      message: refusal('presentation').message,
      reconnect: false,
    });
    expect(r.requests).toEqual([
      expect.objectContaining({
        action: 'refused',
        reason: 'presentation',
        driveReadId: 'r0000000-0000-4000-8000-000000000001',
      }),
    ]);
  });

  it("a file Drive refuses (in the bin, a Form…) stops with Drive's sentence", async () => {
    const r = rig();
    r.driveAnswers.push(
      driveFailure(
        'DRIVE_REFUSED',
        'That file is in your Google Drive bin.',
        'refused',
        false,
        422,
      ),
    );
    r.store.addDrive([{ fileId: 'BinFile000001', name: 'Old.pdf' }]);
    await r.settle();
    expect(r.store.getState().uploads[0]).toMatchObject({
      phase: 'refused',
      message: 'That file is in your Google Drive bin.',
    });
    expect(r.requests).toEqual([]);
  });

  it('A BROKEN CONNECTION is said, points at Settings, and offers no "Try again"', async () => {
    const r = rig();
    r.driveAnswers.push(
      driveFailure('CONNECTION_BROKEN', DRIVE_CONNECTION_MESSAGES.connection_broken, 'fatal', true),
    );
    r.store.addDrive([{ fileId: 'DocFileId0001', name: 'Rate sheet' }]);
    await r.settle();
    expect(r.store.getState().uploads[0]).toMatchObject({
      phase: 'failed',
      message: DRIVE_CONNECTION_MESSAGES.connection_broken,
      retryable: false,
      reconnect: true,
    });
    expect(r.announced.at(-1)).toContain('no longer connected');
  });

  it('Google busy: "Try again" reads it afresh, under a new id', async () => {
    const r = rig();
    r.driveAnswers.push(
      driveFailure('DRIVE_NOT_READ', DRIVE_RETRY_MESSAGES.drive_busy, 'retryable', false, 429),
    );
    r.store.addDrive([{ fileId: 'DocFileId0001', name: 'Rate sheet' }]);
    await r.settle();
    const item = r.store.getState().uploads[0];
    expect(item).toMatchObject({ phase: 'failed', retryable: true, reconnect: false });
    r.store.retry(item?.localId ?? '');
    await r.settle();
    expect(r.reads.map((read) => read.requestId)).toEqual(['req-2', 'req-3']);
    expect(r.store.getState().uploads).toEqual([]);
  });

  it('DISCONNECTED IN FLIGHT: the read already handed over cannot be attached, and "Try again" reads again', async () => {
    const r = rig();
    let first = true;
    r.handler = (request) => {
      if (request.action === 'begin' && first) {
        first = false;
        return filesFailure(
          'retryable',
          'That file has to be read from Google Drive again before it can be attached. Try again.',
          'FETCH_EXPIRED',
          409,
        );
      }
      return undefined;
    };
    r.store.addDrive([{ fileId: 'DocFileId0001', name: 'Rate sheet' }]);
    await r.settle();
    const item = r.store.getState().uploads[0];
    expect(item).toMatchObject({ phase: 'failed', retryable: true });
    // Retry: Drive refuses now, because it is no longer connected.
    r.driveAnswers.push(
      driveFailure('NOT_CONNECTED', DRIVE_CONNECTION_MESSAGES.not_connected, 'fatal', true),
    );
    r.store.retry(item?.localId ?? '');
    await r.settle();
    expect(r.reads).toHaveLength(2);
    expect(r.store.getState().uploads[0]).toMatchObject({ phase: 'failed', reconnect: true });
  });

  it('a Slides deck of pictures asks before it is read, as a scan does — and THE SPEND CAP mid-read leaves nothing attached', async () => {
    const r = rig();
    r.extractions.push(scannedDeck(3));
    let pages = 0;
    r.handler = (request) => {
      if (request.action === 'read_page') {
        pages += 1;
        if (pages === 2) {
          return filesFailure(
            'cap',
            "Today's budget for the assistant has been used up, so this page was not read and the file was not attached.",
            'SPEND_CAP',
            402,
          );
        }
      }
      return undefined;
    };
    r.store.addDrive([{ fileId: 'SlidesFile001', name: 'Deck' }]);
    await r.settle();
    const asking = r.store.getState().uploads[0];
    expect(asking).toMatchObject({ phase: 'confirm', source: 'drive' });
    r.store.confirm(asking?.localId ?? '');
    await r.settle();
    const stopped = r.store.getState().uploads[0];
    expect(stopped?.phase).toBe('failed');
    expect(stopped?.message).toMatch(/^Stopped after 1 of 3 pages\. Today's budget/);
    expect(r.requests.map((request) => request.action)).not.toContain('finish');
    expect(r.store.getState().files).toEqual([]);
  });

  it('Stop while it is being read from Drive leaves nothing behind', async () => {
    const r = rig();
    r.store.addDrive([{ fileId: 'DocFileId0001', name: 'Rate sheet' }]);
    const item = r.store.getState().uploads[0];
    r.store.cancel(item?.localId ?? '');
    await r.settle();
    expect(r.store.getState().uploads).toEqual([]);
    expect(r.requests.filter((request) => request.action === 'begin')).toEqual([]);
  });

  it('read again, unchanged: said to be the same file, and nothing new is attached', async () => {
    const r = rig();
    r.handler = (request) =>
      request.action === 'begin'
        ? {
            kind: 'ok',
            reply: {
              action: 'begin',
              fileId: 'file-old',
              conversationId: CONV,
              status: 'ready',
              duplicate: true,
              pagesStored: [],
            },
          }
        : undefined;
    r.store.addDrive([{ fileId: 'DocFileId0001', name: 'Rate sheet' }]);
    await r.settle();
    expect(r.announced.at(-1)).toBe(
      'Rate sheet is already in this conversation, unchanged in Google Drive.',
    );
    expect(r.requests.map((request) => request.action)).toEqual(['begin']);
  });

  it('read again, changed: the newer copy replaces the older one, and that is said', async () => {
    const r = rig();
    r.handler = (request) =>
      request.action === 'finish'
        ? {
            kind: 'ok',
            reply: { action: 'finish', duplicate: false, replaced: 1, file: view(request.fileId) },
          }
        : undefined;
    r.store.addDrive([{ fileId: 'DocFileId0001', name: 'Rate sheet' }]);
    await r.settle();
    expect(r.announced.at(-1)).toBe(
      'Rate sheet attached from Google Drive: 1 part. It replaces the earlier read of this file.',
    );
  });
});
