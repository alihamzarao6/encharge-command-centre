/**
 * Page-reading runner (Milestone 5 part 2).
 *
 *   npm run pages -- check <url>               No request to the site. What the address rules
 *                                              say about a link, and — if they pass it — what
 *                                              its name resolves to and whether every address
 *                                              is public. The way to answer "why was this link
 *                                              not opened?"
 *   npm run pages -- fetch <url> [--save <file>]
 *                                              NETWORK. The app's own guarded fetch, from THIS
 *                                              machine: address rules, DNS, robots.txt,
 *                                              redirects re-checked hop by hop, the timeouts and
 *                                              the size cap. Prints the host, hops, status,
 *                                              type, size, time and outcome — the same facts the
 *                                              function logs, and never the page. `--save`
 *                                              writes the bytes to a file for `extract`.
 *   npm run pages -- extract <file|url> [--type <content-type>] [--host <host>]
 *                                              Read a page with the app's own readers and print
 *                                              what came out: its title, each part's text, how
 *                                              many figures the site left for a script, or the
 *                                              sentence it was refused with. A file is read as
 *                                              bytes that came from a link; a url is fetched
 *                                              first (NETWORK).
 *   npm run pages -- ask <file|url> "<question>" [--host <host>] [--times N]
 *                                              LIVE. One answer from that page, through the same
 *                                              system prompt and wrapped-document message a chat
 *                                              turn sends for a conversation with a page in it.
 *                                              `--times 2` asks twice, which shows what a
 *                                              follow-up costs once the page is cached.
 *   npm run pages -- unread "<message with a link>"
 *                                              LIVE. What a chat turn sends when a message
 *                                              carries a link and NO page was read: the voice
 *                                              prefix and the rule about links, and nothing
 *                                              else. The reply must say the page was not
 *                                              opened, and must not answer from the address or
 *                                              from what the model remembers of the site.
 *
 * WHERE THIS RUNS IS NOT WHERE THE APP RUNS. The deployed function reads from Supabase's
 * Sydney region; this reads from the machine it is typed on. Sites answer the two
 * differently (docs/PHASE-ACCEPTANCE.md, Milestone 5 part 2, the probe table). A page that
 * reads here may be refused there and the other way about. To see what the app got, `--save`
 * is no substitute for the function's own log line.
 *
 * Nothing is stored and nothing is rate-limited here: there is no database behind it, so the
 * per-person limit and the per-site gap of the deployed function do not apply. Be the limit.
 *
 * Live modes talk to Claude through src/lib/llm/client.ts — the same cap, pricing, retry and
 * parsing code as the app — with an in-memory ledger, so a run can never exceed the env caps
 * and needs no database. Credentials come from the environment (.env is loaded if present).
 *
 * This prints the text of a page. That is its whole purpose, and it prints only to the
 * terminal of the person who asked; nothing here writes it to a log.
 *
 * Nothing here decides anything: the guard is src/lib/pages/guard.ts, the fetch is
 * src/lib/pages/fetch.ts, the readers are web/src/lib/files and the request is
 * src/lib/files/probe.ts, all unit-tested.
 */
import { promises as dns } from 'node:dns';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { ok, type Result } from '../src/lib/errors.js';
import { loadFilesConfig } from '../src/lib/files/config.js';
import { rulesFor, type TurnFile } from '../src/lib/files/context.js';
import { refusal } from '../src/lib/files/limits.js';
import { PROBE_OPERATION, probeRequest, toTurnFile } from '../src/lib/files/probe.js';
import { sanitiseFileName, sanitiseTitle } from '../src/lib/files/text.js';
import { createHttpClient } from '../src/lib/http.js';
import { turnRules } from '../src/lib/llm/chat.js';
import { createClaudeClient, type ClaudeClient, type UsageRecord } from '../src/lib/llm/client.js';
import { loadLlmConfig } from '../src/lib/llm/config.js';
import { buildSystemBlocks } from '../src/lib/llm/prompt.js';
import { logger } from '../src/lib/logger.js';
import {
  createPageFetcher,
  createResolver,
  type DnsLike,
  type PageFetchResult,
} from '../src/lib/pages/fetch.js';
import { checkResolvedAddresses, classifyAddress, parsePublicUrl } from '../src/lib/pages/guard.js';
import {
  NOT_LOADED_MARK,
  PAGE_RETRY_MESSAGES,
  READ_AS_SENT_MARK,
  pageRefusalMessage,
} from '../src/lib/pages/limits.js';
import { extractFile } from '../web/src/lib/files/extract.js';
import type { ExtractEngines, Extraction } from '../web/src/lib/files/types.js';

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`pages: ${message}\n`);
  process.exit(1);
}

function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env — rely on the real environment.
  }
}

/**
 * The operating system's resolver (getaddrinfo), in the shape the function gets from Deno —
 * the same resolver Node's own fetch connects through, so the addresses checked here are the
 * ones it would use. (Node's other resolver, c-ares, reads its servers for itself and on
 * some machines finds none.) "This family has no records" and "this name does not exist" are
 * answers; anything else is a failure, and the fetch stops on a failure rather than guess
 * (fail closed, as deployed).
 */
const nodeDns: DnsLike = {
  resolveDns: async (name, type) => {
    const found = await dns.lookup(name, { family: type === 'A' ? 4 : 6, all: true });
    return found.map((entry) => entry.address);
  },
};
const noRecords = (caught: unknown): boolean => {
  const code = (caught as { code?: unknown } | null)?.code;
  // ENOENT is how Windows reports a family this machine has no route for: the fetch
  // cannot use that family either, so it is an empty answer and not a failure.
  return code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ENOENT';
};
const resolveName = createResolver(nodeDns, noRecords);

/** The app's readers under Node, as scripts/files.ts runs them. Node does not draw pages. */
function nodeEngines(): ExtractEngines {
  return {
    pdf: () => Promise.resolve({ getDocument }),
    pdfAssets: `${join(import.meta.dirname, '..', 'node_modules', 'pdfjs-dist')}/`,
    images: {
      decode: () => Promise.resolve({ base64: '', width: 0, height: 0 }),
      renderPdfPage: () => Promise.resolve(null),
    },
  };
}

interface Flags {
  readonly positional: readonly string[];
  readonly save: string | null;
  readonly type: string | null;
  readonly host: string | null;
  readonly times: number;
}

function parseFlags(argv: readonly string[]): Flags {
  const positional: string[] = [];
  let save: string | null = null;
  let type: string | null = null;
  let host: string | null = null;
  let times = 1;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const value = argv[i + 1];
    if (arg === '--save' || arg === '--type' || arg === '--host' || arg === '--times') {
      if (value === undefined) fail(`${arg} needs a value`);
      i += 1;
      if (arg === '--save') save = value;
      else if (arg === '--type') type = value;
      else if (arg === '--host') host = value;
      else {
        times = Number(value);
        if (!Number.isInteger(times) || times < 1 || times > 5) fail('--times is 1 to 5');
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, save, type, host, times };
}

async function check(raw: string | undefined): Promise<void> {
  if (raw === undefined) fail('usage: npm run pages -- check <url>');
  const parsed = parsePublicUrl(raw);
  if (!parsed.ok) {
    out({
      opened: false,
      at: 'address',
      refusal: parsed.refusal,
      says: pageRefusalMessage(parsed.refusal),
    });
    return;
  }
  const resolved = await resolveName(parsed.url.host);
  if (!resolved.ok) {
    out({
      opened: false,
      at: 'dns',
      host: parsed.url.host,
      reason: resolved.reason,
      says:
        resolved.reason === 'not_found'
          ? pageRefusalMessage('site_not_found')
          : PAGE_RETRY_MESSAGES.site_unreachable,
    });
    return;
  }
  const verdict = checkResolvedAddresses(resolved.addresses);
  out({
    opened: verdict.ok,
    at: verdict.ok ? null : 'dns',
    host: parsed.url.host,
    hasQuery: parsed.url.hasQuery,
    // Every address the name has, in both families: one private address refuses the name.
    addresses: resolved.addresses.map((address) => ({ address, class: classifyAddress(address) })),
    ...(verdict.ok
      ? {
          note: 'The address rules pass it. robots.txt and the site itself are asked only by "fetch".',
        }
      : { refusal: verdict.refusal, says: pageRefusalMessage(verdict.refusal) }),
  });
}

function fetcher() {
  const config = loadFilesConfig(process.env);
  if (!config.ok) fail(`${config.error.code}: ${config.error.message}`);
  return createPageFetcher({
    fetch: (input, init) => globalThis.fetch(input, init),
    resolve: resolveName,
    userAgent: config.value.pageUserAgent,
  });
}

/** What a read says about itself: the function's log line, with the sentence a person sees. */
function describeRead(result: PageFetchResult): Record<string, unknown> {
  const { facts } = result;
  const line = {
    host: facts.host,
    finalHost: facts.finalHost,
    hops: facts.hops,
    httpStatus: facts.httpStatus,
    contentType: facts.contentType,
    bytes: facts.bytes,
    ms: facts.ms,
    hadQuery: facts.hadQuery,
  };
  if (result.ok) return { ...line, outcome: 'fetched' };
  return {
    ...line,
    outcome: result.code,
    retryable: result.kind === 'retry',
    says:
      result.kind === 'refused'
        ? pageRefusalMessage(result.code, result.detail)
        : PAGE_RETRY_MESSAGES[result.code],
  };
}

async function fetchOne(flags: Flags): Promise<void> {
  const raw = flags.positional[0];
  if (raw === undefined) fail('usage: npm run pages -- fetch <url> [--save <file>]');
  const result = await fetcher().read(raw);
  if (result.ok && flags.save !== null) writeFileSync(resolve(flags.save), result.page.bytes);
  out({
    ...describeRead(result),
    ...(result.ok && flags.save !== null ? { saved: resolve(flags.save) } : {}),
  });
  if (!result.ok) process.exitCode = 2;
}

interface Loaded {
  /** What the reader is told the bytes are called: the last piece of the address. */
  readonly name: string;
  readonly host: string;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
  readonly fetchedAt: Date;
  readonly read: Record<string, unknown> | null;
}

/** Bytes to read: a file saved earlier, or an address fetched now. */
async function load(target: string, flags: Flags): Promise<Loaded> {
  if (existsSync(resolve(target))) {
    const path = resolve(target);
    return {
      name: basename(path),
      host: flags.host ?? 'a saved file',
      contentType: flags.type,
      bytes: new Uint8Array(readFileSync(path)),
      fetchedAt: new Date(),
      read: null,
    };
  }
  const result = await fetcher().read(target);
  if (!result.ok) {
    out({ read: false, ...describeRead(result) });
    process.exit(2);
  }
  const last = result.page.final.pathAndQuery.split('?')[0]?.split('/').filter(Boolean).pop();
  return {
    name: last ?? '',
    host: result.page.final.host,
    contentType: result.page.contentType,
    bytes: result.page.bytes,
    fetchedAt: new Date(),
    read: describeRead(result),
  };
}

async function readLoaded(loaded: Loaded): Promise<{ extraction: Extraction; ms: number }> {
  const started = performance.now();
  const extraction = await extractFile(
    { name: loaded.name, bytes: loaded.bytes, fromLink: true, contentType: loaded.contentType },
    nodeEngines(),
  );
  return { extraction, ms: Math.round(performance.now() - started) };
}

const countMissing = (text: string): number => text.split(NOT_LOADED_MARK).length - 1;

async function extract(flags: Flags): Promise<void> {
  const target = flags.positional[0];
  if (target === undefined) {
    fail('usage: npm run pages -- extract <file|url> [--type <content-type>] [--host <host>]');
  }
  const loaded = await load(target, flags);
  const { extraction, ms } = await readLoaded(loaded);
  const head = {
    host: loaded.host,
    bytes: loaded.bytes.byteLength,
    contentType: loaded.contentType,
    readerMs: ms,
    ...(loaded.read === null ? {} : { fetch: loaded.read }),
  };
  if (!extraction.ok) {
    out({ ...head, read: false, kind: extraction.kind, refusal: extraction.refusal });
    return;
  }
  const text = extraction.pages.map((page) => page.text).join('\n');
  out({
    ...head,
    read: true,
    kind: extraction.kind,
    // As it is shown: a stranger's words, cleaned, never trusted.
    title:
      extraction.kind === 'html'
        ? sanitiseTitle(extraction.title, loaded.host)
        : sanitiseFileName(loaded.name),
    parts: extraction.pages.length,
    chars: text.length,
    valuesMissing: countMissing(text),
    pagesToReadAsImages: extraction.vision.map((page) => page.label),
    notes: extraction.notes,
    pages: extraction.pages.map((page) => ({
      label: page.label,
      method: page.method,
      chars: page.text.length,
      text: page.text,
    })),
  });
  extraction.dispose();
}

function claudeWithLedger(): { claude: ClaudeClient; rows: UsageRecord[] } {
  const config = loadLlmConfig(process.env);
  if (!config.ok) fail(`${config.error.code}: ${config.error.message}`);
  const rows: UsageRecord[] = [];
  const claude = createClaudeClient({
    config: config.value,
    http: createHttpClient({ timeoutMs: config.value.timeoutMs, retries: 0, logger }),
    usage: {
      spentSince: (): Promise<Result<number>> =>
        Promise.resolve(ok(rows.reduce((sum, r) => sum + r.costUsd, 0))),
      record: (row): Promise<Result<void>> => {
        rows.push(row);
        return Promise.resolve(ok(undefined));
      },
    },
    log: logger,
  });
  return { claude, rows };
}

async function ask(flags: Flags): Promise<void> {
  const [target, question] = flags.positional;
  if (target === undefined || question === undefined || question.trim() === '') {
    fail('usage: npm run pages -- ask <file|url> "<question>" [--host <host>] [--times N]');
  }
  const config = loadFilesConfig(process.env);
  if (!config.ok) fail(`${config.error.code}: ${config.error.message}`);
  const loaded = await load(target, flags);
  const { extraction } = await readLoaded(loaded);
  if (!extraction.ok) fail(`not read: ${extraction.refusal.message}`);
  if (extraction.vision.length > 0) {
    extraction.dispose();
    // A scan or a picture at a link takes part 1's pages-and-cost path, which draws pages.
    fail(`${refusal('unsupported').message} (this is a scan or a picture: use "npm run files")`);
  }
  const name =
    extraction.kind === 'html'
      ? sanitiseTitle(extraction.title, loaded.host)
      : sanitiseFileName(loaded.name);
  const base = toTurnFile(
    { name, kind: extraction.kind, pages: extraction.pages, vision: extraction.vision },
    [],
  );
  extraction.dispose();
  if (base === null) fail('the page could not be prepared');
  const text = base.pages.map((page) => page.content).join('\n');
  const file: TurnFile = {
    ...base,
    // toTurnFile cleans the name as a FILE name; a page keeps its title as cleaned above.
    name,
    source: {
      host: loaded.host,
      fetchedAt: loaded.fetchedAt.toISOString(),
      valuesMissing: countMissing(text),
      readAsSent: text.includes(READ_AS_SENT_MARK),
    },
  };
  const rules = rulesFor(true, true, new Date()) ?? '';
  const built = probeRequest(file, question, config.value.contextMaxChars, rules);
  const { claude } = claudeWithLedger();
  const turns = [];
  for (let i = 0; i < flags.times; i += 1) {
    const started = performance.now();
    const completion = await claude.complete(built.request);
    if (!completion.ok) fail(`${completion.error.code}: ${completion.error.message}`);
    turns.push({
      ms: Math.round(performance.now() - started),
      model: completion.value.model,
      stopReason: completion.value.stopReason,
      usage: completion.value.usage,
      costUsd: completion.value.costUsd,
      reply: completion.value.text,
    });
  }
  out({
    page: file.name,
    host: loaded.host,
    kind: file.kind,
    parts: file.pages.length,
    pageChars: text.length,
    valuesMissing: file.source?.valuesMissing ?? 0,
    sentChars: built.block?.length ?? 0,
    budgetChars: config.value.contextMaxChars,
    question,
    turns,
  });
}

async function unread(flags: Flags): Promise<void> {
  const message = flags.positional[0];
  if (message === undefined || message.trim() === '') {
    fail('usage: npm run pages -- unread "<message with a link>"');
  }
  // Exactly what chat.ts composes for a turn with no documents: the link rule, or nothing.
  const rules = turnRules({ message, history: [], documents: null });
  if (rules === undefined) fail('that message has no link in it, so a turn would add no rule');
  const { claude } = claudeWithLedger();
  const started = performance.now();
  const completion = await claude.complete({
    route: 'default',
    system: buildSystemBlocks(undefined, rules),
    messages: [{ role: 'user', content: message }],
    operation: PROBE_OPERATION,
    userId: null,
    conversationId: null,
  });
  if (!completion.ok) fail(`${completion.error.code}: ${completion.error.message}`);
  out({
    message,
    pagesGiven: 0,
    ms: Math.round(performance.now() - started),
    model: completion.value.model,
    usage: completion.value.usage,
    costUsd: completion.value.costUsd,
    reply: completion.value.text,
  });
}

async function main(): Promise<void> {
  loadEnv();
  const [mode, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (mode) {
    case 'check':
      await check(flags.positional[0]);
      return;
    case 'fetch':
      await fetchOne(flags);
      return;
    case 'extract':
      await extract(flags);
      return;
    case 'ask':
      await ask(flags);
      return;
    case 'unread':
      await unread(flags);
      return;
    case undefined:
    default:
      fail(
        'usage: npm run pages -- check <url> | fetch <url> | extract <file|url> | ask <file|url> "<q>" | unread "<message with a link>"',
      );
  }
}

main().catch((caught: unknown) => {
  // The name only: a thrown error's message can carry what was being read.
  fail(caught instanceof Error ? caught.name : 'unexpected failure');
});
