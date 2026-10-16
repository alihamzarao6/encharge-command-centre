/**
 * Links in the message being written, and what the interface says about them and about a
 * page once it has been read (Milestone 5 part 2, Part A8 and Part C "the interface").
 *
 * "A message that is only a URL, a URL inside a sentence, several URLs in one message, and a
 * URL the client did not mean to be read" — the last is the reason nothing here opens
 * anything: a link is recognised, offered, and read only when he takes the offer.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { encodePageMeta, PAGE_META_HEADER } from '../../../src/lib/files/meta.js';
import { PAGE_LIMITS, READ_REGION, pageRefusalMessage } from '../../../src/lib/pages/limits.js';
import {
  FILES_API_MESSAGES,
  fetchPage,
  interpretFilesFailure,
  type AttachedFile,
  type FetchPageDeps,
} from '../../../web/src/lib/filesApi.js';
import {
  EXPIRED_FILE_TEXT,
  EXPIRED_PAGE_TEXT,
  READ_AGAIN_LABEL,
  READ_PAGE_LABEL,
  REMOVED_FILE_TEXT,
  REMOVED_PAGE_TEXT,
  READ_AS_SENT_TEXT,
  REPLACED_PAGE_TEXT,
  busyNote,
  goneText,
  linkOffers,
  missingNote,
  pageSummary,
  readWhen,
  sentNote,
  sourceNote,
  unreadAsk,
  uploadPercent,
  uploadStatus,
} from '../../../web/src/lib/filesView.js';
import { findLinks, offered, onlyLinks, withoutLink } from '../../../web/src/lib/links.js';
import type { UploadItem } from '../../../web/src/lib/uploads.js';

const PERTH = 'Australia/Perth';
const NOW = Date.parse('2026-10-12T07:00:00Z'); // 3:00 pm in Perth
const RATES = 'https://www.westpac.example.org/personal-banking/home-loans/all-interest-rates/';

const page = (overrides: Partial<AttachedFile> = {}): AttachedFile => ({
  id: 'p1',
  conversationId: 'c1',
  uploadedBy: 'u1',
  name: 'Home loan interest rates | Example Lender',
  kind: 'html',
  byteSize: 325_346,
  pageCount: 9,
  visionPages: 0,
  status: 'ready',
  createdAt: '2026-10-12T06:14:00Z',
  expiresAt: '2026-10-13T06:14:00Z',
  sourceUrl: RATES,
  sourceHost: 'www.westpac.example.org',
  fetchedAt: '2026-10-12T06:14:00Z',
  valuesMissing: 0,
  readAsSent: false,
  removedReason: null,
  driveFileId: null,
  ...overrides,
});

const item = (overrides: Partial<UploadItem> = {}): UploadItem => ({
  localId: 'upload-1',
  name: 'westpac.example.org',
  byteSize: 0,
  kind: null,
  phase: 'fetching',
  done: 0,
  total: 0,
  message: null,
  retryable: false,
  estimate: null,
  source: 'link',
  url: RATES,
  driveFileId: null,
  reconnect: false,
  ...overrides,
});

describe('findLinks — recognising a link', () => {
  it('a message that is only a link', () => {
    const [link, ...rest] = findLinks(RATES);
    expect(rest).toEqual([]);
    expect(link).toEqual({
      url: RATES,
      typed: RATES,
      host: 'westpac.example.org',
      display: 'westpac.example.org/…/all-interest-rates',
      refusal: null,
    });
    expect(onlyLinks(RATES)).toBe(true);
    expect(onlyLinks(`  ${RATES}\n`)).toBe(true);
  });

  it("a link inside a sentence, without the sentence's punctuation", () => {
    const text = `What is the two year fixed rate on ${RATES}? Thanks.`;
    expect(findLinks(text).map((link) => link.typed)).toEqual([RATES]);
    expect(onlyLinks(text)).toBe(false);
    expect(
      findLinks('See https://rba.example.org/cash-rate. Then').map((link) => link.url),
    ).toEqual(['https://rba.example.org/cash-rate']);
    expect(findLinks('(https://rba.example.org/cash-rate)')[0]?.typed).toBe(
      'https://rba.example.org/cash-rate',
    );
    expect(
      findLinks('"https://rba.example.org/a", and <https://rba.example.org/b>!').map(
        (link) => link.typed,
      ),
    ).toEqual(['https://rba.example.org/a', 'https://rba.example.org/b']);
  });

  it('keeps a bracket that belongs to the address', () => {
    expect(findLinks('https://en.example.org/wiki/Rate_(finance)')[0]?.typed).toBe(
      'https://en.example.org/wiki/Rate_(finance)',
    );
    expect(findLinks('(see https://en.example.org/wiki/Rate_(finance))')[0]?.typed).toBe(
      'https://en.example.org/wiki/Rate_(finance)',
    );
  });

  it('several links in one message, in order, each once', () => {
    const text = `Compare ${RATES} with https://www.nab.example.org/rates and again ${RATES} and https://WWW.NAB.example.org/rates#fixed`;
    expect(findLinks(text).map((link) => link.url)).toEqual([
      RATES,
      'https://www.nab.example.org/rates',
    ]);
    expect(onlyLinks(`${RATES} https://www.nab.example.org/rates`)).toBe(true);
  });

  it(`offers ${String(PAGE_LIMITS.linksOffered)} at a time and says how many more there are`, () => {
    const links = findLinks(
      Array.from({ length: 5 }, (_unused, i) => `https://site${String(i)}.example.org/a`).join(' '),
    );
    expect(links).toHaveLength(5);
    const { shown, more } = offered(links);
    expect(shown.map((link) => link.host)).toEqual([
      'site0.example.org',
      'site1.example.org',
      'site2.example.org',
    ]);
    expect(more).toBe(2);
    expect(offered(links.slice(0, 2))).toEqual({ shown: links.slice(0, 2), more: 0 });
  });

  it('what is not a link is not one', () => {
    for (const text of [
      '',
      'write a post about refinancing',
      'westpac.com.au has good rates',
      'www.westpac.com.au/rates',
      'email ross@fundd.example.org',
      'https://',
      'https://a',
      'the ftp://files.example.org/x server',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ]) {
      expect(findLinks(text), text).toEqual([]);
      expect(onlyLinks(text), text).toBe(false);
    }
  });

  it("an address that will not be opened is still recognised — and says why, in the server's words", () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['http://www.westpac.example.org/rates', 'link_not_https', 'westpac.example.org'],
      ['https://127.0.0.1/admin', 'link_numeric', '127.0.0.1'],
      ['https://localhost/x', 'link_private', 'localhost'],
      ['https://user:pass@www.lender.example.org/x', 'link_has_login', 'lender.example.org'],
      ['https://www.lender.example.org:8443/x', 'link_port', 'lender.example.org:8443'],
      ['https://169.254.169.254/latest/meta-data/', 'link_numeric', '169.254.169.254'],
    ];
    for (const [typed, code, host] of cases) {
      const [link] = findLinks(`please read ${typed} for me`);
      expect(link?.refusal, typed).toEqual({
        code,
        message: pageRefusalMessage(code as 'link_port'),
      });
      expect(link?.host, typed).toBe(host);
      // A password written into an address is never shown back.
      expect(link?.display, typed).not.toContain('pass');
    }
  });

  it('a very long address is shortened for the eye and kept whole for the request', () => {
    const long = `https://www.lender.example.org/${'section/'.repeat(40)}the-final-page-with-a-very-long-name-indeed-and-then-some-more.html?${'q=1&'.repeat(100)}`;
    const [link] = findLinks(long);
    expect(link?.url.length).toBeGreaterThan(700);
    expect(link?.display.length).toBeLessThanOrEqual(70);
    expect(link?.display.startsWith('lender.example.org/…/')).toBe(true);
    expect(link?.display).not.toContain('q=1');
    expect(findLinks('https://lender.example.org')[0]?.display).toBe('lender.example.org');
    expect(findLinks('https://lender.example.org/rates/')[0]?.display).toBe(
      'lender.example.org/rates',
    );
  });

  it('taking a link back out of the box leaves the words tidy', () => {
    const [link] = findLinks(`Look at ${RATES} please`);
    if (link === undefined) throw new Error('expected a link');
    expect(withoutLink(`Look at ${RATES} please`, link)).toBe('Look at please');
    expect(withoutLink(RATES, link)).toBe('');
    expect(withoutLink(`${RATES}\nwhat is the rate?`, link)).toBe('what is the rate?');
  });

  it('never throws on anything a person can paste', () => {
    for (const text of [
      'https://[',
      'https://%',
      'https://exa mple.org',
      `https://${'a'.repeat(5_000)}.org`,
      'https://\u0000',
    ]) {
      expect(() => findLinks(text)).not.toThrow();
    }
  });
});

describe('linkOffers — what the strip beside the box says for each link', () => {
  const empty = { uploads: [], files: [], readLinks: {} };
  const offer = (draft: string, state: Parameters<typeof linkOffers>[1] = empty) =>
    linkOffers(draft, state, NOW, PERTH).offers[0];

  it('a link that has not been read is offered, and nothing more', () => {
    expect(offer(`rate? ${RATES}`)).toMatchObject({
      state: 'unread',
      detail: null,
      retryable: false,
    });
  });

  it('a link that will not be opened says why and offers nothing', () => {
    expect(offer('http://www.westpac.example.org/rates')).toMatchObject({
      state: 'refused',
      detail: pageRefusalMessage('link_not_https'),
    });
  });

  it('a link on its way in says what is happening', () => {
    expect(offer(RATES, { ...empty, uploads: [item()] })).toMatchObject({
      state: 'reading',
      detail: 'Opening the page…',
    });
    expect(offer(RATES, { ...empty, uploads: [item({ phase: 'waiting' })] })?.state).toBe(
      'reading',
    );
    expect(offer(RATES, { ...empty, uploads: [item({ phase: 'finishing' })] })?.state).toBe(
      'reading',
    );
  });

  it("a link that was read says when, in the reader's own time", () => {
    expect(offer(RATES, { ...empty, files: [page()] })).toMatchObject({
      state: 'read',
      detail: 'Read today at 2:14 pm',
    });
  });

  it('an address that redirected is still recognised as read, by what was typed', () => {
    const typed = 'https://westpac.example.org/rates';
    const state = { uploads: [], files: [page()], readLinks: { [typed]: 'p1' } };
    expect(offer(typed, state)?.state).toBe('read');
    // Without that memory (a reload), it is offered again rather than wrongly called read.
    expect(offer(typed, { ...state, readLinks: {} })?.state).toBe('unread');
  });

  it('a page that was removed, has expired, or belongs to another address is not "read"', () => {
    expect(
      offer(RATES, { ...empty, files: [page({ status: 'removed', name: null, sourceUrl: null })] })
        ?.state,
    ).toBe('unread');
    expect(
      offer(RATES, { ...empty, files: [page({ expiresAt: '2026-10-12T06:59:59Z' })] })?.state,
    ).toBe('unread');
    expect(offer('https://www.nab.example.org/rates', { ...empty, files: [page()] })?.state).toBe(
      'unread',
    );
  });

  it('a read that failed says why, and offers another try only where one could help', () => {
    const retryable = item({
      phase: 'failed',
      message: 'That page took too long to answer.',
      retryable: true,
    });
    expect(offer(RATES, { ...empty, uploads: [retryable] })).toEqual({
      link: findLinks(RATES)[0],
      state: 'failed',
      detail: 'That page took too long to answer.',
      retryable: true,
    });
    const refused = item({ phase: 'refused', message: pageRefusalMessage('page_paywall') });
    expect(offer(RATES, { ...empty, uploads: [refused] })).toMatchObject({
      state: 'failed',
      retryable: false,
    });
  });

  it('a read in progress wins over an older copy: it is being read again', () => {
    expect(offer(RATES, { uploads: [item()], files: [page()], readLinks: {} })?.state).toBe(
      'reading',
    );
  });

  it('several links each get their own answer, and the count of the rest', () => {
    const draft = `${RATES} https://www.nab.example.org/rates http://old.example.org/ https://d.example.org/ https://e.example.org/`;
    const { offers, more } = linkOffers(draft, { ...empty, files: [page()] }, NOW, PERTH);
    expect(offers.map((entry) => entry.state)).toEqual(['read', 'unread', 'refused']);
    expect(more).toBe(2);
    expect(linkOffers('no links here', empty, NOW)).toEqual({ offers: [], more: 0 });
  });
});

describe('the question asked once, on Send, about a link that has not been read', () => {
  it('with a question in the message: read it then send, or send without', () => {
    expect(unreadAsk(1, true)).toEqual({
      text: 'This message has a link that has not been read. The assistant cannot open it, and will say so unless the page is read first.',
      read: 'Read it, then send',
      skip: 'Send without reading',
    });
    expect(unreadAsk(3, true)).toMatchObject({ read: 'Read 3 pages, then send' });
    expect(unreadAsk(3, true).text).toContain('3 links that have not been read');
  });

  it('with nothing but the link: read the page — there is no question to send yet', () => {
    expect(unreadAsk(1, false)).toEqual({
      text: 'This link has not been read, and there is nothing else in the message. Read the page, then ask about it.',
      read: READ_PAGE_LABEL,
      skip: 'Send it as it is',
    });
    expect(unreadAsk(2, false).read).toBe('Read 2 pages');
  });
});

describe('a page in the thread', () => {
  it('says its site and when it was read', () => {
    expect(pageSummary(page(), NOW, PERTH)).toBe(
      'Web page · westpac.example.org · read today at 2:14 pm',
    );
    expect(pageSummary(page({ fetchedAt: null, sourceHost: null }), NOW, PERTH)).toBe('Web page');
  });

  it('readWhen: today, yesterday, a date — by the calendar where the reader is', () => {
    expect(readWhen('2026-10-12T06:14:00Z', NOW, PERTH)).toBe('today at 2:14 pm');
    expect(readWhen('2026-10-11T23:30:00Z', NOW, PERTH)).toBe('today at 7:30 am');
    // 11:05 pm on the 11th in Perth is "yesterday" at 3 pm on the 12th.
    expect(readWhen('2026-10-11T15:05:00Z', NOW, PERTH)).toBe('yesterday at 11:05 pm');
    expect(readWhen('2026-10-03T01:05:00Z', NOW, PERTH)).toBe('3 Oct at 9:05 am');
    // The same instant is a different day in another place.
    expect(readWhen('2026-10-11T23:30:00Z', NOW, 'America/New_York')).toBe('yesterday at 7:30 pm');
    expect(readWhen('not a time', NOW, PERTH)).toBe('at an unknown time');
  });

  it('a document reached by a link says where it came from', () => {
    expect(sourceNote(page({ kind: 'pdf' }), NOW, PERTH)).toBe(
      'from westpac.example.org, read today at 2:14 pm',
    );
    expect(sourceNote(page({ sourceHost: null, fetchedAt: null }), NOW, PERTH)).toBeNull();
  });

  it('says plainly when it was read in part', () => {
    expect(missingNote(page())).toBeNull();
    expect(missingNote(page({ valuesMissing: 12 }))).toBe(
      'Read in part: 12 figures on this page are filled in by the site after it loads, and could not be read. To get them, save the page as a PDF and attach it.',
    );
    expect(missingNote(page({ valuesMissing: 1 }))).toContain('1 figure on this page is filled in');
  });

  it('says, where everyone can see it, when a page was read as the site sent it', () => {
    expect(sentNote(page())).toBeNull();
    expect(sentNote(page({ readAsSent: true }))).toBe(READ_AS_SENT_TEXT);
    expect(READ_AS_SENT_TEXT).toBe(
      'Read as the site sent it: this page shows its content only after its scripts run, so what was read may differ from what you see on the page. Check anything important against the page itself.',
    );
  });

  it('what is left where a page was never says which page it was', () => {
    const gone = (overrides: Partial<AttachedFile>) =>
      goneText(
        page({ status: 'removed', name: null, sourceUrl: null, sourceHost: null, ...overrides }),
        NOW,
      );
    expect(gone({ removedReason: 'user' })).toBe(REMOVED_PAGE_TEXT);
    expect(gone({ removedReason: 'expired' })).toBe(EXPIRED_PAGE_TEXT);
    expect(gone({ removedReason: 'replaced' })).toBe(REPLACED_PAGE_TEXT);
    expect(gone({ removedReason: null })).toBe(REMOVED_PAGE_TEXT);
    // Past its date before the nightly purge has run: already "kept for a day, so removed".
    expect(goneText(page({ expiresAt: '2026-10-12T06:00:00Z' }), NOW)).toBe(EXPIRED_PAGE_TEXT);
    // A file keeps part 1's words.
    expect(gone({ kind: 'pdf', removedReason: 'user' })).toBe(REMOVED_FILE_TEXT);
    expect(gone({ kind: 'pdf', removedReason: 'expired' })).toBe(EXPIRED_FILE_TEXT);
    for (const text of [REMOVED_PAGE_TEXT, EXPIRED_PAGE_TEXT, REPLACED_PAGE_TEXT]) {
      expect(text).not.toMatch(/westpac|Example Lender|https?:/);
    }
    expect(EXPIRED_PAGE_TEXT).toContain('kept for a day');
    expect(READ_AGAIN_LABEL).toBe('Read again');
  });
});

describe('progress while a page is being fetched', () => {
  it('before the first byte there is nothing to measure, and the bar says so', () => {
    expect(uploadStatus(item())).toBe('Opening the page…');
    expect(uploadPercent(item())).toBeNull();
  });

  it('once bytes arrive — on a slow connection, for a while — it shows how far', () => {
    const arriving = item({ done: 1_258_291, total: 3_145_728 });
    expect(uploadStatus(arriving)).toBe('Downloading… 1.2 MB of 3.0 MB');
    expect(uploadPercent(arriving)).toBe(40);
  });

  it("then reading, sending and finishing, in a page's own words", () => {
    expect(uploadStatus(item({ phase: 'waiting' }))).toBe('Waiting for the one before it…');
    expect(uploadStatus(item({ phase: 'reading' }))).toBe('Reading the page…');
    expect(uploadStatus(item({ phase: 'reading', done: 2, total: 45 }))).toBe(
      'Reading it… page 3 of 45',
    );
    expect(uploadStatus(item({ phase: 'finishing' }))).toBe('Finishing…');
    // A file's words are untouched.
    expect(uploadStatus(item({ source: 'file', url: null, phase: 'waiting' }))).toBe(
      'Waiting for the file before it…',
    );
    expect(uploadStatus(item({ source: 'file', url: null, phase: 'reading' }))).toBe(
      'Reading the file…',
    );
  });

  it('Send waits for the page, and says so', () => {
    expect(busyNote([item()])).toBe(
      'Wait for the page from westpac.example.org to be read before you send.',
    );
    expect(busyNote([item({ phase: 'failed', message: 'x' })])).toBeNull();
  });
});

describe('fetchPage — the one call whose reply is bytes', () => {
  const HTML = new TextEncoder().encode('<html><body><h1>Rates</h1></body></html>');
  const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  const meta = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    action: 'fetch_page',
    fetchId: 'f0000000-0000-4000-8000-000000000001',
    host: 'www.westpac.example.org',
    fileName: 'all-interest-rates',
    contentType: 'text/html; charset=utf-8',
    byteSize: HTML.length,
    contentHash: sha(HTML),
    ...overrides,
  });
  interface Seen {
    url: string;
    init: RequestInit;
  }
  const addressOf = (input: string | URL | Request): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const sentBody = (entry: Seen | undefined): unknown =>
    JSON.parse(typeof entry?.init.body === 'string' ? entry.init.body : 'null');
  /** A request that never answers until it is aborted, as a stalled connection does. */
  const neverAnswers = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  function deps(
    respond: (seen: Seen) => Response | Promise<Response>,
  ): FetchPageDeps & { seen: Seen[] } {
    const seen: Seen[] = [];
    return {
      seen,
      filesUrl: 'https://project.example.supabase.co/functions/v1/files',
      anonKey: 'anon-key',
      timeoutMs: 200,
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        const entry = { url: addressOf(input), init: init ?? {} };
        seen.push(entry);
        return Promise.resolve(respond(entry));
      },
    };
  }
  const pageResponse = (body: Uint8Array, header: Record<string, unknown>): Response =>
    new Response(body.slice().buffer, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        [PAGE_META_HEADER]: encodePageMeta(header),
      },
    });
  const request = { requestId: 'f0000000-0000-4000-8000-000000000001', url: RATES };

  it('asks OUR endpoint, in the Sydney region, and never the site', async () => {
    const d = deps(() => pageResponse(HTML, meta()));
    const outcome = await fetchPage(d, 'access-token', request);
    expect(outcome.kind).toBe('ok');
    expect(d.seen).toHaveLength(1);
    expect(d.seen[0]?.url).toBe(
      `https://project.example.supabase.co/functions/v1/files?forceFunctionRegion=${READ_REGION}`,
    );
    expect(READ_REGION).toBe('ap-southeast-2');
    expect(d.seen[0]?.init.method).toBe('POST');
    expect(sentBody(d.seen[0])).toEqual({ action: 'fetch_page', ...request });
    expect((d.seen[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer access-token',
    );
    // The site's address appears only inside the body sent to us.
    expect(d.seen.every((entry) => !entry.url.includes('westpac'))).toBe(true);
  });

  it('hands back the bytes and what the server measured, with progress on the way', async () => {
    const d = deps(() => pageResponse(HTML, meta()));
    const progress: [number, number][] = [];
    const outcome = await fetchPage(d, 't', request, undefined, (received, total) => {
      progress.push([received, total]);
    });
    if (outcome.kind !== 'ok') throw new Error('expected the page');
    expect(outcome.reply).toMatchObject({
      fetchId: request.requestId,
      host: 'www.westpac.example.org',
      fileName: 'all-interest-rates',
      contentType: 'text/html; charset=utf-8',
      contentHash: sha(HTML),
    });
    expect(new TextDecoder().decode(outcome.reply.bytes)).toContain('<h1>Rates</h1>');
    expect(progress.at(-1)).toEqual([HTML.length, HTML.length]);
  });

  it('a page cut short on the way here is not read as if it were whole', async () => {
    const short = deps(() => pageResponse(HTML.subarray(0, 10), meta()));
    expect(await fetchPage(short, 't', request)).toMatchObject({
      kind: 'error',
      failure: 'retryable',
      code: 'INCOMPLETE_PAGE',
      message: FILES_API_MESSAGES.incompletePage,
    });
    // The right length and the wrong bytes: the hash catches it.
    const swapped = HTML.slice();
    swapped[5] = 0x58;
    const tampered = deps(() => pageResponse(swapped, meta()));
    expect(await fetchPage(tampered, 't', request)).toMatchObject({ code: 'INCOMPLETE_PAGE' });
  });

  it('a 200 that is not a page is not a success', async () => {
    const noHeader = deps(() => new Response(HTML.slice().buffer, { status: 200 }));
    expect(await fetchPage(noHeader, 't', request)).toMatchObject({
      failure: 'retryable',
      code: 'BAD_RESPONSE',
    });
    const halfMeta = deps(() => pageResponse(HTML, { action: 'fetch_page', host: 'x' }));
    expect(await fetchPage(halfMeta, 't', request)).toMatchObject({ code: 'BAD_RESPONSE' });
    const badHeader = deps(
      () =>
        new Response(HTML.slice().buffer, { status: 200, headers: { [PAGE_META_HEADER]: '!!!' } }),
    );
    expect(await fetchPage(badHeader, 't', request)).toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it("a refusal comes back as the server's own sentence, and is not retryable", async () => {
    const message = pageRefusalMessage('page_blocked');
    const d = deps(() =>
      Response.json(
        { error: { code: 'PAGE_REFUSED', message, retryable: false, refusal: 'page_blocked' } },
        { status: 422 },
      ),
    );
    expect(await fetchPage(d, 't', request)).toEqual({
      kind: 'error',
      failure: 'refused',
      message,
      code: 'PAGE_REFUSED',
      status: 422,
      refusal: 'page_blocked',
    });
  });

  it.each([
    [504, 'retryable'],
    [502, 'retryable'],
    [503, 'retryable'],
    [429, 'retryable'],
    [409, 'retryable'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [400, 'fatal'],
    [404, 'fatal'],
  ] as const)('a %i is %s', async (status, failure) => {
    const d = deps(() =>
      Response.json(
        { error: { code: 'X', message: 'Said by the server.', retryable: status >= 500 } },
        { status },
      ),
    );
    const outcome = await fetchPage(d, 't', request);
    expect(outcome).toMatchObject({ kind: 'error', failure, status });
    expect(interpretFilesFailure(status, null).failure).toBe(failure);
  });

  it('a dropped connection and a timeout are both "try again", told apart', async () => {
    const dropped = deps(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await fetchPage(dropped, 't', request)).toMatchObject({
      failure: 'retryable',
      code: 'NETWORK',
      message: FILES_API_MESSAGES.network,
    });
    const hanging: FetchPageDeps = {
      filesUrl: 'https://project.example.supabase.co/functions/v1/files',
      anonKey: 'k',
      timeoutMs: 30,
      fetch: neverAnswers,
    };
    expect(await fetchPage(hanging, 't', request)).toMatchObject({
      failure: 'retryable',
      code: 'CLIENT_TIMEOUT',
      message: FILES_API_MESSAGES.timeout,
    });
  });

  it('Stop aborts it', async () => {
    const controller = new AbortController();
    const hanging: FetchPageDeps = {
      filesUrl: 'https://project.example.supabase.co/functions/v1/files',
      anonKey: 'k',
      fetch: neverAnswers,
    };
    const pending = fetchPage(hanging, 't', request, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'error', code: 'NETWORK' });
  });

  it('checks the hash with whatever is injected, so the check is the same everywhere', async () => {
    const d = {
      ...deps(() => pageResponse(HTML, meta())),
      hash: () => Promise.resolve('0'.repeat(64)),
    };
    expect(await fetchPage(d, 't', request)).toMatchObject({ code: 'INCOMPLETE_PAGE' });
  });
});
