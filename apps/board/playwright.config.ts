import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from 'node:process';
import { E2E_JWT_SECRET, E2E_SUPERADMIN_PASSWORD } from './e2e/constants.js';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const apiPort = env.MW_E2E_API_PORT ?? '3010';
const boardPort = env.MW_E2E_BOARD_PORT ?? '5174';
const outboxPort = env.MW_E2E_OUTBOX_PORT ?? '3011';
const clamavPort = env.MW_E2E_CLAMAV_PORT ?? '3312';
const clamavHealthPort = env.MW_E2E_CLAMAV_HEALTH_PORT ?? '3313';
const baseURL = `http://127.0.0.1:${boardPort}`;
const databaseUrl =
  env.POSTGRES_TEST_URL ?? 'postgresql://postgres:ci-only-password@127.0.0.1:55432/moonwitness_e2e';
const ci = env.CI === 'true';
const browserMatrix = env.MW_E2E_BROWSER_MATRIX === 'true';
const buildScript = resolve(repositoryRoot, 'scripts/build-api-workspace.mjs');
const buildApiBeforeE2E = env.MW_E2E_USE_BUILT_API !== 'true';
const flakyPolicyPath = resolve(repositoryRoot, 'docs/testing/flaky-tests.json');
const flakyPolicyValue: unknown = JSON.parse(readFileSync(flakyPolicyPath, 'utf8'));
if (
  typeof flakyPolicyValue !== 'object' ||
  flakyPolicyValue === null ||
  !('maxRetries' in flakyPolicyValue) ||
  typeof flakyPolicyValue.maxRetries !== 'number'
) {
  throw new Error('docs/testing/flaky-tests.json must define a numeric maxRetries value.');
}
const maxRetries = flakyPolicyValue.maxRetries;
if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 1) {
  throw new Error('Playwright CI retries must be an integer between 0 and 1.');
}
const flakeReporter = resolve(repositoryRoot, 'scripts/playwright-flake-reporter.mjs');
const apiCommand = buildApiBeforeE2E
  ? `pnpm exec node "${buildScript}" && pnpm --filter @moonwitness/api dev`
  : 'node apps/api/dist/server.js';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: ci,
  retries: ci ? maxRetries : 0,
  // Board E2E specs share seeded PostgreSQL state; CPU-count parallelism causes API contention.
  workers: 1,
  reporter: [
    ['list'],
    ['junit', { outputFile: '../../test-results/junit/board-e2e.xml' }],
    [
      flakeReporter,
      { outputFile: resolve(repositoryRoot, 'test-results/junit/board-e2e-retries.json') },
    ],
  ],
  outputDir: '../../test-results/playwright',
  use: {
    baseURL,
    // Trace archives are scanned before upload because they can contain request credentials.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(browserMatrix
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
  webServer: [
    {
      command: `node scripts/mock-clamd.mjs ${clamavPort} ${clamavHealthPort}`,
      cwd: repositoryRoot,
      url: `http://127.0.0.1:${clamavHealthPort}/readyz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { ...env, MW_E2E_CLAMAV_PORT: clamavPort, MW_E2E_CLAMAV_HEALTH_PORT: clamavHealthPort },
    },
    {
      command: apiCommand,
      cwd: repositoryRoot,
      url: `http://127.0.0.1:${apiPort}/readyz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...env,
        API_HOST: '127.0.0.1',
        API_PORT: apiPort,
        AUTH_LOGIN_RATE_MAX: '100',
        DATABASE_URL: databaseUrl,
        WHATSAPP_CLAMAV_URL: `tcp://127.0.0.1:${clamavPort}`,
        JWT_SECRET: E2E_JWT_SECRET,
        LOG_TO_FILE: 'false',
        PRINT_ROUTES: 'false',
        SUPERADMIN_PASSWORD: E2E_SUPERADMIN_PASSWORD,
      },
    },
    {
      command: `pnpm --filter @moonwitness/board exec next dev --hostname 127.0.0.1 --port ${boardPort}`,
      cwd: repositoryRoot,
      url: `${baseURL}/login`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...env,
        API_PORT: apiPort,
        BOARD_API_TARGET: `http://127.0.0.1:${apiPort}`,
        NEXT_PUBLIC_SITE_URL: baseURL,
        MW_BOARD_DIST_DIR: '.next-e2e',
      },
    },
    {
      command: 'pnpm jobs:outbox',
      cwd: repositoryRoot,
      url: `http://127.0.0.1:${outboxPort}/readyz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...env,
        DATABASE_URL: databaseUrl,
        OUTBOX_WORKER_HEALTH_PORT: outboxPort,
      },
    },
  ],
});
