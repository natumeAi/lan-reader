import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config for the whole workspace.
 *
 * Application and test modules use TypeScript. Plain JavaScript rules remain
 * for build/configuration scripts; TypeScript gets its recommended rules on top.
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
      'server/public/**',
      // Local (Git-ignored) P5 performance CDP driver; not part of the app gate.
      'client/test/browser/p5-cdp.mjs',
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
    files: ['client/src/**/*.{ts,tsx}'],
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
    files: ['server/src/**/*.ts'],
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
    files: ['server/src/services/fileStorage.ts'],
    rules: {
      'no-control-regex': 'off',
    },
  },
  {
    // Client tests drive a jsdom document and install it on the global scope.
    files: ['client/test/**/*.{ts,tsx}'],
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
);
