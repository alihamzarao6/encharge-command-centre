/**
 * File-reading runner (Milestone 5 part 1).
 *
 *   npm run files -- extract <file>            read a file with the app's own readers and print
 *                                              what came out — the kind, each page's text, the
 *                                              notes, or the sentence it was refused with. No
 *                                              network and no database: the way to answer "what
 *                                              did the assistant actually get out of this?"
 *   npm run files -- read <page.jpg> [--route fast]
 *                                              LIVE. One page image → its transcription, with
 *                                              the legibility the model reported, the usage and
 *                                              the cost. The image must be a JPEG, as the browser
 *                                              sends one.
 *   npm run files -- ask <file> "<question>" [--page <transcript.txt>]… [--times N]
 *                                              LIVE. One answer from that file, through the same
 *                                              system prompt and wrapped-document message a chat
 *                                              turn sends. `--times 2` asks twice, which shows
 *                                              what a follow-up costs once the file is cached.
 *                                              A scanned page's text comes from `--page`, one
 *                                              per page, in order (produce it with `read`).
 *   npm run files -- record [--only ID]        LIVE. Re-record the prompt-injection probes into
 *                                              tests/fixtures/files/recorded/, then print each
 *                                              verdict. tests/unit/files/injection-live.test.ts
 *                                              holds the recordings to the same verdict in CI.
 *
 * Live modes talk to Claude through src/lib/llm/client.ts — the same cap, pricing, retry and
 * parsing code as the app — with an in-memory ledger, so a run can never exceed the env caps
 * and needs no database. Credentials come from the environment (.env is loaded if present).
 *
 * This prints the text of a file. That is its whole purpose, and it prints only to the
 * terminal of the person who supplied the file; nothing here writes it to a log. Do not run
 * it on a client's document on a machine whose terminal is recorded.
 *
 * Nothing here decides anything: the readers are web/src/lib/files, the request is
 * src/lib/files/probe.ts and the transcription is src/lib/files/vision.ts, all unit-tested.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { ok, type Result } from '../src/lib/errors.js';
import { loadFilesConfig } from '../src/lib/files/config.js';
import type { TurnFile } from '../src/lib/files/context.js';
import {
  INJECTION_PROBES,
  RECORDED_PROBE,
  judgeReply,
  probeRequest,
  requestFingerprintSource,
  toTurnFile,
  unprotectedRequest,
  type RecordedProbe,
} from '../src/lib/files/probe.js';
import { DOCUMENT_RULES_VERSION } from '../src/lib/files/rules.js';
import { sanitiseFileName } from '../src/lib/files/text.js';
import { transcribePage } from '../src/lib/files/vision.js';
import { createHttpClient } from '../src/lib/http.js';
import {
  createClaudeClient,
  type ClaudeClient,
  type CompletionRequest,
  type UsageRecord,
} from '../src/lib/llm/client.js';
import { loadLlmConfig } from '../src/lib/llm/config.js';
import { logger } from '../src/lib/logger.js';
import { extractFile } from '../web/src/lib/files/extract.js';
import type { ExtractEngines } from '../web/src/lib/files/types.js';

const FIXTURES_DIR = resolve(import.meta.dirname, '..', 'tests', 'fixtures', 'files');
const RECORDED_DIR = join(FIXTURES_DIR, 'recorded');
/** There is no user and no conversation in a terminal; the ledger here is in memory. */
const NOBODY = '00000000-0000-4000-8000-000000000000';

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`files: ${message}\n`);
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
 * The app's readers under Node. pdf.js is the same library the browser loads (its Node
 * build). What Node cannot do is draw: a photo or a scanned page is reported as a page to be
 * looked at, and is not rendered here — `read` takes the JPEG the browser would have sent.
 */
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

async function readWithApp(path: string): Promise<{
  readonly name: string;
  readonly bytes: number;
  readonly ms: number;
  readonly extraction: Awaited<ReturnType<typeof extractFile>>;
}> {
  const bytes = new Uint8Array(readFileSync(resolve(path)));
  const started = performance.now();
  const extraction = await extractFile({ name: basename(path), bytes }, nodeEngines());
  return {
    name: sanitiseFileName(basename(path)),
    bytes: bytes.byteLength,
    ms: Math.round(performance.now() - started),
    extraction,
  };
}

async function extract(path: string | undefined): Promise<void> {
  if (path === undefined) fail('usage: npm run files -- extract <file>');
  const read = await readWithApp(path);
  if (!read.extraction.ok) {
    out({
      file: read.name,
      bytes: read.bytes,
      ms: read.ms,
      read: false,
      kind: read.extraction.kind,
      refusal: read.extraction.refusal,
    });
    return;
  }
  const { extraction } = read;
  out({
    file: read.name,
    bytes: read.bytes,
    ms: read.ms,
    read: true,
    kind: extraction.kind,
    totalPages: extraction.totalPages,
    textPages: extraction.pages.length,
    chars: extraction.pages.reduce((sum, page) => sum + page.text.length, 0),
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

interface Flags {
  readonly positional: readonly string[];
  readonly pages: readonly string[];
  readonly only: readonly string[];
  readonly route: 'default' | 'fast';
  readonly times: number;
}

function parseFlags(argv: readonly string[]): Flags {
  const positional: string[] = [];
  const pages: string[] = [];
  const only: string[] = [];
  let route: Flags['route'] = 'default';
  let times = 1;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const value = argv[i + 1];
    if (arg === '--page' || arg === '--only' || arg === '--route' || arg === '--times') {
      if (value === undefined) fail(`${arg} needs a value`);
      i += 1;
      if (arg === '--page') pages.push(value);
      else if (arg === '--only') only.push(value);
      else if (arg === '--route') {
        if (value !== 'default' && value !== 'fast') fail('--route is default or fast');
        route = value;
      } else {
        times = Number(value);
        if (!Number.isInteger(times) || times < 1 || times > 5) fail('--times is 1 to 5');
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, pages, only, route, times };
}

async function readPage(flags: Flags): Promise<void> {
  const path = flags.positional[0];
  if (path === undefined) fail('usage: npm run files -- read <page.jpg> [--route fast]');
  const bytes = readFileSync(resolve(path));
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    fail('that is not a JPEG. Pass the page as the browser sends it: a JPEG.');
  }
  const config = loadFilesConfig(process.env);
  if (!config.ok) fail(`${config.error.code}: ${config.error.message}`);
  const { claude, rows } = claudeWithLedger();
  const started = performance.now();
  const result = await transcribePage(
    { claude, route: flags.route, maxTokens: config.value.visionMaxTokens, log: logger },
    { imageBase64: bytes.toString('base64'), userId: NOBODY, conversationId: NOBODY },
  );
  const ms = Math.round(performance.now() - started);
  if (!result.ok) fail(`${result.error.code}: ${result.error.message}`);
  out({
    file: basename(path),
    bytes: bytes.byteLength,
    ms,
    kind: result.value.kind,
    legibility: result.value.legibility,
    confidence: result.value.confidence,
    truncated: result.value.truncated,
    model: result.value.model,
    attempts: result.value.attempts,
    costUsd: result.value.costUsd,
    chars: result.value.text.length,
    text: result.value.text,
    ledger: rows.map((r) => ({
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
    })),
  });
}

async function loadTurnFile(path: string, transcriptPaths: readonly string[]): Promise<TurnFile> {
  const read = await readWithApp(path);
  if (!read.extraction.ok) fail(`not read: ${read.extraction.refusal.message}`);
  const transcripts = transcriptPaths.map((p) => readFileSync(resolve(p), 'utf8'));
  const { extraction } = read;
  const file = toTurnFile(
    { name: read.name, kind: extraction.kind, pages: extraction.pages, vision: extraction.vision },
    transcripts,
  );
  extraction.dispose();
  if (file === null) {
    fail(
      `this file has ${String(extraction.vision.length)} page(s) that must be read as images; ` +
        `${String(transcripts.length)} --page transcript(s) were given. Produce them with "read".`,
    );
  }
  return file;
}

async function complete(claude: ClaudeClient, request: CompletionRequest) {
  const result = await claude.complete(request);
  if (!result.ok) fail(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function ask(flags: Flags): Promise<void> {
  const [path, question] = flags.positional;
  if (path === undefined || question === undefined || question.trim() === '') {
    fail('usage: npm run files -- ask <file> "<question>" [--page <transcript.txt>]… [--times N]');
  }
  const config = loadFilesConfig(process.env);
  if (!config.ok) fail(`${config.error.code}: ${config.error.message}`);
  const file = await loadTurnFile(path, flags.pages);
  const built = probeRequest(file, question, config.value.contextMaxChars);
  const { claude } = claudeWithLedger();
  const turns = [];
  for (let i = 0; i < flags.times; i += 1) {
    const started = performance.now();
    const completion = await complete(claude, built.request);
    turns.push({
      ms: Math.round(performance.now() - started),
      model: completion.model,
      stopReason: completion.stopReason,
      usage: completion.usage,
      costUsd: completion.costUsd,
      reply: completion.text,
    });
  }
  out({
    file: file.name,
    pages: file.pages.length,
    documentChars: file.pages.reduce((sum, page) => sum + page.content.length, 0),
    sentChars: built.block?.length ?? 0,
    budgetChars: config.value.contextMaxChars,
    question,
    turns,
  });
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function record(flags: Flags): Promise<void> {
  const probes = INJECTION_PROBES.filter(
    (probe) => flags.only.length === 0 || flags.only.includes(probe.id),
  );
  if (probes.length === 0)
    fail(`no probe matches. Known: ${INJECTION_PROBES.map((p) => p.id).join(', ')}`);
  mkdirSync(RECORDED_DIR, { recursive: true });
  const { claude, rows } = claudeWithLedger();
  const results = [];
  for (const probe of probes) {
    const file = await loadTurnFile(join(FIXTURES_DIR, probe.file), []);
    const requests: readonly (readonly [RecordedProbe['mode'], CompletionRequest])[] = [
      ['protected', probeRequest(file, probe.question).request],
      // The control: the same text with nothing around it, to see what the protections buy.
      ['unprotected', unprotectedRequest(file, probe.question)],
    ];
    for (const [mode, request] of requests) {
      const completion = await complete(claude, request);
      const recorded: RecordedProbe = RECORDED_PROBE.parse({
        id: probe.id,
        file: probe.file,
        question: probe.question,
        mode,
        recordedAt: new Date().toISOString(),
        model: completion.model,
        rulesVersion: DOCUMENT_RULES_VERSION,
        requestSha256: sha256(requestFingerprintSource(request)),
        reply: completion.text,
        stopReason: completion.stopReason,
        usage: completion.usage,
        costUsd: completion.costUsd,
      });
      writeFileSync(
        join(RECORDED_DIR, `${probe.id}.${mode}.json`),
        `${JSON.stringify(recorded, null, 2)}\n`,
      );
      results.push({
        id: probe.id,
        mode,
        verdict: judgeReply(completion.text, probe),
        usage: completion.usage,
        costUsd: completion.costUsd,
        reply: completion.text,
      });
    }
  }
  out({
    recorded: results,
    totalCostUsd: Number(rows.reduce((sum, r) => sum + r.costUsd, 0).toFixed(6)),
  });
}

async function main(): Promise<void> {
  loadEnv();
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (command) {
    case 'extract':
      await extract(flags.positional[0]);
      return;
    case 'read':
      await readPage(flags);
      return;
    case 'ask':
      await ask(flags);
      return;
    case 'record':
      await record(flags);
      return;
    case undefined:
    default:
      fail(
        'usage: npm run files -- extract <file> | read <page.jpg> [--route fast] | ask <file> "<question>" [--page <transcript.txt>]… [--times N] | record [--only ID]',
      );
  }
}

main().catch((caught: unknown) => {
  fail(caught instanceof Error ? caught.message : String(caught));
});
