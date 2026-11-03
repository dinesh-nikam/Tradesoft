import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import tradesoft from './tooling/eslint-plugin-tradesoft/index.js';

// 00 §7 rule 4: a package is imported only through its entrypoint.
const deepImports = [
  { group: ['@tradesoft/*/*'], message: 'Import a package through its public entrypoint only (00 §7).' },
  {
    regex: '\\.\\./[a-z0-9-]+/src(/|$)',
    message: 'Do not reach into another package by relative path; import its entrypoint (00 §7).',
  },
];

// 00 §7 rule 2: domain and engines perform no I/O.
const ioModules = [
  'pg',
  'fastify',
  'fs',
  'fs/promises',
  'http',
  'https',
  'net',
  'child_process',
  'node:fs',
  'node:fs/promises',
  'node:http',
  'node:https',
  'node:net',
  'node:child_process',
].map((name) => ({ name, message: 'domain and engines perform no I/O (00 §7).' }));

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { tradesoft },
    rules: {
      'no-restricted-imports': ['error', { patterns: deepImports }],
    },
  },
  {
    files: ['packages/domain/src/**', 'packages/engines/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ioModules,
          patterns: [
            ...deepImports,
            {
              group: [
                '@tradesoft/db',
                '@tradesoft/ingestion',
                '@tradesoft/observability',
                '@tradesoft/config',
              ],
              message: 'domain and engines import only contracts and each other (00 §7).',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Inject a Clock port; domain and engines never read the clock.',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Inject a Clock port; domain and engines never read the clock.',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'domain and engines are deterministic; inject randomness.',
        },
      ],
    },
  },
  {
    files: ['packages/contracts/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...deepImports,
            {
              group: ['@tradesoft/*'],
              message: 'contracts is the leaf package; it imports no workspace package.',
            },
          ],
        },
      ],
      'tradesoft/decimal-discipline': 'error',
    },
  },
);
