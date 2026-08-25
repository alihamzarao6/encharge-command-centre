/**
 * Browser tests over the BUILT app (web/dist via `vite preview`), in the Chrome already on
 * the machine (`channel: 'chrome'` — no browser download). Every network call the page
 * makes is intercepted in tests/e2e/mock.ts: Supabase auth, PostgREST and the chat Edge
 * Function are all scripted, so the suite proves the interface's behaviour — what it shows
 * for a 402, an empty reply, a 401 mid-turn, a deactivated account — without a stack, a key
 * or a dollar of spend. What it cannot prove is the server; that is the unit and
 * integration suites' job (tests/unit/llm, tests/integration/llm.test.ts).
 *
 * Three viewports, from the standing rule: 375 (primary), 768, 1280.
 */
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export const E2E_SUPABASE_URL = 'https://stack.e2e.invalid';

export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  outputDir: fileURLToPath(new URL('./.output', import.meta.url)),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'chrome',
    trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    {
      // An iPhone-sized Chrome: the device descriptors default to WebKit, which the installed
      // Chrome channel cannot run, so the phone shape is spelled out.
      name: 'phone-375',
      use: {
        channel: 'chrome',
        viewport: { width: 375, height: 812 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
    },
    {
      name: 'tablet-768',
      use: { channel: 'chrome', viewport: { width: 768, height: 1024 }, hasTouch: true },
    },
    { name: 'desktop-1280', use: { channel: 'chrome', viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: 'npm run web:build && npm run web:preview -- --host 127.0.0.1',
    cwd: repoRoot,
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_SUPABASE_URL: E2E_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: 'e2e-anon-key-not-a-secret',
    },
  },
});
