import { cp, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boardRoot = resolve(repositoryRoot, 'apps/board');
const standaloneRoot = resolve(boardRoot, '.next/standalone/apps/board');
const assetCopies = [
  [resolve(boardRoot, 'public'), resolve(standaloneRoot, 'public')],
  [resolve(boardRoot, '.next/static'), resolve(standaloneRoot, '.next/static')],
];

for (const [source, destination] of assetCopies) {
  try {
    await stat(source);
  } catch {
    throw new Error(
      `Cannot prepare standalone Board server: missing build asset directory ${source}`
    );
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

process.stdout.write(
  'Prepared public and Next.js static assets for the standalone Board server.\n'
);
