import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const execFile = promisify(execFileCallback);
const TAG_PATTERN =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function validateReleaseAssets({ tag, releaseId, isDraft, files, adapter }) {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) throw new Error('Invalid release tag');
  if (!Number.isSafeInteger(releaseId) || releaseId < 1) throw new Error('Invalid release ID');
  if (typeof isDraft !== 'boolean') throw new Error('Invalid release draft state');
  if (!Array.isArray(files) || files.length === 0) throw new Error('Release assets are required');
  if (
    !adapter ||
    typeof adapter.listAssets !== 'function' ||
    typeof adapter.uploadAsset !== 'function'
  ) {
    throw new Error('Release asset adapter is incomplete');
  }

  const names = new Set();
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      file.path.length === 0 ||
      typeof file.name !== 'string' ||
      file.name.length === 0 ||
      basename(file.path) !== file.name ||
      !DIGEST_PATTERN.test(file.digest) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      throw new Error('Invalid release asset descriptor');
    }
    if (names.has(file.name)) throw new Error(`Duplicate expected release asset ${file.name}`);
    names.add(file.name);
  }
}

function assetMap(assets) {
  if (!Array.isArray(assets)) throw new Error('GitHub returned an invalid release asset list');
  const byName = new Map();
  for (const asset of assets) {
    if (
      !asset ||
      typeof asset.name !== 'string' ||
      typeof asset.size !== 'number' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      (asset.digest !== null && asset.digest !== undefined && typeof asset.digest !== 'string')
    ) {
      throw new Error('GitHub returned an invalid release asset record');
    }
    if (byName.has(asset.name)) throw new Error(`GitHub returned duplicate asset ${asset.name}`);
    byName.set(asset.name, asset);
  }
  return byName;
}

function matchesExpected(actual, expected) {
  return actual?.digest === expected.digest && actual.size === expected.size;
}

/** Reconcile immutable release assets, recovering ambiguous uploads by re-reading remote state. */
export async function reconcileReleaseAssets({
  tag,
  releaseId,
  isDraft,
  files,
  adapter,
  allowPublishedAdditions = false,
}) {
  if (typeof allowPublishedAdditions !== 'boolean') {
    throw new Error('Invalid published release addition policy');
  }
  validateReleaseAssets({ tag, releaseId, isDraft, files, adapter });
  const current = assetMap(await adapter.listAssets(releaseId));

  for (const file of files) {
    const existing = current.get(file.name);
    if (existing && !matchesExpected(existing, file)) {
      throw new Error(`Existing release asset ${file.name} conflicts with the verified file`);
    }
    if (!existing && !isDraft) {
      if (!allowPublishedAdditions) {
        throw new Error(`Cannot add missing asset ${file.name} to a published release`);
      }
    }
  }

  const results = [];
  for (const file of files) {
    if (current.has(file.name)) {
      results.push({ name: file.name, action: 'reused', digest: file.digest });
      continue;
    }

    let uploadError;
    try {
      await adapter.uploadAsset(tag, file.path);
    } catch {
      // Upload timeouts are ambiguous: the server may have accepted the bytes.
      uploadError = new Error(`Upload command failed for release asset ${file.name}`);
    }

    let afterUpload;
    try {
      afterUpload = assetMap(await adapter.listAssets(releaseId));
    } catch {
      throw new Error(`Unable to verify release asset ${file.name} after upload`);
    }

    const accepted = afterUpload.get(file.name);
    if (!accepted) {
      if (uploadError) throw uploadError;
      throw new Error(`Release asset ${file.name} was not present after upload`);
    }
    if (!matchesExpected(accepted, file)) {
      throw new Error(`Uploaded release asset ${file.name} conflicts with the verified file`);
    }
    results.push({
      name: file.name,
      action: uploadError ? 'recovered' : 'uploaded',
      digest: file.digest,
    });
  }

  return results;
}

async function runGh(args) {
  try {
    const { stdout } = await execFile('gh', args, { maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch {
    throw new Error('GitHub CLI release asset operation failed');
  }
}

async function readJsonGh(args) {
  const output = await runGh(args);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('GitHub CLI returned invalid JSON for release assets');
  }
}

async function main() {
  const repository = process.env.GH_REPOSITORY;
  const tag = process.env.RELEASE_TAG;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error('Invalid GitHub repository for release asset reconciliation');
  }
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) throw new Error('Invalid release tag');

  const release = await readJsonGh(['api', `repos/${repository}/releases/tags/${tag}`]);
  if (
    typeof release !== 'object' ||
    release === null ||
    release.tag_name !== tag ||
    !Number.isSafeInteger(release.id) ||
    typeof release.draft !== 'boolean'
  ) {
    throw new Error('GitHub returned an invalid release record');
  }

  const paths = [
    'release-images/release-api.spdx.json',
    'release-images/release-board.spdx.json',
    'release-images/release-assets.sha256',
  ];
  const files = await Promise.all(
    paths.map(async (path) => {
      const contents = await readFile(path);
      return {
        path,
        name: basename(path),
        digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
        size: contents.byteLength,
      };
    })
  );

  const results = await reconcileReleaseAssets({
    tag,
    releaseId: release.id,
    isDraft: release.draft,
    files,
    adapter: {
      async listAssets(releaseId) {
        const pages = await readJsonGh([
          'api',
          '--paginate',
          '--slurp',
          `repos/${repository}/releases/${releaseId}/assets?per_page=100`,
        ]);
        if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
          throw new Error('GitHub returned an invalid release asset page');
        }
        return pages.flat();
      },
      async uploadAsset(releaseTag, path) {
        await runGh(['release', 'upload', releaseTag, path]);
      },
    },
  });
  process.stdout.write(`${JSON.stringify({ tag, assets: results })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    globalThis.console.error(
      error instanceof Error ? error.message : 'Release asset reconciliation failed'
    );
    process.exitCode = 1;
  });
}
