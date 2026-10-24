import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { reconcileReleaseAssets } from '../reconcile-release-assets.mjs';

const execFile = promisify(execFileCallback);
const STABLE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SOURCE_SHA = /^[a-f0-9]{40}$/u;

async function validateRelease({ tag, sourceSha, release, resolveTagCommit, file, adapter }) {
  if (typeof tag !== 'string' || !STABLE_TAG.test(tag)) {
    throw new Error('Versioned documentation requires a stable semantic release tag');
  }
  if (typeof sourceSha !== 'string' || !SOURCE_SHA.test(sourceSha)) {
    throw new Error('Invalid versioned documentation source SHA');
  }
  if (
    !release ||
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.published_at !== 'string' ||
    release.published_at.length === 0
  ) {
    throw new Error('Release is not the matching published stable release');
  }
  if (typeof resolveTagCommit !== 'function') {
    throw new Error('Release tag commit resolver is required');
  }
  if ((await resolveTagCommit(tag)) !== sourceSha) {
    throw new Error('Release tag does not match the exact documentation source SHA');
  }
  if (!file || typeof file.path !== 'string' || basename(file.path) !== `docs-site-${tag}.tar.gz`) {
    throw new Error('Versioned documentation archive name does not match the release tag');
  }
  if (!adapter) throw new Error('Release asset adapter is required');
}

/** Store the archive for its exact stable tag; published releases may receive this missing asset once. */
export async function reconcileVersionedDocsAsset({
  tag,
  sourceSha,
  release,
  resolveTagCommit,
  file,
  adapter,
}) {
  await validateRelease({ tag, sourceSha, release, resolveTagCommit, file, adapter });
  return reconcileReleaseAssets({
    tag,
    releaseId: release.id,
    isDraft: release.draft,
    files: [file],
    adapter,
    allowPublishedAdditions: true,
  });
}

async function runGh(args) {
  try {
    const { stdout } = await execFile('gh', args, { maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch {
    throw new Error('GitHub documentation release asset operation failed');
  }
}

async function readJsonGh(args) {
  const output = await runGh(args);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('GitHub returned invalid JSON for the documentation release');
  }
}

async function resolveTagCommit(tag) {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--verify', `${tag}^{commit}`]);
    return stdout.trim();
  } catch {
    throw new Error('Unable to resolve the stable release tag commit');
  }
}

async function main() {
  const repository = process.env.GH_REPOSITORY;
  const tag = process.env.RELEASE_TAG;
  const sourceSha = process.env.SOURCE_SHA;
  const filePath = process.env.DOCS_ARCHIVE_PATH ?? process.argv[2];
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error('Invalid GitHub repository for documentation asset reconciliation');
  }
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Documentation archive path is required');
  }
  if (typeof tag !== 'string' || !STABLE_TAG.test(tag)) {
    throw new Error('Versioned documentation requires a stable semantic release tag');
  }
  if (typeof sourceSha !== 'string' || !SOURCE_SHA.test(sourceSha)) {
    throw new Error('Invalid versioned documentation source SHA');
  }
  const name = basename(filePath);
  if (name !== `docs-site-${tag}.tar.gz`) {
    throw new Error('Versioned documentation archive name does not match the release tag');
  }
  const contents = await readFile(filePath);
  const file = {
    path: filePath,
    name,
    digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
    size: contents.byteLength,
  };
  const release = await readJsonGh(['api', `repos/${repository}/releases/tags/${tag}`]);
  const results = await reconcileVersionedDocsAsset({
    tag,
    sourceSha,
    release,
    resolveTagCommit,
    file,
    adapter: {
      async listAssets(releaseId) {
        const pages = await readJsonGh([
          'api',
          '--paginate',
          '--slurp',
          `repos/${repository}/releases/${releaseId}/assets?per_page=100`,
        ]);
        if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
          throw new Error('GitHub returned invalid documentation release asset pages');
        }
        return pages.flat();
      },
      async uploadAsset(releaseTag, path) {
        await runGh(['release', 'upload', releaseTag, path, '--repo', repository]);
      },
    },
  });
  process.stdout.write(`${JSON.stringify({ tag, sourceSha, assets: results })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    globalThis.console.error(
      error instanceof Error ? error.message : 'Versioned documentation reconciliation failed'
    );
    process.exitCode = 1;
  });
}
