import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const docsBasePath = process.env.MW_DOCS_BASE_PATH ?? '/moonwitness-xiv/';

export default defineConfig({
  // The documentation portal publishes the built catalog under <docs base>/components/, so the
  // channel base path has to travel with it; otherwise every asset 404s on the versioned channel.
  base: process.env.MW_UI_CATALOG_BASE_PATH ?? `${docsBasePath}components/`,
  plugins: [react(), tailwindcss()],
  root: appDirectory,
  build: { outDir: 'dist', emptyOutDir: true },
});
