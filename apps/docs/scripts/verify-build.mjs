import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath, URL as FileURL } from 'node:url';

const index = await readFile(
  fileURLToPath(new FileURL('../dist/index.html', import.meta.url)),
  'utf8'
);
const basePath = process.env.MW_DOCS_BASE_PATH ?? '/moonwitness-xiv/';
const escapedBasePath = basePath.replaceAll('/', '\\/');
const catalogBasePath = process.env.MW_UI_CATALOG_BASE_PATH ?? '/moonwitness-xiv/components/';
const escapedCatalogBasePath = catalogBasePath.replaceAll('/', '\\/');
const fallback = await readFile(
  fileURLToPath(new FileURL('../dist/404.html', import.meta.url)),
  'utf8'
);
const catalogIndex = await readFile(
  fileURLToPath(new FileURL('../dist/components/index.html', import.meta.url)),
  'utf8'
);
assert.equal(fallback, index, 'GitHub Pages 404 fallback must load the same SPA shell');
assert.match(index, new RegExp(`(?:src|href)="${escapedBasePath}assets/`, 'u'));
assert.match(
  catalogIndex,
  new RegExp(`(?:src|href)="${escapedCatalogBasePath}assets/`, 'u'),
  'UI catalog assets must use the published nested Pages path'
);
process.stdout.write(
  'Verified the GitHub Pages base path, nested-route fallback, and bundled UI catalog.\n'
);
