import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createReleaseTag, planReleaseTag } from './create-release-tag.mjs';

function git(cwd, args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Release Test', '-c', 'user.email=release@example.com', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
}

function withRepository(callback) {
  const root = mkdtempSync(path.join(tmpdir(), 'moonwitness-release-tag-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  try {
    git(root, ['init', '--bare', remote]);
    git(root, ['clone', remote, work]);
    git(work, ['checkout', '-b', 'main']);
    writeFileSync(path.join(work, 'file.txt'), 'first\n');
    git(work, ['add', 'file.txt']);
    git(work, ['commit', '-m', 'feat: first']);
    git(work, ['push', 'origin', 'main']);
    const first = git(work, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(work, 'file.txt'), 'second\n');
    git(work, ['commit', '-am', 'fix: second']);
    const second = git(work, ['rev-parse', 'HEAD']);
    git(work, ['push', 'origin', 'main']);
    return callback({ root, remote, work, first, second });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('creates an annotated tag at the exact commit and is idempotent', () => {
  withRepository(({ work, first }) => {
    const created = createReleaseTag('v1.2.3', first, { cwd: work });
    assert.deepEqual(created, { created: true, tag: 'v1.2.3', sha: first });

    const remote = git(work, ['ls-remote', '--tags', 'origin', 'refs/tags/v1.2.3^{}']);
    assert.match(remote, new RegExp(`^${first}`));

    const reused = createReleaseTag('v1.2.3', first, { cwd: work });
    assert.deepEqual(reused, { created: false, tag: 'v1.2.3', sha: first });
  });
});

test('refuses to overwrite a remote tag that points at another commit', () => {
  withRepository(({ work, first, second }) => {
    createReleaseTag('v1.2.3', first, { cwd: work });
    assert.throws(
      () => createReleaseTag('v1.2.3', second, { cwd: work }),
      /refusing to overwrite/u
    );
  });
});

test('refuses to move an unpushed local tag', () => {
  withRepository(({ work, first, second }) => {
    git(work, ['tag', '-a', 'v1.2.4', '-m', 'local', first]);
    assert.throws(() => createReleaseTag('v1.2.4', second, { cwd: work }), /refusing to move/u);
  });
});

test('rejects unsupported tag names and abbreviated SHAs', () => {
  assert.throws(
    () =>
      planReleaseTag({ tag: 'release-1', sha: 'a'.repeat(40), remoteSha: null, localSha: null }),
    /supported version tag/u
  );
  assert.throws(
    () => planReleaseTag({ tag: 'v1.2.3', sha: 'abc123', remoteSha: null, localSha: null }),
    /full commit SHA/u
  );
  assert.deepEqual(
    planReleaseTag({
      tag: 'v1.2.3',
      sha: 'a'.repeat(40),
      remoteSha: 'a'.repeat(40),
      localSha: null,
    }),
    { action: 'reuse', tag: 'v1.2.3', sha: 'a'.repeat(40) }
  );
});
