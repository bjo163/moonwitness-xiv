import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  composeVersionedSite,
  extractVersionedSite,
  packageVersionedSite,
  planVersionedReleaseRetention,
} from './versioned-site.mjs';

const sha = (digit) => digit.repeat(40);

function release(tag, { docs = true, draft = false, prerelease = false, published = true } = {}) {
  return {
    tag_name: tag,
    draft,
    prerelease,
    published_at: published ? '2026-01-01T00:00:00Z' : null,
    assets: docs ? [{ name: `docs-site-${tag}.tar.gz` }] : [],
  };
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function makeSite(directory, { tag = 'v1.2.3', sourceSha = sha('a'), runId = '1' } = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'index.html'), `<h1>${tag}</h1>\n`);
  await mkdir(path.join(directory, 'assets'));
  await writeFile(path.join(directory, 'assets', 'app.js'), 'console.log("docs");\n');
  await writeFile(
    path.join(directory, 'build-info.json'),
    `${JSON.stringify({
      applicationVersion: tag.slice(1),
      sourceSha,
      sourceRef: tag,
      docsOnly: false,
      releaseChangeKind: 'patch',
      runId,
      generatedAt: `2026-01-0${runId}T00:00:00Z`,
    })}\n`
  );
}

test('retains only published stable releases with an immutable docs asset in SemVer order', () => {
  const plan = planVersionedReleaseRetention(
    [
      [
        release('v1.12.0', { docs: false }),
        release('v1.9.0'),
        release('v2.0.0-rc.1', { prerelease: true }),
      ],
      [release('v1.11.0', { docs: false }), release('v1.10.0', { draft: true }), release('v1.8.0')],
    ],
    2
  );

  assert.deepEqual(
    plan.retained.map(({ tag }) => tag),
    ['v1.9.0', 'v1.8.0']
  );
  assert.equal(plan.latestTag, null, 'newest stable release without docs must not map to latest');
  assert.equal(plan.stableReleaseCount, 4);
  assert.throws(() => planVersionedReleaseRetention([release('v1.2.3-rc.1')]), /stable/u);
});

test('packages a version deterministically and extracts canonical metadata', async (t) => {
  const root = await temporaryDirectory(t, 'mw-versioned-package-');
  const firstSite = path.join(root, 'first');
  const secondSite = path.join(root, 'second');
  await makeSite(firstSite, { runId: '1' });
  await makeSite(secondSite, { runId: '2' });
  const first = await packageVersionedSite({
    siteDirectory: firstSite,
    tag: 'v1.2.3',
    outputFile: path.join(root, 'one.tar.gz'),
  });
  const second = await packageVersionedSite({
    siteDirectory: secondSite,
    tag: 'v1.2.3',
    outputFile: path.join(root, 'two.tar.gz'),
  });
  assert.equal(first.sha256, second.sha256);
  assert.equal(
    first.sha256,
    createHash('sha256')
      .update(await readFile(first.file))
      .digest('hex')
  );

  const extracted = path.join(root, 'extracted');
  assert.deepEqual(
    await extractVersionedSite({ archiveFile: first.file, outputDirectory: extracted }),
    {
      fileCount: 3,
    }
  );
  const metadata = JSON.parse(await readFile(path.join(extracted, 'build-info.json'), 'utf8'));
  assert.equal(metadata.sourceSha, sha('a'));
  assert.equal(metadata.runId, undefined);
  assert.equal(await readFile(path.join(extracted, 'index.html'), 'utf8'), '<h1>v1.2.3</h1>\n');
  await assert.rejects(
    packageVersionedSite({
      siteDirectory: firstSite,
      tag: 'v1.2.3-rc.1',
      outputFile: path.join(root, 'rc.tar.gz'),
    }),
    /stable vMAJOR/u
  );
});

test('rejects a corrupted compressed documentation snapshot', async (t) => {
  const root = await temporaryDirectory(t, 'mw-versioned-corrupt-');
  const site = path.join(root, 'site');
  await makeSite(site);
  const packed = await packageVersionedSite({
    siteDirectory: site,
    tag: 'v1.2.3',
    outputFile: path.join(root, 'valid.tar.gz'),
  });
  const corrupted = await readFile(packed.file);
  corrupted[corrupted.length - 8] ^= 0xff;
  const corruptPath = path.join(root, 'corrupt.tar.gz');
  await writeFile(corruptPath, corrupted);
  await assert.rejects(
    extractVersionedSite({ archiveFile: corruptPath, outputDirectory: path.join(root, 'bad') })
  );
});

test('rejects path traversal entries even when their USTAR checksum is valid', async (t) => {
  const root = await temporaryDirectory(t, 'mw-versioned-traversal-');
  const site = path.join(root, 'site');
  await makeSite(site);
  const packed = await packageVersionedSite({
    siteDirectory: site,
    tag: 'v1.2.3',
    outputFile: path.join(root, 'valid.tar.gz'),
  });
  const tar = gunzipSync(await readFile(packed.file));
  const header = tar.subarray(0, 512);
  header.fill(0, 0, 100);
  header.write('../escape', 0, 100, 'utf8');
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const unsafePath = path.join(root, 'unsafe.tar.gz');
  await writeFile(unsafePath, gzipSync(tar, { level: 9, mtime: 0 }));
  await assert.rejects(
    extractVersionedSite({ archiveFile: unsafePath, outputDirectory: path.join(root, 'bad') }),
    /Unsafe documentation archive path/u
  );
});

test('composes version selector, stable latest alias, retained releases, and current next docs', async (t) => {
  const root = await temporaryDirectory(t, 'mw-versioned-compose-');
  const archives = path.join(root, 'archives');
  await mkdir(archives);
  for (const [tag, sourceSha] of [
    ['v1.1.0', sha('1')],
    ['v1.2.0', sha('2')],
  ]) {
    const site = path.join(root, tag);
    await makeSite(site, { tag, sourceSha });
    await packageVersionedSite({
      siteDirectory: site,
      tag,
      outputFile: path.join(archives, `docs-site-${tag}.tar.gz`),
    });
  }
  const current = path.join(root, 'current');
  await makeSite(current, { tag: 'main', sourceSha: sha('f') });
  const currentMetadata = JSON.parse(await readFile(path.join(current, 'build-info.json'), 'utf8'));
  currentMetadata.applicationVersion = '1.2.3-rc.1';
  await writeFile(path.join(current, 'build-info.json'), `${JSON.stringify(currentMetadata)}\n`);

  const output = path.join(root, 'output');
  const manifest = await composeVersionedSite({
    currentSite: current,
    currentKind: 'next',
    sourceRef: 'main',
    releases: [release('v1.2.0'), release('v1.1.0')],
    archiveDirectory: archives,
    outputDirectory: output,
  });
  assert.equal(manifest.latestStable, 'v1.2.0');
  assert.deepEqual(
    manifest.versions.map(({ tag }) => tag),
    ['v1.2.0', 'v1.1.0']
  );
  assert.equal(manifest.next.sourceSha, sha('f'));
  assert.match(await readFile(path.join(output, 'latest', 'index.html'), 'utf8'), /v1\.2\.0/u);
  assert.match(await readFile(path.join(output, 'index.html'), 'utf8'), /next/u);
  assert.equal(
    await readFile(path.join(output, 'v1.1.0', 'index.html'), 'utf8'),
    '<h1>v1.1.0</h1>\n'
  );
  assert.equal(await readFile(path.join(output, 'next', 'index.html'), 'utf8'), '<h1>main</h1>\n');
  assert.equal(manifest.versions[0].path, '/moonwitness-xiv/v1.2.0/');
  assert.equal(manifest.next.path, '/moonwitness-xiv/next/');
  assert.equal(
    await readFile(path.join(output, '404.html'), 'utf8').then((html) =>
      html.includes('/moonwitness-xiv/')
    ),
    true
  );

  const stableOutput = path.join(root, 'stable-output');
  const stableManifest = await composeVersionedSite({
    currentSite: path.join(root, 'v1.2.0'),
    currentKind: 'stable',
    sourceRef: 'v1.2.0',
    releases: [release('v1.2.0'), release('v1.1.0')],
    archiveDirectory: archives,
    outputDirectory: stableOutput,
    basePath: '/moonwitness-xiv/v1.2.0/',
  });
  assert.equal(stableManifest.next, null);
  assert.equal(stableManifest.versions[0].path, '/moonwitness-xiv/v1.2.0/');
  assert.match(
    await readFile(path.join(stableOutput, 'latest', 'index.html'), 'utf8'),
    /href="\/moonwitness-xiv\/v1\.2\.0\/"/u
  );
});

test('does not claim latest or overwrite stable URLs when no release docs asset exists', async (t) => {
  const root = await temporaryDirectory(t, 'mw-versioned-empty-');
  const site = path.join(root, 'current');
  await makeSite(site, { tag: 'main', sourceSha: sha('f') });
  const metadata = JSON.parse(await readFile(path.join(site, 'build-info.json'), 'utf8'));
  metadata.applicationVersion = '1.0.0-rc.1';
  await writeFile(path.join(site, 'build-info.json'), `${JSON.stringify(metadata)}\n`);
  const output = path.join(root, 'out');
  const manifest = await composeVersionedSite({
    currentSite: site,
    currentKind: 'next',
    sourceRef: 'main',
    releases: [release('v1.0.0', { docs: false })],
    archiveDirectory: path.join(root, 'empty-archives'),
    outputDirectory: output,
  });
  assert.equal(manifest.latestStable, null);
  assert.equal(manifest.versions.length, 0);
  assert.match(
    await readFile(path.join(output, 'latest', 'index.html'), 'utf8'),
    /No stable documentation/u
  );
});
