/**
 * Stage 3 part 1 (FND-300): the Voyage key has exactly one reader and the Voyage origin
 * exactly one namer, the same rule tests/security/secrets.test.ts enforces for Anthropic.
 * Runs everywhere — no stack needed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const full = join(root, entry);
    if (statSync(full).isFile()) out.push(full);
  }
  return out;
}

describe('the Voyage key has exactly one reader', () => {
  const srcFiles = listFiles(join(REPO_ROOT, 'src')).map((f) => f.split(sep).join('/'));
  const webFiles = listFiles(join(REPO_ROOT, 'web', 'src')).map((f) => f.split(sep).join('/'));

  it('VOYAGE_API_KEY is referenced only by src/lib/memory/config.ts', () => {
    const readers = srcFiles.filter((f) => readFileSync(f, 'utf8').includes('VOYAGE_API_KEY'));
    expect(readers.map((f) => f.slice(f.indexOf('src/')))).toEqual(['src/lib/memory/config.ts']);
  });

  it('api.voyageai.com is named only by src/lib/memory/config.ts', () => {
    const callers = srcFiles.filter((f) => readFileSync(f, 'utf8').includes('api.voyageai.com'));
    expect(callers.map((f) => f.slice(f.indexOf('src/')))).toEqual(['src/lib/memory/config.ts']);
  });

  it('nothing under web/src mentions Voyage or the memory adapter', () => {
    const offenders = webFiles.filter((f) =>
      /voyage|VOYAGE|memory\/embed/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no real Voyage key shape appears in any scanned source or fixture', () => {
    const files = [
      ...srcFiles,
      ...listFiles(join(REPO_ROOT, 'scripts')),
      ...listFiles(join(REPO_ROOT, 'tests', 'fixtures')),
    ];
    // Real keys are long random strings; the unit-test fake carries the words "unittest"
    // and "not-a-real-key" and is excluded by construction.
    const real = /\bpa-(?!unittest)[A-Za-z0-9_-]{30,}\b/;
    const hits = files.filter((f) => real.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
