/**
 * The files endpoint (src/lib/files/page.ts): who may attach, what each step of an upload
 * does, what is refused and in which words, what happens when the budget or the model gives
 * out part-way through a document — and that nothing a file contains or is called ever
 * reaches a log line. Part C: "security" and "the run".
 */
import { describe, expect, it } from 'vitest';

import {
  AppError,
  NetworkError,
  TimeoutError,
  ValidationError,
  err,
  ok,
} from '../../../src/lib/errors.js';
import { FILE_LIMITS, VISION_CONFIDENCE } from '../../../src/lib/files/limits.js';
import {
  BLANK_PAGE_TEXT,
  FILES_MESSAGES,
  PHOTO_LABEL_NOTE,
  UNREADABLE_PAGE_TEXT,
  handleFilesRequest,
  mapVisionError,
  visionPageCosts,
  type FilesPageResult,
  type FilesReply,
} from '../../../src/lib/files/page.js';
import { VISION_OPERATION } from '../../../src/lib/files/vision.js';
import { ModelRefusalError, RateLimitedError, SpendCapError } from '../../../src/lib/llm/errors.js';
import { DEFAULT_PRICING } from '../../../src/lib/llm/pricing.js';
import { capturingLogger } from '../llm/helpers.js';
import {
  ADMIN_ID,
  CANARY_NAME,
  CANARY_TEXT,
  CONV_ID,
  HASH,
  JPEG_BASE64,
  OTHER_ID,
  PRIVATE_CONV_ID,
  USER_ID,
  completion,
  harness,
  uuid,
  type Harness,
} from './helpers.js';

type Body = Record<string, unknown>;

function call(h: Harness, body: unknown, token: string | null = 'token'): Promise<FilesPageResult> {
  return handleFilesRequest(h.deps, { token, body });
}

function reply<A extends FilesReply['action']>(
  result: FilesPageResult,
  action: A,
): Extract<FilesReply, { action: A }> {
  if (result.status !== 200) {
    throw new Error(`expected 200, got ${String(result.status)} ${result.body.error.code}`);
  }
  if (result.body.action !== action)
    throw new Error(`expected ${action}, got ${result.body.action}`);
  return result.body as Extract<FilesReply, { action: A }>;
}

function errorOf(result: FilesPageResult): {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  refusal?: string;
} {
  if (result.status === 200) throw new Error('expected an error');
  return { status: result.status, ...result.body.error };
}

function beginBody(overrides: Body = {}): Body {
  return {
    action: 'begin',
    requestId: uuid(),
    conversationId: CONV_ID,
    name: 'payslip.pdf',
    kind: 'pdf',
    byteSize: 4651,
    contentHash: HASH('a'),
    totalPages: 2,
    visionPages: 0,
    extractMs: 120,
    ...overrides,
  };
}

/** A text file, attached start to finish. */
async function attach(h: Harness, overrides: Body = {}): Promise<string> {
  const begun = reply(await call(h, beginBody(overrides)), 'begin');
  const pages = Array.from({ length: Number(overrides['totalPages'] ?? 2) }, (_, i) => ({
    pageNo: i + 1,
    label: `Page ${String(i + 1)}`,
    text: `Text of page ${String(i + 1)}`,
  }));
  reply(await call(h, { action: 'append', fileId: begun.fileId, pages }), 'append');
  reply(await call(h, { action: 'finish', fileId: begun.fileId }), 'finish');
  return begun.fileId;
}

describe('who may use the endpoint', () => {
  it('no token is 401 and an invalid one is 401, before any work', async () => {
    const { log } = capturingLogger();
    const h = harness(log, { userId: null });
    expect(errorOf(await call(h, beginBody(), null)).status).toBe(401);
    expect(errorOf(await call(h, beginBody())).status).toBe(401);
    expect(h.files.calls).toEqual([]);
    expect(h.claude.calls).toEqual([]);
  });

  it('an account not on the allowlist, or deactivated, is 403', async () => {
    const { log } = capturingLogger();
    const outsider = harness(log, { allowlisted: false });
    expect(errorOf(await call(outsider, beginBody())).status).toBe(403);
    const former = harness(log, { isActive: false });
    expect(errorOf(await call(former, beginBody())).status).toBe(403);
    expect(outsider.files.calls).toEqual([]);
  });

  it('an auth server that cannot be asked is 503, never a silent pass', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const deps = {
      ...h.deps,
      verify: {
        getUserFromToken: () => Promise.resolve(err(new NetworkError('auth down'))),
        getStaffRow: () => Promise.resolve(ok(null)),
      },
    };
    const result = await handleFilesRequest(deps, { token: 't', body: beginBody() });
    expect(errorOf(result)).toMatchObject({ status: 503, retryable: true });
  });
});

describe('input validation', () => {
  it('names the field that is wrong and never echoes its value', async () => {
    const { log, lines } = capturingLogger();
    const h = harness(log);
    const bad = await call(h, beginBody({ contentHash: `not-a-hash-${CANARY_TEXT}` }));
    expect(errorOf(bad)).toMatchObject({ status: 400, message: 'Invalid request: contentHash.' });
    expect(errorOf(await call(h, { action: 'nope' })).status).toBe(400);
    expect(errorOf(await call(h, 'a string')).message).toBe('Invalid request: body.');
    expect(errorOf(await call(h, { action: 'finish', fileId: 'not-a-uuid' })).message).toBe(
      'Invalid request: fileId.',
    );
    expect(JSON.stringify(bad)).not.toContain(CANARY_TEXT);
    expect(lines.join('\n')).not.toContain(CANARY_TEXT);
  });

  it('refuses a file that breaks a limit with the sentence the browser would have shown', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    expect(errorOf(await call(h, beginBody({ byteSize: 0 })))).toMatchObject({
      status: 422,
      refusal: 'empty',
    });
    const big = errorOf(await call(h, beginBody({ byteSize: FILE_LIMITS.maxFileBytes + 1 })));
    expect(big).toMatchObject({ status: 422, refusal: 'too_large' });
    expect(big.message).toBe('This file is 20.0 MB, which is over the 20 MB limit.');
    // Exactly at the limit is accepted.
    expect((await call(h, beginBody({ byteSize: FILE_LIMITS.maxFileBytes }))).status).toBe(200);
    expect(errorOf(await call(h, beginBody({ totalPages: 501 })))).toMatchObject({
      refusal: 'too_many_pages',
    });
    expect(errorOf(await call(h, beginBody({ kind: 'text', totalPages: 501 })))).toMatchObject({
      refusal: 'too_long',
    });
    expect(errorOf(await call(h, beginBody({ totalPages: 0 })))).toMatchObject({
      refusal: 'no_text',
    });
    const scans = errorOf(await call(h, beginBody({ totalPages: 60, visionPages: 51 })));
    expect(scans).toMatchObject({ refusal: 'too_many_scanned_pages' });
    expect(scans.message).toContain('51 pages');
  });

  it('exactly 50 scanned pages may be declared (D90)', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    expect((await call(h, beginBody({ totalPages: 50, visionPages: 50 }))).status).toBe(200);
  });

  it('refuses shapes that cannot be true', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    expect(errorOf(await call(h, beginBody({ totalPages: 2, visionPages: 3 }))).status).toBe(400);
    expect(
      errorOf(await call(h, beginBody({ kind: 'image', totalPages: 2, visionPages: 2 }))).status,
    ).toBe(400);
    expect(
      errorOf(await call(h, beginBody({ kind: 'csv', totalPages: 2, visionPages: 1 }))).status,
    ).toBe(400);
  });
});

describe('begin', () => {
  it('claims an upload in a conversation the person can see', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await call(h, beginBody()), 'begin');
    expect(begun).toMatchObject({
      conversationId: CONV_ID,
      status: 'reading',
      duplicate: false,
      pagesStored: [],
      file: null,
    });
    expect(h.files.files.get(begun.fileId)?.record.uploadedBy).toBe(USER_ID);
  });

  it('opens a conversation when there is none, untitled until the first message', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await call(h, beginBody({ conversationId: null })), 'begin');
    expect(h.conversations.created).toEqual([begun.conversationId]);
    expect(h.conversations.rows.get(begun.conversationId)?.title).toBeNull();
    const omitted = beginBody({ contentHash: HASH('b') });
    delete omitted['conversationId'];
    expect(reply(await call(h, omitted), 'begin').conversationId).not.toBe(CONV_ID);
  });

  it("someone else's private conversation, a deleted one and a missing one are all 404", async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    expect(errorOf(await call(h, beginBody({ conversationId: PRIVATE_CONV_ID }))).status).toBe(404);
    expect(errorOf(await call(h, beginBody({ conversationId: uuid() }))).status).toBe(404);
    const row = h.conversations.rows.get(CONV_ID);
    if (row !== undefined)
      h.conversations.rows.set(CONV_ID, { ...row, deletedAt: '2026-10-01T00:00:00Z' });
    expect(errorOf(await call(h, beginBody())).status).toBe(404);
    expect(h.files.files.size).toBe(0);
  });

  it('the author of a private conversation may attach to it', async () => {
    const { log } = capturingLogger();
    const h = harness(log, { userId: OTHER_ID });
    expect((await call(h, beginBody({ conversationId: PRIVATE_CONV_ID }))).status).toBe(200);
  });

  it('the same request sent twice is one upload, and reports what is already stored', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const body = beginBody();
    const first = reply(await call(h, body), 'begin');
    await call(h, {
      action: 'append',
      fileId: first.fileId,
      pages: [{ pageNo: 1, label: 'Page 1', text: 'one' }],
    });
    const second = reply(await call(h, body), 'begin');
    expect(second.fileId).toBe(first.fileId);
    expect(second.pagesStored).toEqual([1]);
    expect(h.files.files.size).toBe(1);
  });

  it('the same file uploaded twice is attached once', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const fileId = await attach(h);
    const again = reply(await call(h, beginBody()), 'begin');
    expect(again).toMatchObject({ fileId, duplicate: true, status: 'ready' });
    expect(again.file).toMatchObject({ id: fileId, name: 'payslip.pdf', pageCount: 2 });
    expect([...h.files.files.values()].filter((f) => f.record.status === 'ready')).toHaveLength(1);
  });

  it('two different files at once are two attachments', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const [a, b] = await Promise.all([
      call(h, beginBody({ contentHash: HASH('1') })),
      call(h, beginBody({ contentHash: HASH('2') })),
    ]);
    expect(reply(a, 'begin').fileId).not.toBe(reply(b, 'begin').fileId);
    expect(h.files.files.size).toBe(2);
  });

  it('a full conversation refuses the next file in words', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    for (let i = 0; i < FILE_LIMITS.maxFilesPerConversation; i += 1) {
      await attach(h, { contentHash: HASH(i.toString(16)), totalPages: 1 });
    }
    const full = errorOf(await call(h, beginBody({ contentHash: HASH('f') })));
    expect(full).toMatchObject({ status: 422, refusal: 'too_many_files' });
    expect(full.message).toBe('This conversation already has 10 files attached. Remove one first.');
  });

  it('a name with a path, a null byte or markup is stored as a plain label', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const name = `../../<script>x</script>${String.fromCodePoint(0)}pay.pdf`;
    const begun = reply(await call(h, beginBody({ name })), 'begin');
    const stored = h.files.files.get(begun.fileId)?.record.name ?? '';
    expect(stored).toBe('script)pay.pdf');
    expect(stored).not.toMatch(/[<>]|\.\.|\//);
  });

  it('a store that is down is a 503 that says nothing was kept', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    h.files.failOnce.set('begin', new NetworkError('db down'));
    expect(errorOf(await call(h, beginBody()))).toMatchObject({
      status: 503,
      message: FILES_MESSAGES.storeDown,
      retryable: true,
    });
    h.conversations.fail = new NetworkError('db down');
    expect(errorOf(await call(h, beginBody())).status).toBe(503);
    expect(errorOf(await call(h, beginBody({ conversationId: null }))).status).toBe(503);
  });
});

describe('append', () => {
  it('stores cleaned text with the method the kind implies and a confidence of 1', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await call(h, beginBody()), 'begin');
    const hidden = `Net pay${String.fromCodePoint(0x200b)} 2,887.38  \r\n\r\n\r\n\r\nNext`;
    const appended = reply(
      await call(h, {
        action: 'append',
        fileId: begun.fileId,
        pages: [{ pageNo: 1, label: '  Page\n1 ', text: hidden }],
      }),
      'append',
    );
    expect(appended.stored).toBe(1);
    const page = h.files.files.get(begun.fileId)?.pages.get(1);
    expect(page).toMatchObject({
      label: 'Page 1',
      content: 'Net pay 2,887.38\n\nNext',
      method: 'pdf_text_layer',
      confidence: 1,
      legibility: 'full',
      letterCount: 16,
    });
  });

  it('a browser cannot store a page as a vision transcription, or text for a picture', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(
      await call(h, beginBody({ kind: 'image', totalPages: 1, visionPages: 1 })),
      'begin',
    );
    const result = await call(h, {
      action: 'append',
      fileId: begun.fileId,
      pages: [{ pageNo: 1, label: 'x', text: 'typed, not read' }],
    });
    expect(errorOf(result).status).toBe(400);
    const csv = reply(await call(h, beginBody({ kind: 'csv', contentHash: HASH('c') })), 'begin');
    await call(h, {
      action: 'append',
      fileId: csv.fileId,
      pages: [{ pageNo: 1, label: 'x', text: 'a\tb' }],
    });
    expect(h.files.files.get(csv.fileId)?.pages.get(1)?.method).toBe('csv_parse');
  });

  it('refuses a page out of range, an empty page, an over-long page and too much at once', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await call(h, beginBody()), 'begin');
    const send = (pages: unknown): Promise<FilesPageResult> =>
      call(h, { action: 'append', fileId: begun.fileId, pages });
    expect(errorOf(await send([{ pageNo: 3, label: 'x', text: 'y' }])).status).toBe(400);
    expect(errorOf(await send([{ pageNo: 0, label: 'x', text: 'y' }])).status).toBe(400);
    expect(errorOf(await send([{ pageNo: 1, label: 'x', text: '  \n ' }])).status).toBe(400);
    expect(
      errorOf(
        await send([{ pageNo: 1, label: 'x', text: 'y'.repeat(FILE_LIMITS.maxPageChars + 1) }]),
      ),
    ).toMatchObject({
      status: 422,
      refusal: 'too_long',
    });
    expect(errorOf(await send([])).status).toBe(400);
    expect(
      errorOf(
        await send(
          Array.from({ length: FILE_LIMITS.appendBatchPages + 1 }, () => ({
            pageNo: 1,
            label: 'x',
            text: 'y',
          })),
        ),
      ).status,
    ).toBe(400);
    const five = Array.from({ length: 5 }, () => ({
      pageNo: 1,
      label: 'x',
      text: 'y'.repeat(FILE_LIMITS.maxPageChars),
    }));
    expect(errorOf(await send(five)).message).toBe('Too much text in one request.');
  });

  it('a file that is finished, removed, missing or not visible takes no more pages', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const fileId = await attach(h);
    const page = [{ pageNo: 1, label: 'x', text: 'late' }];
    expect(errorOf(await call(h, { action: 'append', fileId, pages: page }))).toMatchObject({
      status: 409,
      code: 'UPLOAD_CLOSED',
    });
    expect(errorOf(await call(h, { action: 'append', fileId: uuid(), pages: page })).status).toBe(
      404,
    );
    const stranger = harness(log, { userId: OTHER_ID });
    const theirs = reply(
      await call(stranger, beginBody({ conversationId: PRIVATE_CONV_ID })),
      'begin',
    );
    // The same store, asked by someone who cannot see that conversation.
    const asUser = { ...h, files: stranger.files, deps: { ...h.deps, files: stranger.files } };
    expect(
      errorOf(await call(asUser, { action: 'append', fileId: theirs.fileId, pages: page })).status,
    ).toBe(404);
  });

  it('a database refusal or failure is passed on as its own sentence', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await call(h, beginBody()), 'begin');
    const page = [{ pageNo: 1, label: 'x', text: 'y' }];
    h.files.failOnce.set(
      'appendPages',
      new AppError('CONFLICT', 'x', { context: { reason: 'not_reading' } }),
    );
    expect(
      errorOf(await call(h, { action: 'append', fileId: begun.fileId, pages: page })).code,
    ).toBe('UPLOAD_CLOSED');
    h.files.failOnce.set(
      'appendPages',
      new AppError('CONFLICT', 'x', { context: { reason: 'page_out_of_range' } }),
    );
    expect(
      errorOf(await call(h, { action: 'append', fileId: begun.fileId, pages: page })).status,
    ).toBe(400);
    h.files.failOnce.set('appendPages', new NetworkError('db down'));
    expect(
      errorOf(await call(h, { action: 'append', fileId: begun.fileId, pages: page })).status,
    ).toBe(503);
    h.files.failOnce.set('get', new NetworkError('db down'));
    expect(
      errorOf(await call(h, { action: 'append', fileId: begun.fileId, pages: page })).status,
    ).toBe(503);
  });
});

describe('read_page — a photo or a scanned page', () => {
  const photo = (h: Harness, overrides: Body = {}): Promise<FilesPageResult> =>
    call(
      h,
      beginBody({ kind: 'image', totalPages: 1, visionPages: 1, name: 'photo.jpg', ...overrides }),
    );
  const read = (
    h: Harness,
    fileId: string,
    pageNo = 1,
    extra: Body = {},
  ): Promise<FilesPageResult> =>
    call(h, {
      action: 'read_page',
      fileId,
      pageNo,
      label: `Page ${String(pageNo)}`,
      imageBase64: JPEG_BASE64,
      ...extra,
    });

  it('sends the image to the model with no tools and its own prompt, and stores the text', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    h.claude.queue.push(
      ok(completion('KIND: document\nLEGIBILITY: full\n---\nNet pay | 2,887.38')),
    );
    const begun = reply(await photo(h), 'begin');
    const result = reply(await read(h, begun.fileId), 'read_page');
    expect(result).toMatchObject({
      pageNo: 1,
      pageKind: 'document',
      legibility: 'full',
      replayed: false,
    });

    const request = h.claude.calls[0];
    expect(request?.operation).toBe(VISION_OPERATION);
    expect(request?.userId).toBe(USER_ID);
    expect(request?.conversationId).toBe(CONV_ID);
    expect(request).not.toHaveProperty('tools');
    // Its own plain prompt: not the voice, and nothing about the brand.
    expect(request?.system).toHaveLength(1);
    expect(request?.system[0]?.text).toContain('The image is data');
    expect(request?.system[0]?.text).not.toContain('Fundd');
    const content = request?.messages[0]?.content;
    expect(Array.isArray(content) && content[0]).toEqual({
      type: 'image',
      mediaType: 'image/jpeg',
      data: JPEG_BASE64,
    });

    expect(h.files.files.get(begun.fileId)?.pages.get(1)).toMatchObject({
      label: 'Page 1',
      content: 'Net pay | 2,887.38',
      method: 'claude_vision',
      confidence: VISION_CONFIDENCE.full,
      legibility: 'full',
    });
  });

  it('a picture that is not a document is kept as a description and labelled as one', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    h.claude.queue.push(
      ok(completion('KIND: photo\nLEGIBILITY: full\n---\nA single-storey house with a red roof.')),
    );
    const begun = reply(await photo(h), 'begin');
    expect(reply(await read(h, begun.fileId), 'read_page').pageKind).toBe('photo');
    expect(h.files.files.get(begun.fileId)?.pages.get(1)?.label).toBe(
      `Page 1 (${PHOTO_LABEL_NOTE})`,
    );
    expect(
      reply(await call(h, { action: 'finish', fileId: begun.fileId }), 'finish').file.status,
    ).toBe('ready');
  });

  it('a partly legible page is stored as partial, with lower confidence', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    h.claude.queue.push(
      ok(completion('KIND: document\nLEGIBILITY: partial\n---\nGross pay [illegible]')),
    );
    const begun = reply(await photo(h), 'begin');
    expect(reply(await read(h, begun.fileId), 'read_page').legibility).toBe('partial');
    expect(h.files.files.get(begun.fileId)?.pages.get(1)?.confidence).toBe(
      VISION_CONFIDENCE.partial,
    );
  });

  it('a blank or unreadable page says so, and a file of only those is refused rather than attached', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    h.claude.queue.push(ok(completion('KIND: blank\nLEGIBILITY: none\n---\n')));
    const blank = reply(await photo(h), 'begin');
    await read(h, blank.fileId);
    expect(h.files.files.get(blank.fileId)?.pages.get(1)).toMatchObject({
      content: BLANK_PAGE_TEXT,
      letterCount: 0,
      confidence: 0,
    });
    const finished = errorOf(await call(h, { action: 'finish', fileId: blank.fileId }));
    expect(finished).toMatchObject({ status: 422, refusal: 'no_text' });
    expect(finished.message).toBe(
      'Nothing readable was found in this file, so it was not attached.',
    );
    // No orphan: the unusable upload is gone, not left to be seen and not used.
    expect(h.files.files.has(blank.fileId)).toBe(false);

    h.claude.queue.push(ok(completion('KIND: document\nLEGIBILITY: none\n---\n')));
    const unreadable = reply(await photo(h, { contentHash: HASH('d') }), 'begin');
    await read(h, unreadable.fileId);
    expect(h.files.files.get(unreadable.fileId)?.pages.get(1)?.content).toBe(UNREADABLE_PAGE_TEXT);
  });

  it('a page already read is answered from the record — a retry is never paid for twice', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await photo(h), 'begin');
    await read(h, begun.fileId);
    const again = reply(await read(h, begun.fileId), 'read_page');
    expect(again).toMatchObject({ replayed: true, pageKind: null });
    expect(h.claude.calls).toHaveLength(1);
  });

  it('cannot read more pages as images than the upload declared', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await call(h, beginBody({ totalPages: 3, visionPages: 1 })), 'begin');
    expect((await read(h, begun.fileId, 2)).status).toBe(200);
    const over = errorOf(await read(h, begun.fileId, 3));
    expect(over).toMatchObject({ status: 422, refusal: 'too_many_scanned_pages' });
    expect(h.claude.calls).toHaveLength(1);
  });

  it('refuses anything that is not a JPEG within the size limit, before spending anything', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await photo(h), 'begin');
    const send = (imageBase64: string): Promise<FilesPageResult> =>
      read(h, begun.fileId, 1, { imageBase64 });
    expect(errorOf(await send('iVBORw0KGgo' + 'A'.repeat(200))).status).toBe(400); // a PNG
    expect(errorOf(await send('/9j/' + '!'.repeat(200))).status).toBe(400);
    expect(errorOf(await send('/9j/AA')).status).toBe(400);
    expect(errorOf(await send('/9j/' + 'A'.repeat(FILE_LIMITS.maxImageBase64Chars))).status).toBe(
      400,
    );
    expect(errorOf(await read(h, begun.fileId, 2)).status).toBe(400);
    expect(h.claude.calls).toEqual([]);
  });

  it('only a PDF or a picture has pages to look at, and only while it is being read', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const csv = reply(await call(h, beginBody({ kind: 'csv' })), 'begin');
    expect(errorOf(await read(h, csv.fileId)).status).toBe(400);
    const fileId = await attach(h, { contentHash: HASH('e') });
    expect(errorOf(await read(h, fileId)).code).toBe('UPLOAD_CLOSED');
    expect(errorOf(await read(h, uuid())).status).toBe(404);
  });

  it('the budget running out mid-document attaches nothing and says so', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await call(h, beginBody({ totalPages: 3, visionPages: 3 })), 'begin');
    expect((await read(h, begun.fileId, 1)).status).toBe(200);
    h.claude.queue.push(err(new SpendCapError('day', 4.99, 5, 0.077)));
    const capped = errorOf(await read(h, begun.fileId, 2));
    expect(capped).toMatchObject({
      status: 402,
      code: 'SPEND_CAP',
      retryable: false,
      message: FILES_MESSAGES.capDay,
    });
    // The file is still only "being read": no turn can use it, and finishing it is refused.
    expect(h.files.files.get(begun.fileId)?.record.status).toBe('reading');
    const finished = errorOf(await call(h, { action: 'finish', fileId: begun.fileId }));
    expect(finished).toMatchObject({
      status: 409,
      code: 'INCOMPLETE',
      message: FILES_MESSAGES.incomplete,
    });
    expect((await h.files.forTurn(CONV_ID)).ok && (await h.files.forTurn(CONV_ID))).toMatchObject({
      value: { files: [] },
    });
  });

  it('a model timeout fails that page, retryably, and stores nothing for it', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await photo(h), 'begin');
    h.claude.queue.push(err(new TimeoutError('slow', 60_000)));
    expect(errorOf(await read(h, begun.fileId))).toMatchObject({
      status: 504,
      retryable: true,
      message: FILES_MESSAGES.pageTimeout,
    });
    expect(h.files.files.get(begun.fileId)?.pages.size).toBe(0);
    // The retry reads it.
    expect((await read(h, begun.fileId)).status).toBe(200);
  });

  it('a reply that will not validate is asked for once more, then the page fails', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await photo(h), 'begin');
    h.claude.queue.push(ok(completion('PWNED')), ok(completion('Sure! Here is the page:')));
    const failed = errorOf(await read(h, begun.fileId));
    expect(failed).toMatchObject({ status: 502, code: 'PAGE_UNREADABLE', retryable: true });
    expect(h.claude.calls).toHaveLength(2);
    expect(h.files.files.get(begun.fileId)?.pages.size).toBe(0);
  });

  it('a page read but not stored is reported, not presented as read', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await photo(h), 'begin');
    h.files.failOnce.set('appendPages', new NetworkError('db down'));
    expect(errorOf(await read(h, begun.fileId)).status).toBe(503);
    h.files.failOnce.set('pageInfo', new NetworkError('db down'));
    expect(errorOf(await read(h, begun.fileId)).status).toBe(503);
    h.files.failOnce.set('visionPagesStored', new NetworkError('db down'));
    expect(errorOf(await read(h, begun.fileId)).status).toBe(503);
  });

  it('maps every model-side failure to a status and a sentence about the file', () => {
    const status = (error: Parameters<typeof mapVisionError>[0]): number =>
      mapVisionError(error).status;
    expect(status(new SpendCapError('month', 49, 50, 2))).toBe(402);
    expect(errorOf(mapVisionError(new SpendCapError('month', 49, 50, 2))).message).toBe(
      FILES_MESSAGES.capMonth,
    );
    expect(status(new RateLimitedError(1000))).toBe(429);
    expect(status(new ModelRefusalError(null))).toBe(422);
    expect(status(new TimeoutError('t', 1))).toBe(504);
    expect(status(new ValidationError('v'))).toBe(502);
    expect(status(new NetworkError('n'))).toBe(503);
    expect(status(new AppError('CIRCUIT_OPEN', 'c'))).toBe(503);
    expect(status(new AppError('HTTP_STATUS', 'h'))).toBe(502);
    expect(status(new AppError('CONFIG', 'c'))).toBe(500);
    expect(status(new AppError('INTERNAL', 'i'))).toBe(500);
  });
});

describe('finish', () => {
  it('makes the file usable only when every declared page is in', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await call(h, beginBody()), 'begin');
    await call(h, {
      action: 'append',
      fileId: begun.fileId,
      pages: [{ pageNo: 1, label: 'Page 1', text: 'one' }],
    });
    expect(errorOf(await call(h, { action: 'finish', fileId: begun.fileId }))).toMatchObject({
      status: 409,
      code: 'INCOMPLETE',
      retryable: true,
    });
    await call(h, {
      action: 'append',
      fileId: begun.fileId,
      pages: [{ pageNo: 2, label: 'Page 2', text: 'two' }],
    });
    const done = reply(await call(h, { action: 'finish', fileId: begun.fileId }), 'finish');
    expect(done.duplicate).toBe(false);
    expect(done.file).toMatchObject({
      id: begun.fileId,
      status: 'ready',
      pageCount: 2,
      charCount: 6,
      name: 'payslip.pdf',
      kind: 'pdf',
      byteSize: 4651,
    });
    // The view carries no text and no hash.
    expect(Object.keys(done.file).sort()).toEqual(
      [
        'byteSize',
        'charCount',
        'conversationId',
        'createdAt',
        'expiresAt',
        'fetchedAt',
        'id',
        'kind',
        'name',
        'pageCount',
        'readAsSent',
        'sourceHost',
        'sourceUrl',
        'status',
        'uploadedBy',
        'valuesMissing',
        'visionPages',
      ].sort(),
    );
    // An uploaded file came from nowhere on the web.
    expect(done.file).toMatchObject({ sourceUrl: null, sourceHost: null, fetchedAt: null });
    expect(done.replaced).toBe(0);
  });

  it('is idempotent, and a file kept for 30 days says when it expires', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const fileId = await attach(h);
    const again = reply(await call(h, { action: 'finish', fileId }), 'finish');
    expect(again.file.id).toBe(fileId);
    expect(
      new Date(again.file.expiresAt).getTime() - new Date(again.file.createdAt).getTime(),
    ).toBe(30 * 86_400_000);
  });

  it('a document too long to keep is refused and removed', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await call(h, beginBody()), 'begin');
    h.files.failOnce.set(
      'finish',
      new AppError('CONFLICT', 'x', { context: { reason: 'too_long' } }),
    );
    expect(errorOf(await call(h, { action: 'finish', fileId: begun.fileId }))).toMatchObject({
      status: 422,
      refusal: 'too_long',
    });
    expect(h.files.files.has(begun.fileId)).toBe(false);
  });

  it('a removed or missing file cannot be finished, and a failing store is a 503', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const fileId = await attach(h);
    await call(h, { action: 'remove', fileId });
    expect(errorOf(await call(h, { action: 'finish', fileId })).code).toBe('UPLOAD_CLOSED');
    expect(errorOf(await call(h, { action: 'finish', fileId: uuid() })).status).toBe(404);
    const begun = reply(
      await call(h, beginBody({ contentHash: HASH('9'), totalPages: 1 })),
      'begin',
    );
    await call(h, {
      action: 'append',
      fileId: begun.fileId,
      pages: [{ pageNo: 1, label: 'x', text: 'y' }],
    });
    h.files.failOnce.set('finish', new NetworkError('db down'));
    expect(errorOf(await call(h, { action: 'finish', fileId: begun.fileId })).status).toBe(503);
  });
});

describe('remove', () => {
  it('the person who attached it removes it: the text and the name are gone, the row is a tombstone', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const fileId = await attach(h);
    expect(reply(await call(h, { action: 'remove', fileId }), 'remove')).toMatchObject({
      fileId,
      removed: true,
    });
    const stored = h.files.files.get(fileId);
    expect(stored?.record).toMatchObject({ status: 'removed', name: null });
    expect(stored?.pages.size).toBe(0);
    expect(h.files.textOf(fileId)).toBe('');
    // Again: nothing left to do, and it says so rather than failing.
    expect(reply(await call(h, { action: 'remove', fileId }), 'remove').removed).toBe(false);
  });

  it('a colleague who can see the conversation cannot remove it; an administrator can', async () => {
    const { log } = capturingLogger();
    const owner = harness(log);
    const fileId = await attach(owner);
    const colleague = harness(log, { userId: OTHER_ID });
    const asColleague = { ...colleague, deps: { ...colleague.deps, files: owner.files } };
    const denied = errorOf(await call(asColleague, { action: 'remove', fileId }));
    expect(denied).toMatchObject({
      status: 403,
      message: 'Only the person who attached this file, or an administrator, can remove it.',
    });
    expect(owner.files.files.get(fileId)?.record.status).toBe('ready');
    const admin = harness(log, { userId: ADMIN_ID, isAdmin: true });
    const asAdmin = { ...admin, deps: { ...admin.deps, files: owner.files } };
    expect(reply(await call(asAdmin, { action: 'remove', fileId }), 'remove').removed).toBe(true);
  });

  it('an unfinished upload is deleted outright', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const begun = reply(await call(h, beginBody()), 'begin');
    await call(h, { action: 'remove', fileId: begun.fileId });
    expect(h.files.files.has(begun.fileId)).toBe(false);
  });

  it('a file that does not exist, or that the person cannot see, is 404; a failing store is 503', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    expect(errorOf(await call(h, { action: 'remove', fileId: uuid() })).status).toBe(404);
    const fileId = await attach(h);
    h.files.failOnce.set('remove', new NetworkError('db down'));
    expect(errorOf(await call(h, { action: 'remove', fileId })).status).toBe(503);
  });
});

describe('estimate — what a scan will cost, before it is read (D90)', () => {
  it('quotes pages, cost and the daily cap', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    h.spent = { day: 1.25, month: 12 };
    const quote = reply(await call(h, { action: 'estimate', visionPages: 23 }), 'estimate');
    const { typicalUsd } = visionPageCosts(
      DEFAULT_PRICING['claude-sonnet-5'] ?? h.deps.visionPricing,
      4096,
    );
    // (4,784 + 260) × $3/M + 800 × $15/M
    expect(typicalUsd).toBe(0.027132);
    expect(quote).toMatchObject({
      pages: 23,
      perPageUsd: 0.027132,
      dailyCapUsd: 5,
      spentTodayUsd: 1.25,
      affordable: true,
    });
    expect(quote.estimateUsd).toBe(0.624036);
  });

  it('fifty pages is about a third of the daily cap, and is affordable on a fresh day', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const quote = reply(await call(h, { action: 'estimate', visionPages: 50 }), 'estimate');
    expect(quote.estimateUsd / quote.dailyCapUsd).toBeCloseTo(0.27, 2);
    expect(quote.affordable).toBe(true);
  });

  it('says not affordable when today or this month cannot cover it — nothing is started', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    h.spent = { day: 4.5, month: 10 };
    expect(
      reply(await call(h, { action: 'estimate', visionPages: 23 }), 'estimate').affordable,
    ).toBe(false);
    h.spent = { day: 0, month: 49.9 };
    expect(
      reply(await call(h, { action: 'estimate', visionPages: 10 }), 'estimate').affordable,
    ).toBe(false);
    // The last page must clear the cap's own worst-case reservation, not just the typical cost.
    const { typicalUsd, reservedUsd } = visionPageCosts(h.deps.visionPricing, 4096);
    expect(reservedUsd).toBeGreaterThan(typicalUsd * 2);
    h.spent = { day: 5 - reservedUsd + 0.001, month: 0 };
    expect(
      reply(await call(h, { action: 'estimate', visionPages: 1 }), 'estimate').affordable,
    ).toBe(false);
    h.spent = { day: 5 - reservedUsd, month: 0 };
    expect(
      reply(await call(h, { action: 'estimate', visionPages: 1 }), 'estimate').affordable,
    ).toBe(true);
    expect(h.claude.calls).toEqual([]);
  });

  it('refuses nonsense and more than 50 pages, and fails closed when spend cannot be read', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    expect(errorOf(await call(h, { action: 'estimate', visionPages: 0 })).status).toBe(400);
    expect(errorOf(await call(h, { action: 'estimate', visionPages: 51 }))).toMatchObject({
      status: 422,
      refusal: 'too_many_scanned_pages',
    });
    h.failSpent = new NetworkError('db down');
    expect(errorOf(await call(h, { action: 'estimate', visionPages: 3 }))).toMatchObject({
      status: 503,
      retryable: true,
    });
  });
});

describe('logging — who, what type, what size, how long, whether it worked; never the content', () => {
  it('records each upload with ids, kind, size, counts, durations and outcome', async () => {
    const { log, lines } = capturingLogger();
    const h = harness(log);
    await attach(h);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const started = events.find((event) => event['msg'] === 'file upload started');
    expect(started).toMatchObject({
      userId: USER_ID,
      conversationId: CONV_ID,
      kind: 'pdf',
      byteSize: 4651,
      pages: 2,
      visionPages: 0,
      extractMs: 120,
      duplicate: false,
    });
    const finished = events.find((event) => event['msg'] === 'file upload finished');
    expect(finished).toMatchObject({
      userId: USER_ID,
      kind: 'pdf',
      byteSize: 4651,
      pages: 2,
      outcome: 'attached',
    });
    expect(finished).toHaveProperty('totalMs');
    expect(finished).toHaveProperty('chars');
  });

  it('records a refusal the browser made, and one the server made', async () => {
    const { log, lines } = capturingLogger();
    const h = harness(log);
    expect(
      reply(
        await call(h, {
          action: 'refused',
          kind: 'pdf',
          byteSize: 15453,
          reason: 'password_pdf',
          extractMs: 54,
        }),
        'refused',
      ).logged,
    ).toBe(true);
    await call(h, { action: 'refused', kind: null, byteSize: 0, reason: 'empty' });
    await call(h, beginBody({ byteSize: FILE_LIMITS.maxFileBytes + 1 }));
    const refusals = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event['msg'] === 'file upload refused');
    expect(refusals).toHaveLength(3);
    expect(refusals[0]).toMatchObject({
      userId: USER_ID,
      kind: 'pdf',
      byteSize: 15453,
      reason: 'password_pdf',
      extractMs: 54,
      at: 'browser',
    });
    expect(refusals[2]).toMatchObject({ reason: 'too_large', at: 'server' });
    expect(
      errorOf(await call(h, { action: 'refused', kind: 'pdf', byteSize: 1, reason: 'made_up' }))
        .status,
    ).toBe(400);
  });

  it('no log line, error or reply ever carries the file name or a word of its content', async () => {
    const { log, lines } = capturingLogger();
    const h = harness(log);
    const replies: FilesPageResult[] = [];
    const run = async (body: Body): Promise<FilesPageResult> => {
      const result = await call(h, body);
      replies.push(result);
      return result;
    };

    // A text file, start to finish, then removed.
    const begun = reply(await run(beginBody({ name: CANARY_NAME })), 'begin');
    await run({
      action: 'append',
      fileId: begun.fileId,
      pages: [
        { pageNo: 1, label: CANARY_TEXT, text: `Line one ${CANARY_TEXT}` },
        { pageNo: 2, label: 'Page 2', text: CANARY_TEXT },
      ],
    });
    await run({ action: 'finish', fileId: begun.fileId });
    await run(beginBody({ name: CANARY_NAME })); // the duplicate path returns the view
    await run({ action: 'remove', fileId: begun.fileId });

    // A scan: one page read, one page whose reply will not validate (the reply IS content).
    const scan = reply(
      await run(
        beginBody({ name: CANARY_NAME, contentHash: HASH('5'), totalPages: 2, visionPages: 2 }),
      ),
      'begin',
    );
    h.claude.queue.push(
      ok(completion(`KIND: document\nLEGIBILITY: full\n---\n${CANARY_TEXT}`)),
      ok(completion(`not the form ${CANARY_TEXT}`)),
      ok(completion(`still not ${CANARY_TEXT}`)),
    );
    await run({
      action: 'read_page',
      fileId: scan.fileId,
      pageNo: 1,
      label: CANARY_TEXT,
      imageBase64: JPEG_BASE64,
    });
    await run({
      action: 'read_page',
      fileId: scan.fileId,
      pageNo: 2,
      label: 'Page 2',
      imageBase64: JPEG_BASE64,
    });
    // Failures on every path that holds content.
    h.files.failOnce.set('appendPages', new NetworkError(`db down`));
    await run({
      action: 'read_page',
      fileId: scan.fileId,
      pageNo: 2,
      label: 'Page 2',
      imageBase64: JPEG_BASE64,
    });
    await run({ action: 'finish', fileId: scan.fileId });
    await run({
      action: 'append',
      fileId: scan.fileId,
      pages: [{ pageNo: 9, label: 'x', text: CANARY_TEXT }],
    });
    await run(beginBody({ name: CANARY_NAME, byteSize: 0 }));

    const logged = lines.join('\n');
    expect(lines.length).toBeGreaterThan(8);
    expect(logged).not.toContain(CANARY_TEXT);
    expect(logged).not.toContain(CANARY_NAME);
    expect(logged).not.toContain('CANARY');
    // The page image is never logged either.
    expect(logged).not.toContain(JPEG_BASE64.slice(0, 40));
    // Error bodies say what happened, never what the file said.
    for (const result of replies) {
      if (result.status !== 200) expect(JSON.stringify(result.body)).not.toContain('CANARY');
    }
    // The only reply that names the file is the one handing the person their own file's view.
    const named = replies.filter((result) => JSON.stringify(result.body).includes(CANARY_NAME));
    expect(named.every((result) => result.status === 200)).toBe(true);
    expect(replies.some((result) => JSON.stringify(result.body).includes(CANARY_TEXT))).toBe(false);
  });

  it('a handler that throws is a 500 whose log names the error type and nothing else', async () => {
    const { log, lines } = capturingLogger();
    const h = harness(log);
    const deps = {
      ...h.deps,
      files: {
        ...h.files,
        begin: () => {
          throw new TypeError(`boom ${CANARY_TEXT}`);
        },
      },
    };
    const result = await handleFilesRequest(deps, { token: 't', body: beginBody() });
    expect(errorOf(result)).toMatchObject({ status: 500, code: 'INTERNAL' });
    expect(lines.join('\n')).toContain('TypeError');
    expect(lines.join('\n')).not.toContain('CANARY');
  });
});
