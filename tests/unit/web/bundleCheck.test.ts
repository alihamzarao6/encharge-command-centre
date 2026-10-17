/**
 * The bundle guard's one pure predicate (`scripts/check-bundle.ts`).
 *
 * `npm run web:build` forces NODE_ENV=production (`scripts/build-web.ts`) so a development
 * bundle cannot be produced by accident; this is the second layer, which says it did not
 * happen rather than assuming it. It exists because the repo's `.env` sets
 * NODE_ENV=development for the server side, `web/vite.config.ts` reads that same file on
 * purpose, and the result was a 654 kB bundle instead of 443 kB on a developer machine —
 * 48 % more to download on the phone the client actually uses.
 *
 * The markers are React 19's development-only warning strings, measured on this project on
 * 27 Aug 2026: 1–5 occurrences each in a development bundle, zero in a production one.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { devBuildMarkers, scan } from '../../../scripts/check-bundle.js';

describe('devBuildMarkers', () => {
  it('finds nothing in text that carries no React development machinery', () => {
    expect(devBuildMarkers('function App(){return null}')).toStrictEqual([]);
    expect(devBuildMarkers('')).toStrictEqual([]);
    // The production build checks for the devtools hook too — that is not a dev signal.
    expect(devBuildMarkers('__REACT_DEVTOOLS_GLOBAL_HOOK__')).toStrictEqual([]);
  });

  it('names every development-only string it finds, so the failure says what is wrong', () => {
    const bundle =
      'was not wrapped in act(...) ... Should not already be working. ...' +
      ' Each child in a list should have a unique "key" prop.';
    expect(devBuildMarkers(bundle)).toStrictEqual([
      'act(...)',
      'Should not already be working',
      'Each child in a list should have a unique',
    ]);
  });

  it('one marker is enough — a partial dev build is still a dev build', () => {
    expect(devBuildMarkers('something something act(...) something')).toStrictEqual(['act(...)']);
  });
});

/**
 * Milestone 4 (PHASE-ACCEPTANCE item 4): the GoHighLevel token must never reach the bundle.
 * The shape check catches a `pit-<uuid>` from any variable; the value check catches the
 * one in the build environment, whatever it looks like. Built by concatenation so the secret
 * scanners read no token-shaped literal here.
 */
describe('scan — the GoHighLevel token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-check-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const tokenLike = ['pit', '12345678', '1234', '4234', '8234', '123456789abc'].join('-');

  it('flags a token-shaped string wherever it came from, and the environment value by name', () => {
    const file = join(dir, 'leaky.js');
    writeFileSync(file, `const a="${tokenLike}";const b="ghl-token-value-that-is-long";`);
    const findings = scan([file], {
      GHL_PRIVATE_INTEGRATION_TOKEN: 'ghl-token-value-that-is-long',
    });
    expect(findings.map((f) => f.check)).toEqual([
      'ghl-token-shape',
      'value:GHL_PRIVATE_INTEGRATION_TOKEN',
    ]);
    expect(findings[0]?.snippet).toBe('pit-12345678…');
    expect(findings[1]?.snippet).toBe('[redacted]');
  });

  it('a clean bundle produces no finding, and a short environment value is not matched blindly', () => {
    const file = join(dir, 'clean.js');
    writeFileSync(file, 'const pit = "pit-stop"; const x = 1;');
    expect(scan([file], { GHL_PRIVATE_INTEGRATION_TOKEN: 'pit' })).toEqual([]);
  });
});

/**
 * Milestone 5 part 3a (PHASE-ACCEPTANCE M5 part 3a, D4): no Google token, client secret or the
 * key that opens the sealed tokens ever reaches the bundle. The shapes catch any of Google's
 * tokens from anywhere; the values catch the two Drive secrets in the build environment by
 * name. Built by concatenation so no token-shaped literal sits in this file.
 */
describe('scan — Google Drive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-check-drive-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const accessToken = ['ya', '29.', 'a0AfB_byC', 'Q'.repeat(40)].join('');
  const refreshToken = ['1', '//', '0g', 'R'.repeat(40)].join('');
  const clientSecret = ['GOCSPX', '-', 'S'.repeat(28)].join('');
  const apiKey = ['AI', 'za', 'Sy', 'K'.repeat(33)].join('');

  it.each([
    ['google-access-token-shape', accessToken],
    ['google-refresh-token-shape', refreshToken],
    ['google-client-secret-shape', clientSecret],
    ['google-api-key-shape', apiKey],
  ])('flags %s wherever it came from', (check, value) => {
    const file = join(dir, `${check}.js`);
    writeFileSync(file, `const t="${value}";`);
    const findings = scan([file], {});
    expect(findings.map((f) => f.check)).toEqual([check]);
    expect(findings[0]?.snippet.length).toBeLessThanOrEqual(13);
  });

  it('flags the Drive client secret and the sealing key from the environment, by name', () => {
    const file = join(dir, 'values.js');
    const sealKey = 'drive-token-key-value-long-enough';
    const secret = 'drive-client-secret-value-long';
    writeFileSync(file, `const a="${sealKey}";const b="${secret}";`);
    expect(
      scan([file], { DRIVE_TOKEN_KEY: sealKey, GOOGLE_DRIVE_CLIENT_SECRET: secret }).map(
        (f) => f.check,
      ),
    ).toEqual(['value:GOOGLE_DRIVE_CLIENT_SECRET', 'value:DRIVE_TOKEN_KEY']);
  });

  it('the public parts a page may hold — the client id, the scope, the Drive address — are not findings', () => {
    const file = join(dir, 'public.js');
    writeFileSync(
      file,
      'const s="https://www.googleapis.com/auth/drive.file";const u="https://drive.google.com/file/d/1abc/view";const id="123456789012-abc.apps.googleusercontent.com";',
    );
    expect(scan([file], {})).toEqual([]);
  });
});

/**
 * Milestone 5 part 4 (Part D item 13): a connector key never reaches the browser bundle. The page
 * receives one key in one reply at run time and shows it once; nothing may compile one in — a
 * fixture imported by web code, a key pasted into a constant. The guard finds the exact shape
 * keys.ts mints, wherever it sits in a file, and reports only the prefix (not even the public id).
 * Built by concatenation so no key-shaped literal sits in this file.
 */
describe('scan — a connector key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-check-connector-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const key = ['fcc', 'abcdefghjkmn', 'Z'.repeat(20) + '-_' + 'q'.repeat(21)].join('_');

  it('flags a connector key compiled into the bundle, and prints none of it', () => {
    const file = join(dir, 'leaky.js');
    writeFileSync(file, `const fixture={k:"${key}"};const two="${key}";`);
    const findings = scan([file], {});
    expect(findings.map((f) => f.check)).toEqual(['connector-key-shape', 'connector-key-shape']);
    for (const finding of findings) {
      expect(finding.snippet).toBe('fcc_…');
      expect(finding.snippet).not.toContain('abcdefghjkmn');
    }
  });

  it('the public id alone, the words "fcc_" and a key one character short are not findings', () => {
    const file = join(dir, 'public.js');
    writeFileSync(
      file,
      `const id="abcdefghjkmn";const p="fcc_";const short="${key.slice(0, -1)}";const look="fcc_abcdefghjkmn_";`,
    );
    expect(scan([file], {})).toEqual([]);
  });
});
