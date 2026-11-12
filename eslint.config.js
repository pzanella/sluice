import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'dist.next/', 'dist.old/', 'dist-granted/', 'node_modules/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node, chrome: 'readonly' } },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // The MAIN world runtime must stay dependency-free and must not touch extension APIs.
    files: ['src/inject/**/*.ts'],
    ignores: ['src/inject/**/*.test.ts', 'src/inject/__tests__/**'],
    rules: {
      'no-restricted-globals': ['error', 'chrome', 'browser'],
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '^(?!\\.{1,2}/)', message: 'MAIN world code must not import packages.' }] },
      ],
    },
  },
);
