import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const rootManifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
);
const docsManifest = JSON.parse(
  await readFile(new URL('../apps/docs/package.json', import.meta.url), 'utf8')
);
const docsPlaywrightConfig = await readFile(
  new URL('../apps/docs/playwright.config.ts', import.meta.url),
  'utf8'
);
const uiCatalogManifest = JSON.parse(
  await readFile(new URL('../apps/ui-catalog/package.json', import.meta.url), 'utf8')
);
const releaseWorkflow = (
  await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
).replace(/\r\n/gu, '\n');
// The build-dependent checks moved out of the removed `ci.yml` quality job into the release
// workflow's verify lane; this slice is the only place that ordering is asserted.
const releaseVerification =
  releaseWorkflow.split('  verify:\n')[1]?.split('\n  publish:\n')[0] ?? '';

test('local and CI unit lanes run the offline knowledge CLI against the existing build', async () => {
  const runner = await readFile(new URL('./run-unit-tests.mjs', import.meta.url), 'utf8');
  assert.equal(
    rootManifest.scripts['test:knowledge-cli:built'],
    'node --test scripts/knowledge/validate.test.mjs scripts/knowledge/snapshot.test.mjs scripts/knowledge/legacy-inventory.test.mjs scripts/knowledge/ingest.test.mjs scripts/knowledge/revelation-identity.test.mjs scripts/knowledge/rebuild.test.mjs scripts/knowledge/offline-isolation.test.mjs'
  );
  assert.match(rootManifest.scripts['test:unit:built'], /pnpm test:knowledge-cli:built/u);
  assert.match(runner, /run\(\['run', 'test:knowledge-cli:built'\]/u);
});

test('the release verify lane runs each build-dependent check after the build it reuses', () => {
  const verifySteps = ['pnpm typecheck', 'pnpm docs:check:built', 'pnpm test:unit:built'];
  let previousIndex = -1;
  for (const command of verifySteps) {
    const currentIndex = releaseVerification.indexOf(`run: ${command}`);
    assert.ok(currentIndex > previousIndex, `${command} must follow the earlier build step`);
    previousIndex = currentIndex;
  }
  // Diagram generation is a local/repository-verify step, not a release gate; it must not be
  // assumed to build inside the verify lane.
  assert.doesNotMatch(releaseVerification, /run: pnpm architecture/u);

  assert.match(rootManifest.scripts.typecheck, /pnpm build/u);
  assert.match(rootManifest.scripts['architecture:check'], /--filter @moonwitness\/orm build/u);
  const architectureBuildOrder = [
    '@moonwitness/knowledge',
    '@moonwitness/corpus',
    '@moonwitness/research',
    '@moonwitness/orm-workflow',
    '@moonwitness/orm-knowledge',
  ];
  for (const scriptName of ['architecture:generate', 'architecture:check']) {
    const script = rootManifest.scripts[scriptName];
    let previousIndex = -1;
    for (const packageName of architectureBuildOrder) {
      const currentIndex = script.indexOf(`pnpm --filter ${packageName} build`);
      assert.ok(
        currentIndex > previousIndex,
        `${packageName} must build in dependency order for ${scriptName}`
      );
      previousIndex = currentIndex;
    }
  }
  assert.match(rootManifest.scripts['docs:check'], /--filter @moonwitness\/types build/u);
  assert.match(rootManifest.scripts['docs:examples:check'], /--filter @moonwitness\/orm build/u);
  assert.match(docsManifest.scripts['portal:build'], /@moonwitness\/ui-catalog build/u);
  assert.match(docsManifest.scripts['portal:build'], /scripts\/docs\/build-guide\.mjs/u);
  assert.match(rootManifest.scripts['test:ui-budget'], /@moonwitness\/ui-catalog build:built/u);
  assert.match(uiCatalogManifest.scripts.build, /@moonwitness\/ui build/u);
  assert.match(uiCatalogManifest.scripts['build:built'], /tsc -p tsconfig\.json && vite build/u);
  assert.doesNotMatch(uiCatalogManifest.scripts['build:built'], /@moonwitness\/ui build/u);
});

test('docs portal browser tests build the portal once in Playwright webServer', () => {
  assert.equal(rootManifest.scripts['test:docs-portal'], 'pnpm --filter @moonwitness/docs test');
  assert.match(
    docsPlaywrightConfig,
    /portal:build && pnpm --filter @moonwitness\/docs exec vite preview/u
  );
  assert.match(
    rootManifest.scripts['docs:build:built'],
    /docs:check:built[\s\S]*portal:build:built/u
  );
});

test('built variants consume existing package output without invoking package builds', () => {
  assert.match(rootManifest.scripts['test:unit'], /^pnpm build && pnpm test:unit:built$/u);
  assert.doesNotMatch(rootManifest.scripts['test:unit:built'], /pnpm build/u);
  assert.match(rootManifest.scripts.verify, /pnpm typecheck && pnpm test:unit:built/u);
  assert.match(
    rootManifest.scripts.verify,
    /pnpm architecture:check:built && pnpm docs:build:built/u
  );
  assert.equal(
    rootManifest.scripts['architecture:check:built'],
    'node scripts/architecture/generate-diagrams.mjs --check'
  );
  assert.match(rootManifest.scripts['docs:check:built'], /docs:examples:check:built/u);
  assert.doesNotMatch(rootManifest.scripts['docs:check:built'], /pnpm --filter .* build/u);
  assert.match(rootManifest.scripts['docs:build:built'], /docs:check:built/u);
  assert.match(rootManifest.scripts['docs:build:built'], /portal:build:built/u);
  assert.doesNotMatch(
    docsManifest.scripts['portal:build:built'],
    /@moonwitness\/ui-catalog build/u
  );
  assert.doesNotMatch(
    docsManifest.scripts['portal:build:built'],
    /scripts\/docs\/build-guide\.mjs/u
  );

  assert.equal(rootManifest.scripts['test:integration'], 'node scripts/run-postgres-tests.mjs');
  assert.equal(
    rootManifest.scripts['test:integration:built'],
    'node scripts/run-postgres-tests.mjs --built'
  );
  assert.match(releaseVerification, /run: pnpm typecheck[\s\S]*run: pnpm docs:check:built/u);
  assert.match(releaseVerification, /run: pnpm docs:check:built[\s\S]*run: pnpm test:unit:built/u);
  assert.match(releaseVerification, /run: pnpm typecheck[\s\S]*run: pnpm test:integration:built/u);
});

test('built PostgreSQL mode is recognized and still requires an explicit test database', () => {
  const result = spawnSync(process.execPath, ['scripts/run-postgres-tests.mjs', '--built'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    env: { ...process.env, POSTGRES_TEST_URL: '' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /POSTGRES_TEST_URL is required/u);
  assert.doesNotMatch(result.stderr, /Usage:/u);
});

test('built PostgreSQL mode reuses package output while running type and integration checks', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'moonwitness-postgres-runner-'));
  try {
    const packageManagerStub = join(temporaryDirectory, 'pnpm.mjs');
    await writeFile(
      packageManagerStub,
      "import { appendFile } from 'node:fs/promises'; await appendFile(process.env.COMMAND_LOG, JSON.stringify({ args: process.argv.slice(2), postgresRequired: process.env.REQUIRE_POSTGRES_TESTS }) + '\\n');\n",
      'utf8'
    );

    for (const mode of ['--built', 'standalone']) {
      const commandLog = join(temporaryDirectory, `${mode}.jsonl`);
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./run-postgres-tests.mjs', import.meta.url)),
          ...(mode === 'standalone' ? [] : [mode]),
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          encoding: 'utf8',
          env: {
            ...process.env,
            COMMAND_LOG: commandLog,
            POSTGRES_TEST_URL: 'postgresql://postgres:postgres@localhost/moonwitness_test',
            npm_execpath: packageManagerStub,
          },
        }
      );
      assert.equal(result.status, 0, result.stderr);
      const commands = (await readFile(commandLog, 'utf8'))
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line));
      assert.equal(commands[0]?.args[0], mode === 'standalone' ? 'build' : '--filter');
      assert.ok(commands.some(({ args }) => args.includes('tsc')));
      assert.ok(commands.some(({ args }) => args.includes('vitest')));
      assert.ok(
        commands.some(({ args }) =>
          args.includes('tests/research-suggestion-store.postgres.integration.test.ts')
        )
      );
      assert.ok(commands.every(({ postgresRequired }) => postgresRequired === 'true'));
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
