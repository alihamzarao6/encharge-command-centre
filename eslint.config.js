// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'dist/**',
      'web/dist/**',
      'tests/e2e/.output/**',
      '.agents/**',
      'supabase/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md rule 6: no `any`, no unexplained ts-ignore
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': 'allow-with-description', minimumDescriptionLength: 10 },
      ],
      // CLAUDE.md §8: no console.log — use src/lib/logger.ts
      'no-console': 'error',
      // errors.ts contract: never throw a string
      '@typescript-eslint/only-throw-error': 'error',
      // rule 7: no unhandled rejections, no swallowed promises
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ThrowStatement > Literal',
          message: 'Never throw a string. Throw a typed error from src/lib/errors.ts.',
        },
      ],
    },
  },
  {
    // The logger is the one place allowed to write to stdout/stderr.
    files: ['src/lib/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['eslint.config.js', 'vitest.config.ts', 'web/vite.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
