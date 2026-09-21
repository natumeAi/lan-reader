import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config for the whole workspace.
 *
 * Legacy `.js`/`.jsx` application files are still present while the migration
 * runs (see docs/migration/js-coexistence.md); they are linted with the plain
 * JavaScript rules. TypeScript files get the typescript-eslint rules on top.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dev-dist/**',
      '.tmp/**',
      '.trellis/**',
      'client/public/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    rules: {
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['client/src/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['server/**/*.{js,mjs,cjs,ts}', '*.js', 'client/vite.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Express recognises an error handler by its four-parameter signature, so
    // `next` has to be declared even when the handler never calls it.
    files: ['server/src/**/*.{js,ts}'],
    rules: {
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^(_|next$)',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Upload file names are sanitised by stripping C0 control characters, which
    // is exactly what this rule flags.
    files: ['server/src/services/fileStorage.{js,ts}'],
    rules: {
      'no-control-regex': 'off',
    },
  },
  {
    // Client tests drive a jsdom document and install it on the global scope.
    files: ['client/test/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
  },
  {
    // `tseslint.configs.recommended` replaces `no-unused-vars` with its own
    // rule, which would otherwise drop the allowance configured above: Express
    // still recognises an error handler by its four-parameter signature, so the
    // trailing `next` has to stay declared. TypeScript's own
    // `noUnusedParameters` accepts it only when it is underscore-prefixed.
    files: ['server/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^(_|next$)',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Findings inherited from the pre-migration sources, kept visible instead of
    // silently fixed: each file is converted by the step listed in
    // docs/migration/js-coexistence.md, and the exception is removed there.
    // Nothing may be added to this list — new code is linted without exceptions.
    files: [
      'client/src/hooks/usePageTurnController.js', // step 4 · unused assignment to `restored`
      'client/src/utils/epubNavigation.js', // step 4 · dead `isSameDisplayedPage`
    ],
    rules: {
      'no-unused-vars': 'off',
      'no-useless-assignment': 'off',
    },
  },
);
