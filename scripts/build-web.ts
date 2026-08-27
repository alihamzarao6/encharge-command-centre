/**
 * Build the browser app (Stage 3 part 3 review, 27 Aug 2026).
 *
 * This exists for one reason: `vite build` alone produced a DIFFERENT artefact depending on
 * whose machine ran it. The repo's `.env` carries `NODE_ENV=development` (it is the server
 * environment for `npm run dev`, the CLIs and the tests), `web/vite.config.ts` reads that
 * same file by design — `envDir: repoRoot`, so there is one `.env`, not two — and Vite turns
 * a `NODE_ENV` found there into `VITE_USER_NODE_ENV`, which it applies **unless the process
 * already has `NODE_ENV` set**. On a developer machine that meant React was bundled in
 * development mode: 654 kB instead of 443 kB, 48 % more for the client to download on a
 * phone, plus dev-only warning machinery that has no business in a production build.
 *
 * CI and Vercel have no `.env`, so what is actually deployed has always been the small one —
 * confirmed against the live bundle on 27 Aug. But "it happens to be right because the CI
 * box is missing a file" is not a guarantee, and one `vercel deploy --prod` run from a
 * developer machine would have shipped the big one.
 *
 * The fix has to happen BEFORE Vite resolves its config: `resolveConfig` captures
 * `!!process.env.NODE_ENV` before it loads the config file, so setting it inside
 * `vite.config.ts` is too late to win. Hence a wrapper that sets it and only then imports
 * Vite. `??=` rather than `=` so an explicit `NODE_ENV` in the shell still wins — that is
 * how you would deliberately build a development bundle to debug one.
 *
 * `scripts/check-bundle.ts` asserts the outcome on the real output, so this cannot regress
 * quietly: a bundle carrying React's dev-only code fails CI.
 */
import { fileURLToPath } from 'node:url';

import { logger } from '../src/lib/logger.js';

const CONFIG_FILE = fileURLToPath(new URL('../web/vite.config.ts', import.meta.url));

async function main(): Promise<void> {
  process.env['NODE_ENV'] ??= 'production';
  // Imported here, not at the top: a static import is hoisted above the assignment above.
  const { build } = await import('vite');
  await build({ configFile: CONFIG_FILE, mode: process.env['NODE_ENV'] });
  logger.info('web build complete', { nodeEnv: process.env['NODE_ENV'] });
}

main().catch((error: unknown) => {
  logger.error('web build failed', { error });
  process.exitCode = 1;
});
