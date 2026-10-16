/**
 * The upload queue (web/src/lib/uploads.ts) with every dependency scripted: what the browser
 * sends and in what order, what a person sees at each step, and what happens when the
 * connection drops, the budget runs out, a page will not read, or they change their mind.
 * Part C, "the run" — as far as the browser's half of it goes.
 */
import { describe, expect, it } from 'vitest';

import { FILE_LIMITS, refusal } from '../../../src/lib/files/limits.js';
import type {
  AttachedFile,
  FilesFailure,
  FilesOutcome,
  FilesRequest,
  ReplyFor,
  VisionEstimate,
} from '../../../web/src/lib/filesApi.js';
import type { Extraction, ExtractionOk } from '../../../web/src/lib/files/types.js';
import {
  UPLOAD_MESSAGES,
  createUploadsStore,
  isBusy,
  money,
  type BrowserFile,
  type UploadsStore,
} from '../../../web/src/lib/uploads.js';

const CONV = 'c0000000-0000-4000-8000-000000000001';
const NEW_CONV = 'c0000000-0000-4000-8000-0000000000aa';

function file(name: string, size = 4651): BrowserFile & { read: number } {
  const f = {
    name,
    size,
    read: 0,
    bytes: (): Promise<Uint8Array> => {
      f.read += 1;
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
  };
  return f;
}

function textDoc(pages = 2, notes: string[] = []): ExtractionOk {
  return {
    ok: true,
    kind: 'pdf',
    totalPages: pages,
    pages: Array.from({ length: pages }, (_, i) => ({
      pageNo: i + 1,
      label: `Page ${String(i + 1)}`,
      text: `Text of page ${String(i + 1)}`,
      method: 'pdf_text_layer' as const,
    })),
    vision: [],
    notes,
    dispose: () => undefined,
  };
}

function scan(
  pages: number,
  kind: 'pdf' | 'image' = 'pdf',
): ExtractionOk & { rendered: number[]; disposed: number } {
  const doc = {
    ok: true as const,
    kind,
    totalPages: pages,
    pages: [],
    rendered: [] as number[],
    disposed: 0,
    vision: Array.from({ length: pages }, (_, i) => ({
      pageNo: i + 1,
      label: kind === 'image' ? 'Photo' : `Page ${String(i + 1)}`,
      image: () => {
        doc.rendered.push(i + 1);
        return Promise.resolve({ base64: `/9j/page${String(i + 1)}`, width: 1448, height: 2048 });
      },
    })),
    notes: [],
    dispose: () => {
      doc.disposed += 1;
    },
  };
  return doc;
}

const view = (id: string, conversationId = CONV, pageCount = 2): AttachedFile => ({
  id,
  conversationId,
  uploadedBy: 'u1',
  name: 'payslip.pdf',
  kind: 'pdf',
  byteSize: 4651,
  pageCount,
  visionPages: 0,
  status: 'ready',
  createdAt: '2026-10-12T04:00:00Z',
  expiresAt: '2026-11-11T04:00:00Z',
  sourceUrl: null,
  sourceHost: null,
  fetchedAt: null,
  valuesMissing: 0,
  readAsSent: false,
  removedReason: null,
  driveFileId: null,
});

const ESTIMATE: VisionEstimate = {
  pages: 3,
  perPageUsd: 0.027132,
  estimateUsd: 0.081396,
  dailyCapUsd: 5,
  spentTodayUsd: 1.25,
  affordable: true,
};

function failed(
  failure: FilesFailure['failure'],
  message: string,
  status: number | null = 503,
): FilesFailure {
  return { kind: 'error', failure, message, code: 'TEST', status };
}

type Handler = (request: FilesRequest) => FilesOutcome<unknown> | undefined;

interface Rig {
  readonly store: UploadsStore;
  readonly requests: FilesRequest[];
  readonly adopted: string[];
  extractions: Extraction[];
  extractThrows: boolean;
  handler: Handler;
  listed: AttachedFile[] | null;
  expired: number;
  /** Calls matching this are sent and then held open until `release`. */
  holdWhen: (request: FilesRequest) => boolean;
  readonly held: (() => void)[];
  release(): void;
  /** Resolves once the queue has gone quiet. */
  settle(): Promise<void>;
}

function rig(conversationId: string | null = CONV): Rig {
  let fileSeq = 0;
  let requestSeq = 0;
  const r: Rig = {
    requests: [],
    adopted: [],
    extractions: [],
    extractThrows: false,
    handler: () => undefined,
    listed: [],
    expired: 0,
    holdWhen: () => false,
    held: [],
    release: () => {
      for (const go of r.held.splice(0)) go();
    },
    settle: async () => {
      // setImmediate, not setTimeout(0): each turn drains the promise queue all the same, and
      // a timer costs a full clock tick per turn on Windows (30 seconds across this file).
      for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    store: createUploadsStore({
      extract: (_input, onProgress) => {
        if (r.extractThrows) return Promise.reject(new Error('reader failed to load'));
        onProgress(1, 2);
        const next = r.extractions.shift();
        return Promise.resolve(next ?? textDoc());
      },
      hash: () => Promise.resolve('a'.repeat(64)),
      // These tests attach files; links are tests/unit/web/uploads-links.test.ts.
      fetchPage: () => Promise.reject(new Error('uploads.test.ts does not read links')),
      readDrive: () => Promise.reject(new Error('uploads.test.ts does not read Drive files')),
      call: <R extends FilesRequest>(request: R): Promise<FilesOutcome<ReplyFor<R['action']>>> => {
        r.requests.push(request);
        if (r.holdWhen(request)) {
          // Sent, and answered only when the test says so — with the answer it would have had.
          return new Promise((resolve) => {
            r.held.push(() => {
              resolve(answer(request));
            });
          });
        }
        return answer(request);
      },
      loadFiles: () => Promise.resolve(r.listed),
      newRequestId: () => {
        requestSeq += 1;
        return `req-${String(requestSeq)}`;
      },
      now: () => 1000,
      adoptConversation: (id) => {
        r.adopted.push(id);
      },
      onSessionExpired: () => {
        r.expired += 1;
        return Promise.resolve();
      },
    }),
  };

  function answer<R extends FilesRequest>(
    request: R,
  ): Promise<FilesOutcome<ReplyFor<R['action']>>> {
    const scripted = r.handler(request);
    if (scripted !== undefined)
      return Promise.resolve(scripted as FilesOutcome<ReplyFor<R['action']>>);
    const ok = (reply: unknown): Promise<FilesOutcome<ReplyFor<R['action']>>> =>
      Promise.resolve({ kind: 'ok', reply } as FilesOutcome<ReplyFor<R['action']>>);
    switch (request.action) {
      case 'estimate':
        return ok({ action: 'estimate', ...ESTIMATE, pages: request.visionPages });
      case 'begin':
        fileSeq += 1;
        return ok({
          action: 'begin',
          fileId: `file-${String(fileSeq)}`,
          conversationId: request.conversationId ?? NEW_CONV,
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
        return ok({ action: 'finish', duplicate: false, file: view(request.fileId) });
      case 'remove':
        return ok({ action: 'remove', removed: true });
      case 'refused':
        return ok({ action: 'refused' });
    }
  }

  r.store.setConversation(conversationId);
  return r;
}

const actions = (r: Rig): string[] => r.requests.map((request) => request.action);

describe('a typed file', () => {
  it('is read here, sent as text, and attached: begin → append → finish', async () => {
    const r = rig();
    r.store.add([file('payslip.pdf')]);
    expect(r.store.getState().uploads[0]).toMatchObject({
      name: 'payslip.pdf',
      byteSize: 4651,
      phase: 'reading',
    });
    await r.settle();
    expect(actions(r)).toEqual(['begin', 'append', 'finish']);
    expect(r.requests[0]).toMatchObject({
      action: 'begin',
      requestId: 'req-1',
      conversationId: CONV,
      name: 'payslip.pdf',
      kind: 'pdf',
      byteSize: 4651,
      contentHash: 'a'.repeat(64),
      totalPages: 2,
      visionPages: 0,
    });
    expect(r.requests[1]).toMatchObject({
      pages: [
        { pageNo: 1, label: 'Page 1', text: 'Text of page 1' },
        { pageNo: 2, label: 'Page 2', text: 'Text of page 2' },
      ],
    });
    const state = r.store.getState();
    expect(state.uploads).toEqual([]);
    expect(state.files.map((f) => f.id)).toEqual(['file-1']);
    expect(state.announcement).toBe('payslip.pdf attached: 2 parts.');
    expect(isBusy(state)).toBe(false);
  });

  it('the name shown and sent is a clean label, never the raw one', async () => {
    const r = rig();
    r.store.add([file('../../<b>pay</b>.pdf')]);
    expect(r.store.getState().uploads[0]?.name).toBe('b).pdf');
    await r.settle();
    expect(r.requests[0]).toMatchObject({ name: 'b).pdf' });
  });

  it('notes from the reader are part of the announcement', async () => {
    const r = rig();
    r.extractions = [
      textDoc(1, ['This file contains macros. They were not run and were not read.']),
    ];
    r.handler = (request) =>
      request.action === 'finish'
        ? {
            kind: 'ok',
            reply: { action: 'finish', duplicate: false, file: view('file-1', CONV, 1) },
          }
        : undefined;
    r.store.add([file('book.xlsm')]);
    await r.settle();
    expect(r.store.getState().announcement).toBe(
      'book.xlsm attached: 1 part. This file contains macros. They were not run and were not read.',
    );
  });

  it('a long document is sent in batches', async () => {
    const r = rig();
    r.extractions = [textDoc(95)];
    r.store.add([file('policy.pdf')]);
    await r.settle();
    const appends = r.requests.filter((request) => request.action === 'append');
    expect(appends.map((request) => request.pages.length)).toEqual([40, 40, 15]);
  });
});

describe('a new conversation', () => {
  it('the upload opens it, the thread is told, and the next file goes to the same one', async () => {
    const r = rig(null);
    r.store.add([file('one.pdf'), file('two.pdf')]);
    await r.settle();
    const begins = r.requests.filter((request) => request.action === 'begin');
    expect(begins.map((request) => request.conversationId)).toEqual([null, NEW_CONV]);
    expect(r.adopted).toEqual([NEW_CONV]);
    expect(r.store.getState().conversationId).toBe(NEW_CONV);
    // The thread echoing that id back is not "the person left".
    r.store.setConversation(NEW_CONV);
    expect(r.store.getState().files).toHaveLength(2);
  });
});

describe('two files at once, and the same file twice', () => {
  it('two files are two uploads, one after the other', async () => {
    const r = rig();
    r.store.add([file('one.pdf'), file('two.pdf')]);
    expect(r.store.getState().uploads.map((item) => item.phase)).toEqual(['reading', 'waiting']);
    await r.settle();
    expect(actions(r)).toEqual(['begin', 'append', 'finish', 'begin', 'append', 'finish']);
    expect(r.store.getState().files.map((f) => f.id)).toEqual(['file-1', 'file-2']);
  });

  it('a file already attached is recognised: nothing is sent again, and the person is told', async () => {
    const r = rig();
    r.listed = [view('existing')];
    r.handler = (request) =>
      request.action === 'begin'
        ? {
            kind: 'ok',
            reply: {
              action: 'begin',
              fileId: 'existing',
              conversationId: CONV,
              status: 'ready',
              duplicate: true,
              pagesStored: [],
            },
          }
        : undefined;
    r.store.add([file('payslip.pdf')]);
    await r.settle();
    expect(actions(r)).toEqual(['begin']);
    expect(r.store.getState().uploads).toEqual([]);
    expect(r.store.getState().files.map((f) => f.id)).toEqual(['existing']);
    expect(r.store.getState().announcement).toBe(
      'payslip.pdf is already attached to this conversation.',
    );
  });
});

describe('a file that is refused', () => {
  it('a zero-byte file and one over the limit are refused without being read', async () => {
    const r = rig();
    const empty = file('empty.pdf', 0);
    const big = file('big.pdf', FILE_LIMITS.maxFileBytes + 1);
    const exact = file('exact.pdf', FILE_LIMITS.maxFileBytes);
    r.store.add([empty, big, exact]);
    await r.settle();
    expect(empty.read).toBe(0);
    expect(big.read).toBe(0);
    expect(exact.read).toBe(1);
    const [first, second] = r.store.getState().uploads;
    expect(first).toMatchObject({ phase: 'refused', message: refusal('empty').message });
    expect(second).toMatchObject({
      phase: 'refused',
      message: 'This file is 20.0 MB, which is over the 20 MB limit.',
    });
    // The file at exactly the limit went through.
    expect(r.store.getState().files).toHaveLength(1);
    // Both refusals were reported: a size and a reason, never the file.
    expect(r.requests.filter((request) => request.action === 'refused')).toEqual([
      { action: 'refused', kind: null, byteSize: 0, reason: 'empty', extractMs: 0 },
      {
        action: 'refused',
        kind: null,
        byteSize: FILE_LIMITS.maxFileBytes + 1,
        reason: 'too_large',
        extractMs: 0,
      },
    ]);
  });

  it('a refusal from the reader is shown in its own words and nothing is started', async () => {
    const r = rig();
    r.extractions = [{ ok: false, kind: 'pdf', refusal: refusal('password_pdf') }];
    r.store.add([file('locked.pdf')]);
    await r.settle();
    expect(r.store.getState().uploads[0]).toMatchObject({
      phase: 'refused',
      kind: 'pdf',
      message: refusal('password_pdf').message,
      retryable: false,
    });
    expect(actions(r)).toEqual(['refused']);
    expect(r.store.getState().announcement).toContain(
      'locked.pdf was not attached. This PDF is password-protected',
    );
    // Refused is not "busy": it does not hold up a message.
    expect(isBusy(r.store.getState())).toBe(false);
    r.store.cancel(r.store.getState().uploads[0]?.localId ?? '');
    expect(r.store.getState().uploads).toEqual([]);
  });

  it('a reader that throws is a refusal, not a stuck spinner', async () => {
    const r = rig();
    r.extractThrows = true;
    r.store.add([file('odd.pdf')]);
    await r.settle();
    expect(r.store.getState().uploads[0]).toMatchObject({
      phase: 'refused',
      message: refusal('corrupt').message,
    });
  });

  it('a refusal from the server (the conversation is full) is shown as the file being refused', async () => {
    const r = rig();
    r.handler = (request) =>
      request.action === 'begin'
        ? {
            ...failed('refused', refusal('too_many_files').message, 422),
            refusal: 'too_many_files',
          }
        : undefined;
    r.store.add([file('eleventh.pdf')]);
    await r.settle();
    expect(r.store.getState().uploads[0]).toMatchObject({
      phase: 'refused',
      message: 'This conversation already has 10 files attached. Remove one first.',
    });
  });
});

describe('a scan — the question before it is read (D90)', () => {
  it('says how many pages and what it costs, and waits', async () => {
    const r = rig();
    const doc = scan(3);
    r.extractions = [doc];
    r.store.add([file('statement.pdf')]);
    await r.settle();
    expect(actions(r)).toEqual(['estimate']);
    expect(r.requests[0]).toEqual({ action: 'estimate', visionPages: 3 });
    const item = r.store.getState().uploads[0];
    expect(item).toMatchObject({ phase: 'confirm', total: 3 });
    expect(item?.estimate).toMatchObject({ pages: 3, estimateUsd: 0.081396, dailyCapUsd: 5 });
    // Nothing has been rendered, begun or spent.
    expect(doc.rendered).toEqual([]);
    expect(isBusy(r.store.getState())).toBe(true);
    expect(r.store.getState().announcement).toBe(
      'statement.pdf is a scan of 3 pages. Reading it costs about $0.08. Choose to read it or cancel.',
    );
  });

  it('yes → each page is rendered and read in order, then the file is attached', async () => {
    const r = rig();
    const doc = scan(3);
    r.extractions = [doc];
    r.store.add([file('statement.pdf')]);
    await r.settle();
    r.store.confirm(r.store.getState().uploads[0]?.localId ?? '');
    await r.settle();
    expect(actions(r)).toEqual([
      'estimate',
      'begin',
      'read_page',
      'read_page',
      'read_page',
      'finish',
    ]);
    expect(r.requests[1]).toMatchObject({ totalPages: 3, visionPages: 3 });
    expect(r.requests[3]).toEqual({
      action: 'read_page',
      fileId: 'file-1',
      pageNo: 2,
      label: 'Page 2',
      imageBase64: '/9j/page2',
    });
    expect(doc.rendered).toEqual([1, 2, 3]);
    expect(r.store.getState().uploads).toEqual([]);
    expect(doc.disposed).toBe(1);
  });

  it('no → nothing is begun, nothing is rendered, the file is let go', async () => {
    const r = rig();
    const doc = scan(3);
    r.extractions = [doc];
    r.store.add([file('statement.pdf')]);
    await r.settle();
    r.store.cancel(r.store.getState().uploads[0]?.localId ?? '');
    await r.settle();
    expect(actions(r)).toEqual(['estimate']);
    expect(doc.rendered).toEqual([]);
    expect(doc.disposed).toBe(1);
    expect(r.store.getState().uploads).toEqual([]);
    expect(r.store.getState().announcement).toBe('statement.pdf: Stopped. Nothing was attached.');
  });

  it('a single photo is read without the question', async () => {
    const r = rig();
    r.extractions = [scan(1, 'image')];
    r.store.add([file('photo.jpg')]);
    await r.settle();
    expect(actions(r)).toEqual(['begin', 'read_page', 'finish']);
    expect(FILE_LIMITS.visionConfirmFromPages).toBe(2);
  });

  it("when today's budget cannot cover it, nothing is read and the numbers are given", async () => {
    const r = rig();
    r.extractions = [scan(30)];
    r.handler = (request) =>
      request.action === 'estimate'
        ? {
            kind: 'ok',
            reply: {
              action: 'estimate',
              pages: 30,
              perPageUsd: 0.027,
              estimateUsd: 0.81,
              dailyCapUsd: 5,
              spentTodayUsd: 4.6,
              affordable: false,
            },
          }
        : undefined;
    r.store.add([file('statement.pdf')]);
    await r.settle();
    expect(actions(r)).toEqual(['estimate']);
    expect(r.store.getState().uploads[0]).toMatchObject({
      phase: 'failed',
      retryable: true,
      message:
        "Reading these 30 pages would cost about $0.81, and today's budget of $5.00 has $0.40 left. Nothing was read. Try a shorter document, or again tomorrow.",
    });
  });

  it('an estimate that cannot be had stops the upload before anything is read', async () => {
    const r = rig();
    r.extractions = [scan(3)];
    r.handler = (request) =>
      request.action === 'estimate'
        ? failed('retryable', 'The file could not be saved just now.')
        : undefined;
    r.store.add([file('statement.pdf')]);
    await r.settle();
    expect(r.store.getState().uploads[0]).toMatchObject({ phase: 'failed', retryable: true });
    expect(actions(r)).toEqual(['estimate']);
  });
});

describe('when it stops part-way', () => {
  const confirmAndSettle = async (r: Rig): Promise<void> => {
    await r.settle();
    r.store.confirm(r.store.getState().uploads[0]?.localId ?? '');
    await r.settle();
  };

  it('the network dropping mid-upload stops it where it is; Try again resumes from that page', async () => {
    const r = rig();
    const doc = scan(3);
    r.extractions = [doc];
    let drop = true;
    let begins = 0;
    r.handler = (request) => {
      if (request.action === 'read_page' && request.pageNo === 2 && drop) {
        return failed(
          'retryable',
          "Couldn't reach the Command Centre. Check your connection and try again.",
          null,
        );
      }
      if (request.action === 'begin') {
        begins += 1;
        // The second begin is the same request id: the server says what it already holds.
        return {
          kind: 'ok',
          reply: {
            action: 'begin',
            fileId: 'file-1',
            conversationId: CONV,
            status: 'reading',
            duplicate: false,
            pagesStored: begins === 1 ? [] : [1],
          },
        };
      }
      return undefined;
    };
    r.store.add([file('statement.pdf')]);
    await confirmAndSettle(r);
    const stopped = r.store.getState().uploads[0];
    expect(stopped).toMatchObject({
      phase: 'failed',
      retryable: true,
      done: 1,
      message:
        "Stopped after 1 of 3 pages. Couldn't reach the Command Centre. Check your connection and try again.",
    });
    // Nothing is attached, and the server was not told the file is finished.
    expect(r.store.getState().files).toEqual([]);
    expect(actions(r)).not.toContain('finish');

    drop = false;
    r.store.retry(stopped?.localId ?? '');
    await r.settle();
    const begun = r.requests.filter((request) => request.action === 'begin');
    expect(begun.map((request) => request.requestId)).toEqual(['req-1', 'req-1']);
    // Page 1 is not read — or paid for — twice; the question is not asked twice either.
    const read = r.requests.filter((request) => request.action === 'read_page');
    expect(read.map((request) => request.pageNo)).toEqual([1, 2, 2, 3]);
    expect(actions(r).filter((action) => action === 'estimate')).toHaveLength(1);
    expect(r.store.getState().files.map((f) => f.id)).toEqual(['file-1']);
    expect(r.store.getState().uploads).toEqual([]);
  });

  it('the budget running out mid-document: told plainly, nothing attached, no half file', async () => {
    const r = rig();
    r.extractions = [scan(3)];
    const capped =
      "Today's budget for the assistant has been used up, so this page was not read and the file was not attached. It resets at midnight UTC.";
    r.handler = (request) =>
      request.action === 'read_page' && request.pageNo === 3
        ? failed('cap', capped, 402)
        : undefined;
    r.store.add([file('statement.pdf')]);
    await confirmAndSettle(r);
    expect(r.store.getState().uploads[0]).toMatchObject({
      phase: 'failed',
      retryable: false,
      message: `Stopped after 2 of 3 pages. ${capped}`,
    });
    expect(r.store.getState().files).toEqual([]);
    expect(actions(r)).not.toContain('finish');
    expect(r.store.getState().announcement).toContain('statement.pdf was not attached.');
  });

  it('a page this device cannot prepare stops the upload with the reason', async () => {
    const r = rig();
    const doc = scan(2);
    r.extractions = [
      {
        ...doc,
        vision: [
          doc.vision[0] ?? { pageNo: 1, label: 'Page 1', image: () => Promise.resolve(null) },
          { pageNo: 2, label: 'Page 2', image: () => Promise.resolve(null) },
        ],
      },
    ];
    r.store.add([file('statement.pdf')]);
    await confirmAndSettle(r);
    expect(r.store.getState().uploads[0]).toMatchObject({
      phase: 'failed',
      retryable: false,
      message: UPLOAD_MESSAGES.stoppedAt(1, 2, UPLOAD_MESSAGES.notPrepared),
    });
  });

  it('a page whose rendering throws is the same, not an unhandled rejection', async () => {
    const r = rig();
    r.extractions = [
      {
        ...scan(1, 'image'),
        vision: [{ pageNo: 1, label: 'Photo', image: () => Promise.reject(new Error('canvas')) }],
      },
    ];
    r.store.add([file('photo.jpg')]);
    await r.settle();
    expect(r.store.getState().uploads[0]).toMatchObject({
      phase: 'failed',
      message: UPLOAD_MESSAGES.stoppedAt(0, 1, UPLOAD_MESSAGES.notPrepared),
    });
  });

  it('text that cannot be sent, and a finish that fails, stop the upload with nothing attached', async () => {
    const sending = rig();
    sending.extractions = [textDoc(2)];
    sending.handler = (request) =>
      request.action === 'append'
        ? failed('retryable', 'The file could not be saved just now. Nothing was kept. Try again.')
        : undefined;
    sending.store.add([file('a.pdf')]);
    await sending.settle();
    expect(sending.store.getState().uploads[0]).toMatchObject({ phase: 'failed', retryable: true });
    expect(sending.store.getState().uploads[0]?.message).toContain('Stopped after 0 of 2 pages.');

    const finishing = rig();
    finishing.handler = (request) =>
      request.action === 'finish' ? failed('refused', refusal('no_text').message, 422) : undefined;
    finishing.store.add([file('blank.pdf')]);
    await finishing.settle();
    expect(finishing.store.getState().uploads[0]).toMatchObject({
      phase: 'refused',
      message: 'Nothing readable was found in this file, so it was not attached.',
    });
    expect(finishing.store.getState().files).toEqual([]);
  });

  it('an expired session at any step hands over to sign-in', async () => {
    for (const action of ['estimate', 'begin', 'append', 'read_page', 'finish'] as const) {
      const r = rig();
      r.extractions = [
        action === 'estimate' || action === 'read_page'
          ? scan(action === 'estimate' ? 2 : 1, action === 'estimate' ? 'pdf' : 'image')
          : textDoc(),
      ];
      r.handler = (request) =>
        request.action === action
          ? failed('unauthenticated', 'Your session has expired.', 401)
          : undefined;
      r.store.add([file('x.pdf')]);
      await r.settle();
      expect(r.expired, action).toBe(1);
      expect(r.store.getState().uploads[0]?.phase, action).toBe('failed');
    }
  });
});

describe('changing your mind', () => {
  it('stopping an upload while a page is being read: its answer is ignored and nothing is attached', async () => {
    const r = rig();
    r.extractions = [scan(3)];
    // Page 2 is sent and does not come back until the test lets it.
    r.holdWhen = (request) => request.action === 'read_page' && request.pageNo === 2;
    r.store.add([file('statement.pdf')]);
    await r.settle();
    const localId = r.store.getState().uploads[0]?.localId ?? '';
    r.store.confirm(localId);
    await r.settle();
    expect(r.store.getState().uploads[0]).toMatchObject({ phase: 'looking', done: 1 });
    expect(r.held).toHaveLength(1);

    r.store.cancel(localId);
    expect(r.store.getState().uploads).toEqual([]);
    expect(r.requests.at(-1)).toEqual({ action: 'remove', fileId: 'file-1' });
    // The page comes back after all. It changes nothing: no page 3, no finish, no file.
    r.release();
    await r.settle();
    expect(actions(r)).toEqual(['estimate', 'begin', 'read_page', 'read_page', 'remove']);
    expect(r.store.getState().files).toEqual([]);
    expect(r.store.getState().uploads).toEqual([]);
  });

  it('a stop after the upload was claimed removes it on the server', async () => {
    const r = rig();
    const doc = scan(2);
    r.extractions = [doc];
    r.handler = (request) =>
      request.action === 'read_page' ? failed('retryable', 'dropped', null) : undefined;
    r.store.add([file('statement.pdf')]);
    await r.settle();
    r.store.confirm(r.store.getState().uploads[0]?.localId ?? '');
    await r.settle();
    r.store.cancel(r.store.getState().uploads[0]?.localId ?? '');
    expect(r.requests.at(-1)).toEqual({ action: 'remove', fileId: 'file-1' });
    expect(doc.disposed).toBe(1);
  });

  // Found by the browser suite (files.spec.ts, "stopping an upload part-way"): a stop that
  // lands while the upload is being CLAIMED had no file id to send, so the server kept a
  // claimed upload until its fifteen-minute sweep. The claim is now waited for, then dropped.
  it('stopping while the upload is being claimed: once the claim lands, the server is told to drop it', async () => {
    const r = rig();
    r.holdWhen = (request) => request.action === 'begin';
    r.store.add([file('statement.pdf')]);
    await r.settle();
    expect(r.store.getState().uploads[0]).toMatchObject({ phase: 'sending' });
    expect(actions(r)).toEqual(['begin']);

    r.store.cancel(r.store.getState().uploads[0]?.localId ?? '');
    expect(r.store.getState().uploads).toEqual([]);
    // Nothing to remove yet: the id is in the answer that has not arrived.
    expect(actions(r)).toEqual(['begin']);

    r.release();
    await r.settle();
    expect(actions(r)).toEqual(['begin', 'remove']);
    expect(r.requests.at(-1)).toEqual({ action: 'remove', fileId: 'file-1' });
    expect(r.store.getState().files).toEqual([]);
    expect(r.store.getState().uploads).toEqual([]);
  });

  it('the same stop on a new conversation: the conversation the claim opened is the one the thread is on', async () => {
    const r = rig(null);
    r.holdWhen = (request) => request.action === 'begin';
    r.store.add([file('one.pdf'), file('two.pdf')]);
    await r.settle();
    r.store.cancel(r.store.getState().uploads[0]?.localId ?? '');
    r.holdWhen = () => false;
    r.release();
    await r.settle();
    // The first claim opened a conversation. It is adopted rather than left behind, so the
    // second file goes to it and not to a second new conversation.
    expect(r.adopted).toEqual([NEW_CONV]);
    expect(r.store.getState().conversationId).toBe(NEW_CONV);
    const begins = r.requests.filter((request) => request.action === 'begin');
    expect(begins.map((request) => request.conversationId)).toEqual([null, NEW_CONV]);
    expect(r.requests.filter((request) => request.action === 'remove')).toEqual([
      { action: 'remove', fileId: 'file-1' },
    ]);
    expect(r.store.getState().files.map((f) => f.id)).toEqual(['file-2']);
  });

  it('a stop while the file turns out to be attached already does not remove the attached file', async () => {
    const r = rig();
    r.holdWhen = (request) => request.action === 'begin';
    r.handler = (request) =>
      request.action === 'begin'
        ? {
            kind: 'ok',
            reply: {
              action: 'begin',
              fileId: 'already-attached',
              conversationId: CONV,
              status: 'ready',
              duplicate: true,
              pagesStored: [],
            },
          }
        : undefined;
    r.store.add([file('statement.pdf')]);
    await r.settle();
    r.store.cancel(r.store.getState().uploads[0]?.localId ?? '');
    r.release();
    await r.settle();
    expect(actions(r)).toEqual(['begin']);
  });

  it('leaving while the upload is being claimed: it is dropped, and the conversation now open is left alone', async () => {
    const r = rig(null);
    r.holdWhen = (request) => request.action === 'begin';
    r.store.add([file('statement.pdf')]);
    await r.settle();
    r.listed = [];
    r.store.setConversation('other');
    r.release();
    await r.settle();
    expect(r.requests.at(-1)).toEqual({ action: 'remove', fileId: 'file-1' });
    expect(r.store.getState().conversationId).toBe('other');
    expect(r.adopted).toEqual([]);
  });

  it('a claim that fails after a stop is nothing to clean up, and says nothing', async () => {
    const r = rig();
    r.holdWhen = (request) => request.action === 'begin';
    r.handler = (request) =>
      request.action === 'begin' ? failed('retryable', 'dropped', null) : undefined;
    r.store.add([file('statement.pdf')]);
    await r.settle();
    r.store.cancel(r.store.getState().uploads[0]?.localId ?? '');
    const said = r.store.getState().announcement;
    r.release();
    await r.settle();
    expect(actions(r)).toEqual(['begin']);
    expect(r.store.getState().announcement).toBe(said);
    expect(r.store.getState().uploads).toEqual([]);
  });

  it("leaving the conversation drops its uploads and loads the other conversation's files", async () => {
    const r = rig();
    const doc = scan(3);
    r.extractions = [doc];
    r.store.add([file('statement.pdf'), file('later.pdf')]);
    await r.settle();
    expect(r.store.getState().uploads).toHaveLength(2);
    r.listed = [view('other-file', 'other')];
    r.store.setConversation('other');
    await r.settle();
    const state = r.store.getState();
    expect(state.conversationId).toBe('other');
    expect(state.uploads).toEqual([]);
    expect(state.files.map((f) => f.id)).toEqual(['other-file']);
    expect(doc.disposed).toBe(1);
    // The same id again changes nothing.
    r.store.setConversation('other');
    expect(r.store.getState().files).toHaveLength(1);
  });

  it('retry and confirm on something that is not waiting for them do nothing', () => {
    const r = rig();
    r.store.retry('nope');
    r.store.confirm('nope');
    r.store.cancel('nope');
    r.store.add([]);
    expect(r.store.getState().uploads).toEqual([]);
  });
});

describe('the files of a conversation', () => {
  it('are loaded when the conversation is opened, and a failed read says so', async () => {
    const r = rig(null);
    r.listed = [view('f1'), view('f2')];
    r.store.setConversation(CONV);
    expect(r.store.getState().filesState).toBe('loading');
    await r.settle();
    expect(r.store.getState()).toMatchObject({ filesState: 'idle' });
    expect(r.store.getState().files).toHaveLength(2);
    r.listed = null;
    await r.store.refresh();
    expect(r.store.getState().filesState).toBe('error');
    r.store.setConversation(null);
    expect(r.store.getState()).toMatchObject({ files: [], filesState: 'idle' });
    await r.store.refresh();
  });

  it('removing a file leaves a line where it was, with no name', async () => {
    const r = rig();
    r.listed = [view('f1')];
    await r.store.refresh();
    await r.store.remove('f1');
    expect(r.requests.at(-1)).toEqual({ action: 'remove', fileId: 'f1' });
    expect(r.store.getState().files[0]).toMatchObject({ id: 'f1', status: 'removed', name: null });
    expect(r.store.getState().announcement).toBe('payslip.pdf was removed from this conversation.');
    expect(r.store.getState().removing).toBeNull();
  });

  it('a removal that is refused or fails says why and leaves the file', async () => {
    const r = rig();
    r.listed = [view('f1')];
    await r.store.refresh();
    r.handler = (request) =>
      request.action === 'remove'
        ? failed(
            'forbidden',
            'Only the person who attached this file, or an administrator, can remove it.',
            403,
          )
        : undefined;
    await r.store.remove('f1');
    expect(r.store.getState()).toMatchObject({
      notice: 'Only the person who attached this file, or an administrator, can remove it.',
      removing: null,
    });
    expect(r.store.getState().files[0]?.status).toBe('ready');
    r.store.clearNotice();
    expect(r.store.getState().notice).toBeNull();
    r.handler = (request) =>
      request.action === 'remove' ? failed('unauthenticated', 'expired', 401) : undefined;
    await r.store.remove('f1');
    expect(r.expired).toBe(1);
  });
});

describe('subscribing', () => {
  it('listeners hear every change until they unsubscribe', async () => {
    const r = rig();
    let heard = 0;
    const off = r.store.subscribe(() => {
      heard += 1;
    });
    r.store.add([file('a.pdf')]);
    await r.settle();
    expect(heard).toBeGreaterThan(3);
    const before = heard;
    off();
    r.store.clearNotice();
    expect(heard).toBe(before);
  });

  it('money is dollars and cents', () => {
    expect(money(0.624036)).toBe('$0.62');
    expect(money(5)).toBe('$5.00');
  });
});
