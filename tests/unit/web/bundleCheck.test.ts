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
