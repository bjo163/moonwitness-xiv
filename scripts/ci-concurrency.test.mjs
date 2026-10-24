import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const lifecycleWorkflow = readFileSync('.github/workflows/roadmap-issue-plan.yml', 'utf8');
const codeqlWorkflow = readFileSync('.github/workflows/codeql.yml', 'utf8');
const gitleaksWorkflow = readFileSync('.github/workflows/gitleaks.yml', 'utf8');
const pagesWorkflow = readFileSync('.github/workflows/pages.yml', 'utf8');
const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
const productionCompose = readFileSync('docker-compose.production.yml', 'utf8');
const containerSmoke = readFileSync('scripts/smoke-containers.mjs', 'utf8');

test('CI cancels stale runs only within the same target branch and event type', () => {
  assert.match(
    workflow,
    /group:\s*ci-\$\{\{\s*github\.event\.pull_request\.base\.ref\s*\|\|\s*github\.ref_name\s*\}\}-\$\{\{\s*github\.event_name\s*\}\}/u
  );
  assert.match(workflow, /cancel-in-progress:\s*true/u);

  const group = (branch, event) => `ci-${branch}-${event}`;
  assert.notEqual(group('dev', 'push'), group('dev', 'pull_request'));
  assert.notEqual(group('main', 'pull_request'), group('dev', 'push'));
  assert.equal(group('dev', 'push'), group('dev', 'push'));
});

test('technical CI plans full validation on main and a thin lane on dev pushes', () => {
  assert.match(workflow, /^ {2}pull_request:\r?\n {4}branches: \[dev, main\]$/mu);
  assert.match(workflow, /^ {2}push:\r?\n {4}branches: \[dev, main\]$/mu);
  assert.match(workflow, /GITHUB_EVENT_NAME" == "push" && "\$GITHUB_REF" == "refs\/heads\/dev"/u);
  assert.match(workflow, /'projects=\["quality","automation"\]'/u);
  assert.match(workflow, /"reason":"thin-validation-on-integration-branch"/u);

  for (const source of [codeqlWorkflow, gitleaksWorkflow]) {
    assert.match(source, /^ {2}pull_request:\r?\n {4}branches: \[dev, main\]$/mu);
    assert.match(source, /^ {2}push:\r?\n {4}branches: \[main\]$/mu);
  }

  const planJob = workflow.match(/ {2}plan:[\s\S]*?\n {2}quality:/u)?.[0];
  assert.ok(planJob, 'CI should keep planning promotion risk for every event');
  assert.match(planJob, /GITHUB_EVENT_NAME" == "pull_request_review"/u);
  assert.match(planJob, /printf '%s\\n' 'projects=\[\]'/u);
});

test('roadmap lifecycle may read PR identity without gaining pull request write access', () => {
  const planJob = lifecycleWorkflow.match(/ {2}plan:[\s\S]*?\n {2}apply:/u)?.[0];
  const applyJob = lifecycleWorkflow.match(/ {2}apply:[\s\S]*$/u)?.[0];
  assert.ok(planJob, 'issue sync should define its read-only planning job');
  assert.ok(applyJob, 'issue sync should define its bounded apply job');
  assert.match(planJob, /pull-requests: read/u);
  assert.match(applyJob, /pull-requests: read/u);
  assert.doesNotMatch(lifecycleWorkflow, /pull-requests: write/u);
});

test('technical gate validates every required lane and stays independent from promotion approval', () => {
  const technicalJob = workflow.match(/ {2}ci-technical-gate:[\s\S]*?\n {2}ci-gate:/u)?.[0];
  assert.ok(technicalJob, 'CI should define its technical gate');
  assert.match(technicalJob, /if: always\(\) && github\.event_name != 'pull_request_review'/u);
  assert.match(
    technicalJob,
    /needs: \[plan, quality, integration, browser, containers, automation, ui\]/u
  );
  assert.match(
    technicalJob,
    /node --test scripts\/ci-gate\.test\.mjs scripts\/ci-concurrency\.test\.mjs scripts\/scan-test-reports\.test\.mjs/u
  );
  assert.doesNotMatch(technicalJob, /CODEOWNER|check-promotion-approval/u);

  const gateJob = workflow.match(/ {2}ci-gate:[\s\S]*$/u)?.[0];
  assert.ok(gateJob, 'CI should define its final gate job');
  assert.doesNotMatch(gateJob, /setup-pnpm|pnpm install/u);
  assert.match(gateJob, /actions\/setup-node@[0-9a-f]{40}/u);
  assert.match(gateJob, /node-version: ['"]22['"]/u);
  assert.match(gateJob, /needs: .*ci-technical-gate/u);
  assert.match(gateJob, /needs\.ci-technical-gate\.result/u);
  assert.match(gateJob, /check-promotion-approval\.mjs/u);
  assert.match(gateJob, /Verify exact-head technical CI evidence for review events/u);
  assert.match(gateJob, /review-ci-evidence\.mjs verify/u);
  assert.match(workflow, /actions: read/u);
});

test('affected CI selector keeps full validation for shared config and master roadmap changes', () => {
  const selector = readFileSync('scripts/select-affected.mjs', 'utf8');
  assert.match(
    selector,
    /const requiredProjects = \['quality', 'integration', 'browser', 'containers', 'automation', 'ui'\]/u
  );
  assert.match(selector, /'ROADMAP\.md'/u);
  assert.match(selector, /const projects = new Set\(\)/u);
});

test('CI planning pins the supported Node runtime without installing pnpm or workspace dependencies', () => {
  const planJob = workflow.match(/ {2}plan:[\s\S]*?\n {2}quality:/u)?.[0];
  assert.ok(planJob, 'CI should define its planning job');
  assert.match(planJob, /actions\/setup-node@[0-9a-f]{40}/u);
  assert.match(planJob, /node-version: ['"]22['"]/u);
  assert.doesNotMatch(planJob, /setup-pnpm|pnpm install/u);
});

test('integration job supplies isolated credentials to the application restore drill', () => {
  const integrationJob = workflow.match(/ {2}integration:[\s\S]*?\n {2}browser:/u)?.[0];
  assert.ok(integrationJob, 'CI should define its integration job');
  assert.match(integrationJob, /JWT_SECRET:\s*ci-only-secret-that-is-at-least-32-characters-long/u);
});

test('Pages portal tests build and serve the publication site only once', () => {
  assert.doesNotMatch(pagesWorkflow, /name: Build documentation portal site/u);
  assert.match(pagesWorkflow, /name: Test documentation portal\s+id: docs_portal_tests/u);
  assert.match(pagesWorkflow, /run: pnpm --filter @moonwitness\/docs test/u);
});

test('every caller of the production Compose stack supplies each variable it requires', () => {
  const required = [...productionCompose.matchAll(/\$\{([A-Z0-9_]+):\?[^}]*\}/gu)].map(
    ([, name]) => name
  );
  assert.ok(required.includes('JWT_SECRET'), 'the Compose requirement scan must find real keys');

  const callers = [
    [
      'CI containers job',
      workflow.match(/name: Validate production Compose configuration[\s\S]*?config --quiet/u),
    ],
    [
      'release verify job',
      releaseWorkflow.match(
        /name: Validate production Compose configuration[\s\S]*?config --quiet/u
      ),
    ],
    [
      'container smoke runner',
      containerSmoke.match(/const composeEnvironment = \{[\s\S]*?\n {2}\};/u),
    ],
  ];
  for (const [label, source] of callers) {
    assert.ok(source, `${label} must keep its Compose variable source in place`);
    for (const name of new Set(required)) {
      assert.match(
        source[0],
        new RegExp(`\\b${name}\\s*:`, 'u'),
        `${label} must define ${name}; Compose interpolation fails before any container starts`
      );
    }
  }
});
