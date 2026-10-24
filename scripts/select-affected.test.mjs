import assert, { deepEqual, equal } from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  automationSuitesForPlan,
  ciProjectsForAffectedPackages,
  expandWorkspaceDependencies,
  fullScopeFiles,
  hasFullScopeChange,
  readWorkspaceProjects,
  requiresQualityLane,
} from './select-affected.mjs';

test('shared automation configuration and the master roadmap select full validation', () => {
  equal(hasFullScopeChange(['.github/workflows/ci.yml']), true);
  equal(hasFullScopeChange(['scripts/select-affected.mjs']), true);
  equal(hasFullScopeChange(['ROADMAP.md']), true);
  equal(hasFullScopeChange(['.gitleaks.toml']), true);
  equal(hasFullScopeChange(['.dockerignore']), true);
  equal(hasFullScopeChange(['docker-compose.yml']), true);
  equal(hasFullScopeChange(['docker-compose.smoke.yml']), true);
  equal(hasFullScopeChange(['.githooks/pre-commit']), true);
  equal(hasFullScopeChange(['.gitattributes']), true);
  equal(hasFullScopeChange(['deploy/coolify/app.dockerfile']), true);
  equal(hasFullScopeChange(['docs/guide.md']), false);
});

test('every shared-configuration entry names something that is in the repository', async () => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const rootEntries = await readdir(repositoryRoot, { withFileTypes: true });
  const present = new Set(rootEntries.map((entry) => entry.name));
  deepEqual([...fullScopeFiles].filter((entry) => !present.has(entry)).sort(), []);
});

test('reads workspace dependency closure directly from manifests without requiring pnpm install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moonwitness-affected-'));
  try {
    await writeFile(
      join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - 'apps/*'\n  - 'packages/*'\n"
    );
    await mkdir(join(root, 'apps', 'api'), { recursive: true });
    await mkdir(join(root, 'apps', 'logs'), { recursive: true });
    await mkdir(join(root, 'packages', 'core'), { recursive: true });
    await mkdir(join(root, 'packages', 'orm'), { recursive: true });
    await writeFile(
      join(root, 'apps', 'logs', 'package.json'),
      JSON.stringify({ name: '@moonwitness/logs', dependencies: {} })
    );
    await writeFile(
      join(root, 'apps', 'api', 'package.json'),
      JSON.stringify({
        name: '@moonwitness/api',
        dependencies: { '@moonwitness/orm': 'workspace:*', fastify: '^5.0.0' },
        devDependencies: { '@moonwitness/core': 'workspace:*' },
      })
    );
    await writeFile(
      join(root, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@moonwitness/core', dependencies: {} })
    );
    await writeFile(
      join(root, 'packages', 'orm', 'package.json'),
      JSON.stringify({
        name: '@moonwitness/orm',
        dependencies: { '@moonwitness/core': 'workspace:*' },
      })
    );

    deepEqual(await readWorkspaceProjects(root), [
      {
        name: '@moonwitness/api',
        path: 'apps/api',
        dependencies: ['@moonwitness/core', '@moonwitness/orm'],
      },
      { name: '@moonwitness/core', path: 'packages/core', dependencies: [] },
      { name: '@moonwitness/logs', path: 'apps/logs', dependencies: [] },
      { name: '@moonwitness/orm', path: 'packages/orm', dependencies: ['@moonwitness/core'] },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a workspace directory without a manifest is reported instead of dropped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moonwitness-affected-graph-'));
  try {
    await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    await mkdir(join(root, 'packages', 'orm'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'orm', 'package.json'),
      JSON.stringify({ name: '@moonwitness/orm' })
    );
    await mkdir(join(root, 'packages', 'orm-scratch', 'src'), { recursive: true });
    await assert.rejects(
      () => readWorkspaceProjects(root),
      /packages\/orm-scratch/u,
      'a manifest-less directory must surface as an invalid workspace graph'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const workspace = [
  { name: '@moonwitness/types', dependencies: [] },
  { name: '@moonwitness/orm', dependencies: ['@moonwitness/types'] },
  {
    name: '@moonwitness/orm-base',
    dependencies: ['@moonwitness/orm'],
  },
  {
    name: '@moonwitness/auth',
    dependencies: ['@moonwitness/orm', '@moonwitness/orm-base'],
  },
  {
    name: '@moonwitness/jobs',
    dependencies: ['@moonwitness/orm', '@moonwitness/orm-base'],
  },
  {
    name: '@moonwitness/api',
    dependencies: [
      '@moonwitness/auth',
      '@moonwitness/jobs',
      '@moonwitness/orm',
      '@moonwitness/orm-base',
      '@moonwitness/types',
    ],
  },
  { name: '@moonwitness/client', dependencies: ['@moonwitness/types'] },
  { name: '@moonwitness/board', dependencies: ['@moonwitness/client'] },
  { name: '@moonwitness/ui', dependencies: [] },
  { name: '@moonwitness/ui-catalog', dependencies: ['@moonwitness/ui'] },
  { name: '@moonwitness/assets', dependencies: [] },
];

test('ORM changes expand to auth, jobs, API, and the Board transitively', () => {
  const affected = expandWorkspaceDependencies(['@moonwitness/orm'], workspace);
  deepEqual(
    [...affected].sort(),
    [
      '@moonwitness/api',
      '@moonwitness/auth',
      '@moonwitness/jobs',
      '@moonwitness/orm',
      '@moonwitness/orm-base',
    ].sort()
  );
  deepEqual(ciProjectsForAffectedPackages([...affected]).sort(), [
    'browser',
    'containers',
    'integration',
    'quality',
  ]);
});

test('base type package changes propagate through ORM consumers and client/Board', () => {
  const affected = expandWorkspaceDependencies(['@moonwitness/types'], workspace);
  deepEqual(
    [...affected].sort(),
    [
      '@moonwitness/api',
      '@moonwitness/auth',
      '@moonwitness/board',
      '@moonwitness/client',
      '@moonwitness/jobs',
      '@moonwitness/orm',
      '@moonwitness/orm-base',
      '@moonwitness/types',
    ].sort()
  );
});

test('an unrelated workspace remains outside the dependency closure', () => {
  const affected = expandWorkspaceDependencies(['@moonwitness/logger'], workspace);
  equal(affected.size, 1);
  equal(affected.has('@moonwitness/logger'), true);
});

test('automation and unrelated lanes are omitted when no workspace package is affected', () => {
  deepEqual(ciProjectsForAffectedPackages([]), []);
});

test('roadmap documentation changes retain roadmap policy and lifecycle CI coverage', () => {
  deepEqual(ciProjectsForAffectedPackages([], ['docs/roadmap/ACTIVE-PLAN.md']), ['automation']);
  deepEqual(ciProjectsForAffectedPackages([], ['docs/guides/quickstart.md']), []);
});

test('roadmap-only scope runs one automation suite while full scope keeps every suite', () => {
  deepEqual(automationSuitesForPlan(['automation'], 'affected'), ['roadmap']);
  deepEqual(automationSuitesForPlan(['automation'], 'full'), [
    'workflow',
    'release',
    'roadmap',
    'platform',
  ]);
  deepEqual(automationSuitesForPlan([], 'affected'), []);
});

test('roadmap-only edits do not promote the full quality lane, while mixed docs still do', () => {
  equal(requiresQualityLane(['docs/roadmap/ACTIVE-PLAN.md']), false);
  equal(requiresQualityLane(['docs/roadmap/ACTIVE-PLAN.md', 'docs/guides/quickstart.md']), true);
  equal(requiresQualityLane(['README.md']), true);
  equal(requiresQualityLane(['docs/roadmap/ACTIVE-PLAN.md'], true), true);
});

test('catalog-only changes select UI quality and browser acceptance without unrelated database jobs', () => {
  const affected = expandWorkspaceDependencies(['@moonwitness/ui-catalog'], workspace);
  deepEqual(ciProjectsForAffectedPackages([...affected]).sort(), ['quality', 'ui']);
});

test('shared UI or SVG assets select UI package, catalog, and static asset validation', () => {
  const uiAffected = expandWorkspaceDependencies(['@moonwitness/ui'], workspace);
  assert.equal(uiAffected.has('@moonwitness/ui-catalog'), true);
  deepEqual(ciProjectsForAffectedPackages([...uiAffected]).sort(), ['quality', 'ui']);
  deepEqual(ciProjectsForAffectedPackages(['@moonwitness/assets']).sort(), ['quality', 'ui']);
});
