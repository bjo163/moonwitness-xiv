import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';
import { replaceGeneratedAssets } from './manifest-ownership.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(packageRoot, 'source/fonts/RoadRage-Regular.ttf');
const outputPath = resolve(packageRoot, 'fonts/RoadRage-latin.woff2');
const outputRelativePath = 'fonts/RoadRage-latin.woff2';
const targetCharacters =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!?.,:;—–-+&/()\'" ' +
  'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ';

await mkdir(dirname(outputPath), { recursive: true });
const source = await readFile(sourcePath);
const subset = await subsetFont(source, targetCharacters, { targetFormat: 'woff2' });
await writeFile(outputPath, subset);
const digest = createHash('sha256').update(subset).digest('hex').toUpperCase();
const sourceDigest = createHash('sha256').update(source).digest('hex').toUpperCase();

const asset = {
  path: outputRelativePath,
  source: 'source/fonts/RoadRage-Regular.ttf',
  kind: 'font',
  variant: 'latin-display-subset',
  format: 'woff2',
  license: 'SIL Open Font License 1.1',
  sha256: digest,
};
const manifestPath = resolve(packageRoot, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const sourceAsset = {
  path: 'source/fonts/RoadRage-Regular.ttf',
  kind: 'source',
  variant: 'upstream-road-rage-regular',
  format: 'ttf',
  license: 'SIL Open Font License 1.1',
  sha256: sourceDigest,
};
manifest.assets = replaceGeneratedAssets(
  manifest.assets,
  [asset, sourceAsset],
  new Set([outputRelativePath, sourceAsset.path])
);
await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const licensesPath = resolve(packageRoot, 'licenses.json');
const licenses = JSON.parse(await readFile(licensesPath, 'utf8'));
licenses.fonts = [
  ...licenses.fonts.filter(({ family }) => family !== 'Road Rage'),
  {
    family: 'Road Rage',
    designer: 'Robert Leuschke',
    source: 'https://github.com/google/fonts/tree/main/ofl/roadrage',
    license: 'SIL Open Font License 1.1',
    files: [
      {
        path: outputRelativePath,
        source: 'https://fonts.gstatic.com/s/roadrage/v9/6NUU8F2fKAOBKjjr4ekvtA.ttf',
        sourceFile: 'source/fonts/RoadRage-Regular.ttf',
        sourceSha256: sourceDigest,
        sha256: digest,
      },
    ],
    usage: 'Bundled subset WOFF2 for short editorial display headings only.',
  },
].sort((left, right) => left.family.localeCompare(right.family));
await atomicWrite(licensesPath, `${JSON.stringify(licenses, null, 2)}\n`);

stdout.write(`Prepared Road Rage WOFF2: ${subset.length} bytes (SHA-256 ${digest}).\n`);

async function atomicWrite(path, content) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, content);
  await rename(temporaryPath, path);
}
