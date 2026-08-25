/**
 * Voice conformance runner (Stage 2 part 5).
 *
 *   npm run voice                       check the recorded fixtures (what CI does; no network)
 *   npm run voice -- check              same
 *   npm run voice -- record             re-record EVERY fixture from the live model, then check
 *   npm run voice -- record --out DIR   record into DIR instead of the committed fixtures
 *   npm run voice -- record --only ID   record one prompt (repeatable)
 *   npm run voice -- live "<brief>"     one ad-hoc generation, printed with usage and cost
 *
 * Live modes talk to Claude through src/lib/llm/client.ts — the same cap, pricing, retry and
 * parsing code as the chat path — with an in-memory usage ledger, so a recording run can
 * never exceed the env caps and needs no database. Credentials come from the environment
 * (.env is loaded if present): ANTHROPIC_API_KEY and both caps, exactly as for the app.
 *
 * Nothing here decides anything: the prompt is src/lib/voice/prompt.ts and the checks are
 * src/lib/voice/conformance.ts, both unit-tested. This file reads files and prints.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ok, type Result } from '../src/lib/errors.js';
import { createHttpClient } from '../src/lib/http.js';
import { createClaudeClient, type ClaudeClient, type UsageRecord } from '../src/lib/llm/client.js';
import { loadLlmConfig } from '../src/lib/llm/config.js';
import { runChecks, type CheckResult, type VoicePrompt } from '../src/lib/voice/conformance.js';
import {
  parsePromptFile,
  parseRecordedResponse,
  type RecordedResponse,
} from '../src/lib/voice/fixtures.js';
import {
  VOICE_PROMPT_VERSION,
  buildVoicePrefix,
  buildVoiceSystemBlocks,
  voicePromptHash,
} from '../src/lib/voice/prompt.js';
import { logger } from '../src/lib/logger.js';

const FIXTURES_DIR = resolve(import.meta.dirname, '..', 'tests', 'fixtures', 'voice');
const RESPONSES_DIR = join(FIXTURES_DIR, 'responses');

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`voice: ${message}\n`);
  process.exit(1);
}

interface Args {
  readonly mode: 'check' | 'record' | 'live';
  readonly outDir: string;
  readonly only: readonly string[];
  readonly brief: string;
}

function parseArgs(argv: readonly string[]): Args {
  let mode: Args['mode'] = 'check';
  let outDir = RESPONSES_DIR;
  const only: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'check' || arg === 'record' || arg === 'live') {
      mode = arg;
    } else if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined) fail('--out needs a directory');
      outDir = resolve(next);
      i += 1;
    } else if (arg === '--only') {
      const next = argv[i + 1];
      if (next === undefined) fail('--only needs a prompt id');
      only.push(next);
      i += 1;
    } else if (arg !== undefined) {
      rest.push(arg);
    }
  }
  const brief = rest.join(' ').trim();
  if (mode === 'live' && brief === '') fail('usage: npm run voice -- live "<brief>"');
  return { mode, outDir, only, brief };
}

function loadPrompts(): readonly VoicePrompt[] {
  const raw: unknown = JSON.parse(readFileSync(join(FIXTURES_DIR, 'prompts.json'), 'utf8'));
  const parsed = parsePromptFile(raw);
  if (!parsed.ok) fail(`${parsed.error.message}: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.value;
}

function loadResponses(dir: string): Map<string, RecordedResponse> {
  const responses = new Map<string, RecordedResponse>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return responses;
  }
  for (const file of files) {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const parsed = parseRecordedResponse(raw);
    if (!parsed.ok) fail(`${file}: ${parsed.error.message}`);
    responses.set(parsed.value.promptId, parsed.value);
  }
  return responses;
}

function report(
  prompts: readonly VoicePrompt[],
  responses: ReadonlyMap<string, RecordedResponse>,
): boolean {
  const hash = voicePromptHash();
  let failures = 0;
  let checks = 0;
  for (const prompt of prompts) {
    const response = responses.get(prompt.id);
    out(`\n[${prompt.id}] (${prompt.format})`);
    if (response === undefined) {
      failures += 1;
      out('  MISSING  no recorded response');
      continue;
    }
    if (response.promptHash !== hash) {
      failures += 1;
      out(
        `  STALE    recorded against v${response.promptVersion} (${response.promptHash}); current v${VOICE_PROMPT_VERSION} (${hash})`,
      );
    }
    const results: readonly CheckResult[] = runChecks(prompt, response.text);
    for (const r of results) {
      checks += 1;
      if (!r.pass) failures += 1;
      out(`  ${r.pass ? 'PASS' : 'FAIL'}     ${r.id.padEnd(24)} ${r.detail}`);
    }
  }
  out(
    `\n${prompts.length} prompts · ${checks} checks · ${failures} failing · prompt v${VOICE_PROMPT_VERSION} (${hash})`,
  );
  return failures === 0;
}

interface Ledger {
  readonly rows: UsageRecord[];
  spentSince(): Promise<Result<number>>;
  record(row: UsageRecord): Promise<Result<void>>;
}

/** In-memory api_usage: the cap is enforced across this run, and nothing touches a database. */
function memoryLedger(): Ledger {
  const rows: UsageRecord[] = [];
  return {
    rows,
    spentSince: () => Promise.resolve(ok(rows.reduce((sum, r) => sum + r.costUsd, 0))),
    record: (row) => {
      rows.push(row);
      return Promise.resolve(ok(undefined));
    },
  };
}

function liveClient(): { client: ClaudeClient; ledger: Ledger } {
  try {
    process.loadEnvFile();
  } catch {
    // No .env — rely on the real environment.
  }
  const config = loadLlmConfig(process.env);
  if (!config.ok) fail(`${config.error.code}: ${config.error.message}`);
  const ledger = memoryLedger();
  const http = createHttpClient({ timeoutMs: config.value.timeoutMs, retries: 0, logger: logger });
  const client = createClaudeClient({
    config: config.value,
    http,
    usage: { spentSince: () => ledger.spentSince(), record: (row) => ledger.record(row) },
    log: logger,
  });
  return { client, ledger };
}

async function generate(
  client: ClaudeClient,
  prompt: VoicePrompt,
  now: () => string,
): Promise<RecordedResponse> {
  const completion = await client.complete({
    route: 'default',
    system: buildVoiceSystemBlocks(),
    messages: [{ role: 'user', content: prompt.message }],
    operation: 'voice.record',
    userId: null,
    conversationId: null,
  });
  if (!completion.ok) fail(`[${prompt.id}] ${completion.error.code}: ${completion.error.message}`);
  const c = completion.value;
  return {
    promptId: prompt.id,
    promptVersion: VOICE_PROMPT_VERSION,
    promptHash: voicePromptHash(),
    model: c.model,
    requestId: c.requestId,
    recordedAt: now(),
    stopReason: c.stopReason,
    usage: c.usage,
    costUsd: c.costUsd,
    text: c.text,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prompts = loadPrompts();
  const now = (): string => new Date().toISOString();

  if (args.mode === 'check') {
    const responses = loadResponses(args.outDir);
    process.exit(report(prompts, responses) ? 0 : 2);
  }

  if (args.mode === 'live') {
    const { client, ledger } = liveClient();
    const prompt: VoicePrompt = { id: 'live', format: 'chat', message: args.brief, checks: [] };
    const response = await generate(client, prompt, now);
    out(
      `--- prompt v${VOICE_PROMPT_VERSION} (${voicePromptHash()}) · prefix ${buildVoicePrefix().length} chars`,
    );
    out(`--- model ${response.model} · request ${response.requestId ?? 'n/a'}`);
    out('');
    out(response.text);
    out('');
    out(
      `--- usage in=${response.usage.inputTokens} out=${response.usage.outputTokens} cacheRead=${response.usage.cacheReadTokens} cacheWrite=${response.usage.cacheWriteTokens} · cost $${response.costUsd.toFixed(6)} · run total $${ledger.rows.reduce((s, r) => s + r.costUsd, 0).toFixed(6)}`,
    );
    process.exit(0);
  }

  // record
  const selected =
    args.only.length === 0 ? prompts : prompts.filter((p) => args.only.includes(p.id));
  if (selected.length === 0) fail('no prompt matched --only');
  mkdirSync(args.outDir, { recursive: true });
  const { client, ledger } = liveClient();
  const responses = loadResponses(args.outDir);
  for (const prompt of selected) {
    const response = await generate(client, prompt, now);
    writeFileSync(join(args.outDir, `${prompt.id}.json`), `${JSON.stringify(response, null, 2)}\n`);
    responses.set(prompt.id, response);
    out(
      `recorded ${prompt.id.padEnd(40)} in=${response.usage.inputTokens} out=${response.usage.outputTokens} cacheRead=${response.usage.cacheReadTokens} cacheWrite=${response.usage.cacheWriteTokens} $${response.costUsd.toFixed(6)}`,
    );
  }
  const total = ledger.rows.reduce((s, r) => s + r.costUsd, 0);
  out(`\nrun cost $${total.toFixed(6)} over ${ledger.rows.length} call(s) → ${args.outDir}`);
  process.exit(report(prompts, responses) ? 0 : 2);
}

main().catch((caught: unknown) => {
  fail(caught instanceof Error ? caught.message : String(caught));
});
