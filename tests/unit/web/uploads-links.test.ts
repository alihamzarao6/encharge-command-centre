/**
 * A link in the upload queue (web/src/lib/uploads.ts, Milestone 5 part 2) with every
 * dependency scripted. A link is one more thing in the SAME queue as a file, so what is
 * tested here is what a link adds: the fetch at the front, the server's receipt carried into
 * `begin`, and the promise back to the message box — and that everything else (one at a
 * time, Stop, Try again, whole or not at all) is unchanged for it.
 *
 * Part C, "the run": the same link twice · a link while another read is in flight · a page
 * that changed between two reads · a read abandoned part-way.
 */
import { describe, expect, it } from 'vitest';

import { refusal } from '../../../src/lib/files/limits.js';
import { pageRefusalMessage } from '../../../src/lib/pages/limits.js';
import type {
  AttachedFile,
  FetchedPage,
  FilesFailure,
  FilesOutcome,
  FilesRequest,
  ReplyFor,
} from '../../../web/src/lib/filesApi.js';
import type { Extraction, ExtractionOk } from '../../../web/src/lib/files/types.js';
import {
  UPLOAD_MESSAGES,
  createUploadsStore,
  isBusy,
  type BrowserFile,
  type LinkOutcome,
  type UploadsStore,
} from '../../../web/src/lib/uploads.js';

const CONV = 'c0000000-0000-4000-8000-000000000001';
const NEW_CONV = 'c0000000-0000-4000-8000-0000000000aa';
const RATES = 'https://www.lender.example.org/home-loans/rates';
const OTHER = 'https://www.rba.example.org/cash-rate';
const HASH = 'b'.repeat(64);
const BYTES = new TextEncoder().encode('<html><title>Rates</title><body>6.04% p.a.</body></html>');

function webPage(
  title: string | null = 'Home loan rates | Example Lender',
  parts = 2,
): ExtractionOk {
  return {
    ok: true,
    kind: 'html',
    totalPages: parts,
    title,
    pages: Array.from({ length: parts }, (_unused, i) => ({
      pageNo: i + 1,
      label: i === 0 ? 'Top of the page' : `Section ${String(i + 1)}`,
      text: `Part ${String(i + 1)}: variable 6.04% p.a.`,
      method: 'html_text' as const,
    })),
    vision: [],
    notes: [],
    dispose: () => undefined,
  };
}

function pdfDocument(): ExtractionOk & { disposed: number } {
  const doc = {
    ok: true as const,
    kind: 'pdf' as const,
    totalPages: 1,
    pages: [
      { pageNo: 1, label: 'Page 1', text: 'Fees and charges', method: 'pdf_text_layer' as const },
    ],
    vision: [],
    notes: [],
    disposed: 0,
    dispose: () => {
      doc.disposed += 1;
    },
  };
  return doc;
}

function scannedDocument(pages: number): ExtractionOk {
  return {
    ok: true,
    kind: 'pdf',
    totalPages: pages,
    pages: [],
    vision: Array.from({ length: pages }, (_unused, i) => ({
      pageNo: i + 1,
      label: `Page ${String(i + 1)}`,
      image: () =>
        Promise.resolve({ base64: `/9j/page${String(i + 1)}`, width: 1448, height: 2048 }),
    })),
    notes: [],
    dispose: () => undefined,
  };
}

const view = (id: string, overrides: Partial<AttachedFile> = {}): AttachedFile => ({
  id,
  conversationId: CONV,
  uploadedBy: 'u1',
  name: 'Home loan rates | Example Lender',
  kind: 'html',
  byteSize: BYTES.length,
  pageCount: 2,
  visionPages: 0,
  status: 'ready',
  createdAt: '2026-10-12T06:14:00Z',
  expiresAt: '2026-10-13T06:14:00Z',
  sourceUrl: RATES,
  sourceHost: 'www.lender.example.org',
  fetchedAt: '2026-10-12T06:14:00Z',
  valuesMissing: 0,
  readAsSent: false,
  removedReason: null,
  driveFileId: null,
  ...overrides,
});

function failed(
  failure: FilesFailure['failure'],
  message: string,
  code = 'TEST',
  status: number | null = 503,
): FilesFailure {
  return { kind: 'error', failure, message, code, status };
}

interface FetchSeen {
  readonly requestId: string;
  readonly url: string;
  readonly signal: AbortSignal;
}
interface ExtractSeen {
  readonly name: string;
  readonly bytes: number;
  readonly fromLink: boolean | undefined;
  readonly contentType: string | null | undefined;
}
type Handler = (request: FilesRequest) => FilesOutcome<unknown> | undefined;

interface Rig {
  readonly store: UploadsStore;
  readonly requests: FilesRequest[];
  readonly fetches: FetchSeen[];
  readonly extracts: ExtractSeen[];
  readonly adopted: string[];
  readonly announced: string[];
  /** What each fetch answers, in order; past the end, the page. */
  fetchAnswers: (FilesOutcome<FetchedPage> | 'hold')[];
  extractions: Extraction[];
  extractThrows: boolean;
  handler: Handler;
  listed: AttachedFile[] | null;
  loads: number;
  expired: number;
  /** Lets every held fetch answer with the page. */
  release(): void;
  settle(): Promise<void>;
}

function rig(conversationId: string | null = CONV): Rig {
  let fileSeq = 0;
  let requestSeq = 0;
  const begun = new Map<string, string>();
  const held: (() => void)[] = [];
  const pageFor = (request: { requestId: string; url: string }): FilesOutcome<FetchedPage> => ({
    kind: 'ok',
    reply: {
      fetchId: request.requestId,
      host: new URL(request.url).host,
      fileName: new URL(request.url).pathname.split('/').pop() ?? '',
      contentType: 'text/html; charset=utf-8',
      contentHash: HASH,
      bytes: BYTES.slice(),
    },
  });
  const r: Rig = {
    requests: [],
    fetches: [],
    extracts: [],
    adopted: [],
    announced: [],
    fetchAnswers: [],
    extractions: [],
    extractThrows: false,
    handler: () => undefined,
    listed: [],
    loads: 0,
    expired: 0,
    release: () => {
      for (const go of held.splice(0)) go();
    },
    settle: async () => {
      for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    store: createUploadsStore({
      // These tests read links; Drive files are tests/unit/web/drive-uploads.test.ts.
      readDrive: () => Promise.reject(new Error('uploads-links.test.ts does not read Drive files')),
      fetchPage: (request, signal, onProgress) => {
        r.fetches.push({ ...request, signal });
        const scripted = r.fetchAnswers.shift();
        if (scripted === 'hold') {
          return new Promise((resolve) => {
            // As the real call does: an aborted fetch answers with a failure, it never throws.
            signal.addEventListener('abort', () => {
              resolve(failed('retryable', 'Stopped.', 'NETWORK', null));
            });
            held.push(() => {
              onProgress(BYTES.length, BYTES.length);
              resolve(pageFor(request));
            });
          });
        }
        if (scripted !== undefined) return Promise.resolve(scripted);
        onProgress(BYTES.length, BYTES.length);
        return Promise.resolve(pageFor(request));
      },
      extract: (input, onProgress) => {
        r.extracts.push({
          name: input.name,
          bytes: input.bytes.length,
          fromLink: input.fromLink,
          contentType: input.contentType,
        });
        if (r.extractThrows) return Promise.reject(new Error('reader failed to load'));
        onProgress(1, 2);
        return Promise.resolve(r.extractions.shift() ?? webPage());
      },
      hash: () => Promise.resolve('a'.repeat(64)),
      call: <R extends FilesRequest>(request: R): Promise<FilesOutcome<ReplyFor<R['action']>>> => {
        r.requests.push(request);
        return answer(request);
      },
      loadFiles: () => {
        r.loads += 1;
        return Promise.resolve(r.listed);
      },
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
        return ok({
          action: 'estimate',
          pages: request.visionPages,
          perPageUsd: 0.027132,
          estimateUsd: 0.081396,
          dailyCapUsd: 5,
          spentTodayUsd: 1.25,
          affordable: true,
        });
      case 'begin': {
        // The same request id is the same upload, as it is on the server.
        let fileId = begun.get(request.requestId);
        if (fileId === undefined) {
          fileSeq += 1;
          fileId = `file-${String(fileSeq)}`;
          begun.set(request.requestId, fileId);
        }
        return ok({
          action: 'begin',
          fileId,
          conversationId: request.conversationId ?? NEW_CONV,
          status: 'reading',
          duplicate: false,
          pagesStored: [],
        });
      }
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
        return ok({ action: 'finish', duplicate: false, replaced: 0, file: view(request.fileId) });
      case 'remove':
        return ok({ action: 'remove', removed: true });
      case 'refused':
        return ok({ action: 'refused' });
    }
  }

  r.store.subscribe(() => {
    const said = r.store.getState().announcement;
    if (said !== '' && r.announced.at(-1) !== said) r.announced.push(said);
  });
  r.store.setConversation(conversationId);
  return r;
}

const actions = (r: Rig): string[] => r.requests.map((request) => request.action);
const begins = (r: Rig): Extract<FilesRequest, { action: 'begin' }>[] =>
  r.requests.filter(
    (request): request is Extract<FilesRequest, { action: 'begin' }> => request.action === 'begin',
  );

describe('reading a page from a link', () => {
  it('our server fetches it, this device reads it, and it is attached: fetch → begin → append → finish', async () => {
    const r = rig();
    const outcome = r.store.addLink(RATES);
    expect(r.store.getState().uploads[0]).toMatchObject({
      name: 'lender.example.org',
      source: 'link',
      url: RATES,
      phase: 'fetching',
      kind: null,
    });
    expect(isBusy(r.store.getState())).toBe(true);
    expect(await outcome).toBe('attached');

    // Asked for by address, and read as something that came from a link.
    expect(r.fetches.map(({ requestId, url }) => ({ requestId, url }))).toEqual([
      { requestId: 'req-2', url: RATES },
    ]);
    expect(r.extracts).toEqual([
      {
        name: 'rates',
        bytes: BYTES.length,
        fromLink: true,
        contentType: 'text/html; charset=utf-8',
      },
    ]);
    expect(actions(r)).toEqual(['begin', 'append', 'finish']);
    expect(begins(r)[0]).toEqual({
      action: 'begin',
      requestId: 'req-1',
      conversationId: CONV,
      name: 'rates',
      kind: 'html',
      byteSize: BYTES.length,
      // The server's hash of what it fetched — `begin` is checked against it — not one
      // computed here.
      contentHash: HASH,
      totalPages: 2,
      visionPages: 0,
      extractMs: 0,
      fetchId: 'req-2',
      title: 'Home loan rates | Example Lender',
    });
    expect(r.requests[1]).toMatchObject({
      pages: [
        { pageNo: 1, label: 'Top of the page', text: 'Part 1: variable 6.04% p.a.' },
        { pageNo: 2, label: 'Section 2', text: 'Part 2: variable 6.04% p.a.' },
      ],
    });

    const state = r.store.getState();
    expect(state.uploads).toEqual([]);
    expect(state.files.map((file) => file.id)).toEqual(['file-1']);
    expect(state.readLinks).toEqual({ [RATES]: 'file-1' });
    expect(isBusy(state)).toBe(false);
    expect(r.announced).toEqual([
      'Opening lender.example.org.',
      'Page read: Home loan rates | Example Lender, from lender.example.org. 2 parts.',
    ]);
  });

  it('this browser never sends the address anywhere but to our own endpoint', async () => {
    const r = rig();
    await r.store.addLink(RATES);
    // The only place the address appears is the one request that asks OUR server to fetch it.
    expect(JSON.stringify(r.requests)).not.toContain('lender.example.org');
    expect(r.fetches).toHaveLength(1);
  });

  it('shows how much has arrived while it is on its way', async () => {
    const r = rig();
    r.fetchAnswers = ['hold'];
    const outcome = r.store.addLink(RATES);
    await r.settle();
    expect(r.store.getState().uploads[0]).toMatchObject({ phase: 'fetching', done: 0, total: 0 });
    r.release();
    expect(await outcome).toBe('attached');
  });

  it("the name on screen is the page's title once it has one — as text, never as markup", async () => {
    const r = rig();
    r.extractions = [webPage('<img src=x onerror="alert(1)">Rates & fees')];
    r.fetchAnswers = [];
    const seen: string[] = [];
    r.store.subscribe(() => {
      const name = r.store.getState().uploads[0]?.name;
      if (name !== undefined && seen.at(-1) !== name) seen.push(name);
    });
    await r.store.addLink(RATES);
    expect(seen[0]).toBe('lender.example.org');
    expect(seen.at(-1)).toBe("(img src=x onerror='alert(1)')Rates + fees");
    expect(seen.join(' ')).not.toMatch(/[<>"]/);
  });

  it('a page with no title is called by its site', async () => {
    const r = rig();
    r.extractions = [webPage(null, 1)];
    r.handler = (request) =>
      request.action === 'finish'
        ? {
            kind: 'ok',
            reply: { action: 'finish', duplicate: false, file: view('file-1', { pageCount: 1 }) },
          }
        : undefined;
    await r.store.addLink(RATES);
    expect(begins(r)[0]).not.toHaveProperty('title');
    expect(r.announced.at(-1)).toBe(
      'Page read: www.lender.example.org, from lender.example.org. 1 part.',
    );
  });

  it('a document at a link goes through the same readers, and is named as a file', async () => {
    const r = rig();
    r.extractions = [pdfDocument()];
    const url = 'https://www.lender.example.org/docs/fees-and-charges.pdf';
    expect(await r.store.addLink(url)).toBe('attached');
    expect(r.extracts[0]).toMatchObject({ name: 'fees-and-charges.pdf', fromLink: true });
    expect(begins(r)[0]).toMatchObject({
      kind: 'pdf',
      name: 'fees-and-charges.pdf',
      fetchId: 'req-2',
      contentHash: HASH,
    });
    expect(begins(r)[0]).not.toHaveProperty('title');
  });

  it('a scan at a link still asks before it reads: the pages and the cost', async () => {
    const r = rig();
    r.extractions = [scannedDocument(3)];
    const outcome = r.store.addLink('https://www.lender.example.org/docs/scan.pdf');
    await r.settle();
    const [item] = r.store.getState().uploads;
    expect(item).toMatchObject({ phase: 'confirm', total: 3 });
    expect(actions(r)).toEqual(['estimate']);
    r.store.confirm(item?.localId ?? '');
    expect(await outcome).toBe('attached');
    expect(actions(r)).toEqual([
      'estimate',
      'begin',
      'read_page',
      'read_page',
      'read_page',
      'finish',
    ]);
    expect(begins(r)[0]).toMatchObject({ fetchId: 'req-2', visionPages: 3 });
  });

  it('in a new conversation, the read opens it and the thread is moved onto it', async () => {
    const r = rig(null);
    expect(await r.store.addLink(RATES)).toBe('attached');
    expect(begins(r)[0]?.conversationId).toBeNull();
    expect(r.adopted).toEqual([NEW_CONV]);
    expect(r.store.getState().conversationId).toBe(NEW_CONV);
    expect(r.store.getState().readLinks).toEqual({ [RATES]: 'file-1' });
  });
});

describe('an address that will not be opened', () => {
  it.each([
    'http://www.lender.example.org/rates',
    'https://127.0.0.1/admin',
    'https://169.254.169.254/latest/meta-data/',
    'https://localhost/',
    'https://user:pass@www.lender.example.org/',
    'https://www.lender.example.org:8443/',
    'not a link',
    '',
  ])('%s — is not sent anywhere', async (address) => {
    const r = rig();
    expect(await r.store.addLink(address)).toBe('failed');
    expect(r.fetches).toEqual([]);
    expect(r.requests).toEqual([]);
    expect(r.store.getState().uploads).toEqual([]);
  });
});

describe('the same link twice, and a link while another read is in flight', () => {
  it('the same link pressed twice is one read, and both hear how it ended', async () => {
    const r = rig();
    r.fetchAnswers = ['hold'];
    const first = r.store.addLink(RATES);
    const second = r.store.addLink(RATES);
    // The same address however it was typed.
    const third = r.store.addLink('HTTPS://WWW.LENDER.EXAMPLE.ORG/home-loans/rates#fixed');
    await r.settle();
    expect(r.store.getState().uploads).toHaveLength(1);
    expect(r.fetches).toHaveLength(1);
    r.release();
    expect(await Promise.all([first, second, third])).toEqual(['attached', 'attached', 'attached']);
    expect(r.fetches).toHaveLength(1);
    expect(begins(r)).toHaveLength(1);
  });

  it('a second link waits its turn: nothing of it is fetched until the first is done', async () => {
    const r = rig();
    r.fetchAnswers = ['hold'];
    const first = r.store.addLink(RATES);
    const second = r.store.addLink(OTHER);
    await r.settle();
    expect(r.store.getState().uploads.map((item) => [item.name, item.phase])).toEqual([
      ['lender.example.org', 'fetching'],
      ['rba.example.org', 'waiting'],
    ]);
    expect(r.fetches.map((seen) => seen.url)).toEqual([RATES]);
    r.release();
    expect(await first).toBe('attached');
    expect(await second).toBe('attached');
    expect(r.fetches.map((seen) => seen.url)).toEqual([RATES, OTHER]);
    // In order, and each whole before the next began.
    expect(actions(r)).toEqual(['begin', 'append', 'finish', 'begin', 'append', 'finish']);
    expect(r.store.getState().readLinks).toEqual({ [RATES]: 'file-1', [OTHER]: 'file-2' });
  });

  it('a link behind a file being attached waits for the file', async () => {
    const r = rig();
    const file: BrowserFile = {
      name: 'payslip.pdf',
      size: 4651,
      bytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    };
    r.extractions = [pdfDocument(), webPage()];
    r.store.add([file]);
    const outcome = r.store.addLink(RATES);
    expect(r.store.getState().uploads.map((item) => item.phase)).toEqual(['reading', 'waiting']);
    expect(r.fetches).toEqual([]);
    expect(await outcome).toBe('attached');
    expect(begins(r).map((request) => request.kind)).toEqual(['pdf', 'html']);
    // The file was hashed here; the page's hash is the server's.
    expect(begins(r).map((request) => request.contentHash)).toEqual(['a'.repeat(64), HASH]);
    expect(begins(r)[0]).not.toHaveProperty('fetchId');
  });

  it('read again after it was read: a new fetch, and the older copy is replaced', async () => {
    const r = rig();
    expect(await r.store.addLink(RATES)).toBe('attached');
    r.listed = [view('file-2')];
    r.handler = (request) =>
      request.action === 'finish'
        ? {
            kind: 'ok',
            reply: { action: 'finish', duplicate: false, replaced: 1, file: view('file-2') },
          }
        : undefined;
    const loadsBefore = r.loads;
    expect(await r.store.addLink(RATES)).toBe('attached');
    expect(r.fetches).toHaveLength(2);
    // Two reads, two ids: the server opens one page per id.
    expect(new Set(r.fetches.map((seen) => seen.requestId)).size).toBe(2);
    expect(r.announced.at(-1)).toBe(
      'Page read: Home loan rates | Example Lender, from lender.example.org. 2 parts. It replaces the earlier read of this page.',
    );
    // What the server now holds is shown: the older copy is gone from the list.
    expect(r.loads).toBe(loadsBefore + 1);
    expect(r.store.getState().files.map((file) => file.id)).toEqual(['file-2']);
    expect(r.store.getState().readLinks).toEqual({ [RATES]: 'file-2' });
  });

  it('read again and nothing had changed: said so, and nothing is sent twice', async () => {
    const r = rig();
    r.listed = [view('file-9')];
    r.handler = (request) =>
      request.action === 'begin'
        ? {
            kind: 'ok',
            reply: {
              action: 'begin',
              fileId: 'file-9',
              conversationId: CONV,
              status: 'ready',
              duplicate: true,
              pagesStored: [],
            },
          }
        : undefined;
    expect(await r.store.addLink(RATES)).toBe('already');
    expect(actions(r)).toEqual(['begin']);
    expect(r.announced.at(-1)).toBe(
      'Home loan rates | Example Lender has not changed since it was last read.',
    );
    expect(r.store.getState().readLinks).toEqual({ [RATES]: 'file-9' });
    expect(r.store.getState().files.map((file) => file.id)).toEqual(['file-9']);
    expect(r.store.getState().uploads).toEqual([]);
  });
});

describe('a page that cannot be read', () => {
  it("refused by the site or by our rules: said in the server's words, and not offered again", async () => {
    const r = rig();
    const message = pageRefusalMessage('page_login_required');
    r.fetchAnswers = [
      { ...failed('refused', message, 'PAGE_REFUSED', 422), refusal: 'page_login_required' },
    ];
    expect(await r.store.addLink(RATES)).toBe('failed');
    expect(r.store.getState().uploads[0]).toMatchObject({
      phase: 'refused',
      message,
      retryable: false,
    });
    expect(r.announced.at(-1)).toBe(`lender.example.org was not read. ${message}`);
    // Nothing was read, so nothing was sent — and nothing is attached.
    expect(r.extracts).toEqual([]);
    expect(r.requests).toEqual([]);
    expect(r.store.getState().files).toEqual([]);
    expect(isBusy(r.store.getState())).toBe(false);
  });

  it('the site did not answer: Try again asks afresh, under a new id', async () => {
    const r = rig();
    r.fetchAnswers = [
      failed('retryable', 'That page took too long to answer.', 'PAGE_NOT_READ', 504),
    ];
    const outcome = r.store.addLink(RATES);
    expect(await outcome).toBe('failed');
    const [item] = r.store.getState().uploads;
    expect(item).toMatchObject({
      phase: 'failed',
      retryable: true,
      message: 'That page took too long to answer.',
    });
    r.store.retry(item?.localId ?? '');
    await r.settle();
    expect(r.fetches.map((seen) => seen.requestId)).toEqual(['req-2', 'req-3']);
    expect(r.store.getState().uploads).toEqual([]);
    expect(r.store.getState().files.map((file) => file.id)).toEqual(['file-1']);
    // The attachment keeps the id it was given at the start; the fetch it names is the one
    // that worked.
    expect(begins(r)[0]).toMatchObject({ requestId: 'req-1', fetchId: 'req-3' });
  });

  it('pressing "Read this page" on a stopped link replaces the stopped attempt', async () => {
    const r = rig();
    r.fetchAnswers = [failed('retryable', 'That site did not answer.', 'PAGE_NOT_READ', 502)];
    expect(await r.store.addLink(RATES)).toBe('failed');
    expect(r.store.getState().uploads).toHaveLength(1);
    expect(await r.store.addLink(RATES)).toBe('attached');
    expect(r.store.getState().uploads).toEqual([]);
    expect(r.fetches).toHaveLength(2);
  });

  it.each([
    ['page_paywall', 'html'],
    ['page_forwards', 'html'],
    ['page_no_text', 'html'],
    ['password_pdf', 'pdf'],
  ] as const)(
    'fetched, but this device refuses it (%s): said plainly, and the server is told the fetch is closed',
    async (code, kind) => {
      const r = rig();
      const message = code === 'password_pdf' ? refusal(code).message : pageRefusalMessage(code);
      r.extractions = [{ ok: false, kind, refusal: { code, message } }];
      expect(await r.store.addLink(RATES)).toBe('failed');
      expect(r.store.getState().uploads[0]).toMatchObject({ phase: 'refused', message, kind });
      expect(r.announced.at(-1)).toBe(`lender.example.org was not read. ${message}`);
      // The report carries a reason and a size, and names the fetch — never the page.
      expect(r.requests).toEqual([
        {
          action: 'refused',
          kind,
          byteSize: BYTES.length,
          reason: code,
          extractMs: 0,
          fetchId: 'req-2',
        },
      ]);
      expect(r.store.getState().files).toEqual([]);
    },
  );

  it('the reader itself failing is a refusal, not a crash and not a half-read page', async () => {
    const r = rig();
    r.extractThrows = true;
    expect(await r.store.addLink(RATES)).toBe('failed');
    expect(r.store.getState().uploads[0]).toMatchObject({
      phase: 'refused',
      message: refusal('corrupt').message,
    });
    expect(r.requests).toEqual([
      {
        action: 'refused',
        kind: null,
        byteSize: BYTES.length,
        reason: 'corrupt',
        extractMs: 0,
        fetchId: 'req-2',
      },
    ]);
  });

  it('a session that ran out is handed to sign-in, and nothing is attached', async () => {
    const r = rig();
    r.fetchAnswers = [
      failed('unauthenticated', 'Your session has ended. Sign in again.', 'UNAUTHENTICATED', 401),
    ];
    expect(await r.store.addLink(RATES)).toBe('failed');
    expect(r.expired).toBe(1);
    expect(r.requests).toEqual([]);
  });

  it('a connection that drops while its text is being sent stops there, and resumes without fetching again', async () => {
    const r = rig();
    let appends = 0;
    r.handler = (request) => {
      if (request.action !== 'append') return undefined;
      appends += 1;
      return appends === 1 ? failed('retryable', 'The connection dropped. Try again.') : undefined;
    };
    expect(await r.store.addLink(RATES)).toBe('failed');
    const [item] = r.store.getState().uploads;
    expect(item).toMatchObject({ phase: 'failed', retryable: true });
    // Nothing is attached from a read that did not finish.
    expect(r.store.getState().files).toEqual([]);
    expect(r.announced.at(-1)).toContain('was not read.');
    r.store.retry(item?.localId ?? '');
    await r.settle();
    // The page was already fetched and read: only the sending is done again.
    expect(r.fetches).toHaveLength(1);
    expect(r.extracts).toHaveLength(1);
    expect(actions(r)).toEqual(['begin', 'append', 'begin', 'append', 'finish']);
    expect(begins(r).map((request) => [request.requestId, request.fetchId])).toEqual([
      ['req-1', 'req-2'],
      ['req-1', 'req-2'],
    ]);
    expect(r.store.getState().files.map((file) => file.id)).toEqual(['file-1']);
  });

  it('the server no longer stands behind the fetch: Try again opens the page afresh', async () => {
    const r = rig();
    const first = pdfDocument();
    r.extractions = [first, webPage()];
    let refusedOnce = false;
    r.handler = (request) => {
      if (request.action !== 'begin' || refusedOnce) return undefined;
      refusedOnce = true;
      return failed(
        'retryable',
        'That page has to be opened again before it can be attached. Try again.',
        'FETCH_EXPIRED',
        409,
      );
    };
    expect(await r.store.addLink(RATES)).toBe('failed');
    const [item] = r.store.getState().uploads;
    expect(item).toMatchObject({ phase: 'failed', retryable: true });
    // What was read from the stale bytes is let go of, not kept for a second try.
    expect(first.disposed).toBe(1);
    r.store.retry(item?.localId ?? '');
    await r.settle();
    expect(r.fetches.map((seen) => seen.requestId)).toEqual(['req-2', 'req-3']);
    expect(r.extracts).toHaveLength(2);
    expect(begins(r).map((request) => request.fetchId)).toEqual(['req-2', 'req-3']);
    expect(begins(r)[1]).toMatchObject({ kind: 'html', contentHash: HASH });
    expect(r.store.getState().files.map((file) => file.id)).toEqual(['file-1']);
  });
});

describe('a read abandoned part-way', () => {
  it('Stop while the page is being fetched: the request is dropped and nothing is attached', async () => {
    const r = rig();
    r.fetchAnswers = ['hold'];
    const outcome = r.store.addLink(RATES);
    await r.settle();
    const [item] = r.store.getState().uploads;
    r.store.cancel(item?.localId ?? '');
    expect(await outcome).toBe('cancelled');
    expect(r.fetches[0]?.signal.aborted).toBe(true);
    await r.settle();
    expect(r.store.getState().uploads).toEqual([]);
    expect(r.store.getState().files).toEqual([]);
    expect(r.extracts).toEqual([]);
    expect(r.requests).toEqual([]);
    expect(r.announced.at(-1)).toBe(`lender.example.org: ${UPLOAD_MESSAGES.cancelled}`);
    expect(isBusy(r.store.getState())).toBe(false);
  });

  it('Stop after its text began to be sent: the server is told to drop what it has', async () => {
    const r = rig();
    // He presses Stop while the first of its text is on the wire.
    r.handler = (request) => {
      if (request.action === 'append') r.store.cancel(r.store.getState().uploads[0]?.localId ?? '');
      return undefined;
    };
    expect(await r.store.addLink(RATES)).toBe('cancelled');
    await r.settle();
    expect(r.store.getState().files).toEqual([]);
    expect(r.store.getState().uploads).toEqual([]);
    expect(r.store.getState().readLinks).toEqual({});
    expect(actions(r)).toEqual(['begin', 'append', 'remove']);
    expect(r.requests.at(-1)).toEqual({ action: 'remove', fileId: 'file-1' });
  });

  it('leaving the conversation ends the read, and whoever was waiting is told', async () => {
    const r = rig();
    r.fetchAnswers = ['hold'];
    const outcome = r.store.addLink(RATES);
    await r.settle();
    r.store.setConversation('c0000000-0000-4000-8000-000000000002');
    expect(await outcome).toBe('cancelled');
    expect(r.fetches[0]?.signal.aborted).toBe(true);
    await r.settle();
    expect(r.store.getState().uploads).toEqual([]);
    expect(r.store.getState().readLinks).toEqual({});
    expect(r.requests).toEqual([]);
  });

  it('one link stopped does not take the next one with it', async () => {
    const r = rig();
    r.fetchAnswers = ['hold'];
    const first = r.store.addLink(RATES);
    const second = r.store.addLink(OTHER);
    await r.settle();
    r.store.cancel(r.store.getState().uploads[0]?.localId ?? '');
    const outcomes: LinkOutcome[] = await Promise.all([first, second]);
    expect(outcomes).toEqual(['cancelled', 'attached']);
    expect(r.store.getState().readLinks).toEqual({ [OTHER]: 'file-1' });
  });
});
