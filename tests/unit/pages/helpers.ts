/**
 * Fakes for the page-reading tests: a scripted `fetch` that answers by address, a scripted
 * DNS resolver, and streams that misbehave on purpose (never finishing, never ending, sending
 * more than they declared). Nothing here touches a network.
 */
import type {
  PageFetchDeps,
  PageFetchLike,
  PageFetchState,
  PageResolver,
} from '../../../src/lib/pages/fetch.js';
import { createPageFetchState } from '../../../src/lib/pages/fetch.js';
import type { PageGuard } from '../../../src/lib/pages/guard.js';
import { DEFAULT_USER_AGENT } from '../../../src/lib/pages/limits.js';

export const PUBLIC_V4 = '203.2.218.214';
export const PUBLIC_V6 = '2404:6800:4006:80a::200e';

export type Answer =
  | {
      readonly status?: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string | ReadableStream<Uint8Array> | null;
    }
  /** The request never gets an answer: it ends only when it is aborted. */
  | 'hang'
  /** The connection fails before any answer. */
  | 'network';

export type Route = Answer | ((attempt: number) => Answer);

export interface ScriptedFetch {
  readonly fetch: PageFetchLike;
  /** Every address requested, in order. */
  readonly calls: string[];
  readonly inits: RequestInit[];
}

/** Answers by exact address. An address with no route is a test bug, and says so. */
export function scriptedFetch(routes: Readonly<Record<string, Route>>): ScriptedFetch {
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  const attempts = new Map<string, number>();
  const fetch: PageFetchLike = (input, init) => {
    calls.push(input);
    inits.push(init);
    const route = Object.hasOwn(routes, input) ? routes[input] : undefined;
    if (route === undefined) {
      return Promise.reject(new Error(`scriptedFetch: no route for ${input}`));
    }
    const attempt = (attempts.get(input) ?? 0) + 1;
    attempts.set(input, attempt);
    const answer = typeof route === 'function' ? route(attempt) : route;
    if (answer === 'network') return Promise.reject(new TypeError('connection reset'));
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }
    const status = answer.status ?? 200;
    const body = status === 204 || status === 205 || status === 304 ? null : (answer.body ?? '');
    return Promise.resolve(new Response(body, { status, headers: { ...(answer.headers ?? {}) } }));
  };
  return { fetch, calls, inits };
}

export interface ScriptedResolver {
  readonly resolve: PageResolver;
  readonly asked: string[];
}

/** Names not listed resolve to one public address, as most of the internet does. */
export function scriptedResolver(
  names: Readonly<Record<string, readonly string[] | 'not_found' | 'failed'>> = {},
): ScriptedResolver {
  const asked: string[] = [];
  const resolve: PageResolver = (host) => {
    asked.push(host);
    const answer = Object.hasOwn(names, host) ? names[host] : undefined;
    if (answer === 'not_found') return Promise.resolve({ ok: false, reason: 'not_found' });
    if (answer === 'failed') return Promise.resolve({ ok: false, reason: 'failed' });
    return Promise.resolve({ ok: true, addresses: answer ?? [PUBLIC_V4] });
  };
  return { resolve, asked };
}

/**
 * NO GUARD AT ALL: every address parses and every resolved address is fine. Used only to show
 * that the hostile cases reach the network when the real guard is taken out — which is what
 * makes the guarded tests mean something.
 */
export const NO_GUARD: PageGuard = {
  parse: (raw) => {
    const url = new URL(String(raw));
    return {
      ok: true,
      url: {
        href: url.href,
        host: url.hostname,
        origin: url.origin,
        pathAndQuery: `${url.pathname}${url.search}`,
        hasQuery: url.search.length > 1,
      },
    };
  },
  addresses: () => ({ ok: true }),
};

export const NO_ROBOTS = { status: 404, body: 'Not found' } as const;

/** Deps with short timers, so a "never answers" test takes milliseconds. */
export function fetchDeps(
  scripted: ScriptedFetch,
  resolver: ScriptedResolver = scriptedResolver(),
  overrides: Partial<PageFetchDeps> = {},
): PageFetchDeps & { readonly state: PageFetchState; readonly slept: number[] } {
  const slept: number[] = [];
  return {
    fetch: scripted.fetch,
    resolve: resolver.resolve,
    userAgent: DEFAULT_USER_AGENT,
    state: createPageFetchState(),
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    limits: { firstByteTimeoutMs: 40, totalTimeoutMs: 400, robotsTimeoutMs: 60 },
    ...overrides,
    slept,
  };
}

export interface CountingStream {
  readonly stream: ReadableStream<Uint8Array>;
  /** Chunks the consumer has actually pulled. */
  readonly pulled: () => number;
  readonly cancelled: () => boolean;
}

/**
 * A body that hands out `chunk`-sized pieces for as long as it is asked — a multi-gigabyte
 * download, as far as the reader can tell. `highWaterMark: 0` means a piece is produced only
 * when somebody reads, so `pulled()` is exactly how much was taken.
 */
export function endlessStream(chunkBytes = 64 * 1024, fill = 0x41): CountingStream {
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(chunkBytes).fill(fill);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk.slice());
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

/** A body that sends `first` and then nothing, ever: a page that never finishes loading. */
export function stallingStream(first: string): CountingStream {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled += 1;
        if (pulled === 1) {
          controller.enqueue(new TextEncoder().encode(first));
          return undefined;
        }
        // Never resolves: the next read waits for bytes that do not come.
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

/** A finite body in pieces, which also reports whether anybody read it. */
export function countedBody(text: string, pieceBytes = 256): CountingStream {
  const bytes = new TextEncoder().encode(text);
  let pulled = 0;
  let cancelled = false;
  let at = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled += 1;
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(at, at + pieceBytes));
        at += pieceBytes;
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

export const HTML_PAGE =
  '<!doctype html><html><head><title>Rates</title></head><body><h1>Home loan rates</h1><p>Variable 6.04% p.a.</p></body></html>';
