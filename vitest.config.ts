import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
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
