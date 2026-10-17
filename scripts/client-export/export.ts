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
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assess,
  parseState,
  remember,
  type ClientCommit,
  type ClientSide,
  type GuardState,
} from './guard.js';
import { dropTest, scrubFixtureDescription, scrubReferences } from './scrub.js';
import { stripForPath } from './strip.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HERE = 'scripts/client-export/';
/** Which client trees this tool wrote or a person accepted. Gitignored; never exported. */
const STATE_FILE = join(REPO_ROOT, HERE, '.state.json');
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

function loadState(): GuardState {
  return parseState(existsSync(STATE_FILE) ? readFileSync(STATE_FILE, 'utf8') : null);
}

function saveState(state: GuardState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

/** The tree `git add -A` would commit in the clone, through a throwaway index. */
function treeOfFiles(target: string): string {
  const index = join(mkdtempSync(join(tmpdir(), 'client-guard-')), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    run('git', ['add', '-A'], { cwd: target, env });
    return run('git', ['write-tree'], { cwd: target, env });
  } finally {
    rmSync(dirname(index), { recursive: true, force: true });
  }
}

function clientSide(target: string): ClientSide {
  run('git', ['fetch', '--quiet', 'origin'], { cwd: target });
  const log = run('git', ['log', '-n', '200', '--format=%H %T %an%x09%s', 'origin/main', 'HEAD'], {
    cwd: target,
  });
  const commits: ClientCommit[] = log
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [ids = '', subject = ''] = line.split('\t');
      const [sha = '', tree = '', ...author] = ids.split(' ');
      return { sha, tree, author: author.join(' '), subject };
    });
  return {
    remoteTree: run('git', ['rev-parse', 'origin/main^{tree}'], { cwd: target }),
    headTree: run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: target }),
    workTree: treeOfFiles(target),
    commits,
  };
}

/** Files the foreign commits touched, for the post-sync check that the fix survived. */
function foreignFiles(target: string, base: string | null): string[] {
  if (base === null) return [];
  const names = run('git', ['diff', '--name-only', base, 'origin/main'], { cwd: target });
  return names.split('\n').filter((n) => n !== '');
}

/**
 * Refuse to overwrite work that only exists on the client side. Returns the files a person
 * accepted (to re-check after the sync), or null when the export must stop.
 */
function guard(
  target: string,
  head: string,
  accept: boolean,
  dryRun: boolean,
): { state: GuardState; accepted: string[] } | null {
  let state = loadState();
  const side = clientSide(target);
  const verdict = assess(state, side);
  if (verdict.kind === 'clean') return { state, accepted: [] };
  if (verdict.kind === 'bootstrap') {
    out(
      `guard: first run — taking GitHub's current tree ${verdict.tree.slice(0, 12)} as the baseline`,
    );
    state = remember(state, [verdict.tree], 'bootstrap', head, new Date());
    if (!dryRun) saveState(state);
    return { state, accepted: [] };
  }

  out(`\nGUARD: the client side holds work this tool did not write (${verdict.where.join(', ')}).`);
  for (const c of verdict.foreign) {
    out(`  ${c.sha.slice(0, 8)}  ${c.author}  ${c.subject}`);
  }
  if (verdict.where.includes('github') && verdict.base !== null) {
    out(`  on GitHub, changed since ${verdict.base.slice(0, 8)}:`);
    const stat = run('git', ['diff', '--stat', verdict.base, 'origin/main'], { cwd: target });
    for (const line of stat.split('\n')) out(`    ${line}`);
  } else if (verdict.where.includes('github')) {
    out('  no commit on that history matches an export — was it rewritten?');
  }
  if (verdict.where.includes('clone HEAD')) {
    const ahead = run('git', ['log', '--oneline', 'origin/main..HEAD'], { cwd: target });
    out('  committed in the clone, not on GitHub:');
    for (const line of ahead.split('\n').filter((l) => l !== '')) out(`    ${line}`);
  }
  if (verdict.where.includes('clone files')) {
    const status = run('git', ['status', '--short'], { cwd: target });
    out('  edited in the clone, not committed:');
    for (const line of status.split('\n').slice(0, 30)) out(`    ${line}`);
  }
  if (!accept) {
    out('\nExport refused: it would overwrite that work. Port the change into THIS repository');
    out('(with its test), commit it, then run again with --accept-remote.');
    return null;
  }
  const files = foreignFiles(target, verdict.base);
  out(
    `\nguard: accepted by --accept-remote; ${String(files.length)} file(s) re-checked after the sync`,
  );
  state = remember(
    state,
    [side.remoteTree, side.headTree, side.workTree],
    'accepted',
    head,
    new Date(),
  );
  if (!dryRun) saveState(state);
  return { state, accepted: files };
}

function main(): number {
  const args = process.argv.slice(2);
  const toIndex = args.indexOf('--to');
  const toArg = toIndex === -1 ? undefined : args[toIndex + 1];
  if (toArg === undefined) {
    out(
      'usage: tsx scripts/client-export/export.ts --to <client clone> ' +
        '[--verify] [--dry-run] [--accept-remote]',
    );
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
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT });
  const guarded = guard(target, head, args.includes('--accept-remote'), dryRun);
  if (guarded === null) return 1;

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
  saveState(remember(guarded.state, [treeOfFiles(target)], 'export', head, new Date()));
  if (guarded.accepted.length > 0) {
    const changed = run('git', ['diff', '--name-only', 'origin/main', '--', ...guarded.accepted], {
      cwd: target,
    });
    if (changed !== '') {
      out('\nCHECK: these files of the accepted change differ after the export — confirm the');
      out(`fix is in this repository (git -C ${target} diff origin/main -- <file>):`);
      for (const f of changed.split('\n')) out(`  ${f}`);
    }
  }
  out(
    `\nsynced into ${target} — review with \`git -C ${target} status\`; nothing committed or pushed`,
  );
  if (args.includes('--verify') && !verify(target)) return 1;
  return 0;
}

process.exitCode = main();
