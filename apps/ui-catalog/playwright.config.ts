import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const flakeReporter = resolve(repositoryRoot, 'scripts/playwright-flake-reporter.mjs');
const ci = process.env.CI === 'true';

const baseURL = 'http://127.0.0.1:4174/moonwitness-xiv/components/';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: ci ? 1 : 0,
  workers: process.env.CI ? 2 : 1,
  reporter: [
    ['list'],
    ['junit', { outputFile: '../../test-results/junit/ui-catalog.xml' }],
    [
      flakeReporter,
      { outputFile: resolve(repositoryRoot, 'test-results/junit/ui-catalog-retries.json') },
    ],
  ],
  outputDir: '../../test-results/ui-catalog',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  use: {
    baseURL,
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 4174 --strictPort',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
