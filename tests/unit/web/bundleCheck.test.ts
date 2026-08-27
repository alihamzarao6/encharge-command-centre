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
import { describe, expect, it } from 'vitest';

import { devBuildMarkers } from '../../../scripts/check-bundle.js';

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
