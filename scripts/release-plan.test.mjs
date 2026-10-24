import assert from 'node:assert/strict';
import test from 'node:test';
import { createReleasePlan } from './release-plan.mjs';

const tags = [{ tag: 'v1.0.0-rc.1' }, { tag: 'v0.9.5' }];
const headSha = 'f'.repeat(40);

test('plans a prerelease increment from the latest prerelease baseline', () => {
  const plan = createReleasePlan({
    tags,
    headSha,
    commits: [{ sha: 'a'.repeat(40), parents: ['p'], subject: 'feat(board): add saved search' }],
  });

  assert.equal(plan.status, 'planned');
  assert.equal(plan.currentVersion, 'v1.0.0-rc.1');
  assert.equal(plan.nextVersion, 'v1.1.0-rc.1');
  assert.equal(plan.source.headSha, headSha);
  assert.equal(plan.writesPerformed, false);
});

test('returns a no-release plan for docs and generator commits', () => {
  const plan = createReleasePlan({
    tags,
    headSha,
    commits: [
      {
        sha: 'b'.repeat(40),
        parents: ['p'],
        subject: 'docs(ci): record workflow coverage gate evidence',
      },
      { sha: 'c'.repeat(40), parents: ['p'], subject: 'chore: regenerate API reference' },
    ],
  });

  assert.equal(plan.status, 'no-release');
  assert.equal(plan.changeKind, 'none');
  assert.equal(plan.nextVersion, null);
  assert.equal(plan.releasableCommitShas.length, 0);
  assert.equal(plan.ignoredCommitShas.length, 2);
});

test('keeps merge commits out of version calculation and identifies invalid commits', () => {
  const plan = createReleasePlan({
    tags,
    headSha,
    commits: [
      { sha: 'd'.repeat(40), parents: ['p1', 'p2'], subject: 'Merge pull request #10' },
      { sha: 'e'.repeat(40), parents: ['p'], subject: 'ordinary unclassified message' },
    ],
  });

  assert.equal(plan.status, 'invalid');
  assert.equal(plan.changeKind, 'invalid');
  assert.deepEqual(plan.skippedMergeShas, ['d'.repeat(40)]);
  assert.equal(plan.invalidCommits.length, 1);
  assert.equal(plan.nextVersion, null);
});

test('fails closed when no explicit release baseline exists', () => {
  assert.throws(
    () => createReleasePlan({ tags: [], headSha, commits: [] }),
    /first-stable baseline explicitly/
  );
});

const fixCommit = { sha: '1'.repeat(40), parents: ['p'], subject: 'fix(board): repair filter' };
const featCommit = {
  sha: '2'.repeat(40),
  parents: ['p'],
  subject: 'feat(board): add saved search',
};
const breakingCommit = {
  sha: '3'.repeat(40),
  parents: ['p'],
  subject: 'feat(api)!: replace legacy endpoint',
};

test('continues the release candidate sequence for patch changes', () => {
  const plan = createReleasePlan({
    tags: [{ tag: 'v1.0.0-rc.1' }, { tag: 'v0.9.5' }],
    headSha,
    commits: [fixCommit],
  });

  assert.equal(plan.status, 'planned');
  assert.equal(plan.bump, 'prerelease');
  assert.equal(plan.nextVersion, 'v1.0.0-rc.2');
  assert.equal(plan.publishPolicy, 'automatic');
  assert.equal(plan.requiresApproval, false);
});

test('release candidates reset on breaking and feature changes', () => {
  const breaking = createReleasePlan({
    tags: [{ tag: 'v1.0.0-rc.2' }],
    headSha,
    commits: [breakingCommit],
  });
  const feature = createReleasePlan({
    tags: [{ tag: 'v1.0.0-rc.2' }],
    headSha,
    commits: [featCommit],
  });

  assert.equal(breaking.nextVersion, 'v2.0.0-rc.1');
  assert.equal(feature.nextVersion, 'v1.1.0-rc.1');
});

test('stabilizes a published release candidate under an explicit stable channel', () => {
  const plan = createReleasePlan({
    tags: [{ tag: 'v1.0.0-rc.2' }],
    headSha,
    commits: [],
    channel: 'stable',
    publishedTags: ['v1.0.0-rc.2'],
    requirePublishedBaseline: true,
  });

  assert.equal(plan.status, 'planned');
  assert.equal(plan.bump, 'stabilize');
  assert.equal(plan.nextVersion, 'v1.0.0');
  assert.equal(plan.requiresApproval, true);
  assert.equal(plan.approvalGate, 'first-stable');
  assert.equal(plan.publishPolicy, 'confirm-stable');
  assert.equal(plan.baselinePublished, true);
});

test('requires confirmation only when no stable release has been published', () => {
  const first = createReleasePlan({
    tags: [{ tag: 'v1.0.0-rc.2' }],
    headSha,
    commits: [fixCommit],
    channel: 'stable',
    publishedTags: ['v1.0.0-rc.2'],
    requirePublishedBaseline: true,
  });
  const subsequent = createReleasePlan({
    tags: [{ tag: 'v1.1.0-rc.1' }, { tag: 'v1.0.0' }],
    headSha,
    commits: [],
    channel: 'stable',
    publishedTags: ['v1.1.0-rc.1', 'v1.0.0'],
    requirePublishedBaseline: true,
  });

  assert.equal(first.requiresApproval, true);
  assert.equal(subsequent.requiresApproval, false);
  assert.equal(subsequent.nextVersion, 'v1.1.0');
});

test('rejects an unstable release candidate line for a stable release', () => {
  const plan = createReleasePlan({
    tags: [{ tag: 'v1.0.0-rc.2' }],
    headSha,
    commits: [featCommit],
    channel: 'stable',
  });

  assert.equal(plan.status, 'invalid');
  assert.match(plan.invalidReason, /requires patch-only changes/u);
  assert.equal(plan.nextVersion, null);
});

test('plans a stable hotfix only from a patch-level change on a stable baseline', () => {
  const hotfix = createReleasePlan({
    tags: [{ tag: 'v1.2.0' }, { tag: 'v1.1.0' }],
    headSha,
    commits: [fixCommit],
    channel: 'hotfix',
  });
  const feature = createReleasePlan({
    tags: [{ tag: 'v1.2.0' }],
    headSha,
    commits: [featCommit],
    channel: 'hotfix',
  });
  const empty = createReleasePlan({
    tags: [{ tag: 'v1.2.0' }],
    headSha,
    commits: [],
    channel: 'hotfix',
  });

  assert.equal(hotfix.status, 'planned');
  assert.equal(hotfix.nextVersion, 'v1.2.1');
  assert.equal(hotfix.requiresApproval, false);
  assert.equal(feature.status, 'invalid');
  assert.equal(empty.status, 'invalid');
});

test('rejects a hotfix when no stable release tag exists', () => {
  const plan = createReleasePlan({
    tags: [{ tag: 'v1.0.0-rc.2' }],
    headSha,
    commits: [fixCommit],
    channel: 'hotfix',
  });

  assert.equal(plan.status, 'invalid');
  assert.match(plan.invalidReason, /stable release tag/u);
});

test('fails closed when the baseline tag has no published release', () => {
  const plan = createReleasePlan({
    tags: [{ tag: 'v1.0.0-rc.1' }],
    headSha,
    commits: [fixCommit],
    publishedTags: [],
    requirePublishedBaseline: true,
  });

  assert.equal(plan.status, 'invalid');
  assert.equal(plan.baselinePublished, false);
  assert.deepEqual(
    plan.anomalies.map((anomaly) => anomaly.code),
    ['baseline-unpublished']
  );
});

test('fails closed when a newer release tag is unpublished', () => {
  const plan = createReleasePlan({
    tags: [{ tag: 'v1.0.0-rc.2' }, { tag: 'v1.0.0-rc.1' }],
    headSha,
    commits: [fixCommit],
    baselineTag: 'v1.0.0-rc.1',
    publishedTags: ['v1.0.0-rc.1'],
    requirePublishedBaseline: true,
  });

  assert.equal(plan.status, 'invalid');
  assert.deepEqual(
    plan.anomalies.map((anomaly) => anomaly.code),
    ['newer-tag-unpublished']
  );
  assert.deepEqual(plan.anomalies[0].tags, ['v1.0.0-rc.2']);
});

test('does not claim published baseline verification when releases were not supplied', () => {
  const plan = createReleasePlan({
    tags: [{ tag: 'v1.0.0-rc.1' }],
    headSha,
    commits: [fixCommit],
  });

  assert.equal(plan.status, 'planned');
  assert.equal(plan.publishedBaselineVerified, false);
  assert.equal(plan.baselinePublished, null);
  assert.deepEqual(plan.anomalies, []);
});
