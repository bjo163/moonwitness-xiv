import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compareAssetInventory, listInventoryMedia } from '../scripts/asset-inventory.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('tracked asset media exactly matches the canonical manifest inventory', async () => {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'manifest.json'), 'utf8'));
  const files = await listInventoryMedia(packageRoot, [
    'brand',
    'fonts',
    'icons',
    'illustrations',
    'sounds',
    'source',
  ]);
  assert.deepEqual(
    compareAssetInventory(
      manifest.assets.map(({ path }) => path),
      files
    ),
    {
      unlistedFiles: [],
      missingFiles: [],
    }
  );
});

test('inventory comparison reports unlisted files and missing manifest files separately', () => {
  assert.deepEqual(
    compareAssetInventory(
      ['brand/logo.svg', 'fonts/display.woff2'],
      ['brand/logo.svg', 'icons/new.svg']
    ),
    {
      unlistedFiles: ['icons/new.svg'],
      missingFiles: ['fonts/display.woff2'],
    }
  );
});
