import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyCandidate, runCandidate } from './dependency-candidate.mjs';

function command(executable, args, cwd) {
  return execFileSync(executable, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function git(cwd, ...args) {
  return command('git', args, cwd);
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'moonwitness-candidate-'));
  git(root, 'init', '-b', 'dev');
  git(root, 'config', 'user.name', 'candidate-test');
  git(root, 'config', 'user.email', 'candidate-test@example.test');
  mkdirSync(join(root, 'packages', 'fixture'), { recursive: true });
  mkdirSync(join(root, 'packages', 'fixture-two'), { recursive: true });
  mkdirSync(join(root, 'apps', 'logs'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      { name: 'fixture-root', private: true, packageManager: 'pnpm@11.0.0' },
      null,
      2
    ) + '\n'
  );
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  writeFileSync(
    join(root, 'packages', 'fixture', 'package.json'),
    JSON.stringify(
      { name: '@fixture/app', version: '1.0.0', dependencies: { 'is-number': '^7.0.0' } },
      null,
      2
    ) + '\n'
  );
  writeFileSync(
    join(root, 'packages', 'fixture-two', 'package.json'),
    JSON.stringify(
      { name: '@fixture/other', version: '1.0.0', devDependencies: { 'is-number': '~7.0.1' } },
      null,
      2
    ) + '\n'
  );
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  return { root, sourceSha: git(root, 'rev-parse', 'HEAD') };
}

test('applies one non-major exact package update only on the matching source SHA', async () => {
  const fixture = workspace();
  try {
    const result = await applyCandidate({
      packageName: 'is-number',
      version: '7.0.2',
      sourceSha: fixture.sourceSha,
      expectedSourceSha: fixture.sourceSha,
      root: fixture.root,
      execute: (_executable, args, cwd) => {
        assert.equal(_executable, 'pnpm');
        if (args.includes('--lockfile-only')) {
          writeFileSync(join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
        }
      },
    });
    assert.deepEqual([...result.current].sort(), ['^7.0.0', '~7.0.1']);
    assert.deepEqual(result.changedFiles, [
      'packages/fixture-two/package.json',
      'packages/fixture/package.json',
      'pnpm-lock.yaml',
    ]);
    const manifest = JSON.parse(
      readFileSync(join(fixture.root, 'packages/fixture/package.json'), 'utf8')
    );
    assert.equal(manifest.dependencies['is-number'], '7.0.2');
    const secondManifest = JSON.parse(
      readFileSync(join(fixture.root, 'packages/fixture-two/package.json'), 'utf8')
    );
    assert.equal(secondManifest.devDependencies['is-number'], '7.0.2');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects mismatched source SHA, major candidates, and unknown packages before mutation', async () => {
  const fixture = workspace();
  try {
    const options = {
      packageName: 'is-number',
      version: '7.0.2',
      sourceSha: fixture.sourceSha,
      expectedSourceSha: 'f'.repeat(40),
      root: fixture.root,
      execute: () => assert.fail('package manager must not run for a rejected candidate'),
    };
    await assert.rejects(applyCandidate(options), /must exactly match/);
    await assert.rejects(
      applyCandidate({ ...options, expectedSourceSha: fixture.sourceSha, version: '8.0.0' }),
      /Major dependency updates/
    );
    await assert.rejects(
      applyCandidate({ ...options, expectedSourceSha: fixture.sourceSha, version: '7.0.0' }),
      /must be newer than every current declaration/
    );
    await assert.rejects(
      applyCandidate({ ...options, expectedSourceSha: fixture.sourceSha, version: '7.0.1' }),
      /must be newer than every current declaration/
    );
    await assert.rejects(
      applyCandidate({ ...options, expectedSourceSha: fixture.sourceSha, version: '7.1.0-beta.1' }),
      /Prerelease dependency versions/
    );
    await assert.rejects(
      applyCandidate({
        ...options,
        expectedSourceSha: fixture.sourceSha,
        packageName: 'not-present',
      }),
      /not declared/
    );
    assert.equal(git(fixture.root, 'status', '--porcelain'), '');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a dirty candidate checkout before invoking the package manager', async () => {
  const fixture = workspace();
  try {
    writeFileSync(join(fixture.root, 'unreviewed.txt'), 'must remain untouched\n');
    await assert.rejects(
      applyCandidate({
        packageName: 'is-number',
        version: '7.0.2',
        sourceSha: fixture.sourceSha,
        expectedSourceSha: fixture.sourceSha,
        root: fixture.root,
        execute: () => assert.fail('package manager must not run for a dirty candidate'),
      }),
      /must be clean/
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a failing full-suite E2E gate stops the candidate before container smoke checks', async () => {
  const fixture = workspace();
  const executed = [];
  try {
    await assert.rejects(
      runCandidate({
        packageName: 'is-number',
        version: '7.0.2',
        sourceSha: fixture.sourceSha,
        expectedSourceSha: fixture.sourceSha,
        root: fixture.root,
        execute: (executable, args, cwd) => {
          executed.push(`${executable} ${args.join(' ')}`);
          if (executable === 'pnpm' && args.includes('--lockfile-only')) {
            writeFileSync(join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
          }
          if (executable === 'pnpm' && args.includes('test:e2e:built')) {
            throw new Error('simulated E2E regression');
          }
        },
      }),
      /simulated E2E regression/
    );
    assert.ok(executed.some((entry) => entry.endsWith(' test:e2e:built')));
    assert.equal(
      executed.some((entry) => entry.includes('smoke-containers.mjs')),
      false
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('uses native browser installation semantics and cross-platform container smoke', async () => {
  for (const [platform, expectedInstall] of [
    ['linux', 'install --with-deps chromium'],
    ['win32', 'install chromium'],
  ]) {
    const fixture = workspace();
    const executed = [];
    try {
      await runCandidate({
        packageName: 'is-number',
        version: '7.0.2',
        sourceSha: fixture.sourceSha,
        expectedSourceSha: fixture.sourceSha,
        root: fixture.root,
        platform,
        execute: (executable, args, cwd) => {
          executed.push(`${executable} ${args.join(' ')}`);
          if (executable === 'pnpm' && args.includes('--lockfile-only')) {
            writeFileSync(join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
          }
        },
      });
      assert.ok(executed.some((entry) => entry.endsWith(expectedInstall)));
      assert.ok(executed.some((entry) => entry === 'node scripts/smoke-containers.mjs'));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('candidate bundle verifies against its recorded source parent and exposes the expected SHA', () => {
  const fixture = workspace();
  const receiver = join(fixture.root, '..', `receiver-${Date.now()}`);
  const bundle = join(fixture.root, 'candidate.bundle');
  try {
    git(fixture.root, 'commit', '--allow-empty', '-m', 'verified candidate');
    const candidateSha = git(fixture.root, 'rev-parse', 'HEAD');
    git(fixture.root, 'bundle', 'create', bundle, 'HEAD');
    const [listedSha, listedRef] = git(fixture.root, 'bundle', 'list-heads', bundle).split(/\s+/u);
    assert.equal(listedSha, candidateSha);
    assert.equal(listedRef, 'HEAD');
    mkdirSync(receiver);
    git(receiver, 'init', '-b', 'dev');
    git(receiver, 'fetch', fixture.root, fixture.sourceSha);
    git(receiver, 'bundle', 'verify', bundle);
    git(receiver, 'fetch', bundle, 'HEAD');
    assert.equal(git(receiver, 'rev-parse', 'FETCH_HEAD^1'), fixture.sourceSha);
  } finally {
    rmSync(receiver, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
