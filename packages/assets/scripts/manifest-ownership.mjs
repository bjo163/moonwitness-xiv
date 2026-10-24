/** Replace only the explicitly owned generator outputs in a shared asset inventory. */
export function replaceGeneratedAssets(existingAssets, generatedAssets, ownedPaths) {
  if (!Array.isArray(existingAssets) || !Array.isArray(generatedAssets)) {
    throw new TypeError('Asset manifest entries must be arrays.');
  }
  if (!(ownedPaths instanceof Set)) {
    throw new TypeError('A Set of paths owned by this generator is required.');
  }

  const generatedPaths = new Set();
  for (const asset of generatedAssets) {
    if (typeof asset?.path !== 'string' || !asset.path) {
      throw new TypeError('Every generated asset must have a non-empty path.');
    }
    if (!ownedPaths.has(asset.path)) {
      throw new Error(`Generator output is not declared as owned: ${asset.path}`);
    }
    if (generatedPaths.has(asset.path)) {
      throw new Error(`Generator produced the same asset more than once: ${asset.path}`);
    }
    generatedPaths.add(asset.path);
  }

  const retained = existingAssets.filter((asset) => !ownedPaths.has(asset.path));
  const merged = [...retained, ...generatedAssets];
  const seen = new Set();
  for (const asset of merged) {
    if (typeof asset?.path !== 'string' || !asset.path) {
      throw new TypeError('Every manifest asset must have a non-empty path.');
    }
    if (seen.has(asset.path)) {
      throw new Error(`Duplicate asset manifest path after generator update: ${asset.path}`);
    }
    seen.add(asset.path);
  }

  return merged.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}
