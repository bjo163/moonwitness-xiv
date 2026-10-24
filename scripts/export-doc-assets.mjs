import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(rootDirectory, 'packages/assets');
const outputDirectory = path.join(rootDirectory, 'docs/assets/moonwitness');
const outputDirectoryRelative = 'docs/assets/moonwitness';
const assetManifestRelative = 'manifest.json';
const tokenSourceRelative = 'packages/ui/src/styles/tokens.css';
const generatedManifestName = 'asset-map.json';
// A Windows checkout with core.autocrlf turns these text assets into CRLF while
// every other runner reads the LF blobs, so hashing raw bytes recorded a
// fingerprint that was only reproducible on the machine that generated it.
const portableTextPattern = /\.(?:svg|css|json|js|mjs|ts|html|txt|xml|csv|md)$/iu;

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function isPortableText(filePath) {
  return portableTextPattern.test(filePath);
}

function toPortableText(contents) {
  return Buffer.from(asBuffer(contents).toString('utf8').replaceAll('\r\n', '\n'), 'utf8');
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error('Generated asset paths must be non-empty relative paths');
  }
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    segments.some((segment) => segment === '..' || segment === '.' || segment.length === 0)
  ) {
    throw new Error(`Unsafe generated asset path '${value}'`);
  }
  return normalized;
}

function resolveInsideOutput(relativePath) {
  const normalized = safeRelativePath(relativePath);
  const target = path.resolve(outputDirectory, normalized);
  const relative = path.relative(outputDirectory, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Generated asset path escapes '${outputDirectoryRelative}'`);
  }
  return target;
}

function asBuffer(contents) {
  return Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
}

export function createDocAssetArtifacts({
  assetManifest,
  assetManifestContents,
  assetSources,
  tokenContents,
}) {
  if (assetManifest.schemaVersion !== 1 || !Array.isArray(assetManifest.assets)) {
    throw new Error('Unsupported @moonwitness/assets manifest');
  }
  const artifactContents = new Map();
  const assetRecords = [];
  const seenSources = new Set();

  for (const asset of assetManifest.assets) {
    const sourcePath = safeRelativePath(asset.path);
    if (seenSources.has(sourcePath)) {
      throw new Error(`Duplicate asset manifest path '${sourcePath}'`);
    }
    seenSources.add(sourcePath);
    // Source masters stay in the workspace/package for regeneration; docs only
    // receives the optimized public derivatives described by the same manifest.
    if (asset.kind === 'source') continue;
    const contents = assetSources.get(sourcePath);
    if (!contents) throw new Error(`Asset source '${sourcePath}' was not loaded`);
    const outputPath = safeRelativePath(sourcePath);
    const portable = isPortableText(outputPath) ? toPortableText(contents) : asBuffer(contents);
    artifactContents.set(outputPath, portable);
    assetRecords.push({
      source: `packages/assets/${sourcePath}`,
      output: `${outputDirectoryRelative}/${outputPath}`,
      kind: asset.kind,
      format: asset.format,
      width: asset.width,
      height: asset.height,
      sha256: sha256(portable),
    });
  }

  const tokenPath = 'styles/tokens.css';
  if (artifactContents.has(tokenPath)) {
    throw new Error(`Brand asset path conflicts with exported design tokens '${tokenPath}'`);
  }
  const tokenBuffer = toPortableText(tokenContents);
  artifactContents.set(tokenPath, tokenBuffer);
  const staticManifest = {
    schemaVersion: 1,
    basePath: 'assets/moonwitness',
    generatedFrom: 'packages/assets/manifest.json and packages/ui/src/styles/tokens.css',
    sources: {
      assetManifest: assetManifestRelative,
      assetManifestSha256: sha256(toPortableText(assetManifestContents)),
      tokens: tokenSourceRelative,
      tokensSha256: sha256(tokenBuffer),
    },
    assets: assetRecords,
    stylesheets: [
      {
        source: tokenSourceRelative,
        output: `${outputDirectoryRelative}/${tokenPath}`,
        sha256: sha256(tokenBuffer),
      },
    ],
  };
  artifactContents.set(
    generatedManifestName,
    Buffer.from(`${JSON.stringify(staticManifest, null, 2)}\n`)
  );
  return artifactContents;
}

async function collectOutputFiles(directory) {
  const files = new Set();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const nested of await collectOutputFiles(target)) {
        files.add(path.posix.join(entry.name, nested));
      }
    } else if (entry.isFile()) files.add(entry.name);
    else throw new Error(`Unexpected non-file in generated docs asset directory: ${target}`);
  }
  return files;
}

async function readOwnedOutputs() {
  const manifestPath = path.join(outputDirectory, generatedManifestName);
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
      manifest.schemaVersion !== 1 ||
      manifest.basePath !== 'assets/moonwitness' ||
      !Array.isArray(manifest.assets) ||
      !Array.isArray(manifest.stylesheets)
    ) {
      throw new Error('Generated docs asset map has an unsupported format');
    }
    const outputs = new Set([generatedManifestName]);
    for (const item of [...manifest.assets, ...manifest.stylesheets]) {
      const prefix = `${outputDirectoryRelative}/`;
      if (typeof item.output !== 'string' || !item.output.startsWith(prefix)) {
        throw new Error('Generated docs asset map contains an output outside its owned directory');
      }
      outputs.add(safeRelativePath(item.output.slice(prefix.length)));
    }
    return outputs;
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
}

async function loadArtifactContents() {
  const manifestPath = path.join(packageRoot, assetManifestRelative);
  const assetManifestContents = await readFile(manifestPath);
  const assetManifest = JSON.parse(assetManifestContents.toString('utf8'));
  const assetSources = new Map();
  for (const asset of assetManifest.assets) {
    const sourcePath = safeRelativePath(asset.path);
    assetSources.set(sourcePath, await readFile(path.join(packageRoot, sourcePath)));
  }
  const tokenContents = await readFile(path.join(rootDirectory, tokenSourceRelative));
  return createDocAssetArtifacts({
    assetManifest,
    assetManifestContents,
    assetSources,
    tokenContents,
  });
}

export async function exportDocAssets({ check = false } = {}) {
  const artifacts = await loadArtifactContents();
  const expected = new Set(artifacts.keys());
  const currentFiles = await collectOutputFiles(outputDirectory);
  const ownedFiles = await readOwnedOutputs();
  const untrackedFiles = [...currentFiles].filter(
    (file) => !ownedFiles.has(file) && !expected.has(file)
  );
  if (untrackedFiles.length) {
    throw new Error(
      `Untracked files in generated docs assets: ${untrackedFiles.join(', ')}. Keep hand-authored files outside '${outputDirectoryRelative}'.`
    );
  }

  const staleFiles = [...currentFiles].filter((file) => !expected.has(file));
  const differences = [];
  for (const [relativePath, contents] of artifacts) {
    const target = resolveInsideOutput(relativePath);
    let current;
    try {
      current = await readFile(target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const comparable = current && isPortableText(relativePath) ? toPortableText(current) : current;
    if (comparable?.equals(contents)) continue;
    differences.push(relativePath);
    if (!check) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
  }
  if (staleFiles.length) {
    differences.push(...staleFiles.map((file) => `stale:${file}`));
    if (!check) {
      for (const staleFile of staleFiles) {
        await rm(resolveInsideOutput(staleFile));
      }
    }
  }
  if (check && differences.length) {
    throw new Error(
      `Static docs assets are stale: ${differences.join(', ')}. Run pnpm assets:export:docs.`
    );
  }
  return { assetCount: artifacts.size - 2, changedCount: differences.length };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  exportDocAssets({ check })
    .then(({ assetCount, changedCount }) => {
      const action = check ? 'Verified' : 'Exported';
      process.stdout.write(
        `${action} ${assetCount} design assets and one token stylesheet; ${changedCount} file(s) ${check ? 'stale' : 'updated'}.\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
