import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import process from 'node:process';
import { syncMainToDev } from './sync-main-to-dev.mjs';
import { pushExpectedRef } from './push-expected-ref.mjs';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function configureIdentity(cwd, name) {
  git(cwd, ['config', 'user.name', name]);
  git(cwd, ['config', 'user.email', `${name}@example.test`]);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'moonwitness-main-dev-sync-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const bot = join(root, 'bot');
  const human = join(root, 'human');
  git(root, ['init', '--bare', remote]);
  git(root, ['init', seed]);
  configureIdentity(seed, 'seed');
  writeFileSync(join(seed, 'base.txt'), 'base\n', 'utf8');
  git(seed, ['add', 'base.txt']);
  git(seed, ['commit', '-m', 'base']);
  git(seed, ['branch', '-M', 'main']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(seed, ['checkout', '-b', 'dev']);
  git(seed, ['push', '-u', 'origin', 'dev']);
  git(seed, ['checkout', 'main']);
  writeFileSync(join(seed, 'main.txt'), 'main change\n', 'utf8');
  git(seed, ['add', 'main.txt']);
  git(seed, ['commit', '-m', 'main change']);
  git(seed, ['push', 'origin', 'main']);
  git(root, ['clone', remote, bot]);
  configureIdentity(bot, 'bot');
  git(bot, ['checkout', '-B', 'main', 'origin/main']);
  return { root, remote, seed, bot, human };
}

function adapterFor(bot, beforeRemoteSha = () => {}) {
  return {
    remoteSha(remote, ref) {
      beforeRemoteSha(remote, ref);
      return git(bot, ['ls-remote', '--refs', remote, ref]).split(/\s+/u)[0] ?? '';
    },
    fetch(remote) {
      git(bot, [
        'fetch',
        '--no-tags',
        remote,
        'refs/heads/main:refs/remotes/origin/main',
        'refs/heads/dev:refs/remotes/origin/dev',
      ]);
    },
    resolve(ref) {
      return git(bot, ['rev-parse', ref]);
    },
    isAncestor(ancestor, descendant) {
      try {
        git(bot, ['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      } catch (error) {
        if (error?.status === 1) return false;
        throw error;
      }
    },
    checkoutDetached(ref) {
      git(bot, ['checkout', '--detach', ref]);
    },
    configureIdentity() {
      configureIdentity(bot, 'bot');
    },
    merge(ref) {
      git(bot, ['merge', '--no-ff', '--no-edit', ref]);
    },
    pushExpectedRef(remote, sourceRef, targetRef, expectedSha) {
      const previousCwd = process.cwd();
      process.chdir(bot);
      try {
        return pushExpectedRef(remote, sourceRef, targetRef, expectedSha);
      } finally {
        process.chdir(previousCwd);
      }
    },
  };
}

function mainSha(remote) {
  return git(remote, ['rev-parse', 'refs/heads/main']);
}

function devSha(remote) {
  return git(remote, ['rev-parse', 'refs/heads/dev']);
}

test('stale main event exits without changing dev or checking out a merge candidate', () => {
  const fixture = createFixture();
  try {
    const staleSha = mainSha(fixture.remote);
    writeFileSync(join(fixture.seed, 'later-main.txt'), 'later\n', 'utf8');
    git(fixture.seed, ['add', 'later-main.txt']);
    git(fixture.seed, ['commit', '-m', 'advance main']);
    git(fixture.seed, ['push', 'origin', 'main']);
    const beforeDev = devSha(fixture.remote);
    const beforeHead = git(fixture.bot, ['rev-parse', 'HEAD']);

    const result = syncMainToDev({
      expectedMainSha: staleSha,
      eventRef: 'refs/heads/main',
      git: adapterFor(fixture.bot),
    });

    assert.equal(result.status, 'stale-main');
    assert.equal(devSha(fixture.remote), beforeDev);
    assert.equal(git(fixture.bot, ['rev-parse', 'HEAD']), beforeHead);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('dev already containing current main is a no-op', () => {
  const fixture = createFixture();
  try {
    git(fixture.seed, ['checkout', 'dev']);
    git(fixture.seed, ['merge', '--ff-only', 'main']);
    git(fixture.seed, ['push', 'origin', 'dev']);
    const beforeDev = devSha(fixture.remote);

    const result = syncMainToDev({
      expectedMainSha: mainSha(fixture.remote),
      eventRef: 'refs/heads/main',
      git: adapterFor(fixture.bot),
    });

    assert.equal(result.status, 'already-synced');
    assert.equal(devSha(fixture.remote), beforeDev);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a concurrent dev update after merge is preserved and synchronization fails closed', () => {
  const fixture = createFixture();
  try {
    git(fixture.root, ['clone', '--branch', 'dev', fixture.remote, fixture.human]);
    configureIdentity(fixture.human, 'human');
    let raceInjected = false;
    let humanHead = '';
    const gitAdapter = adapterFor(fixture.bot, (remote, ref) => {
      if (ref !== 'refs/heads/dev' || raceInjected) return;
      raceInjected = true;
      writeFileSync(join(fixture.human, 'human.txt'), 'human change\n', 'utf8');
      git(fixture.human, ['add', 'human.txt']);
      git(fixture.human, ['commit', '-m', 'concurrent dev update']);
      git(fixture.human, ['push', 'origin', 'HEAD:refs/heads/dev']);
      humanHead = git(fixture.human, ['rev-parse', 'HEAD']);
    });
    let pushCalled = false;
    gitAdapter.pushExpectedRef = () => {
      pushCalled = true;
      throw new Error('unexpected candidate push');
    };

    assert.throws(
      () =>
        syncMainToDev({
          expectedMainSha: mainSha(fixture.remote),
          eventRef: 'refs/heads/main',
          git: gitAdapter,
        }),
      /dev advanced during synchronization; refusing to overwrite it/u
    );
    assert.equal(pushCalled, false);
    assert.equal(devSha(fixture.remote), humanHead);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('main advancing after the local merge prevents the candidate push', () => {
  const fixture = createFixture();
  try {
    const beforeDev = devSha(fixture.remote);
    const gitAdapter = adapterFor(fixture.bot);
    const merge = gitAdapter.merge;
    gitAdapter.merge = (ref) => {
      merge(ref);
      writeFileSync(join(fixture.seed, 'later-main.txt'), 'later main change\n', 'utf8');
      git(fixture.seed, ['add', 'later-main.txt']);
      git(fixture.seed, ['commit', '-m', 'advance main during sync']);
      git(fixture.seed, ['push', 'origin', 'main']);
    };
    let pushCalled = false;
    gitAdapter.pushExpectedRef = () => {
      pushCalled = true;
      throw new Error('unexpected candidate push');
    };

    const result = syncMainToDev({
      expectedMainSha: mainSha(fixture.remote),
      eventRef: 'refs/heads/main',
      git: gitAdapter,
    });

    assert.equal(result.status, 'main-advanced');
    assert.equal(pushCalled, false);
    assert.equal(devSha(fixture.remote), beforeDev);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('accepted push with lost response is recovered by a retry without another merge or push', () => {
  const fixture = createFixture();
  try {
    const expectedMainSha = mainSha(fixture.remote);
    const expectedDevSha = devSha(fixture.remote);
    let pushCount = 0;
    const gitAdapter = adapterFor(fixture.bot);
    gitAdapter.pushExpectedRef = (remote, sourceRef, targetRef, expectedSha) => {
      pushCount += 1;
      const previousCwd = process.cwd();
      process.chdir(fixture.bot);
      let pushed;
      try {
        pushed = pushExpectedRef(remote, sourceRef, targetRef, expectedSha);
      } finally {
        process.chdir(previousCwd);
      }
      throw Object.assign(new Error('simulated lost push response'), { cause: pushed });
    };

    assert.throws(
      () =>
        syncMainToDev({
          expectedMainSha,
          eventRef: 'refs/heads/main',
          git: gitAdapter,
        }),
      /simulated lost push response/u
    );
    const acceptedDevSha = devSha(fixture.remote);
    assert.notEqual(acceptedDevSha, expectedDevSha);
    assert.equal(git(fixture.remote, ['rev-list', '--count', '--merges', 'refs/heads/dev']), '1');

    const retry = syncMainToDev({
      expectedMainSha,
      eventRef: 'refs/heads/main',
      git: adapterFor(fixture.bot),
    });

    assert.equal(retry.status, 'already-synced');
    assert.equal(devSha(fixture.remote), acceptedDevSha);
    assert.equal(git(fixture.remote, ['rev-list', '--count', '--merges', 'refs/heads/dev']), '1');
    assert.equal(pushCount, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects non-main events before any remote lookup', () => {
  let lookedUpRemote = false;
  const git = adapterFor(process.cwd(), () => {
    lookedUpRemote = true;
  });
  assert.throws(
    () =>
      syncMainToDev({
        expectedMainSha: 'a'.repeat(40),
        eventRef: 'refs/heads/dev',
        git,
      }),
    /Sync must run from main/u
  );
  assert.equal(lookedUpRemote, false);
});
