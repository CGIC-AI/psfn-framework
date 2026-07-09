import { globalIgnores } from 'eslint/config';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

const GLOBAL_IGNORES = [
  'node_modules/**',
  '**/node_modules/**',
  'dist/**',
  '**/dist/**',
  'admin-ui/.svelte-kit/**',
  '**/.svelte-kit/**',
  'admin-ui/build/**',
  '**/build/**',
  'data/**',
  '**/data/**',
  'logs/**',
  '**/logs/**',
  'import/**',
  '**/import/**',
  'PSFN-Satellite-Hub/**',
  '**/PSFN-Satellite-Hub/**',
  // Coding-agent worktrees (transient full repo copies) must never be linted.
  '.claude/**',
  '**/.claude/**',
];

export default [
  globalIgnores(GLOBAL_IGNORES),
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'error',
    },
  },
  {
    // pi-agent-core version-coupling boundary: only src/boundary/pi-agent may
    // import the package directly. Everything else goes through that module,
    // so a version bump touches one directory. See src/boundary/pi-agent/index.ts.
    files: ['src/**/*.ts'],
    ignores: ['src/boundary/pi-agent/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@mariozechner/pi-agent-core', '@mariozechner/pi-agent-core/*'],
              message:
                'Import pi-agent-core symbols from src/boundary/pi-agent (the version-coupling boundary), not from the package directly.',
            },
          ],
        },
      ],
    },
  },
];
