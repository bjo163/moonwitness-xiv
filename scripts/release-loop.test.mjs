import assert from 'node:assert/strict';
import test from 'node:test';
import { createReleasePlan } from './release-plan.mjs';
import { prepareReleaseFiles } from './prepare-release.mjs';
import { renderChangelogSection } from './render-changelog.mjs';

const baselineSha = 'a'.repeat(40);
const featureSha = 'b'.repeat(40);
const docsSha = 'c'.repeat(40);
const prepareSha = 'd'.repeat(40);
const statusSha = 'e'.repeat(40);
const baselineCommitSha = 'f'.repeat(40);
const tags = [{ tag: 'v1.0.0-rc.1' }];
const repositoryUrl = 'https://github.com/bjo163/moonwitness-xiv';
const startingManifests = [
  { path: 'package.json', source: '{\n  "name": "moonwitness",\n  "version": "1.0.0-rc.1"\n}\n' },
  {
    path: 'packages/orm/package.json',
    source: '{\n  "name": "@moonwitness/orm",\n  "version": "1.0.0-rc.1"\n}\n',
  },
  {
    path: 'apps/board/package.json',
    source: '{\n  "name": "board",\n  "version": "1.0.0-rc.1"\n}\n',
  },
];
const initialCommits = [
  { sha: featureSha, parents: [baselineSha], subject: 'feat(board): add release loop visibility' },
  {
    sha: docsSha,
    parents: [featureSha],
    subject: 'docs(roadmap): record the verified source status',
  },
];

function plan(headSha, commits) {
  const candidate = createReleasePlan({ tags, headSha, commits });
  candidate.source.baselineSha = baselineCommitSha;
  return candidate;
}

function prepare(candidate, manifests, changelog) {
  const section = renderChangelogSection({
    plan: candidate,
    commits: candidate.commits,
    repositoryUrl,
    date: '2026-10-07',
  });
  return prepareReleaseFiles({ plan: candidate, manifests, changelog, changelogSection: section });
}

test('one substantive release batch bumps once; docs/status and prepared commit retries are no-ops', () => {
  const firstPlan = plan(docsSha, initialCommits);
  assert.equal(firstPlan.status, 'planned');
  assert.equal(firstPlan.nextVersion, 'v1.1.0-rc.1');
  assert.deepEqual(firstPlan.releasableCommitShas, [featureSha]);
  assert.deepEqual(firstPlan.ignoredCommitShas, [docsSha]);

  const firstPreparation = prepare(firstPlan, startingManifests, '# Changelog\n');
  assert.equal(firstPreparation.status, 'prepared');
  assert.equal(firstPreparation.version, '1.1.0-rc.1');
  assert.equal(firstPreparation.writesPerformed, false);
  const preparedManifests = firstPreparation.files
    .filter(({ path: filePath }) => filePath.endsWith('package.json'))
    .map(({ path: filePath, contents }) => ({ path: filePath, source: contents }));
  const preparedChangelog = firstPreparation.files.find(
    ({ path: filePath }) => filePath === 'CHANGELOG.md'
  ).contents;

  const afterReleaseCommit = plan(prepareSha, [
    ...initialCommits,
    {
      sha: prepareSha,
      parents: [docsSha],
      subject: 'chore(release): prepare workspace release',
    },
  ]);
  assert.equal(afterReleaseCommit.status, 'planned');
  assert.equal(afterReleaseCommit.nextVersion, firstPlan.nextVersion);
  assert.deepEqual(afterReleaseCommit.releasableCommitShas, firstPlan.releasableCommitShas);
  assert.equal(
    prepare(afterReleaseCommit, preparedManifests, preparedChangelog).status,
    'already-prepared'
  );
  assert.deepEqual(prepare(afterReleaseCommit, preparedManifests, preparedChangelog).files, []);

  const afterStatusCommit = plan(statusSha, [
    ...initialCommits,
    { sha: prepareSha, parents: [docsSha], subject: 'chore(release): prepare workspace release' },
    {
      sha: statusSha,
      parents: [prepareSha],
      subject: 'docs(roadmap): reconcile issue lifecycle evidence',
    },
  ]);
  assert.equal(afterStatusCommit.nextVersion, firstPlan.nextVersion);
  assert.deepEqual(afterStatusCommit.releasableCommitShas, firstPlan.releasableCommitShas);
  const retry = prepare(afterStatusCommit, preparedManifests, preparedChangelog);
  assert.equal(retry.status, 'already-prepared');
  assert.deepEqual(retry.files, []);
});

test('docs/status-only history does not propose an application version bump', () => {
  const noRelease = plan(docsSha, [
    {
      sha: docsSha,
      parents: [baselineSha],
      subject: 'docs(roadmap): update task status and evidence',
    },
  ]);
  assert.equal(noRelease.status, 'no-release');
  assert.equal(noRelease.nextVersion, null);
  assert.deepEqual(noRelease.releasableCommitShas, []);
  assert.equal(noRelease.writesPerformed, false);
});
