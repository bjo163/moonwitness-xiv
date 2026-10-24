import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { URL as NodeURL } from 'node:url';
import {
  inspectRepositoryWriteCoordination,
  inspectTrustedCheckoutPolicies,
} from './check-workflow-checkout-trust.mjs';

const expressionStart = '$' + '{';
const normalize = (source) => source.replace(/\r\n/gu, '\n');
const readWorkflow = async (name) =>
  normalize(await readFile(new NodeURL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const pagesAssetReconciler = normalize(
  await readFile(new NodeURL('./docs/reconcile-versioned-docs-asset.mjs', import.meta.url), 'utf8')
);
const pages = `
      - uses: actions/checkout@0123456789012345678901234567890123456789 # v4
        with:
          ref: ${expressionStart}{ github.sha }}
          persist-credentials: false
      - run: pnpm install
    if [[ "$DISPATCH_REF" != "refs/heads/dev" ]]; then exit 1; fi
    if [[ "$DISPATCH_REF" != "refs/heads/main" ]]; then exit 1; fi
    [[ "$SOURCE_REF" =~ ^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]
    select(.publishedAt != null and .isDraft == false and .isPrerelease == false)
    name: Verify and select a published stable release tag
    git merge-base --is-ancestor "$release_sha" refs/remotes/origin/main
    git checkout --detach "$RELEASE_TAG"
    test "$(git rev-parse HEAD)" = "$release_sha"
    name: Verify and select an immutable main source SHA
    git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main
    git cat-file -e "$SOURCE_SHA^{commit}"
    git checkout --detach "$SOURCE_SHA"
`;
const visualReview = `
      - uses: actions/checkout@0123456789012345678901234567890123456789 # v4
        with:
          ref: ${expressionStart}{ github.sha }}
          persist-credentials: false
    if [[ "$DISPATCH_REF" != "refs/heads/dev" ]]; then exit 1; fi
      - name: Scan reports before publishing screenshots
        id: scan_reports
      - name: Publish screenshots for human review
        if: always() && steps.scan_reports.outcome == 'success'
`;
const release = `
    if: github.event_name == 'workflow_dispatch' && inputs.publish && github.ref_type == 'tag'
    needs: verify
    test "$remote_tag_sha" = "$EXPECTED_SOURCE_SHA"
`;
const releasePrepare = `
    if: github.ref == 'refs/heads/dev'
    test "$EXPECTED_SOURCE_SHA" = "$ACTUAL_SOURCE_SHA"
    node scripts/push-expected-ref.mjs origin HEAD refs/heads/dev "$EXPECTED_SOURCE_SHA"
`;
const dependencyCandidate = `
    if: github.ref == 'refs/heads/dev'
    node scripts/push-expected-ref.mjs origin "$EXPECTED_CANDIDATE_SHA" refs/heads/dev "$EXPECTED_SOURCE_SHA"
    gh workflow run promote.yml --repo "$GITHUB_REPOSITORY" --ref dev
    gh workflow run ci.yml --repo "$GH_REPO" --ref dev
`;
const releasePlan = `
    if: github.ref == 'refs/heads/dev'
permissions:
  contents: read
      - run: pnpm release:dry-run -- --output report.json
      - uses: actions/upload-artifact@0123456789012345678901234567890123456789
`;
const promote = `
    checks: read
      - name: Skip stale promotion events
        id: stale
          current_sha="$(git ls-remote origin refs/heads/dev | cut -f1)"
          if [[ "$current_sha" != "$EXPECTED_SHA" ]]; then echo 'stale=true' >> "$GITHUB_OUTPUT"; exit 0; fi
          git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main refs/heads/dev:refs/remotes/origin/dev
      - name: Create or find the promotion pull request
        if: steps.stale.outputs.stale != 'true'
          number="$(gh pr list --base main --head dev --state open --json number --jq '.[0].number // empty')"
          if [ -z "$number" ]; then
            gh pr create --base main --head dev
      - name: Refresh exact-SHA promotion report
        if: steps.stale.outputs.stale != 'true'
          gh api "repos/$GH_REPO/commits/$EXPECTED_SHA/check-runs?per_page=100" > checks.json
          gh pr view "$PR_NUMBER" --json body > promotion-current-body.md
          node scripts/render-promotion-report.mjs base head risk.json checks.json release.json promotion-current-body.md report.md
          gh pr edit "$PR_NUMBER" --repo "$GH_REPO" --body-file "$report_file"
      - name: Classify risk from commits and changed paths
        if: steps.stale.outputs.stale != 'true'
      - name: Ensure approval-required label exists
        if: steps.stale.outputs.stale != 'true' && steps.risk.outputs.approval_required == 'true'
      - name: Disable auto-merge and mark sensitive promotion
        if: steps.stale.outputs.stale != 'true' && steps.risk.outputs.approval_required == 'true'
          gh pr edit "$PR_NUMBER" --repo "$GH_REPO" --add-label approval-required
          gh pr merge "$PR_NUMBER" --repo "$GH_REPO" --disable-auto
      - name: Enable merge for compatible, low-risk promotion
        if: steps.stale.outputs.stale != 'true' && steps.risk.outputs.approval_required != 'true'
          gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json labels --jq '[.labels[].name]'
          if jq -e 'index("approval-required") != null' <<< "$labels" >/dev/null; then
          gh pr edit "$PR_NUMBER" --repo "$GH_REPO" --remove-label approval-required
          gh pr merge "$PR_NUMBER" --repo "$GH_REPO" --auto --merge --match-head-commit "$EXPECTED_SHA"
`;
const versionedPages = `${pages}
  - name: Upload stable documentation archive
  store-versioned-docs:
    DOCS_ARCHIVE_PATH: versioned-docs/docs-site-${expressionStart}{ needs.build.outputs.selected_ref }}.tar.gz
    if [[ ! "$TAG" =~ ^v(0|[1-9][0-9]*) ]]; then exit 1; fi
    git fetch --no-tags origin "refs/tags/$TAG:refs/tags/$TAG"
    node scripts/docs/reconcile-versioned-docs-asset.mjs
  compose-site:
    if: needs.compose-site.result == 'success'
    run: node scripts/docs/versioned-site.mjs compose
    run: node scripts/docs/versioned-site.mjs plan --releases release-inventory.json --limit 5
`;
function policies(overrides = {}) {
  return inspectTrustedCheckoutPolicies({
    pages: versionedPages,
    pagesAssetReconciler,
    visualReview,
    release,
    releasePrepare,
    dependencyCandidate,
    releasePlan,
    promote,
    ...overrides,
  });
}

test('accepts immutable event-SHA checkout and trusted dispatch restrictions', () => {
  assert.deepEqual(policies(), []);
});

test('all repository-writing workflow jobs use their non-cancelling resource lock', async () => {
  const workflowDirectory = new NodeURL('../.github/workflows/', import.meta.url);
  const files = (await readdir(workflowDirectory))
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();
  const workflows = await Promise.all(
    files.map(async (name) => ({
      name,
      source: await readWorkflow(name),
    }))
  );
  assert.deepEqual(inspectRepositoryWriteCoordination(workflows), []);

  const unsafeWorkflows = workflows.map(({ name, source }) => ({
    name,
    source:
      name === 'dependency-candidate.yml'
        ? source.replace(
            '      group: dev-branch-updates\n      cancel-in-progress: false\n',
            '      group: dev-branch-updates\n      cancel-in-progress: true\n'
          )
        : source,
  }));
  assert.ok(
    inspectRepositoryWriteCoordination(unsafeWorkflows).some((finding) =>
      finding.includes('dependency-candidate.yml job "publish"')
    )
  );
});

test('release orchestration is exact-source, ci-gated, and confirmation-bound', async () => {
  const releaseOrchestrate = await readWorkflow('release-orchestrate.yml');
  assert.deepEqual(policies({ releaseOrchestrate }), []);

  const unsafeSource = releaseOrchestrate
    .replace('if [[ "$current" != "$source" ]]', 'true')
    .replace('test "$CONFIRM_STABLE" = "$TAG"', 'true');
  const findings = policies({ releaseOrchestrate: unsafeSource });
  assert.ok(findings.some((finding) => finding.includes('source to be current main')));
  assert.ok(findings.some((finding) => finding.includes('confirm_version to equal')));

  const unsafeGate = policies({
    releaseOrchestrate: releaseOrchestrate.replace(
      '.name == "ci-gate" and .conclusion == "success"',
      '.name == "ci"'
    ),
  });
  assert.ok(unsafeGate.some((finding) => finding.includes('exact-SHA main ci-gate before writes')));

  const unsafeAutomaticStable = policies({
    releaseOrchestrate: releaseOrchestrate.replace('version" != *-rc.*', 'version" == ""'),
  });
  assert.ok(
    unsafeAutomaticStable.some((finding) => finding.includes('reserve stable publication'))
  );
});

test('repository write coordination includes inherited and broad permissions', () => {
  const inherited = `
permissions:
  contents: write
jobs:
  publish:
    steps: []
`;
  const broad = `
permissions:
  contents: read
jobs:
  publish:
    permissions: write-all
    steps: []
`;
  assert.match(
    inspectRepositoryWriteCoordination([{ name: 'inherited.yml', source: inherited }])[0],
    /inherited\.yml job "publish"/u
  );
  assert.match(
    inspectRepositoryWriteCoordination([{ name: 'broad.yml', source: broad }])[0],
    /broad\.yml job "publish"/u
  );
});

test('write workflows use separate resource locks while keeping conflicting writes together', async () => {
  const cases = [
    ['promote.yml', 'promotion-pr-metadata'],
    ['refresh-promotion-report.yml', 'promotion-pr-metadata'],
    ['sync-main-to-dev.yml', 'dev-branch-updates'],
    ['release-prepare.yml', 'dev-branch-updates'],
    ['roadmap-issue-plan.yml', 'roadmap-issue-sync'],
    ['release.yml', 'release-asset-updates'],
    ['release-orchestrate.yml', 'release-asset-updates'],
    ['pages.yml', 'release-asset-updates'],
    ['pages.yml', 'pages-site-deployment'],
    ['pages.yml', 'maintenance-incident-documentation'],
    ['browser-matrix.yml', 'maintenance-incident-browser-regression'],
    ['deep-regression.yml', 'maintenance-incident-deep-regression'],
    ['platform-audit.yml', 'maintenance-incident-platform-audit'],
  ];
  const sources = await Promise.all(
    cases.map(async ([name, group]) => ({
      name,
      group,
      source: await readWorkflow(name),
    }))
  );
  for (const { name, group, source } of sources) {
    assert.match(
      source.replace(/\r\n/gu, '\n'),
      new RegExp(`group: ${group}\\n\\s+cancel-in-progress: false`, 'u'),
      name
    );
  }
  assert.equal(
    sources.find(({ name, group }) => name === 'release.yml' && group === 'release-asset-updates')
      ?.group,
    sources.find(({ name, group }) => name === 'pages.yml' && group === 'release-asset-updates')
      ?.group,
    'release publishing and versioned documentation uploads share an asset lock'
  );

  const unsafePages = sources.map(({ name, source }) => ({
    name,
    source:
      name === 'pages.yml'
        ? source.replace(
            '      group: pages-site-deployment\n      cancel-in-progress: false',
            '      group: uncoordinated-pages-deployment\n      cancel-in-progress: false'
          )
        : source,
  }));
  assert.ok(
    inspectRepositoryWriteCoordination(unsafePages).some((finding) =>
      finding.includes('pages.yml job "deploy"')
    ),
    'the policy rejects a deployment moved out of its shared Pages resource lock'
  );
});

test('promotion report refresh is trusted, dev-scoped, and read-only outside the PR body', async () => {
  const promotionReportRefresh = await readWorkflow('refresh-promotion-report.yml');
  assert.deepEqual(policies({ promotionReportRefresh }), []);

  const unsafe = promotionReportRefresh
    .replace('ref: ${{ github.sha }}', 'ref: ${{ github.event.workflow_run.head_sha }}')
    .replace('      checks: read', '      contents: write');
  const findings = policies({ promotionReportRefresh: unsafe });
  assert.ok(findings.some((finding) => finding.includes('trusted default-branch code')));
  assert.ok(findings.some((finding) => finding.includes('PR-only writes')));
});

test('issue intake workflow keeps the current permission lookup scoped and report inert', async () => {
  const [issueIntake, issueIntakeRunner] = await Promise.all([
    readWorkflow('roadmap-issue-intake.yml'),
    readFile(new NodeURL('./roadmap/run-issue-intake.mjs', import.meta.url), 'utf8'),
  ]);
  assert.deepEqual(policies({ issueIntake, issueIntakeRunner }), []);
});

test('issue intake policy rejects write scopes, unpinned checkout, and user text in summaries', async () => {
  const [issueIntake, issueIntakeRunner] = await Promise.all([
    readWorkflow('roadmap-issue-intake.yml'),
    readFile(new NodeURL('./roadmap/run-issue-intake.mjs', import.meta.url), 'utf8'),
  ]);
  const unsafeWorkflow = issueIntake
    .replace(
      '      contents: read',
      '      contents: read\n      actions: write\n      issues: write'
    )
    .replace('permission-metadata: read', 'permission-issues: write')
    .replace('ref: ${{ github.sha }}', 'ref: ${{ github.event.comment.body }}');
  const unsafeRunner = issueIntakeRunner.replace(
    'kind: result.proposal.kind,',
    'rationale: result.proposal.rationale,'
  );
  const findings = policies({ issueIntake: unsafeWorkflow, issueIntakeRunner: unsafeRunner });
  assert.ok(findings.some((finding) => finding.includes('must not grant write permissions')));
  assert.ok(findings.some((finding) => finding.includes('least-privilege GitHub App token')));
  assert.ok(findings.some((finding) => finding.includes('immutable event-SHA checkout')));
  assert.ok(findings.some((finding) => finding.includes('omit user text')));
  const missingReadPermission = policies({
    issueIntake: issueIntake.replace('      actions: read\n', ''),
    issueIntakeRunner,
  });
  assert.ok(
    missingReadPermission.some((finding) =>
      finding.includes('comment-bound run names and Actions read permission')
    )
  );
});

test('roadmap issue resume dispatch is bounded and Actions write stays apply-scoped', async () => {
  const issueSync = await readWorkflow('roadmap-issue-plan.yml');
  assert.deepEqual(policies({ issueSync }), []);

  const unsafePlanPermission = issueSync.replace(
    '      actions: read\n      contents: read',
    '      actions: write\n      contents: read'
  );
  assert.ok(
    policies({ issueSync: unsafePlanPermission }).some((finding) =>
      finding.includes('planning must keep Actions permission read-only')
    )
  );

  const missingResume = issueSync.replace(
    'LATEST_DEV_SHA="$latest_dev_sha" node scripts/roadmap/resume-stale-issue-sync.mjs',
    'echo stale'
  );
  assert.ok(
    policies({ issueSync: missingResume }).some((finding) =>
      finding.includes('bounded dev workflow-dispatch resume')
    )
  );
});

test('scheduled regression incidents are main-only, isolated, and narrowly scoped', async () => {
  const [browserMatrix, deepRegression] = await Promise.all([
    readWorkflow('browser-matrix.yml'),
    readWorkflow('deep-regression.yml'),
  ]);
  assert.deepEqual(policies({ browserMatrix, deepRegression }), []);

  const unsafe = policies({
    browserMatrix: browserMatrix.replaceAll(
      "github.ref == 'refs/heads/main'",
      "github.ref == 'refs/heads/dev'"
    ),
    deepRegression: deepRegression.replace('      issues: write', '      contents: write'),
  });
  assert.ok(unsafe.some((finding) => finding.includes('limited to main runs')));
  assert.ok(unsafe.some((finding) => finding.includes('issues-only write scope')));
});

test('rejects promotion reports without exact SHA checks or preservation of the existing PR body', () => {
  const unsafe = promote
    .replace('checks: read', 'contents: read')
    .replace('commits/$EXPECTED_SHA/check-runs?per_page=100', 'commits/dev/check-runs?per_page=100')
    .replace('promotion-current-body.md', 'discarded-body.md');
  const findings = policies({ promote: unsafe });
  assert.ok(
    findings.some((finding) => finding.includes('exact-SHA report with read-only check results'))
  );
});

test('requires immutable versioned docs assets and successful five-release composition', () => {
  const unsafePages = versionedPages.replace(
    'scripts/docs/reconcile-versioned-docs-asset.mjs',
    'scripts/docs/other-helper.mjs'
  );
  const missingTagFetch = versionedPages.replace(
    'git fetch --no-tags origin "refs/tags/$TAG:refs/tags/$TAG"',
    ''
  );
  const unsafeReconciler = pagesAssetReconciler.replace('allowPublishedAdditions: true', '');
  const unsafeRetention = versionedPages.replace(
    'versioned-site.mjs plan --releases release-inventory.json --limit 5',
    'versioned-site.mjs plan'
  );
  const findings = policies({ pages: unsafePages, pagesAssetReconciler: unsafeReconciler });
  assert.ok(findings.some((finding) => finding.includes('dedicated immutable asset reconciler')));
  assert.ok(
    policies({ pages: missingTagFetch }).some((finding) =>
      finding.includes('fetch only a validated')
    )
  );
  assert.ok(
    policies({ pagesAssetReconciler: unsafeReconciler }).some((finding) =>
      finding.includes('exact source')
    )
  );
  assert.ok(
    policies({ pages: unsafeRetention }).some((finding) =>
      finding.includes('five-stable-release snapshot retention')
    )
  );
});

test('rejects arbitrary workflow-dispatch checkout refs and persisted credentials', () => {
  const untrustedPages = pages
    .split('ref: ${{ github.sha }}')
    .join('ref: ${{ inputs.source_ref }}');
  const untrustedVisual = visualReview
    .split('persist-credentials: false')
    .join('persist-credentials: true');
  const findings = policies({ pages: untrustedPages, visualReview: untrustedVisual });
  assert.ok(findings.some((finding) => finding.includes('immutable event SHA')));
  assert.ok(findings.some((finding) => finding.includes('persist the workflow token')));
});

test('rejects screenshot upload when report secret scanning is missing or unsuccessful', () => {
  const unsafeVisual = visualReview
    .replace('        id: scan_reports\n', '')
    .replace(
      "        if: always() && steps.scan_reports.outcome == 'success'\n",
      '        if: always()\n'
    );
  assert.ok(
    policies({ visualReview: unsafeVisual }).some((finding) =>
      finding.includes('scan reports successfully before uploading screenshots')
    )
  );
});

test('rejects release-tag checkout before ancestry validation and missing dev guard', () => {
  const ancestryCheck = 'git merge-base --is-ancestor "$release_sha" refs/remotes/origin/main';
  const checkout = 'git checkout --detach "$RELEASE_TAG"';
  const unsafePages = pages
    .split(ancestryCheck)
    .join('')
    .split(checkout)
    .join(`${checkout}\n${ancestryCheck}`);
  const unsafeVisual = visualReview.replace(
    'if [[ "$DISPATCH_REF" != "refs/heads/dev" ]]; then exit 1; fi',
    ''
  );
  const findings = policies({ pages: unsafePages, visualReview: unsafeVisual });
  assert.ok(findings.some((finding) => finding.includes('validate a release tag before')));
  assert.ok(findings.some((finding) => finding.includes('protected dev branch')));
});

test('rejects prerelease Pages publication and immutable-SHA recovery without main ancestry', () => {
  const unsafePages = pages
    .replace('isPrerelease == false', 'isPrerelease != true')
    .replace('git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main', 'true');
  const findings = policies({ pages: unsafePages });
  assert.ok(findings.some((finding) => finding.includes('reject prerelease releases')));
  assert.ok(findings.some((finding) => finding.includes('reachable from main')));
});

test('rejects untrusted release dispatch, stale preparation SHA, and missing follow-up dispatch', () => {
  const findings = policies({
    release: release.replace("github.ref_type == 'tag'", "github.ref_type == 'branch'"),
    releasePrepare: releasePrepare.replace(
      'test "$EXPECTED_SOURCE_SHA" = "$ACTUAL_SOURCE_SHA"',
      'true'
    ),
    dependencyCandidate: dependencyCandidate.replace(
      'gh workflow run ci.yml --repo "$GH_REPO" --ref dev',
      ''
    ),
  });
  assert.ok(findings.some((finding) => finding.includes('explicit dispatch on a version tag')));
  assert.ok(findings.some((finding) => finding.includes('input SHA different from the event SHA')));
  assert.ok(findings.some((finding) => finding.includes('explicitly dispatch full CI')));
});

test('rejects write-capable or non-reviewable release dry-run workflows', () => {
  const findings = policies({
    releasePlan: releasePlan
      .replace("if: github.ref == 'refs/heads/dev'", "if: github.ref == 'refs/heads/feature'")
      .replace('contents: read', 'packages: write')
      .replace(
        'actions/upload-artifact@0123456789012345678901234567890123456789',
        'run: docker push image'
      ),
  });
  assert.ok(findings.some((finding) => finding.includes('only run from dev')));
  assert.ok(findings.some((finding) => finding.includes('remain read-only')));
  assert.ok(findings.some((finding) => finding.includes('reviewable plan artifact')));
  assert.ok(findings.some((finding) => finding.includes('must not publish')));
});

test('promotion disables auto-merge for sensitive changes and binds low-risk merge to exact head', () => {
  const unsafe = promote
    .replace('gh pr merge "$PR_NUMBER" --repo "$GH_REPO" --disable-auto', 'true')
    .replace('--match-head-commit "$EXPECTED_SHA"', '');
  const findings = policies({ promote: unsafe });
  assert.ok(findings.some((finding) => finding.includes('disable auto-merge')));
  assert.ok(findings.some((finding) => finding.includes('exact classified dev SHA')));
});

test('promotion ignores a stale push after dev moves beyond its event SHA', () => {
  const unsafe = promote.replace(
    'if [[ "$current_sha" != "$EXPECTED_SHA" ]]; then echo \'stale=true\' >> "$GITHUB_OUTPUT"; exit 0; fi',
    'true'
  );
  assert.ok(policies({ promote: unsafe }).some((finding) => finding.includes('current dev head')));
});

test('promotion rejects a stale event before fetching its comparison refs', () => {
  const unsafe = promote.replace(
    'if [[ "$current_sha" != "$EXPECTED_SHA" ]]; then echo \'stale=true\' >> "$GITHUB_OUTPUT"; exit 0; fi\n          git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main refs/heads/dev:refs/remotes/origin/dev',
    'git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main refs/heads/dev:refs/remotes/origin/dev\n          if [[ "$current_sha" != "$EXPECTED_SHA" ]]; then exit 0; fi'
  );
  assert.ok(
    policies({ promote: unsafe }).some((finding) =>
      finding.includes('before fetching promotion refs')
    )
  );
});

test('promotion exposes stale-event state and skips every later write-capable step', () => {
  const unsafe = promote.replace('echo \'stale=true\' >> "$GITHUB_OUTPUT"; ', '');
  const findings = policies({ promote: unsafe });
  assert.ok(findings.some((finding) => finding.includes('expose stale-event state')));
});

test('promotion checks fail when sensitive and low-risk commands are moved between steps', () => {
  const unsafe = promote
    .replace('gh pr merge "$PR_NUMBER" --repo "$GH_REPO" --disable-auto', 'true')
    .replace(
      'gh pr merge "$PR_NUMBER" --repo "$GH_REPO" --auto --merge --match-head-commit "$EXPECTED_SHA"',
      'gh pr merge "$PR_NUMBER" --repo "$GH_REPO" --disable-auto'
    );
  assert.ok(
    policies({ promote: unsafe }).some((finding) => finding.includes('disable auto-merge'))
  );
});

test('promotion finds the existing PR before creating and only creates when absent', () => {
  const unsafe = promote.replace('if [ -z "$number" ]; then', 'if true; then');
  assert.ok(
    policies({ promote: unsafe }).some((finding) => finding.includes('create one only when absent'))
  );
});

test('low-risk promotion clears a stale approval label before requesting auto-merge', () => {
  const unsafe = promote.replace(
    'gh pr edit "$PR_NUMBER" --repo "$GH_REPO" --remove-label approval-required',
    'true'
  );
  assert.ok(
    policies({ promote: unsafe }).some((finding) =>
      finding.includes('clear a stale approval-required label')
    )
  );
});

test('low-risk promotion only removes the approval label when it is present', () => {
  const unsafe = promote.replace(
    'if jq -e \'index("approval-required") != null\' <<< "$labels" >/dev/null; then',
    'if true; then'
  );
  assert.ok(
    policies({ promote: unsafe }).some((finding) =>
      finding.includes('clear a stale approval-required label')
    )
  );
});
