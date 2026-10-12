/**
 * Fetching one page a person pointed at (Milestone 5 part 2). Runtime-agnostic and never
 * throws: `fetch`, the DNS resolver, the clock and the sleep are injected, so every path here
 * is tested without a network — and so the Edge Function, the command-line tool and the tests
 * run the same code.
 *
 * One address in, one page out. Nothing on the page is followed, no second page is fetched,
 * and the only other request ever made is the site's own robots.txt.
 *
 * What makes it safe to point at an address somebody else chose:
 *
 *  - THE GUARD RUNS ON EVERY HOP. Redirects are followed by hand (`redirect: 'manual'`), and
 *    each new address goes through guard.ts exactly as the first did — the address rules,
 *    then where the name really points. A public page that redirects to 169.254.169.254 is
 *    refused at the hop, not fetched.
 *  - THE SIZE CAP IS ON THE STREAM. Bytes are counted as they arrive, after decompression
 *    (the runtime decodes gzip and brotli before we see them, so a compression bomb is
 *    counted at its expanded size). A response that declares one length and sends more is
 *    cut off at the cap. Over the cap is a REFUSAL, never a shortened page: a partial read
 *    presented as a whole one is the failure this part exists to avoid.
 *  - TIME IS BOUNDED TWICE: to the first byte of each hop, and for the whole read. A page
 *    that never finishes is a page that was not read.
 *  - A STATUS THAT IS NOT 200 IS NOT A PAGE. Its body is discarded unread — a "not found"
 *    page is 18 KB of ordinary-looking HTML (probe, 12 Oct 2026) and must never be answered
 *    from.
 *
 * Rule 8 (timeout, retry with backoff and jitter, breaker): one retry, on a transport failure
 * only — a person is waiting, and a status is an answer. A host that fails three times
 * running is rested for a minute.
 *
 * Nothing here logs. The caller writes one line per read from the facts returned (host,
 * status, type, bytes, time, outcome) — never an address with its query, never a byte of
 * the page.
 */
import { PAGE_GUARD, type PageGuard, type PublicUrl } from './guard.js';
import { PAGE_LIMITS, type PageRefusalCode, type PageRetryCode } from './limits.js';
import { robotsFromResponse, robotsVerdict, type RobotsAnswer } from './robots.js';

export type PageFetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ResolveResult =
  | { readonly ok: true; readonly addresses: readonly string[] }
  /** `not_found`: the name does not exist. `failed`: the question could not be asked. */
  | { readonly ok: false; readonly reason: 'not_found' | 'failed' };

export type PageResolver = (host: string) => Promise<ResolveResult>;

interface Breaker {
  failures: number;
  openedAt: number | null;
}

/**
 * What outlives one read: each host's robots answer for a few minutes, and which hosts are
 * being rested. Held at module scope by the wiring so a warm function keeps it between
 * requests; a cold one starts empty, which only costs a robots.txt fetch.
 */
export interface PageFetchState {
  readonly robots: Map<string, { readonly at: number; readonly answer: RobotsAnswer }>;
  readonly breakers: Map<string, Breaker>;
}

export function createPageFetchState(): PageFetchState {
  return { robots: new Map(), breakers: new Map() };
}

export interface PageFetchLimits {
  readonly maxRedirects: number;
  readonly firstByteTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxTextBytes: number;
  readonly maxDocumentBytes: number;
  readonly robotsMaxBytes: number;
  readonly robotsTimeoutMs: number;
  readonly robotsCacheMs: number;
}

export interface PageFetchDeps {
  readonly fetch: PageFetchLike;
  readonly resolve: PageResolver;
  readonly userAgent: string;
  readonly state?: PageFetchState;
  /** The real guard unless a test is showing what happens without one. */
  readonly guard?: PageGuard;
  readonly limits?: Partial<PageFetchLimits>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Uniform [0, 1), for the retry's jitter. */
  readonly random?: () => number;
}

/** What a read can say about itself in a log line. No path, no query, no content. */
export interface PageFetchFacts {
  /** The host that was asked for, or null when the address never parsed. */
  readonly host: string | null;
  /** The host that answered last. */
  readonly finalHost: string | null;
  readonly hops: number;
  readonly httpStatus: number | null;
  readonly contentType: string | null;
  readonly bytes: number;
  readonly ms: number;
  readonly hadQuery: boolean;
}

export interface FetchedPage {
  readonly requested: PublicUrl;
  readonly final: PublicUrl;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
}

export type PageFetchResult =
  | { readonly ok: true; readonly page: FetchedPage; readonly facts: PageFetchFacts }
  | {
      readonly ok: false;
      readonly kind: 'refused';
      readonly code: PageRefusalCode;
      /** The limit passed, for `page_too_large`. */
      readonly detail: number;
      readonly facts: PageFetchFacts;
    }
  | {
      readonly ok: false;
      readonly kind: 'retry';
      readonly code: PageRetryCode;
      readonly facts: PageFetchFacts;
    };

export interface PageFetcher {
  read(rawUrl: unknown): Promise<PageFetchResult>;
}

export const BREAKER_FAILURES = 3;
export const BREAKER_REST_MS = 60_000;
const RETRY_BASE_MS = 200;

/** Where a name points: public (null), or why it is not fetched. */
type HostVerdict = 'site_not_found' | 'link_private' | 'site_unreachable' | null;

const REQUEST_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5',
  'accept-language': 'en-AU,en;q=0.8',
} as const;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Headers a bot wall leaves on its refusal. Presence only; the values are never read. */
const BOT_WALL_HEADERS = [
  'cf-mitigated',
  'x-kpsdk-ct',
  'x-kpsdk-cd',
  'x-datadome',
  'x-datadome-cid',
  'x-amzn-waf-action',
  'x-px-block',
] as const;

/** `text/html; charset=utf-8`, cleaned to a media type and a charset, or null. */
export function cleanContentType(header: string | null): string | null {
  if (header === null) return null;
  const [type = '', ...params] = header.split(';');
  const media = type.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]{1,60}\/[a-z0-9!#$&^_.+-]{1,60}$/.test(media)) return null;
  for (const param of params) {
    const match = /^\s*charset\s*=\s*"?([a-z0-9._:-]{1,40})"?\s*$/i.exec(param);
    if (match?.[1] !== undefined) return `${media}; charset=${match[1].toLowerCase()}`;
  }
  return media;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

/**
 * Is this the start of a document Part 1 reads from its bytes (a PDF, an Office file, a
 * picture) rather than a page of text? Decides which size limit applies. The header's
 * content type is not consulted: it is a claim, and this is the evidence.
 */
export function looksLikeDocument(head: Uint8Array): boolean {
  let ascii = '';
  for (let i = 0; i < Math.min(head.length, 1024); i += 1) {
    ascii += String.fromCharCode(head[i] ?? 0);
  }
  if (ascii.includes('%PDF-')) return true;
  return (
    startsWith(head, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(head, [0xd0, 0xcf, 0x11, 0xe0]) ||
    startsWith(head, [0xff, 0xd8, 0xff]) ||
    startsWith(head, [0x89, 0x50, 0x4e, 0x47]) ||
    ascii.startsWith('GIF8') ||
    (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') ||
    ascii.slice(4, 8) === 'ftyp'
  );
}

type StatusVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'refused'; readonly code: PageRefusalCode }
  | { readonly kind: 'retry'; readonly code: PageRetryCode };

/** What a final status means. Only 200 (and its proxy-rewritten twin 203) is a page. */
export function classifyStatus(status: number, headers: Headers): StatusVerdict {
  if (status === 200 || status === 203) return { kind: 'ok' };
  const botWall = BOT_WALL_HEADERS.some((name) => headers.has(name));
  if (status === 204 || status === 205) return { kind: 'refused', code: 'page_no_text' };
  if (status === 401 || status === 407) return { kind: 'refused', code: 'page_login_required' };
  if (status === 403) {
    if (botWall) return { kind: 'refused', code: 'page_blocked' };
    return {
      kind: 'refused',
      code: headers.has('www-authenticate') ? 'page_login_required' : 'page_forbidden',
    };
  }
  if (status === 404 || status === 410) return { kind: 'refused', code: 'page_not_found' };
  // Too many requests from a site that has never seen us before is a bot wall, not a queue.
  if (status === 429) return { kind: 'refused', code: 'page_blocked' };
  if (status === 451) return { kind: 'refused', code: 'page_forbidden' };
  if (status >= 500 && status <= 599) {
    return botWall
      ? { kind: 'refused', code: 'page_blocked' }
      : { kind: 'retry', code: 'site_error' };
  }
  if (status === 408 || status === 425) return { kind: 'retry', code: 'site_error' };
  // 206 is part of a page; an unfollowed 3xx and every other 4xx are not one at all.
  return { kind: 'refused', code: 'page_unexpected_status' };
}

type BodyResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly why: 'too_large'; readonly limit: number }
  | { readonly ok: false; readonly why: 'timeout' | 'network' };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

interface Opened {
  readonly response: Response;
  /** Stops the request, including a body still being read. */
  readonly abort: () => void;
  /** Clears the timers. Always called. */
  readonly settle: () => void;
}

type OpenResult =
  | { readonly ok: true; readonly opened: Opened }
  | { readonly ok: false; readonly why: 'timeout' | 'network' };

export function createPageFetcher(deps: PageFetchDeps): PageFetcher {
  const limits: PageFetchLimits = { ...PAGE_LIMITS, ...(deps.limits ?? {}) };
  const guard = deps.guard ?? PAGE_GUARD;
  const state = deps.state ?? createPageFetchState();
  const now = deps.now ?? ((): number => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? ((): number => Math.random());

  /** Headers under `firstByteMs`; the body, later, under whatever is left until `deadlineAt`. */
  const open = async (
    href: string,
    firstByteMs: number,
    deadlineAt: number,
  ): Promise<OpenResult> => {
    const controller = new AbortController();
    const flags = { timedOut: false };
    const stop = (): void => {
      flags.timedOut = true;
      controller.abort();
    };
    const firstByte = setTimeout(stop, Math.max(1, Math.min(firstByteMs, deadlineAt - now())));
    let whole: ReturnType<typeof setTimeout> | null = null;
    try {
      const response = await deps.fetch(href, {
        method: 'GET',
        redirect: 'manual',
        headers: { ...REQUEST_HEADERS, 'user-agent': deps.userAgent },
        signal: controller.signal,
      });
      clearTimeout(firstByte);
      whole = setTimeout(stop, Math.max(1, deadlineAt - now()));
      const timer = whole;
      return {
        ok: true,
        opened: {
          response,
          abort: () => {
            controller.abort();
          },
          settle: () => {
            clearTimeout(timer);
          },
        },
      };
    } catch {
      clearTimeout(firstByte);
      if (whole !== null) clearTimeout(whole);
      return { ok: false, why: flags.timedOut ? 'timeout' : 'network' };
    }
  };

  /** Discards a body nobody will read, so the connection is not left hanging. */
  const discard = async (opened: Opened): Promise<void> => {
    try {
      await opened.response.body?.cancel();
    } catch {
      // Already closed or already errored: there is nothing left to release.
    }
    opened.abort();
    opened.settle();
  };

  /**
   * The body, counted as it arrives. `capFor` is asked once enough bytes are in to tell a
   * document from a page of text. `truncate` is for robots.txt alone, where the standard
   * says to use what fits and ignore the rest.
   */
  const readBody = async (
    opened: Opened,
    capFor: (head: Uint8Array) => number,
    deadlineAt: number,
    truncate: boolean,
  ): Promise<BodyResult> => {
    const { response } = opened;
    const ceiling = Math.max(limits.maxTextBytes, limits.maxDocumentBytes);
    const declared = Number(response.headers.get('content-length') ?? '');
    if (!truncate && Number.isFinite(declared) && declared > ceiling) {
      await discard(opened);
      return { ok: false, why: 'too_large', limit: ceiling };
    }
    const reader = response.body?.getReader();
    if (reader === undefined) {
      opened.settle();
      return { ok: true, bytes: new Uint8Array(0) };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    let cap: number | null = null;
    const finish = async (result: BodyResult): Promise<BodyResult> => {
      try {
        await reader.cancel();
      } catch {
        // The stream is already finished or already broken.
      }
      opened.abort();
      opened.settle();
      return result;
    };

    try {
      for (;;) {
        const left = deadlineAt - now();
        if (left <= 0) return await finish({ ok: false, why: 'timeout' });
        // A holder, not a `let`: an assignment inside the callback is invisible to narrowing.
        const clock: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
        const expired = new Promise<'expired'>((resolve) => {
          clock.timer = setTimeout(() => {
            resolve('expired');
          }, left);
        });
        const pending = reader.read();
        // If the deadline wins the race, this read is abandoned and then cancelled; its
        // rejection must not surface as an unhandled one.
        pending.catch(() => undefined);
        const step = await Promise.race([pending, expired]);
        if (clock.timer !== null) clearTimeout(clock.timer);
        if (step === 'expired') return await finish({ ok: false, why: 'timeout' });
        if (step.done) break;

        const chunk = step.value;
        chunks.push(chunk);
        total += chunk.length;
        if (cap === null && total >= 16) {
          cap = capFor(concat(chunks, total).subarray(0, 1024));
          if (!truncate && Number.isFinite(declared) && declared > cap) {
            return await finish({ ok: false, why: 'too_large', limit: cap });
          }
        }
        const limit = cap ?? ceiling;
        if (total > limit) {
          if (!truncate) return await finish({ ok: false, why: 'too_large', limit });
          const whole = concat(chunks, total).subarray(0, limit);
          return await finish({ ok: true, bytes: whole.slice() });
        }
      }
    } catch {
      // The deadline aborting the request surfaces here as a broken stream.
      const late = now() >= deadlineAt;
      return await finish({ ok: false, why: late ? 'timeout' : 'network' });
    }
    opened.settle();
    return { ok: true, bytes: concat(chunks, total) };
  };

  const breakerOpen = (host: string): boolean => {
    const breaker = state.breakers.get(host);
    const openedAt = breaker?.openedAt ?? null;
    if (breaker === undefined || openedAt === null) return false;
    if (now() - openedAt < BREAKER_REST_MS) return true;
    // Rested: the next read is the trial. One more failure opens it again.
    breaker.openedAt = null;
    breaker.failures = BREAKER_FAILURES - 1;
    return false;
  };
  const recordFailure = (host: string): void => {
    const breaker = state.breakers.get(host) ?? { failures: 0, openedAt: null };
    breaker.failures += 1;
    if (breaker.failures >= BREAKER_FAILURES) breaker.openedAt = now();
    state.breakers.set(host, breaker);
  };
  const recordSuccess = (host: string): void => {
    state.breakers.delete(host);
  };

  /** Where a name points, once per read. Null = public. */
  const checkHost = async (host: string, seen: Map<string, HostVerdict>): Promise<HostVerdict> => {
    const known = seen.get(host);
    if (known !== undefined) return known;
    let verdict: HostVerdict;
    let resolved: ResolveResult;
    try {
      resolved = await deps.resolve(host);
    } catch {
      resolved = { ok: false, reason: 'failed' };
    }
    if (!resolved.ok) {
      verdict = resolved.reason === 'not_found' ? 'site_not_found' : 'site_unreachable';
    } else {
      const checked = guard.addresses(resolved.addresses);
      verdict = checked.ok ? null : checked.refusal;
    }
    seen.set(host, verdict);
    return verdict;
  };

  /** The site's robots answer, from the cache or from the site. Never throws. */
  const robotsFor = async (
    url: PublicUrl,
    deadlineAt: number,
    seen: Map<string, HostVerdict>,
  ): Promise<RobotsAnswer> => {
    const cached = state.robots.get(url.host);
    if (cached !== undefined && now() - cached.at < limits.robotsCacheMs) return cached.answer;

    const robotsDeadline = Math.min(deadlineAt, now() + limits.robotsTimeoutMs);
    let answer: RobotsAnswer = { kind: 'unavailable' };
    let current = guard.parse(`${url.origin}/robots.txt`);
    for (let hop = 0; hop <= limits.maxRedirects && current.ok; hop += 1) {
      const target = current.url;
      if ((await checkHost(target.host, seen)) !== null) break;
      const opened = await open(target.href, limits.firstByteTimeoutMs, robotsDeadline);
      if (!opened.ok) break;
      const { response } = opened.opened;
      const location = response.headers.get('location');
      if (REDIRECTS.has(response.status) && location !== null) {
        await discard(opened.opened);
        let next: string;
        try {
          next = new URL(location, target.href).href;
        } catch {
          break;
        }
        current = guard.parse(next);
        continue;
      }
      if (response.status >= 200 && response.status < 300) {
        const body = await readBody(
          opened.opened,
          () => limits.robotsMaxBytes,
          robotsDeadline,
          true,
        );
        if (!body.ok) break;
        answer = robotsFromResponse(response.status, new TextDecoder().decode(body.bytes));
      } else {
        await discard(opened.opened);
        answer = robotsFromResponse(response.status, '');
      }
      break;
    }
    // An answer is worth remembering; a failure to get one is asked again next time.
    if (answer.kind !== 'unavailable') state.robots.set(url.host, { at: now(), answer });
    return answer;
  };

  const read = async (rawUrl: unknown): Promise<PageFetchResult> => {
    const started = now();
    const parsed = guard.parse(rawUrl);
    const facts = {
      host: parsed.ok ? parsed.url.host : null,
      finalHost: null as string | null,
      hops: 0,
      httpStatus: null as number | null,
      contentType: null as string | null,
      bytes: 0,
      hadQuery: parsed.ok ? parsed.url.hasQuery : false,
    };
    const snapshot = (): PageFetchFacts => ({ ...facts, ms: Math.round(now() - started) });
    const refused = (code: PageRefusalCode, detail = 0): PageFetchResult => ({
      ok: false,
      kind: 'refused',
      code,
      detail,
      facts: snapshot(),
    });
    const retry = (code: PageRetryCode): PageFetchResult => ({
      ok: false,
      kind: 'retry',
      code,
      facts: snapshot(),
    });

    if (!parsed.ok) return refused(parsed.refusal);
    const requested = parsed.url;
    if (breakerOpen(requested.host)) return retry('site_resting');

    const deadlineAt = started + limits.totalTimeoutMs;
    const seenHosts = new Map<string, HostVerdict>();
    const robotsChecked = new Set<string>();
    const visited = new Set<string>([requested.href]);
    let current = requested;

    for (let hop = 0; ; hop += 1) {
      facts.hops = hop;
      facts.finalHost = current.host;

      // 1. Where does this name really point? Asked for every hop's host.
      const hostVerdict = await checkHost(current.host, seenHosts);
      if (hostVerdict === 'site_unreachable') return retry('site_unreachable');
      if (hostVerdict !== null) {
        // The first address is the person's; a later one is the site's doing.
        if (hop > 0 && hostVerdict === 'link_private') return refused('link_redirect_blocked');
        return refused(hostVerdict);
      }

      // 2. May this path be read? Once per host met on the way.
      if (!robotsChecked.has(current.host)) {
        const answer = await robotsFor(current, deadlineAt, seenHosts);
        if (answer.kind === 'unavailable') return retry('robots_unavailable');
        robotsChecked.add(current.host);
      }
      const cachedRobots = state.robots.get(current.host)?.answer;
      if (cachedRobots?.kind === 'rules') {
        const verdict = robotsVerdict(cachedRobots.groups, current.pathAndQuery);
        if (!verdict.allowed) return refused(verdict.because);
      }

      // 3. Ask. One retry, on a transport failure only.
      if (now() >= deadlineAt) return retry('page_timeout');
      let opened = await open(current.href, limits.firstByteTimeoutMs, deadlineAt);
      if (!opened.ok && opened.why === 'network') {
        const backoff = RETRY_BASE_MS / 2 + random() * (RETRY_BASE_MS / 2);
        if (now() + backoff < deadlineAt) {
          await sleep(backoff);
          opened = await open(current.href, limits.firstByteTimeoutMs, deadlineAt);
        }
      }
      if (!opened.ok) {
        recordFailure(current.host);
        return retry(opened.why === 'timeout' ? 'page_timeout' : 'site_unreachable');
      }
      const { response } = opened.opened;
      facts.httpStatus = response.status;

      // 4. Passed on somewhere else? The new address is judged as the first one was.
      const location = response.headers.get('location');
      if (REDIRECTS.has(response.status) && location !== null) {
        await discard(opened.opened);
        let target: string;
        try {
          target = new URL(location, current.href).href;
        } catch {
          return refused('link_redirect_blocked');
        }
        const next = guard.parse(target);
        if (!next.ok) return refused('link_redirect_blocked');
        if (visited.has(next.url.href)) return refused('redirect_loop');
        if (hop >= limits.maxRedirects) return refused('too_many_redirects');
        visited.add(next.url.href);
        current = next.url;
        continue;
      }

      // 5. An answer. Is it a page?
      facts.contentType = cleanContentType(response.headers.get('content-type'));
      const status = classifyStatus(response.status, response.headers);
      if (status.kind !== 'ok') {
        await discard(opened.opened);
        if (status.kind === 'retry') {
          recordFailure(current.host);
          return retry(status.code);
        }
        // A definite answer from a site that is working.
        recordSuccess(current.host);
        return refused(status.code);
      }

      // 6. The page itself, under the cap its first bytes earn.
      const body = await readBody(
        opened.opened,
        (head) => (looksLikeDocument(head) ? limits.maxDocumentBytes : limits.maxTextBytes),
        deadlineAt,
        false,
      );
      if (!body.ok) {
        if (body.why === 'too_large') {
          recordSuccess(current.host);
          return refused('page_too_large', body.limit);
        }
        recordFailure(current.host);
        return retry(body.why === 'timeout' ? 'page_timeout' : 'site_unreachable');
      }
      recordSuccess(current.host);
      facts.bytes = body.bytes.length;
      if (body.bytes.length === 0) return refused('page_no_text');
      return {
        ok: true,
        page: { requested, final: current, contentType: facts.contentType, bytes: body.bytes },
        facts: snapshot(),
      };
    }
  };

  return {
    read: async (rawUrl) => {
      try {
        return await read(rawUrl);
      } catch {
        // Nothing above is meant to throw. If something does, the read did not happen — and
        // the cause is not carried anywhere: it may be holding an address or a page.
        return {
          ok: false,
          kind: 'retry',
          code: 'site_unreachable',
          facts: {
            host: null,
            finalHost: null,
            hops: 0,
            httpStatus: null,
            contentType: null,
            bytes: 0,
            ms: 0,
            hadQuery: false,
          },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// The resolver, over whatever the runtime offers
// ---------------------------------------------------------------------------------------

/** The slice of `Deno.resolveDns` (and of the Node adapter in scripts/pages.ts) this needs. */
export interface DnsLike {
  resolveDns(name: string, type: 'A' | 'AAAA'): Promise<readonly string[]>;
}

/**
 * Both address families, always: a name that is public over IPv4 and private over IPv6 is a
 * private name. A family with no records is an empty answer; a family whose question FAILED
 * is not — the fetch might still use it, so the whole read stops (fail closed).
 */
export function createResolver(
  dns: DnsLike,
  isNoRecords: (caught: unknown) => boolean = (caught) =>
    caught instanceof Error && caught.name === 'NotFound',
): PageResolver {
  return async (host) => {
    const ask = async (type: 'A' | 'AAAA'): Promise<readonly string[] | 'failed'> => {
      try {
        return await dns.resolveDns(host, type);
      } catch (caught: unknown) {
        return isNoRecords(caught) ? [] : 'failed';
      }
    };
    const [v4, v6] = await Promise.all([ask('A'), ask('AAAA')]);
    if (v4 === 'failed' || v6 === 'failed') return { ok: false, reason: 'failed' };
    const addresses = [...v4, ...v6];
    return addresses.length === 0 ? { ok: false, reason: 'not_found' } : { ok: true, addresses };
  };
}
