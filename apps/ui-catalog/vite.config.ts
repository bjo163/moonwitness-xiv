import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: process.env.MW_UI_CATALOG_BASE_PATH ?? '/moonwitness-xiv/components/',
  plugins: [react(), tailwindcss()],
  root: appDirectory,
  build: { outDir: 'dist', emptyOutDir: true },
});
