/**
 * Static secret scan for client-shippable code (Part C item 5, and the SECURITY.md §2
 * Stage 2 check for T11/R18). Runs everywhere — no Supabase stack needed.
 *
 * Scans every file that could end up in front of a client — src/, scripts/, and any build
 * output directory that exists (dist/, build/, public/) — for:
 *
 *   - an embedded three-segment JWT (the shape of Supabase service_role and anon keys);
 *   - an Anthropic key prefix (the exact failure mode of the client's old prototype, R18);
 *   - the LIVE service role key value from the environment, when one is set, across every
 *     git-tracked file — belt and braces over the pattern check.
 *
 * The .env file is excluded by design: it is gitignored, server-side, and is exactly where
 * the keys are SUPPOSED to live. When Part 6 produces a real client bundle, its output
 * directory lands in SCAN_ROOTS automatically if named dist/build/public — re-check then.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SCAN_ROOTS = ['src', 'scripts', 'supabase/functions', 'dist', 'build', 'public'].filter(
  (dir) => existsSync(join(REPO_ROOT, dir)),
);

// Three real base64url segments — matches actual JWTs, not regex sources that mention eyJ.
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/;
const ANTHROPIC_PATTERN = /sk-ant-[A-Za-z0-9_-]{8,}/;

function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const full = join(root, entry);
    if (statSync(full).isFile()) {
      out.push(full);
    }
  }
  return out;
}

describe('no secret material in client-shippable code', () => {
  const files = SCAN_ROOTS.flatMap((dir) => listFiles(join(REPO_ROOT, dir)));

  it('scans a non-trivial file set (a vacuous pass is a failure)', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it('no embedded JWT (Supabase key shape) and no Anthropic key prefix in any scanned file', () => {
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(JWT_PATTERN.test(content), `JWT-shaped string in ${file}`).toBe(false);
      expect(ANTHROPIC_PATTERN.test(content), `Anthropic key prefix in ${file}`).toBe(false);
    }
  });

  it('the live service role key value appears in no git-tracked file', function liveKeyScan() {
    const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
    if (key === undefined || key.trim() === '') {
      // Nothing to scan for on a machine with no key configured; the pattern check above
      // still holds, and CI (which always has the local stack key) runs this branch.
      return;
    }
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT })
      .toString('utf8')
      .split('\0')
      .filter((f) => f !== '');
    expect(tracked.length).toBeGreaterThan(20);
    for (const file of tracked) {
      const full = join(REPO_ROOT, file);
      if (!existsSync(full)) continue;
      const content = readFileSync(full, 'utf8');
      expect(content.includes(key), `service role key value found in ${file}`).toBe(false);
    }
  });
});

/**
 * Stage 2 part 4 (task 2.4.3, R18): the Anthropic key is read from the server environment
 * by exactly one module, and the Anthropic origin is named in exactly one module. Anything
 * else touching either is a second key path that a future client bundle could pull in.
 */
describe('the Anthropic key has exactly one reader', () => {
  const srcFiles = listFiles(join(REPO_ROOT, 'src')).map((f) => f.split(sep).join('/'));

  it('ANTHROPIC_API_KEY is referenced only by src/lib/llm/config.ts', () => {
    const readers = srcFiles.filter((f) => readFileSync(f, 'utf8').includes('ANTHROPIC_API_KEY'));
    expect(readers.map((f) => f.slice(f.indexOf('src/')))).toEqual(['src/lib/llm/config.ts']);
  });

  it('api.anthropic.com is named only by src/lib/llm/config.ts', () => {
    const callers = srcFiles.filter((f) => readFileSync(f, 'utf8').includes('api.anthropic.com'));
    expect(callers.map((f) => f.slice(f.indexOf('src/')))).toEqual(['src/lib/llm/config.ts']);
  });

  it('no module outside src/lib/llm reads x-api-key or builds an Anthropic header', () => {
    const offenders = srcFiles.filter(
      (f) => !f.includes('src/lib/llm/') && readFileSync(f, 'utf8').includes("'x-api-key':"),
    );
    expect(offenders).toEqual([]);
  });
});
