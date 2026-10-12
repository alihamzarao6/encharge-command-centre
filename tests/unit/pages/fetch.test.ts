/**
 * The guarded fetch (Milestone 5 part 2, Part C "SSRF and the network" and "The response").
 *
 * The first block is the one that matters most: every hostile address is tried twice — once
 * through the real guard, where nothing may reach the network, and once with the guard taken
 * out, where it does. The second run is what makes the first one evidence.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BREAKER_FAILURES,
  BREAKER_REST_MS,
  classifyStatus,
  cleanContentType,
  createPageFetcher,
  createPageFetchState,
  createResolver,
  looksLikeDocument,
  type PageFetchResult,
} from '../../../src/lib/pages/fetch.js';
import { DEFAULT_USER_AGENT, PAGE_LIMITS } from '../../../src/lib/pages/limits.js';
import {
  HTML_PAGE,
  NO_GUARD,
  NO_ROBOTS,
  PUBLIC_V4,
  PUBLIC_V6,
  countedBody,
  endlessStream,
  fetchDeps,
  scriptedFetch,
  scriptedResolver,
  stallingStream,
  type Route,
} from './helpers.js';

const SITE = 'https://www.lender.example.org';
const PAGE = `${SITE}/home-loans/rates`;

function codeOf(result: PageFetchResult): string {
  return result.ok ? 'OK' : result.code;
}

/** A site with no robots file and one page. */
function site(extra: Readonly<Record<string, Route>> = {}): Record<string, Route> {
  return {
    [`${SITE}/robots.txt`]: NO_ROBOTS,
    [PAGE]: { headers: { 'content-type': 'text/html; charset=utf-8' }, body: HTML_PAGE },
    ...extra,
  };
}

describe('a page that can be read', () => {
  it('returns the bytes, the address it ended at, and facts that carry no path or content', async () => {
    const scripted = scriptedFetch(
      site({
        [`${PAGE}?utm=1`]: {
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: HTML_PAGE,
        },
      }),
    );
    const result = await createPageFetcher(fetchDeps(scripted)).read(`${PAGE}?utm=1#top`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.page.bytes)).toBe(HTML_PAGE);
    expect(result.page.final.href).toBe(PAGE.concat('?utm=1'));
    expect(result.page.contentType).toBe('text/html; charset=utf-8');
    expect(result.facts).toMatchObject({
      host: 'www.lender.example.org',
      finalHost: 'www.lender.example.org',
      hops: 0,
      httpStatus: 200,
      bytes: HTML_PAGE.length,
      hadQuery: true,
    });
    expect(JSON.stringify(result.facts)).not.toContain('home-loans');
    expect(JSON.stringify(result.facts)).not.toContain('utm');
  });

  it('asks as itself: our agent, GET, redirects by hand, no cookie and no credentials', async () => {
    const scripted = scriptedFetch(site());
    await createPageFetcher(fetchDeps(scripted)).read(PAGE);
    expect(scripted.calls).toEqual([`${SITE}/robots.txt`, PAGE]);
    for (const init of scripted.inits) {
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('manual');
      const headers = init.headers as Record<string, string>;
      expect(headers['user-agent']).toBe(DEFAULT_USER_AGENT);
      expect(Object.keys(headers).sort()).toEqual(['accept', 'accept-language', 'user-agent']);
    }
  });

  it('checks where the name points before anything is requested', async () => {
    const scripted = scriptedFetch(site());
    const resolver = scriptedResolver({ 'www.lender.example.org': [PUBLIC_V4, PUBLIC_V6] });
    const result = await createPageFetcher(fetchDeps(scripted, resolver)).read(PAGE);
    expect(result.ok).toBe(true);
    // Once for the read: the robots request to the same host does not ask again.
    expect(resolver.asked).toEqual(['www.lender.example.org']);
  });
});

describe('SSRF — nothing reaches the network through the guard, and everything does without it', () => {
  const HOSTILE: readonly (readonly [string, string, string])[] = [
    ['localhost', 'https://localhost/admin', 'link_private'],
    ['127.0.0.1', 'https://127.0.0.1/', 'link_numeric'],
    ['::1', 'https://[::1]/', 'link_numeric'],
    ['0.0.0.0', 'https://0.0.0.0/', 'link_numeric'],
    ['10.*', 'https://10.0.0.8/', 'link_numeric'],
    ['172.16-31.*', 'https://172.20.1.1/', 'link_numeric'],
    ['192.168.*', 'https://192.168.1.1/', 'link_numeric'],
    ['an IPv6 private address', 'https://[fd12::1]/', 'link_numeric'],
    ['the cloud metadata address', 'https://169.254.169.254/latest/meta-data/', 'link_numeric'],
    ['a decimal IP', 'https://2130706433/', 'link_numeric'],
    ['an octal IP', 'https://017700000001/', 'link_numeric'],
    ['a hex IP', 'https://0x7f000001/', 'link_numeric'],
    ['file://', 'file:///etc/passwd', 'link_invalid'],
    ['ftp://', 'ftp://files.example.org/a', 'link_invalid'],
    ['gopher://', 'gopher://example.org/', 'link_invalid'],
    ['http://', 'http://www.lender.example.org/', 'link_not_https'],
    ['embedded credentials', 'https://user:pass@www.lender.example.org/', 'link_has_login'],
    ['a non-standard port', 'https://www.lender.example.org:8443/', 'link_port'],
  ];

  it.each(HOSTILE)('%s is refused before any request or lookup', async (_label, address, code) => {
    const scripted = scriptedFetch({});
    const resolver = scriptedResolver();
    const result = await createPageFetcher(fetchDeps(scripted, resolver)).read(address);
    expect(codeOf(result)).toBe(code);
    expect(result.ok ? null : result.kind).toBe('refused');
    expect(scripted.calls).toEqual([]);
    expect(resolver.asked).toEqual([]);
  });

  it.each([
    ['data:', 'data:text/html,<h1>x</h1>'],
    ['javascript:', 'javascript:alert(1)'],
  ])('%s is refused as not an address', async (_label, address) => {
    const scripted = scriptedFetch({});
    const result = await createPageFetcher(fetchDeps(scripted)).read(address);
    expect(codeOf(result)).toBe('link_invalid');
    expect(scripted.calls).toEqual([]);
  });

  it.each(HOSTILE.filter(([, address]) => address.startsWith('http')))(
    'WITHOUT the guard, %s is requested — the guarded test fails when the guard is removed',
    async (_label, address) => {
      const requested: string[] = [];
      const fetcher = createPageFetcher({
        ...fetchDeps(scriptedFetch({})),
        guard: NO_GUARD,
        fetch: (input) => {
          requested.push(input);
          return Promise.resolve(new Response(HTML_PAGE, { status: 200 }));
        },
      });
      const result = await fetcher.read(address);
      expect(result.ok).toBe(true);
      // The page request itself went out, to the address the guard would have refused.
      expect(requested.some((url) => !url.endsWith('/robots.txt'))).toBe(true);
    },
  );

  it('a public name that RESOLVES to a private address is refused, and never requested', async () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '172.31.0.9',
      '192.168.0.2',
      '169.254.169.254',
      '::1',
      'fd00::9',
      '0.0.0.0',
    ]) {
      const scripted = scriptedFetch(site());
      const resolver = scriptedResolver({ 'www.lender.example.org': [address] });
      const result = await createPageFetcher(fetchDeps(scripted, resolver)).read(PAGE);
      expect(codeOf(result), address).toBe('link_private');
      expect(scripted.calls, address).toEqual([]);
    }
  });

  it('a name with one public and one private address is refused', async () => {
    const scripted = scriptedFetch(site());
    const resolver = scriptedResolver({ 'www.lender.example.org': [PUBLIC_V4, 'fe80::1'] });
    const result = await createPageFetcher(fetchDeps(scripted, resolver)).read(PAGE);
    expect(codeOf(result)).toBe('link_private');
    expect(scripted.calls).toEqual([]);
  });

  it('WITHOUT the guard the same private-resolving name is requested', async () => {
    const scripted = scriptedFetch(site());
    const resolver = scriptedResolver({ 'www.lender.example.org': ['127.0.0.1'] });
    const result = await createPageFetcher(fetchDeps(scripted, resolver, { guard: NO_GUARD })).read(
      PAGE,
    );
    expect(result.ok).toBe(true);
    expect(scripted.calls).toContain(PAGE);
  });

  it('a name that does not exist is "not found"; a lookup that fails is "try again"', async () => {
    const missing = await createPageFetcher(
      fetchDeps(scriptedFetch({}), scriptedResolver({ 'www.lender.example.org': 'not_found' })),
    ).read(PAGE);
    expect(missing).toMatchObject({ ok: false, kind: 'refused', code: 'site_not_found' });

    const failed = await createPageFetcher(
      fetchDeps(scriptedFetch({}), scriptedResolver({ 'www.lender.example.org': 'failed' })),
    ).read(PAGE);
    expect(failed).toMatchObject({ ok: false, kind: 'retry', code: 'site_unreachable' });
  });

  it('a resolver that throws is a lookup that failed, not a crash', async () => {
    const result = await createPageFetcher({
      ...fetchDeps(scriptedFetch({})),
      resolve: () => Promise.reject(new Error('resolver exploded')),
    }).read(PAGE);
    expect(result).toMatchObject({ ok: false, kind: 'retry', code: 'site_unreachable' });
  });
});

describe('redirects — the guard runs again on every hop', () => {
  const redirect = (to: string, status = 302): Route => ({ status, headers: { location: to } });

  it('follows a redirect to another public page and reports where it ended', async () => {
    const scripted = scriptedFetch({
      [`${SITE}/robots.txt`]: NO_ROBOTS,
      'https://lender.example.org/robots.txt': NO_ROBOTS,
      'https://lender.example.org/rates': redirect(`${SITE}/home-loans/rates`, 301),
      [PAGE]: { body: HTML_PAGE },
    });
    const result = await createPageFetcher(fetchDeps(scripted)).read(
      'https://lender.example.org/rates',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.requested.href).toBe('https://lender.example.org/rates');
    expect(result.page.final.href).toBe(PAGE);
    expect(result.facts).toMatchObject({ hops: 1, finalHost: 'www.lender.example.org' });
  });

  it('resolves a relative Location against the page it came from', async () => {
    const scripted = scriptedFetch(site({ [`${SITE}/old`]: redirect('/home-loans/rates', 308) }));
    const result = await createPageFetcher(fetchDeps(scripted)).read(`${SITE}/old`);
    expect(result.ok && result.page.final.href).toBe(PAGE);
  });

  it.each([
    ['the metadata address', 'https://169.254.169.254/latest/meta-data/'],
    ['loopback', 'https://127.0.0.1/'],
    ['IPv6 loopback', 'https://[::1]/'],
    ['a private address', 'https://10.0.0.1/admin'],
    ['localhost', 'https://localhost/'],
    ['plain http', 'http://www.lender.example.org/home-loans/rates'],
    ['a file', 'file:///etc/passwd'],
    ['another port', 'https://www.lender.example.org:8080/'],
    ['an address with credentials', 'https://a:b@www.lender.example.org/'],
    ['a decimal IP', 'https://2130706433/'],
  ])('a public page that redirects to %s is stopped at the hop', async (_label, target) => {
    const scripted = scriptedFetch(site({ [`${SITE}/go`]: redirect(target) }));
    const result = await createPageFetcher(fetchDeps(scripted)).read(`${SITE}/go`);
    expect(result).toMatchObject({ ok: false, kind: 'refused', code: 'link_redirect_blocked' });
    // The redirecting page was asked; its target never was.
    expect(scripted.calls).toEqual([`${SITE}/robots.txt`, `${SITE}/go`]);
  });

  it('a redirect to a public-looking name that resolves inside the network is stopped at the hop', async () => {
    const scripted = scriptedFetch(
      site({ [`${SITE}/go`]: redirect('https://assets.cdn-example.net/internal') }),
    );
    const resolver = scriptedResolver({ 'assets.cdn-example.net': ['10.20.30.40'] });
    const result = await createPageFetcher(fetchDeps(scripted, resolver)).read(`${SITE}/go`);
    expect(result).toMatchObject({ ok: false, kind: 'refused', code: 'link_redirect_blocked' });
    expect(resolver.asked).toEqual(['www.lender.example.org', 'assets.cdn-example.net']);
    expect(scripted.calls.some((url) => url.includes('cdn-example'))).toBe(false);
  });

  it('WITHOUT the guard that redirect is followed to the internal address', async () => {
    const scripted = scriptedFetch(
      site({
        [`${SITE}/go`]: redirect('https://assets.cdn-example.net/internal'),
        'https://assets.cdn-example.net/robots.txt': NO_ROBOTS,
        'https://assets.cdn-example.net/internal': { body: 'internal admin page' },
      }),
    );
    const resolver = scriptedResolver({ 'assets.cdn-example.net': ['10.20.30.40'] });
    const result = await createPageFetcher(fetchDeps(scripted, resolver, { guard: NO_GUARD })).read(
      `${SITE}/go`,
    );
    expect(result.ok).toBe(true);
    expect(scripted.calls).toContain('https://assets.cdn-example.net/internal');
  });

  it('a redirect loop is recognised as one', async () => {
    const scripted = scriptedFetch(
      site({ [`${SITE}/a`]: redirect(`${SITE}/b`), [`${SITE}/b`]: redirect(`${SITE}/a`) }),
    );
    const result = await createPageFetcher(fetchDeps(scripted)).read(`${SITE}/a`);
    expect(result).toMatchObject({ ok: false, kind: 'refused', code: 'redirect_loop' });
    expect(scripted.calls.filter((url) => !url.endsWith('robots.txt'))).toEqual([
      `${SITE}/a`,
      `${SITE}/b`,
    ]);
  });

  it('a page that redirects to itself is a loop of one', async () => {
    const scripted = scriptedFetch(site({ [`${SITE}/self`]: redirect(`${SITE}/self`) }));
    const result = await createPageFetcher(fetchDeps(scripted)).read(`${SITE}/self`);
    expect(codeOf(result)).toBe('redirect_loop');
  });

  it('a very long chain stops at the cap, having made exactly cap + 1 requests', async () => {
    const routes: Record<string, Route> = {};
    for (let i = 0; i < 40; i += 1)
      routes[`${SITE}/hop${String(i)}`] = redirect(`${SITE}/hop${String(i + 1)}`);
    const scripted = scriptedFetch(site(routes));
    const result = await createPageFetcher(fetchDeps(scripted)).read(`${SITE}/hop0`);
    expect(result).toMatchObject({ ok: false, kind: 'refused', code: 'too_many_redirects' });
    const pages = scripted.calls.filter((url) => !url.endsWith('robots.txt'));
    expect(pages).toHaveLength(PAGE_LIMITS.maxRedirects + 1);
    expect(result.ok ? 0 : result.facts.hops).toBe(PAGE_LIMITS.maxRedirects);
  });

  it('a chain of exactly the cap arrives', async () => {
    const routes: Record<string, Route> = {};
    for (let i = 0; i < PAGE_LIMITS.maxRedirects; i += 1) {
      routes[`${SITE}/hop${String(i)}`] = redirect(`${SITE}/hop${String(i + 1)}`);
    }
    routes[`${SITE}/hop${String(PAGE_LIMITS.maxRedirects)}`] = { body: HTML_PAGE };
    const result = await createPageFetcher(fetchDeps(scriptedFetch(site(routes)))).read(
      `${SITE}/hop0`,
    );
    expect(result.ok && result.facts.hops).toBe(PAGE_LIMITS.maxRedirects);
  });

  it('a 3xx with no Location, and a 304, are not pages', async () => {
    const scripted = scriptedFetch(
      site({ [`${SITE}/odd`]: { status: 302 }, [`${SITE}/same`]: { status: 304 } }),
    );
    const fetcher = createPageFetcher(fetchDeps(scripted));
    expect(codeOf(await fetcher.read(`${SITE}/odd`))).toBe('page_unexpected_status');
    expect(codeOf(await fetcher.read(`${SITE}/same`))).toBe('page_unexpected_status');
  });

  it('a Location that is not an address at all stops the read', async () => {
    const scripted = scriptedFetch(site({ [`${SITE}/go`]: redirect('https://[not-an-address') }));
    const result = await createPageFetcher(fetchDeps(scripted)).read(`${SITE}/go`);
    expect(codeOf(result)).toBe('link_redirect_blocked');
  });

  it('the body of a redirect is never read', async () => {
    const body = countedBody('you are being redirected');
    const scripted = scriptedFetch(
      site({ [`${SITE}/go`]: { status: 302, headers: { location: PAGE }, body: body.stream } }),
    );
    const result = await createPageFetcher(fetchDeps(scripted)).read(`${SITE}/go`);
    expect(result.ok).toBe(true);
    expect(body.pulled()).toBe(0);
    expect(body.cancelled()).toBe(true);
  });
});

describe('the response — size', () => {
  const small = { maxTextBytes: 4_096, maxDocumentBytes: 64 * 1024 };

  it('a multi-gigabyte response is cut off at the cap, having read only that much', async () => {
    const endless = endlessStream(1_024);
    const scripted = scriptedFetch(site({ [PAGE]: { body: endless.stream } }));
    const result = await createPageFetcher(
      fetchDeps(scripted, scriptedResolver(), { limits: { ...small, totalTimeoutMs: 2_000 } }),
    ).read(PAGE);
    expect(result).toMatchObject({
      ok: false,
      kind: 'refused',
      code: 'page_too_large',
      detail: small.maxTextBytes,
    });
    // Enforced WHILE streaming: five 1 KB pieces pass 4 KB, and no sixth was ever asked for.
    expect(endless.pulled()).toBe(5);
    expect(endless.cancelled()).toBe(true);
  });

  it('a response that claims one size and sends more is cut off at the cap, not at the claim', async () => {
    const endless = endlessStream(1_024);
    const scripted = scriptedFetch(
      site({ [PAGE]: { headers: { 'content-length': '300' }, body: endless.stream } }),
    );
    const result = await createPageFetcher(
      fetchDeps(scripted, scriptedResolver(), { limits: { ...small, totalTimeoutMs: 2_000 } }),
    ).read(PAGE);
    expect(codeOf(result)).toBe('page_too_large');
    expect(endless.pulled()).toBe(5);
  });

  it('a response that DECLARES itself too large is refused without reading any of it', async () => {
    const body = countedBody('x'.repeat(100));
    const scripted = scriptedFetch(
      site({
        [PAGE]: {
          headers: { 'content-length': String(small.maxDocumentBytes + 1) },
          body: body.stream,
        },
      }),
    );
    const result = await createPageFetcher(
      fetchDeps(scripted, scriptedResolver(), { limits: small }),
    ).read(PAGE);
    expect(result).toMatchObject({ code: 'page_too_large', detail: small.maxDocumentBytes });
    expect(body.pulled()).toBe(0);
  });

  it('over the cap is a refusal, never a shortened page', async () => {
    const scripted = scriptedFetch(site({ [PAGE]: { body: 'a'.repeat(small.maxTextBytes + 1) } }));
    const result = await createPageFetcher(
      fetchDeps(scripted, scriptedResolver(), { limits: small }),
    ).read(PAGE);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('page_too_large');
  });

  it('exactly at the cap is read whole', async () => {
    const scripted = scriptedFetch(site({ [PAGE]: { body: 'a'.repeat(small.maxTextBytes) } }));
    const result = await createPageFetcher(
      fetchDeps(scripted, scriptedResolver(), { limits: small }),
    ).read(PAGE);
    expect(result.ok && result.page.bytes.length).toBe(small.maxTextBytes);
  });

  it('a document is allowed its larger limit because of its BYTES, whatever the header says', async () => {
    const pdf = `%PDF-1.7\n${'x'.repeat(small.maxTextBytes * 2)}`;
    const scripted = scriptedFetch(
      site({ [PAGE]: { headers: { 'content-type': 'text/html' }, body: pdf } }),
    );
    const result = await createPageFetcher(
      fetchDeps(scripted, scriptedResolver(), { limits: small }),
    ).read(PAGE);
    expect(result.ok && result.page.bytes.length).toBe(pdf.length);
  });

  it('a page of text that CLAIMS to be a PDF gets the text limit — a lying content type', async () => {
    const html = `<html><body>${'a'.repeat(small.maxTextBytes * 2)}</body></html>`;
    const scripted = scriptedFetch(
      site({ [PAGE]: { headers: { 'content-type': 'application/pdf' }, body: html } }),
    );
    const result = await createPageFetcher(
      fetchDeps(scripted, scriptedResolver(), { limits: small }),
    ).read(PAGE);
    expect(result).toMatchObject({ code: 'page_too_large', detail: small.maxTextBytes });
  });

  it('a response with no content type is still a page: the bytes decide later', async () => {
    const stream = countedBody(HTML_PAGE);
    const scripted = scriptedFetch(site({ [PAGE]: { body: stream.stream } }));
    const result = await createPageFetcher(fetchDeps(scripted)).read(PAGE);
    expect(result.ok && result.page.contentType).toBeNull();
    expect(result.ok && new TextDecoder().decode(result.page.bytes)).toBe(HTML_PAGE);
  });

  it('an empty 200 is a page with nothing to read', async () => {
    const scripted = scriptedFetch(site({ [PAGE]: { body: '' } }));
    expect(codeOf(await createPageFetcher(fetchDeps(scripted)).read(PAGE))).toBe('page_no_text');
  });
});

describe('the response — time', () => {
  it('a site that never answers is given up on at the first-byte limit, and not asked twice', async () => {
    const scripted = scriptedFetch(site({ [PAGE]: 'hang' }));
    const started = Date.now();
    const result = await createPageFetcher(fetchDeps(scripted)).read(PAGE);
    expect(result).toMatchObject({ ok: false, kind: 'retry', code: 'page_timeout' });
    expect(Date.now() - started).toBeLessThan(350);
    expect(scripted.calls.filter((url) => url === PAGE)).toHaveLength(1);
  });

  it('a page that never finishes loading is given up on at the whole-read limit', async () => {
    const stalled = stallingStream('<html><body>Loading');
    const scripted = scriptedFetch(site({ [PAGE]: { body: stalled.stream } }));
    const started = Date.now();
    const result = await createPageFetcher(
      fetchDeps(scripted, scriptedResolver(), {
        limits: { firstByteTimeoutMs: 40, totalTimeoutMs: 120 },
      }),
    ).read(PAGE);
    expect(result).toMatchObject({ ok: false, kind: 'retry', code: 'page_timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(stalled.cancelled()).toBe(true);
  });

  it('a transport failure is retried once, after a jittered pause, and then succeeds', async () => {
    const scripted = scriptedFetch(
      site({ [PAGE]: (attempt) => (attempt === 1 ? 'network' : { body: HTML_PAGE }) }),
    );
    const deps = fetchDeps(scripted);
    const result = await createPageFetcher(deps).read(PAGE);
    expect(result.ok).toBe(true);
    expect(scripted.calls.filter((url) => url === PAGE)).toHaveLength(2);
    // random() is 0.5: half the base plus half of the other half.
    expect(deps.slept).toEqual([150]);
  });

  it('two transport failures are a site that could not be reached', async () => {
    const scripted = scriptedFetch(site({ [PAGE]: 'network' }));
    const result = await createPageFetcher(fetchDeps(scripted)).read(PAGE);
    expect(result).toMatchObject({ ok: false, kind: 'retry', code: 'site_unreachable' });
    expect(scripted.calls.filter((url) => url === PAGE)).toHaveLength(2);
  });

  it('a host that fails three reads running is rested, then tried once more', async () => {
    const scripted = scriptedFetch(site({ [PAGE]: 'network' }));
    const clock = { at: 1_000_000 };
    const deps = fetchDeps(scripted, scriptedResolver(), { now: () => clock.at });
    const fetcher = createPageFetcher(deps);
    for (let i = 0; i < BREAKER_FAILURES; i += 1) {
      expect(codeOf(await fetcher.read(PAGE))).toBe('site_unreachable');
    }
    const before = scripted.calls.length;
    expect(await fetcher.read(PAGE)).toMatchObject({ kind: 'retry', code: 'site_resting' });
    expect(scripted.calls).toHaveLength(before);

    clock.at += BREAKER_REST_MS + 1;
    expect(codeOf(await fetcher.read(PAGE))).toBe('site_unreachable');
    expect(scripted.calls.length).toBeGreaterThan(before);
    // The trial failed: rested again at once.
    expect(codeOf(await fetcher.read(PAGE))).toBe('site_resting');
  });

  it('a definite answer — even "not found" — is a working site, and clears the count', async () => {
    const scripted = scriptedFetch(
      site({ [PAGE]: (attempt) => (attempt <= 4 ? 'network' : { status: 404 }) }),
    );
    const deps = fetchDeps(scripted);
    const fetcher = createPageFetcher(deps);
    await fetcher.read(PAGE);
    await fetcher.read(PAGE);
    expect(codeOf(await fetcher.read(PAGE))).toBe('page_not_found');
    expect(deps.state.breakers.has('www.lender.example.org')).toBe(false);
  });
});

describe('the response — status', () => {
  it.each([
    [404, {}, 'refused', 'page_not_found'],
    [410, {}, 'refused', 'page_not_found'],
    [403, {}, 'refused', 'page_forbidden'],
    [403, { 'www-authenticate': 'Basic realm="x"' }, 'refused', 'page_login_required'],
    [403, { 'cf-mitigated': 'challenge' }, 'refused', 'page_blocked'],
    [401, {}, 'refused', 'page_login_required'],
    [407, {}, 'refused', 'page_login_required'],
    [429, {}, 'refused', 'page_blocked'],
    [429, { 'x-kpsdk-ct': 'abc' }, 'refused', 'page_blocked'],
    [451, {}, 'refused', 'page_forbidden'],
    [500, {}, 'retry', 'site_error'],
    [502, {}, 'retry', 'site_error'],
    [503, {}, 'retry', 'site_error'],
    [503, { 'cf-mitigated': 'challenge' }, 'refused', 'page_blocked'],
    [408, {}, 'retry', 'site_error'],
    [400, {}, 'refused', 'page_unexpected_status'],
    [405, {}, 'refused', 'page_unexpected_status'],
    [206, {}, 'refused', 'page_unexpected_status'],
    [201, {}, 'refused', 'page_unexpected_status'],
    [204, {}, 'refused', 'page_no_text'],
  ] as const)(
    'a %i %j is %s: %s — and its body is never read',
    async (status, headers, kind, code) => {
      // A "not found" page is ordinary-looking HTML. It must never become the answer.
      const body = countedBody(
        '<html><body><h1>Our rates</h1><p>Variable 1.99% p.a.</p></body></html>',
      );
      const scripted = scriptedFetch(site({ [PAGE]: { status, headers, body: body.stream } }));
      const result = await createPageFetcher(fetchDeps(scripted)).read(PAGE);
      expect(result).toMatchObject({ ok: false, kind, code });
      expect(result.ok ? null : result.facts.httpStatus).toBe(status);
      expect(body.pulled()).toBe(0);
    },
  );

  it('classifyStatus treats 200 and 203 as a page and nothing else', () => {
    const none = new Headers();
    expect(classifyStatus(200, none)).toEqual({ kind: 'ok' });
    expect(classifyStatus(203, none)).toEqual({ kind: 'ok' });
    for (const status of [201, 202, 206, 300, 301, 304, 400, 418, 499]) {
      expect(classifyStatus(status, none).kind, String(status)).not.toBe('ok');
    }
  });
});

describe('robots.txt on the way', () => {
  it('a disallowed path is refused and the page is never requested', async () => {
    const scripted = scriptedFetch(
      site({ [`${SITE}/robots.txt`]: { body: 'User-agent: *\nDisallow: /home-loans/\n' } }),
    );
    const result = await createPageFetcher(fetchDeps(scripted)).read(PAGE);
    expect(result).toMatchObject({ ok: false, kind: 'refused', code: 'robots_disallowed' });
    expect(scripted.calls).toEqual([`${SITE}/robots.txt`]);
  });

  it('a site that shuts AI assistants out is refused for that reason', async () => {
    const scripted = scriptedFetch(
      site({
        [`${SITE}/robots.txt`]: {
          body: 'User-agent: *\nAllow: /\n\nUser-agent: Claude-User\nDisallow: /\n',
        },
      }),
    );
    const result = await createPageFetcher(fetchDeps(scripted)).read(PAGE);
    expect(codeOf(result)).toBe('robots_ai_disallowed');
    expect(scripted.calls).toEqual([`${SITE}/robots.txt`]);
  });

  it('a site whose robots file cannot be fetched is not read, and may be tried again', async () => {
    for (const robots of [{ status: 503 }, 'hang', 'network'] as const) {
      const scripted = scriptedFetch(site({ [`${SITE}/robots.txt`]: robots }));
      const result = await createPageFetcher(fetchDeps(scripted)).read(PAGE);
      expect(result, JSON.stringify(robots)).toMatchObject({
        ok: false,
        kind: 'retry',
        code: 'robots_unavailable',
      });
      expect(scripted.calls).not.toContain(PAGE);
    }
  });

  it('the answer is remembered for the host, and a failure to get one is not', async () => {
    const scripted = scriptedFetch(
      site({ [`${SITE}/robots.txt`]: (attempt) => (attempt === 1 ? { status: 500 } : NO_ROBOTS) }),
    );
    const fetcher = createPageFetcher(fetchDeps(scripted));
    expect(codeOf(await fetcher.read(PAGE))).toBe('robots_unavailable');
    expect(codeOf(await fetcher.read(PAGE))).toBe('OK');
    expect(codeOf(await fetcher.read(PAGE))).toBe('OK');
    expect(scripted.calls.filter((url) => url.endsWith('robots.txt'))).toHaveLength(2);
  });

  it('an old answer is asked for again', async () => {
    const scripted = scriptedFetch(site());
    const clock = { at: 5_000_000 };
    const fetcher = createPageFetcher(
      fetchDeps(scripted, scriptedResolver(), { now: () => clock.at }),
    );
    await fetcher.read(PAGE);
    clock.at += PAGE_LIMITS.robotsCacheMs + 1;
    await fetcher.read(PAGE);
    expect(scripted.calls.filter((url) => url.endsWith('robots.txt'))).toHaveLength(2);
  });

  it('a redirected robots file is followed through the same guard', async () => {
    const scripted = scriptedFetch(
      site({
        [`${SITE}/robots.txt`]: {
          status: 301,
          headers: { location: 'https://lender.example.org/robots.txt' },
        },
        'https://lender.example.org/robots.txt': {
          body: 'User-agent: *\nDisallow: /home-loans/\n',
        },
      }),
    );
    expect(codeOf(await createPageFetcher(fetchDeps(scripted)).read(PAGE))).toBe(
      'robots_disallowed',
    );

    const inward = scriptedFetch(
      site({
        [`${SITE}/robots.txt`]: {
          status: 302,
          headers: { location: 'https://127.0.0.1/robots.txt' },
        },
      }),
    );
    const result = await createPageFetcher(fetchDeps(inward)).read(PAGE);
    expect(codeOf(result)).toBe('robots_unavailable');
    expect(inward.calls).toEqual([`${SITE}/robots.txt`]);
  });

  it('only the first part of a huge robots file is read, and its rules still apply', async () => {
    const endless = endlessStream(1_024, 0x23);
    const scripted = scriptedFetch(site({ [`${SITE}/robots.txt`]: { body: endless.stream } }));
    const result = await createPageFetcher(
      fetchDeps(scripted, scriptedResolver(), {
        limits: { robotsMaxBytes: 4_096, totalTimeoutMs: 2_000 },
      }),
    ).read(PAGE);
    // A file of nothing but comment characters has no rules: the page is read.
    expect(result.ok).toBe(true);
    expect(endless.pulled()).toBe(5);
  });

  it('each host met on the way is asked for its own rules', async () => {
    const scripted = scriptedFetch(
      site({
        [`${SITE}/go`]: { status: 302, headers: { location: 'https://news.example.com/article' } },
        'https://news.example.com/robots.txt': { body: 'User-agent: ChatGPT-User\nDisallow: /\n' },
      }),
    );
    const result = await createPageFetcher(fetchDeps(scripted)).read(`${SITE}/go`);
    expect(codeOf(result)).toBe('robots_ai_disallowed');
    expect(scripted.calls).not.toContain('https://news.example.com/article');
  });
});

describe('never throws', () => {
  it('a fetch that throws synchronously, or returns nonsense, is a failed read', async () => {
    const fetcher = createPageFetcher({
      ...fetchDeps(scriptedFetch({})),
      fetch: () => {
        throw new Error('boom https://secret.example/?token=abc');
      },
    });
    const result = await fetcher.read(PAGE);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('token');
  });

  it('a body that breaks part-way is a failed read, not a short page', async () => {
    let sent = false;
    const broken = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode('<html><body>The first half of'));
            return;
          }
          controller.error(new Error('connection reset'));
        },
      },
      { highWaterMark: 0 },
    );
    const scripted = scriptedFetch(site({ [PAGE]: { body: broken } }));
    const result = await createPageFetcher(fetchDeps(scripted)).read(PAGE);
    expect(result).toMatchObject({ ok: false, kind: 'retry', code: 'site_unreachable' });
  });
});

describe('small pure pieces', () => {
  it('cleanContentType keeps a media type and a charset and nothing else', () => {
    expect(cleanContentType('text/html; charset=UTF-8')).toBe('text/html; charset=utf-8');
    expect(cleanContentType('Text/HTML;charset="windows-1252"; boundary=x')).toBe(
      'text/html; charset=windows-1252',
    );
    expect(cleanContentType('application/pdf')).toBe('application/pdf');
    expect(cleanContentType(null)).toBeNull();
    expect(cleanContentType('')).toBeNull();
    expect(cleanContentType('not a type')).toBeNull();
    expect(cleanContentType('text/html\r\nx-injected: 1')).toBeNull();
  });

  it('looksLikeDocument goes by the bytes', () => {
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    expect(looksLikeDocument(bytes('%PDF-1.7'))).toBe(true);
    expect(looksLikeDocument(bytes('junk before %PDF-1.4'))).toBe(true);
    expect(looksLikeDocument(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe(true);
    expect(looksLikeDocument(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(looksLikeDocument(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(looksLikeDocument(bytes('GIF89a'))).toBe(true);
    expect(looksLikeDocument(bytes('RIFF0000WEBPVP8 '))).toBe(true);
    expect(looksLikeDocument(bytes('<!doctype html><html>'))).toBe(false);
    expect(looksLikeDocument(bytes('{"rates":[]}'))).toBe(false);
    expect(looksLikeDocument(new Uint8Array(0))).toBe(false);
  });

  it('createResolver asks for both families and fails closed', async () => {
    const notFound = Object.assign(new Error('no records'), { name: 'NotFound' });
    const both = createResolver({
      resolveDns: (_name, type) => Promise.resolve(type === 'A' ? [PUBLIC_V4] : [PUBLIC_V6]),
    });
    expect(await both('a.example.org')).toEqual({ ok: true, addresses: [PUBLIC_V4, PUBLIC_V6] });

    const v4Only = createResolver({
      resolveDns: (_name, type) =>
        type === 'A' ? Promise.resolve([PUBLIC_V4]) : Promise.reject(notFound),
    });
    expect(await v4Only('a.example.org')).toEqual({ ok: true, addresses: [PUBLIC_V4] });

    const missing = createResolver({ resolveDns: () => Promise.reject(notFound) });
    expect(await missing('a.example.org')).toEqual({ ok: false, reason: 'not_found' });

    // The IPv6 question could not be asked: the fetch might still use IPv6, so nothing is.
    const half = createResolver({
      resolveDns: (_name, type) =>
        type === 'A' ? Promise.resolve([PUBLIC_V4]) : Promise.reject(new Error('timed out')),
    });
    expect(await half('a.example.org')).toEqual({ ok: false, reason: 'failed' });
  });

  it('a fresh state is empty', () => {
    const state = createPageFetchState();
    expect(state.robots.size).toBe(0);
    expect(state.breakers.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// A real server and the real fetch: what the cap counts when the runtime decompresses.
// ---------------------------------------------------------------------------------------

describe('a real HTTP server through the real fetch', () => {
  let server: Server;
  let base = '';
  const sent = { bomb: 0, drip: 0 };

  beforeAll(async () => {
    // 60 MB of zeros is about 58 KB on the wire.
    const bomb = gzipSync(Buffer.alloc(60 * 1024 * 1024));
    server = createServer((request, response) => {
      if (request.url === '/robots.txt') {
        response.writeHead(404).end('no robots here');
        return;
      }
      if (request.url === '/bomb') {
        sent.bomb = bomb.length;
        response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        response.end(bomb);
        return;
      }
      if (request.url === '/endless') {
        response.writeHead(200, { 'content-type': 'text/html' });
        const piece = Buffer.alloc(64 * 1024, 0x61);
        const push = (): void => {
          while (!response.destroyed && response.write(piece)) {
            // keep writing until the socket pushes back
          }
          if (!response.destroyed) response.once('drain', push);
        };
        push();
        return;
      }
      if (request.url === '/drip') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.write('<html><body>Loading');
        sent.drip += 1;
        // …and then nothing, ever.
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HTML_PAGE);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  /** The guard refuses this server's real address, so the test maps a public name onto it. */
  const realFetcher = (limits: Record<string, number> = {}) =>
    createPageFetcher({
      fetch: (input, init) =>
        globalThis.fetch(input.replace('https://real.example.org', base), init),
      resolve: scriptedResolver().resolve,
      userAgent: DEFAULT_USER_AGENT,
      limits,
    });

  it('reads an ordinary page', async () => {
    const result = await realFetcher().read('https://real.example.org/page');
    expect(result.ok && new TextDecoder().decode(result.page.bytes)).toBe(HTML_PAGE);
    expect(result.ok && result.page.contentType).toBe('text/html; charset=utf-8');
  });

  it('a compressed bomb is counted at its expanded size and cut off at the cap', async () => {
    const started = Date.now();
    const result = await realFetcher().read('https://real.example.org/bomb');
    expect(result).toMatchObject({
      ok: false,
      kind: 'refused',
      code: 'page_too_large',
      detail: PAGE_LIMITS.maxTextBytes,
    });
    // 58 KB went over the wire; the cap that stopped it is 5 MB of what it expanded to.
    expect(sent.bomb).toBeLessThan(100 * 1024);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('a body with no end is cut off at the cap', async () => {
    const result = await realFetcher({ maxTextBytes: 512 * 1024 }).read(
      'https://real.example.org/endless',
    );
    expect(result).toMatchObject({ ok: false, code: 'page_too_large', detail: 512 * 1024 });
  });

  it('a body that stops arriving is given up on at the whole-read limit', async () => {
    const started = Date.now();
    const result = await realFetcher({ totalTimeoutMs: 400 }).read('https://real.example.org/drip');
    expect(result).toMatchObject({ ok: false, kind: 'retry', code: 'page_timeout' });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(sent.drip).toBe(1);
  });
});
