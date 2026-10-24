import { defineConfig } from '@playwright/test';

const basePath = process.env.MW_DOCS_BASE_PATH ?? '/moonwitness-xiv/';
const baseUrl = `http://127.0.0.1:4178${basePath}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: [['list'], ['junit', { outputFile: '../../test-results/junit/docs-portal.xml' }]],
  outputDir: '../../test-results/docs-portal',
  use: {
    baseURL: baseUrl,
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'pnpm --filter @moonwitness/docs portal:build && pnpm --filter @moonwitness/docs exec vite preview --host 127.0.0.1 --port 4178 --strictPort',
    url: baseUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
