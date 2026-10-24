import baseConfig from './packages/eslint-config/index.js';

export default [
  ...baseConfig,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      // .mjs files in this workspace are Node.js scripts, CLI tools, and tests.
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    ignores: [
      '**/dist/**',
      '**/.next*/**',
      '**/node_modules/**',
      '.qoder-tmp/**',
      'services/**',
      'pnpm-lock.yaml',
      '.env*',
    ],
  },
];
