import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { compareReleaseVersions } from '../release-latest-policy.mjs';

const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const archiveAssetName = (tag) => `docs-site-${tag}.tar.gz`;
const maximumArchiveBytes = 256 * 1024 * 1024;
const maximumExpandedBytes = 512 * 1024 * 1024;
const maximumArchiveFiles = 25_000;

function assertStableTag(tag) {
  if (!stableTagPattern.test(tag))
    throw new Error(`Documentation snapshots require a stable vMAJOR.MINOR.PATCH tag: ${tag}`);
}

function safeArchivePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\'))
    throw new Error('Archive path must be a non-empty POSIX relative path.');
  const normalized = path.posix.normalize(value);
  if (
    path.posix.isAbsolute(value) ||
    normalized !== value ||
    value.split('/').some((part) => part === '..' || part === '.' || part.length === 0) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`Unsafe documentation archive path: ${value}`);
  }
  return value;
}

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length)
    throw new Error('Documentation archive field exceeds USTAR limits.');
  header.write(`${encoded}\0`, offset, length, 'ascii');
}

function tarHeader(filePath, size) {
  const header = Buffer.alloc(512);
  const nameBuffer = Buffer.from(filePath);
  let name = filePath;
  let prefix = '';
  if (nameBuffer.length > 100) {
    const splitAt = filePath.lastIndexOf('/');
    name = filePath.slice(splitAt + 1);
    prefix = filePath.slice(0, splitAt);
  }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
    throw new Error(`Documentation archive path is too long: ${filePath}`);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix) header.write(prefix, 345, 155, 'utf8');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function canonicalBuildInfo(source) {
  const metadata = JSON.parse(source);
  if (
    typeof metadata.applicationVersion !== 'string' ||
    typeof metadata.sourceRef !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(metadata.sourceSha)
  ) {
    throw new Error(
      'Versioned documentation requires application version, source ref, and full source SHA.'
    );
  }
  return `${JSON.stringify(
    {
      applicationVersion: metadata.applicationVersion,
      sourceSha: metadata.sourceSha,
      sourceRef: metadata.sourceRef,
      docsOnly: metadata.docsOnly === true,
      releaseChangeKind: metadata.releaseChangeKind ?? 'unknown',
    },
    null,
    2
  )}\n`;
}

async function collectSiteFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
    safeArchivePath(entryPath);
    if (entry.isSymbolicLink())
      throw new Error(`Symlinks are not allowed in docs snapshots: ${entryPath}`);
    if (entry.isDirectory()) files.push(...(await collectSiteFiles(root, entryPath)));
    else if (entry.isFile()) {
      const file = path.join(root, ...entryPath.split('/'));
      const source = await readFile(file);
      files.push({
        path: entryPath,
        contents:
          entryPath === 'build-info.json'
            ? Buffer.from(canonicalBuildInfo(source.toString('utf8')))
            : source,
      });
    } else throw new Error(`Unsupported filesystem entry in docs snapshot: ${entryPath}`);
  }
  return files;
}

function createTar(files) {
  if (files.length === 0 || files.length > maximumArchiveFiles)
    throw new Error(`Documentation snapshot has an invalid file count: ${files.length}`);
  const blocks = [];
  let totalBytes = 0;
  for (const file of files) {
    const name = safeArchivePath(file.path);
    totalBytes += file.contents.length;
    if (totalBytes > maximumExpandedBytes)
      throw new Error('Documentation snapshot exceeds the expanded size limit.');
    blocks.push(tarHeader(name, file.contents.length), file.contents);
    const padding = (512 - (file.contents.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function readString(header, offset, length) {
  const end = header.indexOf(0, offset);
  return header.toString(
    'utf8',
    offset,
    end >= offset && end < offset + length ? end : offset + length
  );
}

function parseOctal(header, offset, length) {
  const value = readString(header, offset, length).trim();
  if (!/^[0-7]+$/u.test(value))
    throw new Error('Documentation archive has an invalid numeric field.');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('Documentation archive size is invalid.');
  return parsed;
}

function readTar(archive) {
  if (archive.length > maximumArchiveBytes)
    throw new Error('Documentation archive exceeds the compressed size limit.');
  const tar = gunzipSync(archive, {
    maxOutputLength: maximumExpandedBytes + maximumArchiveFiles * 1024,
  });
  const files = [];
  const seen = new Set();
  let offset = 0;
  let totalBytes = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const expectedChecksum = parseOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((total, byte) => total + byte, 0);
    if (actualChecksum !== expectedChecksum)
      throw new Error('Documentation archive header checksum is invalid.');
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const filePath = safeArchivePath(prefix ? `${prefix}/${name}` : name);
    if (seen.has(filePath))
      throw new Error(`Documentation archive contains duplicate path ${filePath}.`);
    seen.add(filePath);
    const type = String.fromCharCode(header[156]);
    if (type !== '0' && type !== '\0')
      throw new Error(`Documentation archive contains unsupported entry type ${type}.`);
    const size = parseOctal(header, 124, 12);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length)
      throw new Error('Documentation archive ended inside a file entry.');
    totalBytes += size;
    if (totalBytes > maximumExpandedBytes || files.length >= maximumArchiveFiles)
      throw new Error('Documentation archive exceeds the extraction limits.');
    files.push({ path: filePath, contents: tar.subarray(contentStart, contentEnd) });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (
    !files.some((file) => file.path === 'index.html') ||
    !files.some((file) => file.path === 'build-info.json')
  )
    throw new Error('Documentation archive is missing its index or build metadata.');
  return files;
}

function flattenReleases(value) {
  if (!Array.isArray(value)) throw new Error('Release inventory must be a JSON array.');
  return value.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
}

export function planVersionedReleaseRetention(releaseInput, limit = 5) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error('Documentation retention limit must be from 1 through 20 stable releases.');
  const releases = flattenReleases(releaseInput);
  const stable = [];
  for (const release of releases) {
    if (release?.draft !== false || release?.prerelease !== false || !release.published_at)
      continue;
    const tag = release.tag_name;
    if (typeof tag !== 'string' || !tag.startsWith('v')) continue;
    assertStableTag(tag);
    stable.push(release);
  }
  stable.sort((left, right) => compareReleaseVersions(right.tag_name, left.tag_name));
  const latestTag = stable[0]?.tag_name ?? null;
  const eligible = stable.filter(
    (release) =>
      Array.isArray(release.assets) &&
      release.assets.some((asset) => asset.name === archiveAssetName(release.tag_name))
  );
  return {
    latestTag: eligible.some((release) => release.tag_name === latestTag) ? latestTag : null,
    stableReleaseCount: stable.length,
    retained: eligible.slice(0, limit).map((release) => ({
      tag: release.tag_name,
      assetName: archiveAssetName(release.tag_name),
      publishedAt: release.published_at,
    })),
    retentionLimit: limit,
  };
}

export async function packageVersionedSite({ siteDirectory, tag, outputFile }) {
  assertStableTag(tag);
  const site = path.resolve(siteDirectory);
  const metadata = JSON.parse(await readFile(path.join(site, 'build-info.json'), 'utf8'));
  if (metadata.sourceRef !== tag || metadata.applicationVersion !== tag.slice(1))
    throw new Error(
      'Documentation source ref and application version must match the requested stable tag.'
    );
  const files = await collectSiteFiles(site);
  const archive = gzipSync(createTar(files), { level: 9, mtime: 0 });
  if (archive.length > maximumArchiveBytes)
    throw new Error('Packaged documentation exceeds the release asset size limit.');
  const target = path.resolve(outputFile);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, archive);
  return {
    tag,
    assetName: archiveAssetName(tag),
    file: target,
    size: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
    sourceSha: metadata.sourceSha,
    fileCount: files.length,
  };
}

export async function extractVersionedSite({ archiveFile, outputDirectory }) {
  const archive = await readFile(archiveFile);
  const files = readTar(archive);
  const targetRoot = path.resolve(outputDirectory);
  await mkdir(targetRoot, { recursive: true });
  for (const file of files) {
    const safePath = safeArchivePath(file.path);
    const target = path.resolve(targetRoot, ...safePath.split('/'));
    if (target !== targetRoot && !target.startsWith(`${targetRoot}${path.sep}`))
      throw new Error(`Documentation extraction escaped its target: ${safePath}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.contents, { flag: 'wx', mode: 0o644 });
  }
  return { fileCount: files.length };
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/gu,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character
  );
}

function versionLandingPage({ versions, latestTag, next }) {
  const stableLinks = versions
    .map(({ tag }) => `<li><a href="${escapeHtml(tag)}/">${escapeHtml(tag)}</a></li>`)
    .join('\n');
  const nextLink = next
    ? `<p>Current development documentation: <a href="next/">next</a> (${escapeHtml(next.sourceSha.slice(0, 12))}).</p>`
    : '';
  const latestLink = latestTag
    ? `<p><a href="latest/">Latest stable documentation (${escapeHtml(latestTag)})</a></p>`
    : '<p>No stable documentation version is published yet.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MoonWitness documentation</title></head>
<body><main><h1>MoonWitness documentation</h1>${latestLink}${nextLink}<h2>Retained stable versions</h2><ul>${stableLinks}</ul><p>Stable version paths are retained for the five newest supported releases. Older immutable snapshots remain attached to their GitHub Releases.</p></main></body></html>\n`;
}

function latestLandingPage(latestTag, basePath) {
  if (!latestTag)
    return '<!doctype html><html lang="en"><meta charset="utf-8"><title>No stable docs</title><h1>No stable documentation version is published yet.</h1><a href="../">Browse versions</a></html>\n';
  const destination = `${basePath}${latestTag}/`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtml(destination)}"><link rel="canonical" href="${escapeHtml(destination)}"><title>Latest stable docs</title></head><body><p>Redirecting to the <a href="${escapeHtml(destination)}">latest stable documentation (${escapeHtml(latestTag)})</a>.</p></body></html>\n`;
}

async function copyDirectory(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Symlinks are not allowed in published docs: ${entry.name}`);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await writeFile(to, await readFile(from), { flag: 'wx' });
    else throw new Error(`Unsupported filesystem entry in published docs: ${entry.name}`);
  }
}

export async function composeVersionedSite({
  currentSite,
  currentKind,
  sourceRef,
  releases,
  archiveDirectory,
  outputDirectory,
  basePath = '/moonwitness-xiv/',
  retentionLimit = 5,
}) {
  if (currentKind !== 'stable' && currentKind !== 'next')
    throw new Error('Current documentation kind must be stable or next.');
  if (!/^\/[A-Za-z0-9_./-]+\/$/u.test(basePath) || basePath.includes('..'))
    throw new Error('Documentation base path must be a safe absolute path ending in a slash.');
  const currentMetadata = JSON.parse(
    await readFile(path.join(currentSite, 'build-info.json'), 'utf8')
  );
  if (currentMetadata.sourceRef !== sourceRef)
    throw new Error('Current site metadata does not match the selected source ref.');
  if (currentKind === 'stable') {
    assertStableTag(sourceRef);
    if (currentMetadata.applicationVersion !== sourceRef.slice(1))
      throw new Error('Stable documentation app version does not match the selected tag.');
  }
  if (currentKind === 'next' && !/^(?:main|[0-9a-f]{40})$/u.test(sourceRef))
    throw new Error('Next documentation must identify main or a full immutable source SHA.');
  const retention = planVersionedReleaseRetention(releases, retentionLimit);
  if (currentKind === 'stable' && !retention.retained.some((release) => release.tag === sourceRef))
    throw new Error(
      `Selected stable docs tag ${sourceRef} is outside retention or has no immutable release asset.`
    );

  const targetRoot = path.resolve(outputDirectory);
  const repositoryBasePath = `/${basePath.split('/').filter(Boolean)[0]}/`;
  await mkdir(targetRoot, { recursive: true });
  const versions = [];
  for (const release of retention.retained) {
    const archiveFile = path.join(archiveDirectory, release.assetName);
    const versionDirectory = path.join(targetRoot, release.tag);
    const extracted = await extractVersionedSite({
      archiveFile,
      outputDirectory: versionDirectory,
    });
    const metadata = JSON.parse(
      await readFile(path.join(versionDirectory, 'build-info.json'), 'utf8')
    );
    if (metadata.sourceRef !== release.tag || metadata.applicationVersion !== release.tag.slice(1))
      throw new Error(`Archived docs metadata does not match release ${release.tag}.`);
    if (
      currentKind === 'stable' &&
      release.tag === sourceRef &&
      metadata.sourceSha !== currentMetadata.sourceSha
    ) {
      throw new Error(`Archived docs source SHA does not match selected release ${sourceRef}.`);
    }
    versions.push({
      tag: release.tag,
      path: `${repositoryBasePath}${release.tag}/`,
      sourceSha: metadata.sourceSha,
      applicationVersion: metadata.applicationVersion,
      publishedAt: release.publishedAt,
      fileCount: extracted.fileCount,
    });
  }
  let next = null;
  if (currentKind === 'next') {
    const nextDirectory = path.join(targetRoot, 'next');
    await copyDirectory(currentSite, nextDirectory);
    next = {
      path: `${repositoryBasePath}next/`,
      sourceSha: currentMetadata.sourceSha,
      applicationVersion: currentMetadata.applicationVersion,
    };
  }
  const latestTag = retention.latestTag;
  await mkdir(path.join(targetRoot, 'latest'), { recursive: true });
  await writeFile(
    path.join(targetRoot, 'index.html'),
    versionLandingPage({ versions, latestTag, next })
  );
  await writeFile(
    path.join(targetRoot, 'latest', 'index.html'),
    latestLandingPage(latestTag, repositoryBasePath)
  );
  await writeFile(
    path.join(targetRoot, '404.html'),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Documentation not found</title><h1>Documentation page not found</h1><a href="${repositoryBasePath}">Browse documentation versions</a></html>\n`
  );
  await writeFile(path.join(targetRoot, '.nojekyll'), '');
  const manifest = {
    schemaVersion: 1,
    sourceSha: currentMetadata.sourceSha,
    sourceRef,
    currentKind,
    latestStable: latestTag,
    stableReleaseCount: retention.stableReleaseCount,
    retention: {
      stableVersionLimit: retentionLimit,
      olderSnapshots: 'permanently retained as immutable GitHub Release assets',
    },
    versions,
    next,
  };
  await writeFile(
    path.join(targetRoot, 'docs-versions.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}

async function readJsonFile(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function run(args) {
  const [command] = args;
  if (command === 'plan') {
    const input = optionValue(args, '--releases');
    if (!input)
      throw new Error('Usage: versioned-site.mjs plan --releases <release-list.json> [--limit 5]');
    const inventory = await readJsonFile(input);
    const plan = planVersionedReleaseRetention(
      inventory,
      Number(optionValue(args, '--limit') ?? 5)
    );
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (command === 'package') {
    const result = await packageVersionedSite({
      siteDirectory: optionValue(args, '--site'),
      tag: optionValue(args, '--tag'),
      outputFile: optionValue(args, '--output'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'compose') {
    const retention = optionValue(args, '--retention');
    const result = await composeVersionedSite({
      currentSite: optionValue(args, '--site'),
      currentKind: optionValue(args, '--kind'),
      sourceRef: optionValue(args, '--source-ref'),
      releases: await readJsonFile(optionValue(args, '--releases')),
      archiveDirectory: optionValue(args, '--archives'),
      outputDirectory: optionValue(args, '--output'),
      basePath: optionValue(args, '--base-path') ?? '/moonwitness-xiv/',
      retentionLimit: retention === undefined ? 5 : Number(retention),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error('Commands: plan, package, compose.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Versioned docs operation failed'}\n`
    );
    process.exitCode = 1;
  });
}
