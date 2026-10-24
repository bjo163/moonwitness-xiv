import { readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export async function listInventoryMedia(packageRoot, directories) {
  const files = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        const assetPath = relative(packageRoot, fullPath).split(sep).join('/');
        if (/^fonts\/OFL-[^/]+\.txt$/u.test(assetPath)) continue;
        files.push(assetPath);
      }
    }
  }

  for (const directory of directories) await visit(resolve(packageRoot, directory));
  return files.sort();
}

export function compareAssetInventory(manifestPaths, packageFiles) {
  const listed = new Set(manifestPaths);
  const present = new Set(packageFiles);
  return {
    unlistedFiles: packageFiles.filter((path) => !listed.has(path)).sort(),
    missingFiles: manifestPaths.filter((path) => !present.has(path)).sort(),
  };
}
