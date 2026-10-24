import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsonImportPattern = /\bfrom\s*(['"])(\.\.?\/[^'"]+\.json)\1(?:\s+with\s*\{[^}]*\})?/gu;

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listJavaScriptFiles(entryPath);
      return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
    })
  );
  return nested.flat();
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/**
 * Copy external JSON assets referenced by deployed workspace package output to
 * the exact relative location Node resolves from the deployed module path.
 * pnpm deploy relocates workspace packages into its virtual store, so imports
 * that reach back to the repository root need these source assets staged too.
 */
export async function prepareApiRuntimeAssets({ root = repositoryRoot, deployDirectory }) {
  if (typeof deployDirectory !== 'string' || deployDirectory.trim() === '') {
    throw new TypeError('An API deployment directory is required.');
  }

  const resolvedRoot = path.resolve(root);
  const resolvedDeploy = path.resolve(deployDirectory);
  const realRoot = await realpath(resolvedRoot);
  const realDeploy = await realpath(resolvedDeploy);
  const apiManifest = JSON.parse(await readFile(path.join(resolvedDeploy, 'package.json'), 'utf8'));
  if (apiManifest.name !== '@moonwitness/api') {
    throw new Error('Runtime asset staging requires an @moonwitness/api deployment.');
  }

  const packageDirectory = path.join(resolvedRoot, 'packages');
  const packageNames = await readdir(packageDirectory, { withFileTypes: true });
  const copiedAssets = new Set();

  for (const entry of packageNames) {
    if (!entry.isDirectory()) continue;
    const sourcePackageRoot = path.join(packageDirectory, entry.name);
    const sourceManifestPath = path.join(sourcePackageRoot, 'package.json');
    let sourceManifest;
    try {
      sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (
      typeof sourceManifest.name !== 'string' ||
      !sourceManifest.name.startsWith('@moonwitness/')
    ) {
      continue;
    }
    if (!/^@moonwitness\/[a-z0-9-]+$/u.test(sourceManifest.name)) {
      throw new Error('Invalid workspace package name: ' + sourceManifest.name);
    }

    const deployedPackagePath = path.join(
      resolvedDeploy,
      'node_modules',
      ...sourceManifest.name.split('/')
    );
    let deployedPackageRoot;
    try {
      deployedPackageRoot = await realpath(deployedPackagePath);
    } catch {
      // The workspace package is not part of this API's production dependency graph.
      continue;
    }
    if (!isWithin(realDeploy, deployedPackageRoot)) {
      throw new Error(
        'Deployed workspace package escapes the API deployment: ' + sourceManifest.name
      );
    }

    const sourceDistRoot = path.join(sourcePackageRoot, 'dist');
    let sourceFiles;
    try {
      sourceFiles = await listJavaScriptFiles(sourceDistRoot);
    } catch {
      continue;
    }

    for (const sourceModule of sourceFiles) {
      const sourceText = await readFile(sourceModule, 'utf8');
      const imports = [...sourceText.matchAll(jsonImportPattern)];
      for (const match of imports) {
        const specifier = match[2];
        if (!specifier) continue;
        const sourceAsset = path.resolve(path.dirname(sourceModule), specifier);
        if (!isWithin(resolvedRoot, sourceAsset)) {
          throw new Error(`Runtime JSON import escapes the repository: ${specifier}`);
        }
        const sourceAssetRelative = path.relative(sourceDistRoot, sourceAsset);
        if (!sourceAssetRelative.startsWith(`..${path.sep}`) && sourceAssetRelative !== '..')
          continue;
        const realSourceAsset = await realpath(sourceAsset);
        if (!isWithin(realRoot, realSourceAsset)) {
          throw new Error('Runtime JSON asset resolves outside the repository: ' + specifier);
        }
        const sourceAssetStat = await stat(realSourceAsset);
        if (!sourceAssetStat.isFile()) {
          throw new Error(`Runtime JSON import is not a file: ${specifier}`);
        }

        const moduleRelative = path.relative(sourceDistRoot, sourceModule);
        const deployedModule = path.resolve(deployedPackageRoot, 'dist', moduleRelative);
        const deployedAsset = path.resolve(path.dirname(deployedModule), specifier);
        if (!isWithin(resolvedDeploy, deployedAsset)) {
          throw new Error(`Runtime JSON destination escapes the API deployment: ${specifier}`);
        }

        await mkdir(path.dirname(deployedAsset), { recursive: true });
        const realDestinationDirectory = await realpath(path.dirname(deployedAsset));
        if (!isWithin(realDeploy, realDestinationDirectory)) {
          throw new Error(
            'Runtime JSON destination resolves outside the API deployment: ' + specifier
          );
        }
        try {
          const existingStat = await lstat(deployedAsset);
          if (!existingStat.isFile()) {
            throw new Error('Runtime JSON destination is not a regular file: ' + deployedAsset);
          }
          const existing = await readFile(deployedAsset);
          const source = await readFile(realSourceAsset);
          if (!existing.equals(source)) {
            throw new Error(
              `Conflicting runtime JSON asset at ${path.relative(resolvedDeploy, deployedAsset)}.`
            );
          }
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            await copyFile(realSourceAsset, deployedAsset);
          } else {
            throw error;
          }
        }
        copiedAssets.add(deployedAsset);
      }
    }
  }

  return { copiedAssetCount: copiedAssets.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deployDirectory = process.argv[2];
  const { copiedAssetCount } = await prepareApiRuntimeAssets({ deployDirectory });
  process.stdout.write(`Prepared ${copiedAssetCount} external workspace JSON runtime asset(s).\n`);
}
