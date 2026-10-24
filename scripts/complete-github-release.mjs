import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';
import { completeGitHubRelease } from './github-release-lifecycle.mjs';

const execFile = promisify(execFileCallback);
const tag = process.env.RELEASE_TAG;
const repository = process.env.GH_REPOSITORY;
const updateLatest = process.env.UPDATE_LATEST === 'true';
const prerelease = typeof tag === 'string' && tag.includes('-');

async function runGh(args) {
  try {
    const { stdout } = await execFile('gh', args, { maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch {
    throw new Error('GitHub CLI release operation failed');
  }
}

async function readRelease(releaseTag) {
  try {
    const { stdout } = await execFile(
      'gh',
      ['api', `repos/${repository}/releases/tags/${releaseTag}`],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const release = JSON.parse(stdout);
    if (!Number.isSafeInteger(release.id)) throw new Error('Invalid release ID');
    return {
      tagName: release.tag_name,
      id: release.id,
      isDraft: release.draft,
      isPrerelease: release.prerelease,
    };
  } catch (error) {
    if (error?.code === 1 && /HTTP 404\b/u.test(error.stderr ?? '')) return null;
    throw new Error(`Unable to inspect GitHub release ${releaseTag}`, { cause: error });
  }
}

async function main() {
  if (
    typeof tag !== 'string' ||
    !/^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
      tag
    ) ||
    typeof repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    (prerelease && updateLatest)
  ) {
    throw new Error('Invalid GitHub release configuration');
  }

  const assetPaths = [
    'release-images/release-api.spdx.json',
    'release-images/release-board.spdx.json',
    'release-images/release-assets.sha256',
  ];
  const files = await Promise.all(
    assetPaths.map(async (path) => {
      const contents = await readFile(path);
      return {
        path,
        name: basename(path),
        digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
        size: contents.byteLength,
      };
    })
  );

  const result = await completeGitHubRelease({
    tag,
    prerelease,
    updateLatest,
    files,
    adapter: {
      getReleaseByTag: readRelease,
      async createDraft(releaseTag, isPrerelease) {
        const args = [
          'release',
          'create',
          releaseTag,
          '--repo',
          repository,
          '--verify-tag',
          '--generate-notes',
          '--draft',
          '--latest=false',
        ];
        if (isPrerelease) args.push('--prerelease');
        await runGh(args);
      },
      async listAssets(releaseId) {
        const pages = JSON.parse(
          await runGh([
            'api',
            '--paginate',
            '--slurp',
            `repos/${repository}/releases/${releaseId}/assets?per_page=100`,
          ])
        );
        if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
          throw new Error('GitHub returned an invalid release asset list');
        }
        return pages.flat().map((asset) => ({
          name: asset.name,
          size: asset.size,
          digest: asset.digest,
        }));
      },
      async uploadAsset(releaseTag, path) {
        await runGh(['release', 'upload', releaseTag, path, '--repo', repository]);
      },
      async verifyAsset(releaseTag, path) {
        await runGh(['release', 'verify-asset', releaseTag, path, '--repo', repository]);
      },
      async publishRelease(releaseTag, options) {
        const args = ['release', 'edit', releaseTag, '--repo', repository, '--draft=false'];
        if (options.prerelease) args.push('--prerelease', '--latest=false');
        else args.push(options.updateLatest ? '--latest' : '--latest=false');
        await runGh(args);
      },
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Release completion failed'}\n`);
  process.exitCode = 1;
});
