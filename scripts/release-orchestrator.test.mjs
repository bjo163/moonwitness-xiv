import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideReleaseAction,
  normalizeVersion,
  parseReleases,
  parseRemoteTags,
  publishedTagsFromReleases,
} from './release-orchestrator.mjs';

const headSha = 'a'.repeat(40);
const devSha = 'a'.repeat(40);
const baselineSha = 'b'.repeat(40);
const otherSha = 'c'.repeat(40);

const rcPlan = {
  status: 'planned',
  channel: 'rc',
  changeKind: 'patch',
  currentVersion: 'v1.0.0-rc.1',
  nextVersion: 'v1.0.0-rc.2',
  source: { baselineTag: 'v1.0.0-rc.1', baselineSha },
  requiresApproval: false,
  approvalGate: null,
  publishPolicy: 'automatic',
  anomalies: [],
};

const stablePlan = {
  ...rcPlan,
  channel: 'stable',
  changeKind: 'none',
  currentVersion: 'v1.0.0-rc.2',
  nextVersion: 'v1.0.0',
  source: { baselineTag: 'v1.0.0-rc.2', baselineSha },
  requiresApproval: true,
  approvalGate: 'first-stable',
  publishPolicy: 'confirm-stable',
};

const decide = (overrides = {}) =>
  decideReleaseAction({
    plan: rcPlan,
    currentVersion: '1.0.0-rc.1',
    headSha,
    devSha,
    devContained: true,
    remoteTags: new Map(),
    releases: [],
    confirmVersion: null,
    channel: 'rc',
    ...overrides,
  });

test('normalizes supported release versions', () => {
  assert.equal(normalizeVersion('1.2.3'), 'v1.2.3');
  assert.equal(normalizeVersion('v1.2.3-rc.4'), 'v1.2.3-rc.4');
  assert.throws(() => normalizeVersion('1.2'), /Unsupported release version/u);
});

test('parses annotated and lightweight remote tags with peeled SHAs', () => {
  const tags = parseRemoteTags(
    [
      `${baselineSha}\trefs/tags/v1.0.0-rc.1`,
      `${otherSha}\trefs/tags/v1.0.0-rc.1^{}`,
      `${headSha}\trefs/tags/v1.0.0`,
    ].join('\n')
  );

  assert.equal(tags.get('v1.0.0-rc.1'), otherSha);
  assert.equal(tags.get('v1.0.0'), headSha);
  assert.throws(() => parseRemoteTags('not-a-sha\trefs/tags/v1.0.0'), /invalid SHA/u);
});

test('parses paginated GitHub releases and keeps only published semantic tags', () => {
  const releases = parseReleases(
    JSON.stringify([
      [
        { tag_name: 'v1.0.0-rc.1', draft: false, prerelease: true },
        { tag_name: 'v1.0.0-rc.2', draft: true, prerelease: true },
      ],
      [
        { tag_name: 'v1.0.0', draft: false, prerelease: false },
        { tag_name: 'design-preview', draft: false, prerelease: false },
      ],
    ])
  );

  assert.deepEqual(
    releases.map((release) => [release.tag, release.draft]),
    [
      ['v1.0.0-rc.1', false],
      ['v1.0.0-rc.2', true],
      ['v1.0.0', false],
    ]
  );
  assert.deepEqual(publishedTagsFromReleases(releases), ['v1.0.0-rc.1', 'v1.0.0']);
  assert.throws(() => parseReleases(JSON.stringify([{ tag_name: 'v1.0.0' }])), /invalid release/u);
});

test('reports no-release plans without any action', () => {
  const decision = decide({ plan: { ...rcPlan, status: 'no-release', nextVersion: null } });
  assert.equal(decision.status, 'no-release');
  assert.equal(decision.action, null);
});

test('blocks invalid plans and published release anomalies', () => {
  const invalid = decide({
    plan: {
      ...rcPlan,
      status: 'invalid',
      nextVersion: null,
      invalidReason: 'Baseline tag v1.0.0-rc.1 has no published GitHub Release.',
    },
  });
  assert.equal(invalid.status, 'blocked');
  assert.equal(invalid.reason, 'invalid-plan');
});

test('prepares the planned version from a contained dev branch', () => {
  const decision = decide();
  assert.equal(decision.status, 'ready');
  assert.equal(decision.action.type, 'prepare');
  assert.equal(decision.action.expectedDevSha, devSha);
  assert.equal(decision.action.tag, 'v1.0.0-rc.2');
  assert.equal(decision.action.createTag, false);
});

test('waits while dev has commits outside main', () => {
  const decision = decide({ devContained: false });
  assert.equal(decision.status, 'waiting');
  assert.equal(decision.action, null);
});

test('refuses to prepare when the next tag already exists', () => {
  const decision = decide({ remoteTags: new Map([['v1.0.0-rc.2', otherSha]]) });
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.reason, 'tag-exists-before-preparation');
});

test('tags and publishes a prepared release candidate', () => {
  const decision = decide({ currentVersion: 'v1.0.0-rc.2' });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.action.type, 'release');
  assert.equal(decision.action.tag, 'v1.0.0-rc.2');
  assert.equal(decision.action.createTag, true);
  assert.equal(decision.action.confirmStable, null);
});

test('resumes an existing draft release without recreating the tag', () => {
  const decision = decide({
    currentVersion: '1.0.0-rc.2',
    remoteTags: new Map([['v1.0.0-rc.2', headSha]]),
    releases: [{ tag: 'v1.0.0-rc.2', draft: true, prerelease: true }],
  });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.action.createTag, false);
});

test('treats an already published release as an idempotent no-op', () => {
  const decision = decide({
    currentVersion: '1.0.0-rc.2',
    remoteTags: new Map([['v1.0.0-rc.2', headSha]]),
    releases: [{ tag: 'v1.0.0-rc.2', draft: false, prerelease: true }],
  });
  assert.equal(decision.status, 'already-released');
  assert.equal(decision.action, null);
});

test('fails closed on moved tags and mismatched release states', () => {
  const conflict = decide({
    currentVersion: '1.0.0-rc.2',
    remoteTags: new Map([['v1.0.0-rc.2', otherSha]]),
  });
  const moved = decide({
    currentVersion: '1.0.0-rc.2',
    remoteTags: new Map([['v1.0.0-rc.2', otherSha]]),
    releases: [{ tag: 'v1.0.0-rc.2', draft: false, prerelease: true }],
  });
  const state = decide({
    currentVersion: '1.0.0-rc.2',
    remoteTags: new Map([['v1.0.0-rc.2', headSha]]),
    releases: [{ tag: 'v1.0.0-rc.2', draft: false, prerelease: false }],
  });

  assert.equal(conflict.reason, 'tag-conflict');
  assert.equal(moved.reason, 'tag-mismatch-for-published-release');
  assert.equal(state.reason, 'release-state-mismatch');
});

test('requires an exact stable confirmation before preparing or publishing', () => {
  const prepare = decide({
    plan: stablePlan,
    currentVersion: '1.0.0-rc.2',
    channel: 'stable',
  });
  const publish = decide({
    plan: stablePlan,
    currentVersion: '1.0.0',
    channel: 'stable',
  });
  const wrong = decide({
    plan: stablePlan,
    currentVersion: '1.0.0',
    channel: 'stable',
    confirmVersion: 'v1.0.1',
  });
  assert.equal(prepare.status, 'approval-required');
  assert.equal(prepare.requiredConfirmation, 'v1.0.0');
  assert.equal(publish.status, 'approval-required');
  assert.equal(wrong.status, 'approval-required');
});

test('publishes a stable release only after exact confirmation', () => {
  const decision = decide({
    plan: stablePlan,
    currentVersion: '1.0.0',
    channel: 'stable',
    confirmVersion: '1.0.0',
  });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.action.type, 'release');
  assert.equal(decision.action.tag, 'v1.0.0');
  assert.equal(decision.action.confirmStable, 'v1.0.0');
});

test('blocks a workspace version that matches neither baseline nor plan', () => {
  const decision = decide({ currentVersion: '1.0.1' });
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.reason, 'version-mismatch');
});
