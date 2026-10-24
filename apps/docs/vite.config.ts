import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryVersion = JSON.parse(
  readFileSync(path.resolve(appDirectory, '../../package.json'), 'utf8')
).version;

export default defineConfig({
  root: appDirectory,
  base: process.env.MW_DOCS_BASE_PATH ?? '/moonwitness-xiv/',
  envPrefix: ['VITE_', 'MW_DOCS_'],
  define: {
    'import.meta.env.MW_DOCS_APPLICATION_VERSION': JSON.stringify(repositoryVersion),
    'import.meta.env.MW_DOCS_CHANNEL': JSON.stringify(process.env.MW_DOCS_CHANNEL ?? 'preview'),
  },
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
