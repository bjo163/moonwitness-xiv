import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMPATIBILITY_REVIEW_GATES,
  DEFAULT_BATCH_LIMIT,
  buildDependencyPlan,
  classifyCompatibility,
  resolvePlanOutputPath,
  renderSummary,
  selectBatch,
  selectUpdateCandidate,
} from './dependency-update-plan.mjs';

test('full dependency candidate gates reuse the workspace build without dropping checks', () => {
  assert.ok(COMPATIBILITY_REVIEW_GATES.includes('pnpm typecheck'));
  assert.ok(COMPATIBILITY_REVIEW_GATES.includes('pnpm test:unit:built'));
  assert.ok(COMPATIBILITY_REVIEW_GATES.includes('pnpm architecture:check:built'));
  assert.ok(COMPATIBILITY_REVIEW_GATES.includes('pnpm docs:check:built'));
  assert.ok(COMPATIBILITY_REVIEW_GATES.includes('pnpm test:integration:built'));
  assert.ok(COMPATIBILITY_REVIEW_GATES.includes('pnpm test:e2e:built'));
  assert.ok(COMPATIBILITY_REVIEW_GATES.includes('pnpm test:docs-portal'));
  assert.ok(!COMPATIBILITY_REVIEW_GATES.includes('pnpm test:unit'));
  assert.ok(!COMPATIBILITY_REVIEW_GATES.includes('pnpm test:integration'));
  assert.ok(!COMPATIBILITY_REVIEW_GATES.includes('pnpm test:e2e'));
  assert.ok(!COMPATIBILITY_REVIEW_GATES.includes('pnpm architecture:check'));
  assert.ok(!COMPATIBILITY_REVIEW_GATES.includes('pnpm docs:check'));
});

test('read-only planning writes JSON only when an output path is explicitly requested', () => {
  assert.equal(resolvePlanOutputPath([]), undefined);
  assert.equal(
    resolvePlanOutputPath(['--source-sha', 'abc', '--output', 'report.json']),
    'report.json'
  );
  assert.throws(() => resolvePlanOutputPath(['--output']), /requires a path/);
});

test('classifies patch, minor, major, same, and unknown versions without guessing', () => {
  assert.equal(classifyCompatibility('2.4.1', '2.4.2'), 'patch');
  assert.equal(classifyCompatibility('2.4.1', '2.5.0'), 'minor');
  assert.equal(classifyCompatibility('2.4.1', '3.0.0'), 'major');
  assert.equal(classifyCompatibility('2.4.1', '2.4.1'), 'same');
  assert.equal(classifyCompatibility('workspace:*', '2.0.0'), 'unknown');
});

test('groups exact outdated runtime, development, and action candidates deterministically', () => {
  const plan = buildDependencyPlan(
    {
      zeta: {
        current: '1.2.0',
        wanted: '1.2.0',
        latest: '2.0.0',
        dependencyType: 'dependencies',
        dependentPackages: [{ name: '@moonwitness/api' }],
        latestManifest: { repository: { url: 'git+https://github.com/acme/zeta.git' } },
      },
      eslint: {
        current: '9.0.0',
        wanted: '9.2.0',
        latest: '9.2.0',
        dependencyType: 'devDependencies',
      },
      'actions/checkout': {
        current: '4.4.0',
        wanted: '4.4.0',
        latest: '5.0.0',
        dependencyType: 'githubAction',
        dependentPackages: [{ name: '.github' }],
      },
      ignored: { current: '1.0.0', latest: '2.0.0', dependencyType: 'peerDependencies' },
    },
    'abc123',
    '2026-10-05T00:00:00.000Z'
  );

  assert.deepEqual(Object.keys(plan.groups), ['runtime', 'development', 'actions']);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(plan.groups.runtime[0]).filter(
        ([key]) => !['majorImpact', 'localUsage', 'batchSelected'].includes(key)
      )
    ),
    {
      name: 'zeta',
      group: 'runtime',
      current: '1.2.0',
      wanted: '1.2.0',
      latest: '2.0.0',
      compatibility: 'major',
      wantedCompatibility: 'same',
      safeTarget: null,
      deprecated: false,
      dependents: ['@moonwitness/api'],
      impactedWorkspaces: [],
      releaseNotes: 'https://github.com/acme/zeta',
      releaseNotesSource: 'registry-manifest',
    }
  );
  assert.equal(plan.groups.development[0].compatibility, 'minor');
  assert.equal(plan.groups.actions[0].compatibility, 'major');
  assert.equal(plan.groups.actions[0].releaseNotes, 'https://github.com/actions/checkout');
  assert.equal(plan.groups.actions[0].releaseNotesSource, 'action-reference');
  assert.equal(plan.groups.actions[0].localUsage.kind, 'not-applicable');
  assert.equal(plan.groups.runtime[0].majorImpact.status, 'manual-review-required');
  assert.deepEqual(plan.groups.runtime[0].majorImpact.workspaceDependents, ['@moonwitness/api']);
  assert.deepEqual(plan.groups.runtime[0].majorImpact.testImpacts, [
    'pnpm typecheck',
    'pnpm test:unit:built',
  ]);
  assert.match(plan.groups.runtime[0].majorImpact.localUsage, /reference "zeta"/);
  assert.ok(
    plan.groups.runtime[0].majorImpact.requiredTasks.some((task) => task.includes('migration'))
  );
  assert.ok(plan.groups.runtime[0].majorImpact.requiredGates.includes('pnpm test:e2e:built'));
  assert.match(renderSummary(plan), /Major compatibility review: zeta/);
  assert.match(renderSummary(plan), /candidate executor refuses major updates/);
  assert.match(renderSummary(plan), /Test impacts derived from the impacted workspaces/);
  assert.equal(plan.sourceSha, 'abc123');
  assert.equal(plan.mode, 'read-only-plan');
  assert.equal(plan.batchLimit, DEFAULT_BATCH_LIMIT);
});

test('rejects non-GitHub repository URLs and missing dependency metadata safely', () => {
  const plan = buildDependencyPlan(
    {
      package: {
        current: '1.0.0',
        latest: '1.0.1',
        dependencyType: 'dependencies',
        latestManifest: { homepage: 'javascript:alert(1)' },
      },
    },
    'sha',
    'now'
  );
  assert.equal(plan.groups.runtime[0].releaseNotes, null);
  assert.deepEqual(plan.groups.runtime[0].dependents, []);
});

test('selects exactly one safe non-major package and keeps major candidates report-only', () => {
  const plan = buildDependencyPlan(
    {
      safe: { current: '2.1.0', wanted: '2.1.2', latest: '3.0.0', dependencyType: 'dependencies' },
      major: {
        current: '1.0.0',
        wanted: '2.0.0',
        latest: '2.0.0',
        dependencyType: 'devDependencies',
      },
    },
    'a'.repeat(40),
    '2026-10-05T00:00:00.000Z'
  );
  assert.deepEqual(selectUpdateCandidate(plan, 'safe'), {
    packageName: 'safe',
    version: '2.1.2',
    sourceSha: 'a'.repeat(40),
    compatibility: 'patch',
    targetSource: 'wanted',
  });
  assert.throws(() => selectUpdateCandidate(plan, 'major'), /report-only/);
  assert.throws(() => selectUpdateCandidate(plan, 'missing'), /found 0/);
  const prereleasePlan = buildDependencyPlan(
    {
      prerelease: {
        current: '1.0.0',
        wanted: '1.1.0-beta.1',
        latest: '1.1.0-beta.1',
        dependencyType: 'dependencies',
      },
    },
    'b'.repeat(40),
    '2026-10-05T00:00:00.000Z'
  );
  assert.throws(() => selectUpdateCandidate(prereleasePlan, 'prerelease'), /prerelease/);
});

test('chooses wanted-range updates first and falls back only to stable latest patch/minor targets', () => {
  const plan = buildDependencyPlan(
    {
      wanted: {
        current: '3.4.0',
        wanted: '3.4.2',
        latest: '4.0.0',
        dependencyType: 'dependencies',
      },
      latestPatch: {
        current: '5.1.0',
        wanted: '5.1.0',
        latest: '5.1.2',
        dependencyType: 'dependencies',
      },
      latestMinor: {
        current: '2.8.0',
        wanted: '2.8.0',
        latest: '2.9.0',
        dependencyType: 'devDependencies',
      },
      latestMajor: {
        current: '1.9.0',
        wanted: '1.9.0',
        latest: '2.0.0',
        dependencyType: 'dependencies',
      },
      latestPrerelease: {
        current: '1.0.0',
        wanted: '1.0.0',
        latest: '1.1.0-beta.1',
        dependencyType: 'dependencies',
      },
      olderOnly: {
        current: '1.2.3',
        wanted: '1.2.2',
        latest: '1.2.1',
        dependencyType: 'dependencies',
      },
    },
    'c'.repeat(40),
    '2026-10-11T00:00:00.000Z'
  );

  assert.deepEqual(selectUpdateCandidate(plan, 'wanted'), {
    packageName: 'wanted',
    version: '3.4.2',
    sourceSha: 'c'.repeat(40),
    compatibility: 'patch',
    targetSource: 'wanted',
  });
  assert.deepEqual(selectUpdateCandidate(plan, 'latestPatch'), {
    packageName: 'latestPatch',
    version: '5.1.2',
    sourceSha: 'c'.repeat(40),
    compatibility: 'patch',
    targetSource: 'latest',
  });
  assert.deepEqual(selectUpdateCandidate(plan, 'latestMinor'), {
    packageName: 'latestMinor',
    version: '2.9.0',
    sourceSha: 'c'.repeat(40),
    compatibility: 'minor',
    targetSource: 'latest',
  });
  assert.throws(() => selectUpdateCandidate(plan, 'latestMajor'), /Major candidate .* report-only/);
  assert.throws(
    () => selectUpdateCandidate(plan, 'latestPrerelease'),
    /no safe patch\/minor target/
  );
  assert.throws(() => selectUpdateCandidate(plan, 'olderOnly'), /no safe patch\/minor target/);
  assert.match(renderSummary(plan), /Safe target \| Latest/);
});

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));

test('grounds a candidate report in the installed store and the real workspace usage', () => {
  const plan = buildDependencyPlan(
    {
      pino: {
        current: '9.14.0',
        wanted: '9.14.0',
        latest: '10.4.0',
        dependencyType: 'dependencies',
        isDeprecated: false,
        dependentPackages: [
          { name: '@moonwitness/logger', location: resolve(workspaceRoot, 'packages/logger') },
        ],
      },
    },
    'd'.repeat(40),
    '2026-10-23T00:00:00.000Z'
  );
  const [candidate] = plan.groups.runtime;

  assert.equal(candidate.releaseNotes, 'https://github.com/pinojs/pino');
  assert.equal(candidate.releaseNotesSource, 'installed-manifest');
  assert.deepEqual(candidate.impactedWorkspaces, ['packages/logger']);
  assert.equal(candidate.localUsage.kind, 'local-import-scan');
  assert.ok(candidate.localUsage.referencingFiles > 0);
  assert.ok(candidate.localUsage.specifiers.includes('pino'));
  assert.deepEqual(candidate.majorImpact.testImpacts, ['pnpm typecheck', 'pnpm test:unit:built']);
  assert.match(candidate.majorImpact.localUsage, /reference "pino"/);
  assert.match(renderSummary(plan), /Impacted workspaces: packages\/logger/);
});

test('maps API, Board, UI and workflow dependents onto the lanes that must re-verify a major', () => {
  const plan = buildDependencyPlan(
    {
      react: {
        current: '19.0.0',
        wanted: '19.0.0',
        latest: '20.0.0',
        dependencyType: 'dependencies',
        dependentPackages: [
          { name: '@moonwitness/board', location: resolve(workspaceRoot, 'apps/board') },
          { name: '@moonwitness/ui', location: resolve(workspaceRoot, 'packages/ui') },
          { name: '@moonwitness/api', location: resolve(workspaceRoot, 'apps/api') },
          { name: '.github', location: workspaceRoot },
        ],
      },
    },
    'e'.repeat(40),
    '2026-10-23T00:00:00.000Z'
  );

  assert.deepEqual(plan.groups.runtime[0].impactedWorkspaces, [
    '.github',
    'apps/api',
    'apps/board',
    'packages/ui',
  ]);
  assert.deepEqual(plan.groups.runtime[0].majorImpact.testImpacts, [
    'pnpm typecheck',
    'pnpm test:unit:built',
    'pnpm test:integration:built',
    'pnpm test:e2e:built',
    'pnpm test:ui-catalog',
    'pnpm test:ui-budget',
    'pnpm test:action-pins',
    'pnpm test:workflow-trust',
    'pnpm test:ci-gate',
    'pnpm automation:check:action-tags',
  ]);
});

test('normalizes the npm repository shorthand into an upstream URL', () => {
  const plan = buildDependencyPlan(
    {
      shorthand: {
        current: '1.0.0',
        wanted: '1.0.0',
        latest: '2.0.0',
        dependencyType: 'dependencies',
        latestManifest: { repository: 'acme/shorthand' },
      },
      prefixed: {
        current: '1.0.0',
        wanted: '1.0.0',
        latest: '2.0.0',
        dependencyType: 'dependencies',
        latestManifest: { repository: { url: 'github:acme/prefixed' } },
      },
    },
    'a'.repeat(40),
    '2026-10-23T00:00:00.000Z'
  );

  assert.deepEqual(
    plan.groups.runtime.map((item) => [item.releaseNotes, item.releaseNotesSource]),
    [
      ['https://github.com/acme/prefixed', 'registry-manifest'],
      ['https://github.com/acme/shorthand', 'registry-manifest'],
    ]
  );
});

test('caps each group at the batch limit and keeps majors out of the batch', () => {
  const outdated = {
    'a-1': patch(),
    'a-2': patch(),
    'a-3': patch(),
    major: {
      current: '1.0.0',
      wanted: '1.0.0',
      latest: '2.0.0',
      dependencyType: 'dependencies',
    },
  };
  const plan = buildDependencyPlan(outdated, 'f'.repeat(40), '2026-10-23T00:00:00.000Z', {
    batchLimit: 2,
  });

  assert.equal(plan.batch.limit, 2);
  assert.deepEqual(
    plan.batch.selected.map((item) => `${item.group}:${item.name}`),
    ['runtime:a-1', 'runtime:a-2']
  );
  assert.deepEqual(plan.batch.deferred, ['runtime:a-3']);
  assert.equal(plan.groups.runtime.find((item) => item.name === 'major').batchSelected, null);
  assert.match(renderSummary(plan), /Selected batch \(2 of the safe patch\/minor candidates\)/);
  assert.equal(selectBatch(plan.groups, 1).selected.length, 1);
  assert.throws(
    () => buildDependencyPlan(outdated, 'f'.repeat(40), 'now', { batchLimit: '0' }),
    /between 1 and 20/
  );
});

function patch() {
  return { current: '1.0.0', wanted: '1.0.1', latest: '1.0.1', dependencyType: 'dependencies' };
}
