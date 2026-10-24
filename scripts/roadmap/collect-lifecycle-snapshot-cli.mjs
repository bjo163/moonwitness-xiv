import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  collectLifecycleSnapshot,
  completedExactDevPullRequestTechnicalGate,
  exactDevPullRequestTechnicalGate,
  flattenGitHubPages,
  isExactDevMainPullRequest,
  selectExactDevPullRequestCiRun,
} from './collect-lifecycle-snapshot.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const execFileAsync = promisify(execFile);

function git(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

export async function withGitHubReadRetry(
  read,
  { sleep = delay, maxAttempts = 3, initialDelayMs = 1_000 } = {}
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      const message = `${error.stderr ?? ''} ${error.message ?? ''}`;
      const transient = /HTTP 5(?:02|03|04)|couldn't respond to your request in time/iu.test(
        message
      );
      if (!transient || attempt >= maxAttempts) throw error;
      await sleep(initialDelayMs * 2 ** (attempt - 1));
    }
  }
}

async function ghJson(args) {
  const { stdout } = await withGitHubReadRetry(() =>
    execFileAsync('gh', ['api', '--paginate', '--slurp', ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    })
  );
  return JSON.parse(stdout);
}

async function ghJsonObject(args) {
  const { stdout } = await withGitHubReadRetry(() =>
    execFileAsync('gh', ['api', ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    })
  );
  return JSON.parse(stdout);
}

export async function readCurrentDevPullRequestTechnicalGate({
  repository,
  sourceSha,
  readDevHead,
  readWorkflowRuns,
  readPullRequest,
  readJobs,
}) {
  if ((await readDevHead()) !== sourceSha) return { status: 'stale' };
  const pages = await readWorkflowRuns();
  const run = selectExactDevPullRequestCiRun(pages, sourceSha);
  if (!run) return { status: 'ready', checkRuns: [] };

  const pullRequest = await readPullRequest(run.pull_request_number);
  if (!isExactDevMainPullRequest(pullRequest, sourceSha, repository, run.pull_request_number)) {
    if ((await readDevHead()) !== sourceSha) return { status: 'stale' };
    throw new Error(
      `The CI run for ${sourceSha} is not tied to a same-repository dev-to-main pull request.`
    );
  }

  const jobPages = await readJobs(run.id);
  if (run.status === 'completed') {
    return {
      status: 'ready',
      checkRuns: completedExactDevPullRequestTechnicalGate(run, jobPages),
    };
  }

  // A pending or missing gate cannot verify or close an issue. Capture the
  // current exact-SHA state and let the normal lifecycle rules keep it open;
  // a later push or scheduled reconciliation can observe the terminal gate.
  const gate = exactDevPullRequestTechnicalGate(run, jobPages);
  return { status: 'ready', checkRuns: gate ? [gate] : [] };
}

export async function writeSnapshotIfDevHeadIsCurrent({ sourceSha, readDevHead, writeSnapshot }) {
  if ((await readDevHead()) !== sourceSha) return false;
  await writeSnapshot();
  return true;
}

function isAncestor(sourceSha, branchHeadSha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sourceSha, branchHeadSha], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw new Error('Unable to verify local Git ancestry for lifecycle snapshot.', {
      cause: error,
    });
  }
}

function hasCommit(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    if (error.status === 1 || error.status === 128) return false;
    throw new Error('Unable to resolve evidence source commit.', { cause: error });
  }
}

function resolveReleaseCommit(tag) {
  if (!/^v?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u.test(tag))
    return undefined;
  try {
    return git(['rev-parse', `refs/tags/${tag}^{commit}`]);
  } catch {
    return undefined;
  }
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const repositoryId = process.env.GITHUB_REPOSITORY_ID;
  const eventSha = process.env.SOURCE_SHA ?? process.env.GITHUB_SHA;
  if (!repository || !repositoryId || !eventSha)
    throw new Error(
      'GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID and a workflow source SHA are required.'
    );
  execFileSync(
    process.execPath,
    [path.join(repositoryRoot, 'scripts/roadmap/validate-roadmap.mjs')],
    {
      cwd: repositoryRoot,
      stdio: 'inherit',
    }
  );
  const currentSha = git(['rev-parse', 'HEAD']);
  if (currentSha !== eventSha)
    throw new Error('Checkout HEAD does not match the workflow event SHA.');
  const index = JSON.parse(
    await readFile(path.join(repositoryRoot, 'docs/roadmap/tasks.json'), 'utf8')
  );
  const roadmap = await readFile(path.join(repositoryRoot, 'ROADMAP.md'), 'utf8');
  const branchHeads = {
    dev: git(['rev-parse', 'refs/remotes/origin/dev']),
    main: git(['rev-parse', 'refs/remotes/origin/main']),
  };
  const [gateResult, releasePages] = await Promise.all([
    readCurrentDevPullRequestTechnicalGate({
      repository,
      sourceSha: branchHeads.dev,
      readDevHead: async () =>
        (await ghJsonObject([`repos/${repository}/git/ref/heads/dev`])).object?.sha,
      readWorkflowRuns: () =>
        ghJson([
          `repos/${repository}/actions/workflows/ci.yml/runs?branch=dev&event=pull_request&per_page=100`,
        ]),
      readPullRequest: (number) => ghJsonObject([`repos/${repository}/pulls/${number}`]),
      readJobs: (runId) => ghJson([`repos/${repository}/actions/runs/${runId}/jobs?per_page=100`]),
    }),
    ghJson([`repos/${repository}/releases?per_page=100`]),
  ]);
  if (gateResult.status === 'stale') {
    process.stdout.write(
      `Skipping stale issue-sync event: dev advanced beyond ${branchHeads.dev}.\n`
    );
    return;
  }
  const checkRuns = gateResult.checkRuns;
  const releases = flattenGitHubPages(releasePages);
  const snapshot = await collectLifecycleSnapshot({
    tasks: index.tasks,
    roadmap,
    readEvidence: async (relativePath) => {
      const absolutePath = path.resolve(repositoryRoot, relativePath);
      if (!absolutePath.startsWith(`${repositoryRoot}${path.sep}`))
        throw new Error('Evidence path escapes the repository.');
      try {
        return await readFile(absolutePath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw error;
      }
    },
    repositoryId,
    sourceSha: eventSha,
    branchHeads,
    checkRuns,
    releases,
    resolveReleaseCommit,
    commitExists: hasCommit,
    isAncestor,
  });
  const snapshotWritten = await writeSnapshotIfDevHeadIsCurrent({
    sourceSha: branchHeads.dev,
    readDevHead: async () =>
      (await ghJsonObject([`repos/${repository}/git/ref/heads/dev`])).object?.sha,
    writeSnapshot: async () =>
      writeFile(
        path.join(repositoryRoot, '.roadmap-lifecycle-snapshot.json'),
        `${JSON.stringify(snapshot, null, 2)}\n`,
        'utf8'
      ),
  });
  if (!snapshotWritten) {
    process.stdout.write(
      `Skipping stale issue-sync event: dev advanced beyond ${branchHeads.dev}.\n`
    );
    return;
  }
  process.stdout.write(
    `Collected read-only lifecycle snapshot for ${snapshot.tasks.length} tasks at ${snapshot.sourceSha}.\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
