import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { summarizeJunitFailures } from './summarize-junit-failures.mjs';
import { renderUnitRunnerFailureReport } from './unit-runner-report.mjs';
import { assertReportsAreSanitized } from './scan-test-reports.mjs';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const pagesWorkflow = readFileSync('.github/workflows/pages.yml', 'utf8');
const unitRunner = readFileSync('scripts/run-unit-tests.mjs', 'utf8');
const e2eRunner = readFileSync('scripts/run-e2e.mjs', 'utf8');
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));

test('failed unit and PostgreSQL jobs annotate testcase names before report scanning', () => {
  assert.match(workflow, /id: unit_tests\s+run: pnpm test:unit:ci/u);
  assert.match(workflow, /id: postgres_tests\s+run: pnpm test:integration:built/u);
  assert.match(
    workflow,
    /if: always\(\) && \(steps\.unit_tests\.outcome == 'failure' \|\| steps\.postgres_tests\.outcome == 'failure'\)[\s\S]*?run: node scripts\/summarize-junit-failures\.mjs test-results\/junit/u
  );

  const annotation = workflow.indexOf('Annotate failed unit and integration testcase names');
  const scanner = workflow.indexOf('Scan reports for secrets before artifact upload');
  assert.ok(annotation >= 0 && scanner > annotation);
});

test('diagnostic report names do not enable upload when the sanitizer rejects JUnit', () => {
  assert.match(workflow, /steps\.scan_reports\.outcome == 'success'/u);
  assert.match(
    workflow,
    /Scan reports for secrets before artifact upload[\s\S]*?run: node scripts\/scan-test-reports\.mjs/u
  );
});

test('UI CI splits build, component tests and export verification with scanned JUnit output', () => {
  assert.match(
    workflow,
    /name: Build shared UI package\s+run: pnpm --filter @moonwitness\/ui build/u
  );
  assert.match(
    workflow,
    /name: Create UI unit test report directory\s+run: node -e ".+test-results\/junit/u
  );
  assert.match(
    workflow,
    /name: Test UI component contracts with JUnit diagnostics\s+run: node --test .+--test-reporter=junit .+ui-package\.xml/u
  );
  assert.match(
    workflow,
    /name: Verify shared UI package public exports\s+run: node packages\/ui\/scripts\/verify-package\.mjs/u
  );
  const uiTests = workflow.indexOf('Test UI component contracts with JUnit diagnostics');
  const scanner = workflow.indexOf('Scan UI browser reports before artifact upload');
  const upload = workflow.indexOf('Upload sanitized UI reports and visual screenshots');
  assert.ok(uiTests >= 0 && scanner > uiTests && upload > scanner);
  assert.match(workflow, /test-results\/junit\/ui-package\.xml/u);
});

test('unit runner records a safe phase name when it fails before writing a suite report', () => {
  const report = renderUnitRunnerFailureReport('API build <failed>', 2);

  assert.deepEqual(summarizeJunitFailures(report), ['unit-runner :: API build <failed> exited 2']);
  assert.doesNotMatch(report, /compiler output|password|token/u);
  assert.match(
    unitRunner,
    /renderUnitRunnerFailureReport\(label, result\.status \?\? 1, buildFailure\)/u
  );
  assert.match(unitRunner, /renderUnitRunnerFailureReport\(label, 1\)/u);
  assert.match(unitRunner, /summarizeWorkspaceBuildDiagnostics\(output\)/u);
  assert.match(unitRunner, /title=Workspace build \$\{diagnostic\.code\}/u);
  assert.match(unitRunner, /See compiler details in the runner log\./u);
  assert.doesNotMatch(unitRunner, /::error[^\n]*\$\{diagnostic\.message\}/u);
  assert.throws(() => renderUnitRunnerFailureReport('Build', 0), /non-zero exit code/u);
});

test('workspace build JUnit exposes sanitized typecheck locations for hosted diagnosis', () => {
  const report = renderUnitRunnerFailureReport('Build', 1, {
    failedPackage: '@moonwitness/orm-request',
    diagnostics: [
      {
        path: 'packages/orm-request/src/manifest.ts',
        line: 3,
        column: 36,
        code: 'TS2307',
        message: 'Cannot find module private-token',
      },
    ],
  });

  assert.match(report, /@moonwitness\/orm-request/u);
  assert.match(report, /packages\/orm-request\/src\/manifest\.ts\(3,36\) TS2307/u);
  assert.doesNotMatch(report, /private-token|Cannot find module/u);
  assert.doesNotThrow(() => assertReportsAreSanitized(report));
});

test('unit runner executes each workspace package suite only once', () => {
  const suiteBlock = unitRunner.match(/const suites = \[([\s\S]*?)\n\];/u)?.[1];
  assert.ok(suiteBlock, 'unit runner suite list should be present');

  const packageNames = [...suiteBlock.matchAll(/packageName: '([^']+)'/gu)].map(
    (match) => match[1]
  );
  assert.ok(packageNames.length > 0, 'unit runner should define workspace package suites');
  assert.equal(new Set(packageNames).size, packageNames.length, 'package suites must be unique');
});

test('root workspace builds use the diagnostic wrapper and its tests run in CI', () => {
  assert.equal(rootPackage.scripts.build, 'node scripts/ci/build-workspace.mjs');
  assert.match(e2eRunner, /runPreflight\('build-api', 'node'/u);
  assert.match(e2eRunner, /'@moonwitness\/api\.\.\.'/u);
  assert.match(
    rootPackage.scripts['test:e2e:diagnostics'],
    /scripts\/ci\/workspace-build-diagnostics\.test\.mjs/u
  );
});

test('candidate Board E2E reuses the exact workspace build produced by typecheck', () => {
  assert.equal(rootPackage.scripts['test:e2e:built'], 'node scripts/run-e2e.mjs --built');
  assert.match(e2eRunner, /const built = args\[0\] === '--built'/u);
  assert.match(e2eRunner, /if \(built\) \{[\s\S]*Using the existing workspace build/u);
  assert.match(e2eRunner, /MW_E2E_USE_BUILT_API: 'true'/u);
  const playwrightConfig = readFileSync('apps/board/playwright.config.ts', 'utf8');
  assert.match(playwrightConfig, /MW_E2E_USE_BUILT_API !== 'true'/u);
});

test('documentation builds are isolated and portal failures annotate sanitized JUnit names', () => {
  const documentedPackages = [
    ['@moonwitness/types', 'types'],
    ['@moonwitness/orm', 'ORM'],
    ['@moonwitness/orm-base', 'base addon'],
    ['@moonwitness/auth', 'auth'],
    ['@moonwitness/jobs', 'jobs'],
    ['@moonwitness/orm-integration', 'integration'],
    ['@moonwitness/orm-notification', 'notifications'],
    ['@moonwitness/orm-organization', 'organization'],
    ['@moonwitness/orm-workflow', 'workflow'],
    ['@moonwitness/orm-request', 'requests'],
    ['@moonwitness/orm-storage', 'storage'],
    ['@moonwitness/orm-knowledge', 'knowledge'],
  ];

  for (const [packageName, label] of documentedPackages) {
    assert.match(
      pagesWorkflow,
      new RegExp(
        `name: Build documentation package ${label}\\s+run: node scripts/ci/build-workspace-package\\.mjs ${packageName}`,
        'u'
      )
    );
  }
  for (const [packageName, label] of [
    ['@moonwitness/knowledge', 'core knowledge contracts'],
    ['@moonwitness/corpus', 'corpus'],
    ['@moonwitness/research', 'research'],
  ]) {
    assert.match(
      pagesWorkflow,
      new RegExp(
        `name: Build documentation package ${label}\\s+run: pnpm --filter ${packageName} build`,
        'u'
      )
    );
  }
  const coreKnowledgePosition = pagesWorkflow.indexOf(
    'name: Build documentation package core knowledge contracts'
  );
  const corpusPosition = pagesWorkflow.indexOf('name: Build documentation package corpus');
  const researchPosition = pagesWorkflow.indexOf('name: Build documentation package research');
  const ormKnowledgePosition = pagesWorkflow.indexOf('name: Build documentation package knowledge');
  assert.ok(coreKnowledgePosition < corpusPosition);
  assert.ok(corpusPosition < researchPosition);
  assert.ok(researchPosition < ormKnowledgePosition);
  const docsBuildPackages = documentedPackages.map(([packageName]) => packageName);
  const requestPackageIndex = docsBuildPackages.indexOf('@moonwitness/orm-request');
  const workflowPackageIndex = docsBuildPackages.indexOf('@moonwitness/orm-workflow');
  const storagePackageIndex = docsBuildPackages.indexOf('@moonwitness/orm-storage');
  const knowledgePackageIndex = docsBuildPackages.indexOf('@moonwitness/orm-knowledge');
  assert.ok(workflowPackageIndex < requestPackageIndex);
  assert.ok(storagePackageIndex < knowledgePackageIndex);
  for (const scriptName of ['docs:check', 'docs:generate']) {
    const script = rootPackage.scripts[scriptName];
    const coreKnowledgePosition = script.indexOf('pnpm --filter @moonwitness/knowledge build');
    const corpusPosition = script.indexOf('pnpm --filter @moonwitness/corpus build');
    const researchPosition = script.indexOf('pnpm --filter @moonwitness/research build');
    const ormKnowledgePosition = script.indexOf('pnpm --filter @moonwitness/orm-knowledge build');
    const workflowPosition = script.indexOf('pnpm --filter @moonwitness/orm-workflow build');
    const requestPosition = script.indexOf('pnpm --filter @moonwitness/orm-request build');
    assert.ok(coreKnowledgePosition >= 0 && corpusPosition > coreKnowledgePosition);
    assert.ok(researchPosition > corpusPosition && ormKnowledgePosition > researchPosition);
    assert.ok(workflowPosition >= 0 && requestPosition > workflowPosition);
  }
  assert.match(
    pagesWorkflow,
    /name: Test documentation generators\s+run: node --test scripts\/docs\/generate-reference\.test\.mjs scripts\/docs\/update-readme\.test\.mjs scripts\/docs\/build-guide\.test\.mjs/u
  );
  assert.match(
    pagesWorkflow,
    /name: Verify generated documentation reference\s+run: node scripts\/docs\/generate-reference\.mjs --check/u
  );
  assert.match(
    pagesWorkflow,
    /name: Verify generated README\s+run: node scripts\/docs\/update-readme\.mjs --check/u
  );
  assert.match(pagesWorkflow, /name: Check documentation links\s+run: pnpm docs:links/u);
  assert.match(
    pagesWorkflow,
    /name: Check documentation example types\s+run: pnpm exec tsc --noEmit -p packages\/orm\/examples\/tsconfig\.json/u
  );
  assert.match(
    pagesWorkflow,
    /name: Test documented addon examples\s+run: pnpm --filter @moonwitness\/orm exec vitest run tests\/addon\.test\.ts/u
  );
  assert.doesNotMatch(pagesWorkflow, /name: Build documentation portal site/u);
  const docsPackage = JSON.parse(readFileSync('apps/docs/package.json', 'utf8'));
  assert.match(
    docsPackage.scripts['portal:build'],
    /node \.\.\/\.\.\/scripts\/docs\/build-guide\.mjs/u
  );
  assert.match(
    readFileSync('apps/docs/playwright.config.ts', 'utf8'),
    /portal:build && pnpm --filter @moonwitness\/docs exec vite preview/u
  );
  assert.match(pagesWorkflow, /name: Test documentation portal\s+id: docs_portal_tests/u);
  assert.match(
    pagesWorkflow,
    /name: Annotate failed documentation portal testcases\s+if: always\(\) && steps\.docs_portal_tests\.outcome == 'failure'\s+continue-on-error: true\s+run: node scripts\/summarize-junit-failures\.mjs test-results\/junit/u
  );
});
