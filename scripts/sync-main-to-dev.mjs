import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { pushExpectedRef } from './push-expected-ref.mjs';

const MAIN_REF = 'refs/heads/main';
const DEV_REF = 'refs/heads/dev';
const REMOTE_MAIN_REF = 'refs/remotes/origin/main';
const REMOTE_DEV_REF = 'refs/remotes/origin/dev';

function runGit(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createGitAdapter() {
  return {
    remoteSha(remote, ref) {
      const output = runGit(['ls-remote', '--refs', remote, ref]);
      return output.split(/\s+/u)[0] ?? '';
    },
    fetch(remote) {
      runGit([
        'fetch',
        '--no-tags',
        remote,
        `${MAIN_REF}:${REMOTE_MAIN_REF}`,
        `${DEV_REF}:${REMOTE_DEV_REF}`,
      ]);
    },
    resolve(ref) {
      return runGit(['rev-parse', ref]);
    },
    isAncestor(ancestor, descendant) {
      try {
        runGit(['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      } catch (error) {
        if (error?.status === 1) return false;
        throw error;
      }
    },
    checkoutDetached(ref) {
      runGit(['checkout', '--detach', ref]);
    },
    configureIdentity() {
      runGit(['config', 'user.name', 'github-actions[bot]']);
      runGit(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
    },
    merge(ref) {
      runGit(['merge', '--no-ff', '--no-edit', ref]);
    },
    pushExpectedRef(remote, sourceRef, targetRef, expectedSha) {
      return pushExpectedRef(remote, sourceRef, targetRef, expectedSha);
    },
  };
}

/**
 * Merge the exact main event into dev without overwriting concurrent dev work.
 * The injected adapter keeps the decision flow testable without hosted writes.
 */
export function syncMainToDev({
  expectedMainSha,
  eventRef,
  remote = 'origin',
  git = createGitAdapter(),
}) {
  if (eventRef !== 'refs/heads/main') {
    throw new Error(`Sync must run from main, received ${eventRef || '(missing)'}.`);
  }
  if (!/^[0-9a-f]{40,64}$/iu.test(expectedMainSha ?? '')) {
    throw new Error('Expected main SHA must be a full hexadecimal object ID.');
  }

  const currentMain = git.remoteSha(remote, MAIN_REF);
  if (currentMain !== expectedMainSha) {
    return { status: 'stale-main', expectedMainSha, currentMain };
  }

  git.fetch(remote);
  const expectedDevSha = git.resolve(REMOTE_DEV_REF);
  if (git.isAncestor(REMOTE_MAIN_REF, REMOTE_DEV_REF)) {
    return { status: 'already-synced', expectedMainSha, expectedDevSha };
  }

  git.checkoutDetached(expectedDevSha);
  git.configureIdentity();
  git.merge(REMOTE_MAIN_REF);

  const currentMainAfterMerge = git.remoteSha(remote, MAIN_REF);
  if (currentMainAfterMerge !== expectedMainSha) {
    return {
      status: 'main-advanced',
      expectedMainSha,
      currentMain: currentMainAfterMerge,
    };
  }

  const currentDev = git.remoteSha(remote, DEV_REF);
  if (currentDev !== expectedDevSha) {
    throw new Error(
      `dev advanced during synchronization; refusing to overwrite it (expected ${expectedDevSha}, found ${currentDev || '(missing)'}).`
    );
  }

  const pushed = git.pushExpectedRef(remote, 'HEAD', DEV_REF, expectedDevSha);
  return { status: 'synced', expectedMainSha, expectedDevSha, pushed };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = syncMainToDev({
      expectedMainSha: process.env.EXPECTED_MAIN_SHA,
      eventRef: process.env.EVENT_REF,
    });
    if (result.status === 'stale-main') {
      process.stdout.write(
        `Skipping stale sync for ${result.expectedMainSha}; main is now ${result.currentMain || '(missing)'}\n`
      );
    } else if (result.status === 'already-synced') {
      process.stdout.write('dev already contains current main\n');
    } else if (result.status === 'main-advanced') {
      process.stdout.write('main advanced during synchronization; no push performed\n');
    } else {
      process.stdout.write(`Synchronized main ${result.expectedMainSha} into dev.\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
