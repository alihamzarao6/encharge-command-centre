/**
 * Export the committed tree to the client's repository as a clean copy.
 *
 *   npx tsx scripts/client-export/export.ts --to ../ross-command-center [--verify]
 *
 * What goes is HEAD, never the working tree: no .env, no node_modules, nothing unfinished. The
 * internal material (planning docs, agent instructions, this tool) is left out, every comment is
 * removed by `strip.ts`, and a leak scan refuses the export if a planning reference, an assistant
 * trace or a secret shape is still present. The target's files are replaced; its `.git` is not
 * touched, and nothing is committed or pushed — that stays a person's decision.
 */
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dropTest, scrubFixtureDescription, scrubReferences } from './scrub.js';
import { stripForPath } from './strip.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HERE = 'scripts/client-export/';
const TARGET_REMOTE = /github\.com[/:]rossb96\/ross-command-center(?:\.git)?$/;

/** Internal material: never leaves this repository. */
const EXCLUDED: readonly RegExp[] = [
  /^docs\//,
  /^tasks\//,
  /^\.agents\//,
  /^\.claude\//,
  /^CLAUDE\.md$/,
  /^skills-lock\.json$/,
  /^README\.md$/,
  /^scripts\/client-export\//,
  /^tests\/unit\/scripts\/clientExport/,
  /__pycache__\//,
  /^tests\/fixtures\/files\/make_fixtures\.py$/,
  /^tests\/fixtures\/google\/README\.md$/,
];

/** Copied byte for byte: recorded inputs the tests compare exactly. */
const VERBATIM = 'tests/fixtures/';

/**
 * Tests that read this repository's internal docs or the comments the export removes (a
 * migration's "Reversible:" note, its numbered section headers). They keep running here.
 */
const DROPPED_TESTS: readonly (readonly [string, string])[] = [
  ['tests/unit/voice/prompt.test.ts', 'every rule id is in the traceability table'],
  ['tests/unit/memory/privacy.test.ts', 'carries its own reversal'],
  ['tests/unit/knowledge/plumbing.test.ts', 'the triggers inside `finish` and `remove`'],
];

/** Text the scrub may rewrite (code, SQL, CI, hooks) — never data files. */
const SCRUBBED = /\.(?:[cm]?[jt]sx?|sql|ya?ml|toml)$|(?:^|\/)pre-commit$/;

/** Lines in ignore files that only make sense with the internal material present. */
const INTERNAL_ENTRY = /(?:^|\/)(?:CLAUDE\.md|\.claude|\.agents|docs|tasks)(?:\/|\*|$)/;

/** Assistant traces and planning references. Any hit outside fixtures fails the export. */
const LEAKS: readonly (readonly [string, RegExp])[] = [
  [
    'assistant tooling',
    /claude code|claude\.md|claude\.ai\/code|\.claude\/|\.agents\/|skills-lock/i,
  ],
  ['attribution', /co-authored-by|noreply@anthropic|generated with/i],
  ['authorship tell', /\bvibe[- ]?cod|ai[- ]generated|as an ai\b/i],
  [
    'planning doc',
    /\b(?:MEMORY|PLAN|TASKS|SECURITY|RUNBOOK|TESTING|SCHEMA|VOICE)\.md\b|CLIENT-CONTEXT|PHASE-ACCEPTANCE|(?:^|[^/\w}.-]|\.\/)docs\//,
  ],
  ['decision / ticket id', /\bD(?:[4-9]|[1-9]\d{1,2})\b|\bFND-\d+\b/],
  ['delivery plan', /\bmilestone|\bstage[ -][1-6]\b|\breviewer\b/i],
];

/** A secret shape that says it is a stand-in is a test double, not a credential. */
const STAND_IN = /fake|placeholder|dummy|integration|unittest|0{8}/i;

const SECRETS: readonly (readonly [string, RegExp])[] = [
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['jwt', /eyJhbGciOi[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ['ghl token', /pit-[0-9a-f]{8}-[0-9a-f]{4}-/],
  ['google key', /AIza[0-9A-Za-z_-]{35}|GOCSPX-[0-9A-Za-z_-]{20,}/],
  ['voyage key', /\bpa-[A-Za-z0-9_-]{30,}/],
  ['supabase secret', /sb_secret_[A-Za-z0-9_-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** .env.example keeps its names and its tuning defaults; identifiers and credentials go blank. */
const BLANK_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|_ID|_IDS|_DB_[A-Z_]+|_DS_[A-Z_]+|_URL)$/;

interface Finding {
  readonly file: string;
  readonly kind: string;
  readonly line: number;
  readonly snippet: string;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function run(cmd: string, args: readonly string[], opts: ExecFileSyncOptions = {}): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    .toString()
    .trim();
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

function walk(dir: string, root: string = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full, root));
    else files.push(posix(relative(root, full)));
  }
  return files;
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/** HEAD into a fresh directory through a throwaway index — the real index is never touched. */
function checkoutHead(staging: string): string {
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT });
  const index = join(staging, '..', 'export.index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  run('git', ['read-tree', 'HEAD'], { cwd: REPO_ROOT, env });
  run('git', ['checkout-index', '--all', '--force', `--prefix=${posix(staging)}/`], {
    cwd: REPO_ROOT,
    env,
  });
  rmSync(index, { force: true });
  return sha;
}

function cleanEnvExample(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m === null) return line;
      const [, name = '', value = ''] = m;
      if (name === 'GHL_API_BASE' || name.endsWith('_API_BASE')) return line;
      return BLANK_ENV.test(name) && value !== '' ? `${name}=` : line;
    })
    .join('\n');
}

interface Transformed {
  readonly stripped: number;
  readonly removed: string[];
  /** Lines the reference scrub rewrote, before → after, for a person to read. */
  readonly scrubbed: string[];
}

function transform(staging: string): Transformed {
  const removed: string[] = [];
  const scrubbed: string[] = [];
  let stripped = 0;
  for (const file of walk(staging)) {
    const full = join(staging, file);
    if (EXCLUDED.some((re) => re.test(file))) {
      rmSync(full, { force: true });
      removed.push(file);
      continue;
    }
    const bytes = readFileSync(full);
    if (isBinary(bytes)) continue;
    const text = bytes.toString('utf8');
    if (file.startsWith(VERBATIM)) {
      if (file.endsWith('.json')) {
        const next = scrubFixtureDescription(text);
        if (next !== text) writeFileSync(full, next);
      }
      continue;
    }
    let next = stripForPath(file, text) ?? text;
    for (const [path, title] of DROPPED_TESTS) {
      if (path === file) next = dropTest(next, file, title);
    }
    if (SCRUBBED.test(file)) {
      const before = next.split('\n');
      next = scrubReferences(next);
      const after = next.split('\n');
      before.forEach((line, i) => {
        if (after[i] !== line)
          scrubbed.push(
            `${file}:${String(i + 1)}\n  - ${line.trim()}\n  + ${(after[i] ?? '').trim()}`,
          );
      });
    }
    const name = file.split('/').pop() ?? file;
    if (name === '.gitignore' || name === '.prettierignore') {
      next = next
        .split('\n')
        .filter((line) => !INTERNAL_ENTRY.test(line.trim()))
        .join('\n');
    }
    if (file === 'eslint.config.js') next = next.replace(/^\s*'\.agents\/\*\*',\n/m, '');
    if (file === '.env.example') next = cleanEnvExample(next);
    if (next !== text) {
      writeFileSync(full, next);
      stripped += 1;
    }
  }
  for (const dir of ['docs', 'tasks', '.agents', '.claude']) {
    rmSync(join(staging, dir), { recursive: true, force: true });
  }
  cpSync(join(REPO_ROOT, HERE, 'README.client.md'), join(staging, 'README.md'));
  return { stripped, removed, scrubbed };
}

function prettier(staging: string): void {
  const bin = join(REPO_ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
  run(process.execPath, [bin, '--write', '--log-level', 'warn', '.'], { cwd: staging });
}

function scan(staging: string): { leaks: Finding[]; fixtureLeaks: Finding[]; secrets: Finding[] } {
  const leaks: Finding[] = [];
  const fixtureLeaks: Finding[] = [];
  const secrets: Finding[] = [];
  for (const file of walk(staging)) {
    const bytes = readFileSync(join(staging, file));
    if (isBinary(bytes)) continue;
    const lines = bytes.toString('utf8').split('\n');
    lines.forEach((text, i) => {
      for (const [kind, re] of SECRETS) {
        const m = re.exec(text);
        if (m !== null && !STAND_IN.test(text) && !STAND_IN.test(m[0])) {
          secrets.push({ file, kind, line: i + 1, snippet: '(redacted)' });
        }
      }
      for (const [kind, re] of LEAKS) {
        const m = re.exec(text);
        if (m === null) continue;
        const at = Math.max(0, m.index - 50);
        const finding = { file, kind, line: i + 1, snippet: text.slice(at, m.index + 70).trim() };
        (file.startsWith(VERBATIM) ? fixtureLeaks : leaks).push(finding);
      }
    });
  }
  return { leaks, fixtureLeaks, secrets };
}

/** Replace the target's content with the staging tree; its .git, node_modules and .env stay. */
function sync(staging: string, target: string): void {
  const keep = new Set(['.git', 'node_modules', '.env', '.env.local', '.vercel']);
  for (const entry of readdirSync(target)) {
    if (!keep.has(entry)) rmSync(join(target, entry), { recursive: true, force: true });
  }
  cpSync(staging, target, { recursive: true });
}

function verify(target: string): boolean {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const env = {
    ...process.env,
    VITE_SUPABASE_URL: 'https://placeholder.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'placeholder-anon-key',
  };
  const steps: readonly (readonly string[])[] = [
    ['ci', '--no-audit', '--no-fund'],
    ['run', 'typecheck'],
    ['run', 'lint'],
    ['run', 'test:unit'],
    ['run', 'web:build'],
    ['run', 'web:check'],
    ['run', 'functions:bundle'],
  ];
  for (const step of steps) {
    out(`verify: npm ${step.join(' ')}`);
    try {
      execFileSync(npm, step, { cwd: target, env, stdio: 'inherit', shell: true });
    } catch {
      out(`verify: FAILED at npm ${step.join(' ')}`);
      return false;
    }
  }
  return true;
}

function report(title: string, findings: readonly Finding[], limit = 200): void {
  if (findings.length === 0) return;
  out(`\n${title}: ${String(findings.length)}`);
  for (const f of findings.slice(0, limit)) {
    out(`  ${f.file}:${String(f.line)} [${f.kind}] ${f.snippet}`);
  }
}

function main(): number {
  const args = process.argv.slice(2);
  const toIndex = args.indexOf('--to');
  const toArg = toIndex === -1 ? undefined : args[toIndex + 1];
  if (toArg === undefined) {
    out('usage: tsx scripts/client-export/export.ts --to <client clone> [--verify] [--dry-run]');
    return 2;
  }
  const target = resolve(toArg);
  const dryRun = args.includes('--dry-run');
  if (!existsSync(join(target, '.git'))) {
    out(`refusing: ${target} is not a git checkout`);
    return 2;
  }
  const remote = run('git', ['remote', 'get-url', 'origin'], { cwd: target });
  if (!TARGET_REMOTE.test(remote)) {
    out(`refusing: ${target} points at ${remote}, not the client repository`);
    return 2;
  }
  if (run('git', ['status', '--porcelain'], { cwd: REPO_ROOT }) !== '') {
    out('note: this repository has uncommitted changes — they are NOT exported (HEAD only)');
  }

  const staging = join(mkdtempSync(join(tmpdir(), 'client-export-')), 'tree');
  const sha = checkoutHead(staging);
  const { stripped, removed, scrubbed } = transform(staging);
  prettier(staging);
  const { leaks, fixtureLeaks, secrets } = scan(staging);
  const scrubLog = join(staging, '..', 'scrubbed.txt');
  writeFileSync(scrubLog, `${scrubbed.join('\n')}\n`);

  out(`exported ${sha.slice(0, 12)} → ${staging}`);
  out(
    `files: ${String(walk(staging).length)}, comments stripped in ${String(stripped)}, ` +
      `left out ${String(removed.length)}, string lines rewritten ${String(scrubbed.length)} (${scrubLog})`,
  );
  report('SECRET SHAPES (export refused)', secrets);
  report('LEAKS (export refused)', leaks);
  report('IN FIXTURES (export refused)', fixtureLeaks);
  if (secrets.length > 0 || leaks.length > 0 || fixtureLeaks.length > 0) return 1;
  if (dryRun) {
    out('\ndry run: target untouched');
    return 0;
  }

  sync(staging, target);
  rmSync(join(staging, '..'), { recursive: true, force: true });
  out(
    `\nsynced into ${target} — review with \`git -C ${target} status\`; nothing committed or pushed`,
  );
  if (args.includes('--verify') && !verify(target)) return 1;
  return 0;
}

process.exitCode = main();
