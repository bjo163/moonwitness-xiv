import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const tagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?$/u;
const shaPattern = /^[a-f0-9]{40}$/u;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function planReleaseTag({ tag, sha, remoteSha, localSha }) {
  if (!tagPattern.test(tag ?? '')) throw new Error('Release tag must be a supported version tag.');
  if (!shaPattern.test(sha ?? '')) throw new Error('Release tag requires a full commit SHA.');
  if (remoteSha && remoteSha !== sha)
    throw new Error(`Remote tag ${tag} already points at ${remoteSha}; refusing to overwrite it.`);
  if (remoteSha === sha) return { action: 'reuse', tag, sha };
  if (localSha && localSha !== sha)
    throw new Error(`Local tag ${tag} points at ${localSha}; refusing to move it.`);
  return { action: 'create', tag, sha };
}

function readRemoteTag(tag, remote, cwd) {
  const output = git(
    ['ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    cwd
  );
  let resolved = null;
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const [sha, reference] = line.trim().split(/\s+/u);
    if (reference === `refs/tags/${tag}^{}`) return sha;
    resolved = sha;
  }
  return resolved;
}

function readLocalTag(tag, cwd) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], cwd);
  } catch {
    return null;
  }
}

export function createReleaseTag(tag, sha, { remote = 'origin', cwd = process.cwd() } = {}) {
  git(['cat-file', '-e', `${sha}^{commit}`], cwd);
  const plan = planReleaseTag({
    tag,
    sha,
    remoteSha: readRemoteTag(tag, remote, cwd),
    localSha: readLocalTag(tag, cwd),
  });
  if (plan.action === 'reuse') return { created: false, tag, sha };

  if (!readLocalTag(tag, cwd))
    git(
      [
        '-c',
        'user.name=github-actions[bot]',
        '-c',
        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'tag',
        '-a',
        tag,
        '-m',
        `Release ${tag}`,
        sha,
      ],
      cwd
    );
  try {
    git(['push', remote, `refs/tags/${tag}`], cwd);
  } catch (error) {
    const remoteSha = readRemoteTag(tag, remote, cwd);
    if (remoteSha === sha) return { created: true, tag, sha, recovered: true };
    throw error;
  }
  const remoteSha = readRemoteTag(tag, remote, cwd);
  if (remoteSha !== sha) throw new Error(`Remote tag ${tag} did not resolve to ${sha} after push.`);
  return { created: true, tag, sha };
}

function main() {
  const [tag, sha, remote] = process.argv.slice(2);
  if (!tag || !sha) throw new Error('Usage: node create-release-tag.mjs <tag> <sha> [remote]');
  const result = createReleaseTag(tag, sha, remote ? { remote } : undefined);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
