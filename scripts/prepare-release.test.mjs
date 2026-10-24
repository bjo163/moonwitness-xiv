import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeReleaseInputSha,
  releaseNotesBegin,
  releaseNotesEnd,
  renderChangelogSection,
} from './render-changelog.mjs';
import { prepareReleaseFiles } from './prepare-release.mjs';

const plan = {
  status: 'planned',
  nextVersion: 'v1.1.0-rc.1',
  source: { headSha: 'a'.repeat(40), baselineSha: 'b'.repeat(40) },
  releasableCommitShas: ['c'.repeat(40)],
  commits: [
    {
      sha: 'c'.repeat(40),
      type: 'feat',
      description: 'add a company directory',
      isBreaking: false,
    },
  ],
};
const commits = [{ sha: 'c'.repeat(40), subject: 'feat(base): add a company directory', body: '' }];
const section = (sourcePlan = plan, date = '2026-10-06') =>
  renderChangelogSection({
    plan: sourcePlan,
    commits,
    repositoryUrl: 'https://github.com/bjo163/moonwitness-xiv',
    date,
  });
const manifests = [
  {
    path: 'package.json',
    source: '{\n  "name": "moonwitness-monorepo",\n  "version": "1.0.0-rc.1"\n}\n',
  },
  {
    path: 'packages/orm/package.json',
    source: '{\n  "name": "@moonwitness/orm",\n  "version": "1.0.0-rc.1"\n}\n',
  },
  {
    path: 'apps/board/package.json',
    source: '{\n  "name": "board",\n  "version": "1.0.0-rc.1"\n}\n',
  },
];

test('prepares root and scoped workspace versions while leaving unscoped apps alone', () => {
  const result = prepareReleaseFiles({
    plan,
    manifests,
    changelog: '# Changelog\n',
    changelogSection: section(),
  });
  assert.equal(result.status, 'prepared');
  assert.equal(result.updatedWorkspaces, 1);
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['package.json', 'packages/orm/package.json', 'CHANGELOG.md']
  );
  assert.match(result.files[0].contents, /"version": "1\.1\.0-rc\.1"/);
  assert.doesNotMatch(result.files[2].contents, /board/);
  assert.equal(result.writesPerformed, false);
});

test('release notes are deterministic from baseline, version and releasable commits', () => {
  assert.equal(
    computeReleaseInputSha(plan),
    computeReleaseInputSha({ ...plan, source: { ...plan.source, headSha: 'd'.repeat(40) } })
  );
  const result = prepareReleaseFiles({
    plan,
    manifests,
    changelog: '# Changelog\n',
    changelogSection: section(),
  });
  const changelog = result.files.find((file) => file.path === 'CHANGELOG.md').contents;
  assert.ok(changelog.includes(releaseNotesBegin));
  assert.ok(changelog.includes(releaseNotesEnd));
  assert.ok(changelog.includes(`input: ${computeReleaseInputSha(plan)}`));
});

test('same release input is an idempotent no-op even when source head and date advance', () => {
  const first = prepareReleaseFiles({
    plan,
    manifests,
    changelog: '# Changelog\n',
    changelogSection: section(),
  });
  const generatedChangelog = first.files.find((file) => file.path === 'CHANGELOG.md').contents;
  const laterPlan = { ...plan, source: { ...plan.source, headSha: 'd'.repeat(40) } };
  const second = prepareReleaseFiles({
    plan: laterPlan,
    manifests: first.files
      .filter((file) => file.path.endsWith('package.json'))
      .map((file) => ({ path: file.path, source: file.contents })),
    changelog: generatedChangelog,
    changelogSection: section(laterPlan, '2026-10-07'),
  });
  assert.equal(second.status, 'already-prepared');
  assert.deepEqual(second.files, []);
});

test('updates only the managed notes and preserves human text around them', () => {
  const initialSection = section().replace('2026-10-06', '2026-10-01');
  const original = `# Changelog\n\n${initialSection.replace(/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}\n/u, '## [1.1.0-rc.1] - 2026-10-01\n\nMaintainer note before.\n')}\nMaintainer note after.\n\n## [1.0.0] - 2026-09-01\n\nOlder notes.\n`;
  const changedPlan = {
    ...plan,
    releasableCommitShas: [...plan.releasableCommitShas, 'e'.repeat(40)],
    commits: [
      ...plan.commits,
      {
        sha: 'e'.repeat(40),
        type: 'fix',
        description: 'fix the directory filter',
        isBreaking: false,
      },
    ],
  };
  const updatedSection = renderChangelogSection({
    plan: changedPlan,
    commits: [
      ...commits,
      { sha: 'e'.repeat(40), subject: 'fix(board): fix the directory filter', body: '' },
    ],
    repositoryUrl: 'https://github.com/bjo163/moonwitness-xiv',
    date: '2026-10-07',
  });
  const result = prepareReleaseFiles({
    plan: changedPlan,
    manifests,
    changelog: original,
    changelogSection: updatedSection,
  });
  const output = result.files.find((file) => file.path === 'CHANGELOG.md').contents;
  assert.match(output, /Maintainer note before\./);
  assert.match(output, /Maintainer note after\./);
  assert.match(output, /fix the directory filter/);
  assert.match(output, /## \[1\.1\.0-rc\.1\] - 2026-10-01/);
});

test('fails closed if an existing version section has no unique managed note block', () => {
  const unsafe = '# Changelog\n\n## [1.1.0-rc.1] - 2026-10-01\n\nHand-written notes.\n';
  assert.throws(
    () => prepareReleaseFiles({ plan, manifests, changelog: unsafe, changelogSection: section() }),
    /not safely managed/
  );
  assert.throws(
    () =>
      prepareReleaseFiles({
        plan,
        manifests,
        changelog: `${unsafe}\n${unsafe}`,
        changelogSection: section(),
      }),
    /duplicate sections/
  );
});
