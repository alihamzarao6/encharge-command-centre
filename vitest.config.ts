import { defineConfig } from 'vitest/config';

/**
 * True when a real Supabase stack is in the ENVIRONMENT (CI's integration job exports these;
 * a developer's `.env` is not read here, and the stack-backed suites skip without them).
 */
const stackBacked =
  (process.env['SUPABASE_URL'] ?? '') !== '' && (process.env['SUPABASE_DB_URL'] ?? '') !== '';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    /**
     * Test files run in parallel — EXCEPT when they are talking to a real database, where
     * they all share one. That was survivable while a workspace memory fact's identity was
     * `(user_id, scope, key)`: each file's fixture user had its own namespace. Since D54 a
     * workspace note is unique by `key` across the whole table and readable by every
     * allowlisted user, which is right for production (there is one workspace) and means two
     * concurrent files are two files pretending to BE that workspace — they collide on the
     * key and they see each other's notes in `currentFacts`. One at a time, each cleaning up
     * after itself, is the honest arrangement. The unit suite is unaffected.
     */
    fileParallelism: !stackBacked,
    // No network in unit tests (TESTING.md §1). A test that reaches the network fails loudly.
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts', 'web/src/lib/**/*.ts'],
      // env.ts reads import.meta.env at module load (browser-only); supabase.ts builds the
      // browser client. Both are one-liners over tested functions and are covered by e2e.
      exclude: ['src/lib/**/*.d.ts', 'web/src/lib/env.ts', 'web/src/lib/supabase.ts'],
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      // TESTING.md §7 — CI fails below this floor.
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
        statements: 80,
      },
    },
  },
});
