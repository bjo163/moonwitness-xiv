import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { env } from 'node:process';
import { E2E_JWT_SECRET, E2E_SUPERADMIN_PASSWORD } from './e2e/constants.js';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const apiPort = env.MW_VISUAL_API_PORT ?? '3017';
const boardPort = env.MW_VISUAL_BOARD_PORT ?? '5177';
const baseURL = `http://127.0.0.1:${boardPort}`;
const browserMatrix = env.MW_VISUAL_BROWSER_MATRIX === 'true';
const projects = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ...(browserMatrix
    ? [
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
      ]
    : []),
];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '../../test-results/playwright-visual',
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'off',
    viewport: { width: 1440, height: 1000 },
  },
  projects,
  webServer: [
    {
      command: 'pnpm --filter @moonwitness/api run visual-audit:server',
      cwd: repositoryRoot,
      url: `http://127.0.0.1:${apiPort}/readyz`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...env,
        API_HOST: '127.0.0.1',
        API_PORT: apiPort,
        DATABASE_URL: 'postgresql://visual-audit:unused@127.0.0.1:1/unused',
        JWT_SECRET: E2E_JWT_SECRET,
        LOG_TO_FILE: 'false',
        NODE_ENV: 'test',
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
        MW_BOARD_DIST_DIR: '.next-visual',
      },
    },
  ],
});
