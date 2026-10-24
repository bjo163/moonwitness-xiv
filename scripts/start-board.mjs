import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

process.env.PORT ??= process.env.BOARD_PORT ?? '5173';
process.env.HOSTNAME = process.env.BOARD_HOST ?? '127.0.0.1';
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
await import(
  pathToFileURL(resolve(repositoryRoot, 'apps/board/.next/standalone/apps/board/server.js')).href
);
