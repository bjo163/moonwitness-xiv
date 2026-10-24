import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const repositoryWriteScopes = new Set([
  'contents',
  'deployments',
  'issues',
  'packages',
  'pages',
  'pull-requests',
]);

const requiredWriteConcurrencyGroups = new Map([
  ['promote.yml:*', 'promotion-pr-metadata'],
  ['refresh-promotion-report.yml:*', 'promotion-pr-metadata'],
  ['sync-main-to-dev.yml:*', 'dev-branch-updates'],
  ['release-prepare.yml:prepare', 'dev-branch-updates'],
  ['dependency-candidate.yml:publish', 'dev-branch-updates'],
  ['roadmap-issue-plan.yml:apply', 'roadmap-issue-sync'],
  ['release.yml:publish', 'release-asset-updates'],
  ['release-orchestrate.yml:publish-rc', 'release-asset-updates'],
  ['release-orchestrate.yml:publish-stable', 'release-asset-updates'],
  ['pages.yml:store-versioned-docs', 'release-asset-updates'],
  ['pages.yml:compose-site', 'pages-site-compose'],
  ['pages.yml:deploy', 'pages-site-deployment'],
  ['pages.yml:report-failure', 'maintenance-incident-documentation'],
  ['pages.yml:resolve-failure', 'maintenance-incident-documentation'],
  ['browser-matrix.yml:report-failure', 'maintenance-incident-browser-regression'],
  ['browser-matrix.yml:resolve-failure', 'maintenance-incident-browser-regression'],
  ['deep-regression.yml:report-failure', 'maintenance-incident-deep-regression'],
  ['deep-regression.yml:resolve-failure', 'maintenance-incident-deep-regression'],
  ['platform-audit.yml:report-failure', 'maintenance-incident-platform-audit'],
  ['platform-audit.yml:resolve-failure', 'maintenance-incident-platform-audit'],
]);

function workflowJobBlocks(source) {
  const jobsIndex = source.search(/^jobs:\s*$/mu);
  if (jobsIndex < 0) return [];
  const jobsSource = source.slice(jobsIndex);
  const starts = [...jobsSource.matchAll(/^(?: ){2}(?<name>[a-zA-Z0-9_-]+):\s*$/gmu)];
  return starts.map((match, index) => {
    const start = match.index;
    const end = starts[index + 1]?.index ?? jobsSource.length;
    return { name: match.groups.name, source: jobsSource.slice(start, end) };
  });
}

export function inspectRepositoryWriteCoordination(workflows) {
  const findings = [];
  for (const workflow of workflows) {
    const name = workflow.name;
    const source = (workflow.source ?? '').replace(/\r\n/gu, '\n');
    const workflowHeader = source.split(/^jobs:\s*$/mu, 1)[0];
    const workflowWritePermissions = [
      ...workflowHeader.matchAll(/^(?: ){2}(?<scope>[a-z-]+):\s*write\s*$/gmu),
    ]
      .map((match) => match.groups.scope)
      .filter((scope) => repositoryWriteScopes.has(scope));
    const workflowGrantsWriteAll = /^permissions:\s*write-all\s*$/mu.test(workflowHeader);
    const workflowConcurrency = /^concurrency:\s*\r?\n(?<block>(?:\s+[^\r\n]*\r?\n?)+)/mu.exec(
      workflowHeader
    )?.groups?.block;
    const workflowGroup = /^\s+group:\s*(?<group>[^\s]+)\s*$/mu.exec(workflowConcurrency ?? '')
      ?.groups?.group;
    const workflowCancelInProgress = /^\s+cancel-in-progress:\s*(?<value>\S+)\s*$/mu.exec(
      workflowConcurrency ?? ''
    )?.groups?.value;
    const workflowCoordinatesWrites =
      Boolean(workflowGroup) && workflowCancelInProgress === 'false';

    for (const job of workflowJobBlocks(source)) {
      const hasJobPermissions = /^(?: ){4}permissions:(?:\s+write-all)?\s*$/mu.test(job.source);
      const writePermissions = [...job.source.matchAll(/^\s{6}(?<scope>[a-z-]+):\s*write\s*$/gmu)]
        .map((match) => match.groups.scope)
        .filter((scope) => repositoryWriteScopes.has(scope));
      const inheritedWritePermissions =
        !hasJobPermissions && (workflowWritePermissions.length > 0 || workflowGrantsWriteAll);
      const jobGrantsWriteAll = /^(?: ){4}permissions:\s*write-all\s*$/mu.test(job.source);
      const publishesOrMutates =
        /\b(?:git push|gh (?:pr (?:create|edit|merge|close)|release (?:create|edit|upload|delete))|actions\/deploy-pages@|maintenance-incident\.mjs)\b/u.test(
          job.source
        );
      if (
        writePermissions.length === 0 &&
        !inheritedWritePermissions &&
        !jobGrantsWriteAll &&
        !publishesOrMutates
      )
        continue;

      const jobConcurrency =
        /^(?: ){4}concurrency:\s*\r?\n(?<block>(?:\s{6}[^\r\n]*\r?\n?)+)/mu.exec(job.source)?.groups
          ?.block;
      const jobGroup = /^\s{6}group:\s*(?<group>[^\s]+)\s*$/mu.exec(jobConcurrency ?? '')?.groups
        ?.group;
      const jobCancelInProgress = /^\s{6}cancel-in-progress:\s*(?<value>\S+)\s*$/mu.exec(
        jobConcurrency ?? ''
      )?.groups?.value;
      const jobCoordinatesWrites = Boolean(jobGroup) && jobCancelInProgress === 'false';
      if (!workflowCoordinatesWrites && !jobCoordinatesWrites) {
        findings.push(
          `${name} job "${job.name}" can write repository state but has no non-cancelling concurrency group.`
        );
        continue;
      }
      const expectedGroup =
        requiredWriteConcurrencyGroups.get(`${name}:${job.name}`) ??
        requiredWriteConcurrencyGroups.get(`${name}:*`);
      const actualGroup = jobCoordinatesWrites ? jobGroup : workflowGroup;
      if (!expectedGroup) {
        findings.push(
          `${name} job "${job.name}" is missing an explicit resource-specific concurrency policy.`
        );
      } else if (actualGroup !== expectedGroup) {
        findings.push(
          `${name} job "${job.name}" must use the resource concurrency group "${expectedGroup}".`
        );
      }
    }
  }
  return findings;
}

function checkoutSteps(source) {
  const starts = [
    ...source.matchAll(/^(?<indent>\s*)-\s+uses:\s+actions\/checkout@[^\r\n]*\r?\n/gmu),
  ];
  return starts.map((match, index) => {
    const start = match.index + match[0].length;
    const indent = match.groups.indent.length;
    const next = starts[index + 1]?.index ?? source.length;
    const block = source.slice(start, next);
    const stepStart = block.search(new RegExp(`^\\s{0,${indent}}-\\s`, 'mu'));
    return stepStart < 0 ? block : block.slice(0, stepStart);
  });
}

function namedWorkflowStep(source, expectedName) {
  const lines = source.split(/\r?\n/u);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^(?<indent>\s*)- name: (?<name>.+?)\s*$/u.exec(line);
    if (match?.groups?.name !== expectedName) continue;
    const indent = match.groups.indent.length;
    let end = index + 1;
    while (end < lines.length) {
      const candidate = lines[end];
      const candidateIndent = candidate.length - candidate.trimStart().length;
      if (candidateIndent === indent && candidate.startsWith(`${' '.repeat(indent)}- `)) break;
      end += 1;
    }
    matches.push(lines.slice(index, end).join('\n'));
  }
  return matches.length === 1 ? matches[0] : null;
}

export function inspectTrustedCheckoutPolicies({
  pages,
  pagesAssetReconciler = '',
  visualReview,
  release,
  releasePrepare,
  dependencyCandidate,
  releasePlan,
  releaseOrchestrate,
  promote,
  promotionReportRefresh,
  issueIntake,
  issueIntakeRunner,
  issueSync,
  browserMatrix,
  deepRegression,
}) {
  const normalize = (source) => (source ?? '').replace(/\r\n/gu, '\n');
  pages = normalize(pages);
  pagesAssetReconciler = normalize(pagesAssetReconciler);
  visualReview = normalize(visualReview);
  release = normalize(release);
  releasePrepare = normalize(releasePrepare);
  dependencyCandidate = normalize(dependencyCandidate);
  releasePlan = normalize(releasePlan);
  releaseOrchestrate = normalize(releaseOrchestrate);
  promote = normalize(promote);
  promotionReportRefresh = normalize(promotionReportRefresh);
  issueIntake = normalize(issueIntake);
  issueIntakeRunner = normalize(issueIntakeRunner);
  issueSync = normalize(issueSync);
  browserMatrix = normalize(browserMatrix);
  deepRegression = normalize(deepRegression);

  const findings = [];
  for (const [name, source] of [
    ['pages.yml', pages],
    ['visual-review.yml', visualReview],
  ]) {
    const steps = checkoutSteps(source);
    if (steps.length === 0) {
      findings.push(`${name} must have a reviewed checkout step.`);
      continue;
    }
    for (const [index, checkout] of steps.entries()) {
      if (!checkout.includes('ref: ${{ github.sha }}'))
        findings.push(
          `${name} checkout ${index + 1} must use the immutable event SHA, not a dispatch input.`
        );
      if (!checkout.includes('persist-credentials: false'))
        findings.push(
          `${name} checkout ${index + 1} must not persist the workflow token in git config.`
        );
      if (checkout.includes('${{ inputs.') || checkout.includes('${{inputs.'))
        findings.push(
          `${name} checkout ${index + 1} must not interpolate workflow-dispatch input.`
        );
    }
  }

  if (!pages.includes('DISPATCH_REF" != "refs/heads/dev"'))
    findings.push('Pages preview dispatch must be restricted to the protected dev branch.');
  if (!pages.includes('DISPATCH_REF" != "refs/heads/main"'))
    findings.push('Pages publication dispatch must be restricted to the protected main branch.');
  if (!pages.includes('git merge-base --is-ancestor "$release_sha" refs/remotes/origin/main'))
    findings.push('Release-tag checkout must verify that the tag is reachable from main.');
  if (
    pages.indexOf('git merge-base --is-ancestor "$release_sha" refs/remotes/origin/main') >
    pages.indexOf('git checkout --detach "$RELEASE_TAG"')
  ) {
    findings.push('Pages must validate a release tag before checking out its source code.');
  }
  if (!pages.includes('test "$(git rev-parse HEAD)" = "$release_sha"'))
    findings.push(
      'Pages must verify the checked-out release tag still matches its resolved commit.'
    );
  if (
    pages.indexOf('git checkout --detach "$RELEASE_TAG"') >
    pages.indexOf('name: Verify and select an immutable main source SHA')
  ) {
    findings.push('Pages must keep stable-tag checkout in its tag-selection step.');
  }
  if (!pages.includes('isPrerelease == false'))
    findings.push('Pages must reject prerelease releases as stable documentation sources.');
  if (!pages.includes('SOURCE_REF" =~ ^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'))
    findings.push('Pages publication must accept only stable SemVer release tags.');
  if (!pages.includes('git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main'))
    findings.push('Pages SHA recovery must require the exact source to be reachable from main.');
  if (!pages.includes('git cat-file -e "$SOURCE_SHA^{commit}"'))
    findings.push('Pages SHA recovery must require a full commit object before checkout.');
  if (!pages.includes('git checkout --detach "$SOURCE_SHA"'))
    findings.push('Pages recovery must rebuild from the exact requested source SHA.');
  if (
    pages.indexOf('git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main') >
    pages.indexOf('git checkout --detach "$SOURCE_SHA"')
  ) {
    findings.push('Pages must validate a recovery SHA before checking out its source code.');
  }

  if (!visualReview.includes('DISPATCH_REF" != "refs/heads/dev"'))
    findings.push('Visual review dispatch must be restricted to the protected dev branch.');
  if (
    visualReview.includes('name: Publish screenshots for human review') &&
    (!visualReview.includes('id: scan_reports') ||
      !visualReview.includes("if: always() && steps.scan_reports.outcome == 'success'"))
  ) {
    findings.push('Visual review must scan reports successfully before uploading screenshots.');
  }
  if (visualReview.split(/\r?\n/u).some((line) => line.startsWith('    inputs:')))
    findings.push('Visual review must not accept an arbitrary ref input.');

  if (release) {
    if (
      !release.includes(
        "if: github.event_name == 'workflow_dispatch' && inputs.publish && github.ref_type == 'tag'"
      )
    )
      findings.push('Release publishing must require an explicit dispatch on a version tag.');
    if (!release.includes('needs: verify'))
      findings.push('Release publishing must depend on the verification job.');
    if (!release.includes('test "$remote_tag_sha" = "$EXPECTED_SOURCE_SHA"'))
      findings.push('Release publishing must revalidate the exact source tag SHA before writes.');
  }

  if (releasePrepare) {
    if (!releasePrepare.includes("if: github.ref == 'refs/heads/dev'"))
      findings.push('Release preparation must only run from dev.');
    if (!releasePrepare.includes('test "$EXPECTED_SOURCE_SHA" = "$ACTUAL_SOURCE_SHA"'))
      findings.push('Release preparation must reject an input SHA different from the event SHA.');
    if (!releasePrepare.includes('node scripts/push-expected-ref.mjs origin HEAD refs/heads/dev'))
      findings.push('Release preparation must publish with an expected-dev-SHA guard.');
  }

  if (dependencyCandidate) {
    if (!dependencyCandidate.includes("if: github.ref == 'refs/heads/dev'"))
      findings.push('Dependency candidate workflow must only run from dev.');
    if (
      !dependencyCandidate.includes(
        'node scripts/push-expected-ref.mjs origin "$EXPECTED_CANDIDATE_SHA" refs/heads/dev "$EXPECTED_SOURCE_SHA"'
      )
    )
      findings.push('Dependency candidate publication must use the expected source SHA guard.');
    if (
      !dependencyCandidate.includes(
        'gh workflow run promote.yml --repo "$GITHUB_REPOSITORY" --ref dev'
      )
    )
      findings.push(
        'Dependency candidate must explicitly dispatch promotion after its GITHUB_TOKEN push.'
      );
    if (!dependencyCandidate.includes('gh workflow run ci.yml --repo "$GH_REPO" --ref dev'))
      findings.push(
        'Dependency candidate must explicitly dispatch full CI after its GITHUB_TOKEN push.'
      );
  }

  if (releasePlan) {
    if (!releasePlan.includes("if: github.ref == 'refs/heads/dev'"))
      findings.push('Release dry-run must only run from dev.');
    if (!releasePlan.includes('permissions:\n  contents: read'))
      findings.push('Release dry-run workflow must remain read-only.');
    if (!releasePlan.includes('pnpm release:dry-run'))
      findings.push('Release dry-run workflow must use the shared release planner.');
    if (!releasePlan.includes('actions/upload-artifact@'))
      findings.push('Release dry-run workflow must retain a reviewable plan artifact.');
    if (/packages:\s*write|deploy-pages|docker push|gh release create/u.test(releasePlan))
      findings.push(
        'Release dry-run workflow must not publish packages, releases, or deployments.'
      );
  }

  if (releaseOrchestrate) {
    const sourceStep = namedWorkflowStep(
      releaseOrchestrate,
      'Resolve and verify the trusted main source'
    );
    const gateStep = namedWorkflowStep(
      releaseOrchestrate,
      'Verify the exact main ci-gate for the source SHA'
    );
    const decisionStep = namedWorkflowStep(
      releaseOrchestrate,
      'Decide the next idempotent release action'
    );
    const prepareStep = namedWorkflowStep(
      releaseOrchestrate,
      'Dispatch release preparation on dev'
    );
    const rcTagStep = namedWorkflowStep(
      releaseOrchestrate,
      'Revalidate main and create the immutable release tag'
    );
    const rcDispatchStep = namedWorkflowStep(
      releaseOrchestrate,
      'Dispatch the trusted release workflow for the new tag'
    );
    const stableTagStep = namedWorkflowStep(
      releaseOrchestrate,
      'Revalidate main, stable confirmation, and the release tag'
    );
    const stableDispatchStep = namedWorkflowStep(
      releaseOrchestrate,
      'Dispatch the confirmed stable release workflow'
    );

    if (
      !releaseOrchestrate.includes('workflow_run:') ||
      !releaseOrchestrate.includes('workflows:\n      - CI') ||
      !releaseOrchestrate.includes('types: [completed]') ||
      !releaseOrchestrate.includes('branches: [main]')
    )
      findings.push(
        'Release orchestration must start only from a completed main CI run or an explicit dispatch.'
      );
    for (const fragment of [
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.head_branch == 'main'",
      'github.event.workflow_run.head_repository.full_name == github.repository',
    ]) {
      if (!releaseOrchestrate.includes(fragment))
        findings.push(
          'Release orchestration must verify same-repository main push CI provenance before writes.'
        );
    }
    if (
      !sourceStep?.includes('[[ "$DISPATCH_REF" == "refs/heads/main" ]]') ||
      !sourceStep.includes('[[ "$source" =~ ^[a-f0-9]{40}$ ]]') ||
      !sourceStep.includes('gh api "repos/$GH_REPO/git/ref/heads/main"') ||
      !sourceStep.includes('if [[ "$current" != "$source" ]]')
    )
      findings.push(
        'Release orchestration must restrict manual dispatch to main and require the source to be current main.'
      );
    if (
      !sourceStep?.includes('source="$RUN_SHA"') ||
      !sourceStep.includes('source="$DISPATCH_SHA"') ||
      !sourceStep.includes('source="$INPUT_SHA"')
    )
      findings.push(
        'Release orchestration must resolve an immutable commit SHA, never a branch ref.'
      );

    const orchestrateCheckouts = checkoutSteps(releaseOrchestrate);
    if (
      orchestrateCheckouts.length !== 3 ||
      !orchestrateCheckouts[0]?.includes('ref: ${{ steps.source.outputs.source }}') ||
      !orchestrateCheckouts[1]?.includes('ref: ${{ needs.decide.outputs.source_sha }}') ||
      !orchestrateCheckouts[2]?.includes('ref: ${{ needs.decide.outputs.source_sha }}')
    )
      findings.push(
        'Release orchestration jobs must check out the validated source SHA instead of a dispatch ref.'
      );
    if (orchestrateCheckouts.some((checkout) => checkout.includes('${{ inputs.')))
      findings.push('Release orchestration checkouts must never interpolate a workflow input ref.');
    if (releaseOrchestrate.includes('download-artifact@'))
      findings.push(
        'Release orchestration must not execute artifacts from an earlier workflow run.'
      );

    if (
      !gateStep?.includes('head_sha=$SOURCE_SHA&event=push') ||
      !gateStep.includes('sort_by(.created_at, .run_attempt) | last') ||
      !gateStep.includes('EVENT_RUN_ID') ||
      !gateStep.includes('.name == "ci-gate" and .conclusion == "success"')
    )
      findings.push(
        'Release orchestration must require the newest successful exact-SHA main ci-gate before writes.'
      );
    if (
      !decisionStep?.includes('scripts/release-orchestrator.mjs') ||
      !decisionStep.includes('--releases-file') ||
      !decisionStep.includes('--remote-tags-file') ||
      !decisionStep.includes('if [[ "$status" == "blocked" ]]') ||
      !decisionStep.includes('version" != *-rc.*')
    )
      findings.push(
        'Release orchestration must fail closed on blocked plans and reserve stable publication for explicit dispatch.'
      );
    if (
      !prepareStep?.includes('[[ "$EXPECTED_DEV_SHA" =~ ^[a-f0-9]{40}$ ]]') ||
      !prepareStep.includes('gh workflow run release-prepare.yml --repo "$GH_REPO" --ref dev') ||
      !prepareStep.includes('-f expected_dev_sha="$EXPECTED_DEV_SHA" -f channel="$CHANNEL"') ||
      !releaseOrchestrate.includes("if: needs.decide.outputs.action == 'prepare'")
    )
      findings.push(
        'Release orchestration must dispatch preparation only for a prepared action on dev with the expected SHA and channel.'
      );
    for (const [name, step] of [
      ['release candidate tag', rcTagStep],
      ['stable tag', stableTagStep],
    ]) {
      if (
        !step?.includes('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"') ||
        !step.includes(
          'test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$SOURCE_SHA"'
        ) ||
        !step.includes('node scripts/create-release-tag.mjs "$TAG" "$SOURCE_SHA"')
      )
        findings.push(
          `Release orchestration must create the ${name} only after revalidating the exact current main source.`
        );
    }
    if (!stableTagStep?.includes('test "$CONFIRM_STABLE" = "$TAG"'))
      findings.push('Stable orchestration must require confirm_version to equal the released tag.');
    if (
      !rcDispatchStep?.includes('gh workflow run release.yml --repo "$GH_REPO" --ref "$TAG"') ||
      !rcDispatchStep.includes('-f version="$TAG" -f publish=true')
    )
      findings.push(
        'Release orchestration must explicitly dispatch publication for the exact release tag.'
      );
    if (!stableDispatchStep?.includes('-f confirm_stable="$TAG"'))
      findings.push(
        'Stable orchestration must forward the exact confirmation to the trusted release workflow.'
      );
    if (
      !releaseOrchestrate.includes(
        "if: needs.decide.outputs.action == 'release' && needs.decide.outputs.confirm_stable == ''"
      ) ||
      !releaseOrchestrate.includes(
        "if: needs.decide.outputs.action == 'release' && needs.decide.outputs.confirm_stable != ''"
      ) ||
      !releaseOrchestrate.includes('environment: release')
    )
      findings.push(
        'Stable publication must be isolated behind the release environment and its confirmation.'
      );
    const orchestrateHeader = releaseOrchestrate.split(/^jobs:\s*$/mu, 1)[0];
    if (
      !orchestrateHeader.includes('permissions:\n  contents: read') ||
      /^\s{2}contents:\s+write\s*$/mu.test(orchestrateHeader)
    )
      findings.push('Release orchestration must keep workflow-level permissions read-only.');
    if (/\bgit push\b|gh release create|docker push|packages:\s+write/u.test(releaseOrchestrate))
      findings.push(
        'Release orchestration must delegate tag and package publication to the reviewed helpers.'
      );
  }

  if (pages.includes('compose-site:')) {
    if (
      !pages.includes('scripts/docs/reconcile-versioned-docs-asset.mjs') ||
      !pages.includes(
        'DOCS_ARCHIVE_PATH: versioned-docs/docs-site-${{ needs.build.outputs.selected_ref }}.tar.gz'
      ) ||
      !pages.includes('refs/tags/$TAG:refs/tags/$TAG') ||
      !pages.includes('if [[ ! "$TAG" =~ ^v(0|[1-9][0-9]*)')
    )
      findings.push(
        'Versioned Pages snapshots must fetch only a validated stable tag before using the dedicated immutable asset reconciler.'
      );
    if (
      !pagesAssetReconciler.includes('allowPublishedAdditions: true') ||
      !pagesAssetReconciler.includes('resolveTagCommit(tag)') ||
      !pagesAssetReconciler.includes('release.tag_name !== tag') ||
      !pagesAssetReconciler.includes('STABLE_TAG')
    )
      findings.push(
        'Versioned Pages assets must verify a published stable tag and its exact source before reconciliation.'
      );
    if (!pages.includes('name: Upload stable documentation archive'))
      findings.push('Stable docs archive must be available to the immutable release-asset job.');
    if (!pages.includes('versioned-site.mjs compose'))
      findings.push(
        'Pages must compose the retained version map before uploading the deploy artifact.'
      );
    if (!pages.includes("needs.compose-site.result == 'success'"))
      findings.push('Pages deployment must require a successfully composed versioned site.');
    if (!pages.includes('versioned-site.mjs plan --releases release-inventory.json --limit 5'))
      findings.push('Pages must apply the five-stable-release snapshot retention plan.');
  }

  if (promote) {
    const staleGuard = namedWorkflowStep(promote, 'Skip stale promotion events');
    const pullRequest = namedWorkflowStep(promote, 'Create or find the promotion pull request');
    const riskStep = namedWorkflowStep(promote, 'Classify risk from commits and changed paths');
    const report = namedWorkflowStep(promote, 'Refresh exact-SHA promotion report');
    const ensureLabel = namedWorkflowStep(promote, 'Ensure approval-required label exists');
    const sensitive = namedWorkflowStep(promote, 'Disable auto-merge and mark sensitive promotion');
    const lowRisk = namedWorkflowStep(promote, 'Enable merge for compatible, low-risk promotion');
    if (!staleGuard?.includes('current_sha="$(git ls-remote origin refs/heads/dev | cut -f1)"'))
      findings.push('Promotion must ignore stale dev push events before opening or updating a PR.');
    if (!staleGuard?.includes('if [[ "$current_sha" != "$EXPECTED_SHA" ]]'))
      findings.push('Promotion must compare the event SHA with the current dev head.');
    if (!staleGuard?.includes('echo \'stale=true\' >> "$GITHUB_OUTPUT"'))
      findings.push('Promotion must expose stale-event state so later steps can be skipped.');
    if (
      staleGuard &&
      staleGuard.indexOf('git fetch --no-tags origin') >= 0 &&
      staleGuard.indexOf('if [[ "$current_sha" != "$EXPECTED_SHA" ]]') >
        staleGuard.indexOf('git fetch --no-tags origin')
    ) {
      findings.push('Promotion must reject stale dev events before fetching promotion refs.');
    }
    if (
      !pullRequest?.includes(
        `number="$(gh pr list --base main --head dev --state open --json number --jq '.[0].number // empty')"`
      ) ||
      !pullRequest.includes('if [ -z "$number" ]; then') ||
      !pullRequest.includes('--base main') ||
      !pullRequest.includes('--head dev') ||
      pullRequest.indexOf('gh pr create') < pullRequest.indexOf('if [ -z "$number" ]; then')
    ) {
      findings.push(
        'Promotion must find the existing dev-to-main PR and create one only when absent.'
      );
    }
    if (
      !promote.includes('checks: read') ||
      !report?.includes('commits/$EXPECTED_SHA/check-runs?per_page=100') ||
      !report?.includes('promotion-current-body.md') ||
      !report?.includes('node scripts/render-promotion-report.mjs') ||
      !report?.includes('gh pr edit "$PR_NUMBER" --repo "$GH_REPO" --body-file "$report_file"')
    ) {
      findings.push(
        'Promotion must render an exact-SHA report with read-only check results and preserve/update the managed PR body safely.'
      );
    }
    for (const [name, step] of [
      ['PR lookup/create', pullRequest],
      ['risk classification', riskStep],
      ['promotion report', report],
      ['approval label', ensureLabel],
      ['sensitive approval', sensitive],
      ['low-risk merge', lowRisk],
    ]) {
      if (!step?.includes("if: steps.stale.outputs.stale != 'true'"))
        findings.push(`Promotion ${name} must not run for a stale dev push event.`);
    }
    if (
      promote.indexOf('name: Skip stale promotion events') >
      promote.indexOf('name: Create or find the promotion pull request')
    ) {
      findings.push('Promotion must reject a stale dev event before reconciling its pull request.');
    }
    if (
      !sensitive?.includes("steps.risk.outputs.approval_required == 'true'") ||
      !sensitive.includes('gh pr edit "$PR_NUMBER" --repo "$GH_REPO" --add-label approval-required')
    ) {
      findings.push('Sensitive promotion must be labeled for CODEOWNER approval.');
    }
    if (
      !sensitive?.includes('gh pr merge "$PR_NUMBER" --repo "$GH_REPO" --disable-auto') ||
      !sensitive?.includes("steps.risk.outputs.approval_required == 'true'") ||
      sensitive?.includes('--auto') ||
      !lowRisk?.includes("steps.risk.outputs.approval_required != 'true'")
    ) {
      findings.push(
        'Sensitive promotion must disable auto-merge; only low-risk promotion may enable it.'
      );
    }
    if (
      !lowRisk?.includes(
        'gh pr merge "$PR_NUMBER" --repo "$GH_REPO" --auto --merge --match-head-commit "$EXPECTED_SHA"'
      )
    ) {
      findings.push('Automatic promotion must be bound to the exact classified dev SHA.');
    }
    if (
      !lowRisk?.includes('gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json labels') ||
      !lowRisk?.includes(
        'if jq -e \'index("approval-required") != null\' <<< "$labels" >/dev/null; then'
      ) ||
      !lowRisk?.includes(
        'gh pr edit "$PR_NUMBER" --repo "$GH_REPO" --remove-label approval-required'
      ) ||
      lowRisk.indexOf('--remove-label approval-required') >
        lowRisk.indexOf('gh pr merge "$PR_NUMBER" --repo "$GH_REPO" --auto')
    ) {
      findings.push(
        'Low-risk promotion must clear a stale approval-required label before auto-merge.'
      );
    }
  }

  if (promotionReportRefresh) {
    const refreshCheckout = checkoutSteps(promotionReportRefresh);
    const sourceGuard = namedWorkflowStep(
      promotionReportRefresh,
      'Verify current dev and fetch trusted comparison refs'
    );
    const reportStep = namedWorkflowStep(
      promotionReportRefresh,
      'Refresh exact-SHA report after hosted checks complete'
    );
    if (
      !promotionReportRefresh.includes('workflow_run:') ||
      !promotionReportRefresh.includes('types: [completed]') ||
      !promotionReportRefresh.includes('branches: [dev]')
    )
      findings.push('Promotion report refresh must run only after a dev workflow run completes.');
    if (
      !promotionReportRefresh.includes('permissions:\n  contents: read') ||
      !promotionReportRefresh.includes('      checks: read') ||
      !promotionReportRefresh.includes('      pull-requests: write') ||
      /^\s+(?:contents|checks|actions):\s+write\s*$/mu.test(promotionReportRefresh)
    )
      findings.push(
        'Promotion report refresh must use read-only source/checks and PR-only writes.'
      );
    if (
      refreshCheckout.length !== 1 ||
      !refreshCheckout[0].includes('ref: ${{ github.sha }}') ||
      !refreshCheckout[0].includes('persist-credentials: false') ||
      refreshCheckout[0].includes('github.event.workflow_run.head_sha')
    )
      findings.push(
        'Promotion report refresh must execute trusted default-branch code, not workflow-run source code.'
      );
    if (
      !promotionReportRefresh.includes(
        'github.event.workflow_run.head_repository.full_name == github.repository'
      ) ||
      !promotionReportRefresh.includes("github.event.workflow_run.head_branch == 'dev'") ||
      !sourceGuard?.includes('EXPECTED_SHA') ||
      !sourceGuard.includes('git ls-remote origin refs/heads/dev') ||
      !sourceGuard.includes('test "$(git rev-parse refs/remotes/origin/dev)" = "$EXPECTED_SHA"')
    )
      findings.push(
        'Promotion report refresh must verify same-repository dev provenance and current exact SHA.'
      );
    if (
      !reportStep?.includes('commits/$EXPECTED_SHA/check-runs?per_page=100') ||
      !reportStep.includes('node scripts/render-promotion-report.mjs') ||
      !reportStep.includes(
        'gh pr edit "$PR_NUMBER" --repo "$GH_REPO" --body-file "$report_file"'
      ) ||
      reportStep.includes('gh pr merge')
    )
      findings.push(
        'Post-CI refresh must update only the exact-SHA managed PR report and never merge.'
      );
  }

  if (issueIntake) {
    if (!issueIntake.includes('issue_comment:\n    types: [created]'))
      findings.push('Issue intake must process only newly created issue comments.');
    if (!issueIntake.includes('permissions:\n  contents: read'))
      findings.push('Issue intake must grant the workflow token contents: read only.');
    const intakeProposalJob = workflowJobBlocks(issueIntake).find((job) => job.name === 'proposal');
    if (
      !issueIntake.includes('run-name: Roadmap intake comment ${{ github.event.comment.id }}') ||
      !intakeProposalJob?.source.includes('      actions: read') ||
      !intakeProposalJob.source.includes('      contents: read')
    )
      findings.push(
        'Issue intake deduplication must use comment-bound run names and Actions read permission only.'
      );
    if (/^\s+(?:issues|contents|pull-requests|checks|actions):\s+write\s*$/mu.test(issueIntake))
      findings.push('Issue intake must not grant write permissions to workflow tokens.');
    const intakeCheckouts = checkoutSteps(issueIntake);
    if (
      intakeCheckouts.length !== 1 ||
      !intakeCheckouts[0].includes('ref: ${{ github.sha }}') ||
      !intakeCheckouts[0].includes('persist-credentials: false')
    )
      findings.push(
        'Issue intake must use one immutable event-SHA checkout without persisted credentials.'
      );
    const requireToken = namedWorkflowStep(
      issueIntake,
      'Require the least-privilege GitHub App permission verifier'
    );
    const dedupe = namedWorkflowStep(issueIntake, 'Skip previously reported issue comment');
    const mintToken = namedWorkflowStep(issueIntake, 'Mint repository-scoped metadata-read token');
    const runIntake = namedWorkflowStep(
      issueIntake,
      'Verify actor and report a read-only proposal'
    );
    const reportDuplicate = namedWorkflowStep(issueIntake, 'Report already processed comment');
    if (
      !requireToken?.includes('ROADMAP_INTAKE_APP_CLIENT_ID') ||
      !requireToken.includes('ROADMAP_INTAKE_APP_PRIVATE_KEY') ||
      !requireToken.includes('exit 2')
    )
      findings.push('Issue intake must fail clearly when its GitHub App credentials are missing.');
    if (
      !dedupe?.includes('issue-intake-dedupe.mjs') ||
      !dedupe.includes('GITHUB_COMMENT_ID') ||
      !dedupe.includes('GITHUB_COMMENT_CREATED_AT') ||
      !dedupe.includes('GITHUB_RUN_ID') ||
      !dedupe.includes('github.token') ||
      !requireToken?.includes("steps.dedupe.outputs.skip != 'true'") ||
      !mintToken?.includes("steps.dedupe.outputs.skip != 'true'") ||
      !runIntake?.includes("steps.dedupe.outputs.skip != 'true'") ||
      !reportDuplicate?.includes("steps.dedupe.outputs.skip == 'true'")
    )
      findings.push(
        'Issue intake must check durable successful-run history before minting its verifier token.'
      );
    if (
      !mintToken?.includes('actions/create-github-app-token@') ||
      !mintToken.includes('permission-metadata: read') ||
      mintToken.includes('permission-issues:') ||
      mintToken.includes('permission-contents:')
    )
      findings.push(
        'Issue intake must mint a least-privilege GitHub App token with Metadata: read only.'
      );
    if (
      !runIntake?.includes('steps.intake-token.outputs.token') ||
      runIntake.includes('github.token') ||
      !runIntake.includes('GITHUB_EVENT_PATH')
    )
      findings.push(
        'Issue intake must use the scoped verifier token and trusted runner event payload.'
      );
    if (
      requireToken &&
      dedupe &&
      mintToken &&
      runIntake &&
      (issueIntake.indexOf(dedupe) > issueIntake.indexOf(requireToken) ||
        issueIntake.indexOf(requireToken) > issueIntake.indexOf(mintToken) ||
        issueIntake.indexOf(mintToken) > issueIntake.indexOf(runIntake))
    )
      findings.push(
        'Issue intake must validate credentials, mint its token, then run the planner in order.'
      );
    if (
      !issueIntakeRunner?.includes('sourceSha: process.env.GITHUB_SHA') ||
      !issueIntakeRunner.includes('deliveryId: result.deliveryId') ||
      !issueIntakeRunner.includes('requestedStatus: result.proposal.requestedStatus') ||
      !issueIntakeRunner.includes('requestedAction: result.proposal.requestedAction') ||
      /proposal\.(?:rationale|requestedChange)|comment\.body|issue\.body/u.test(issueIntakeRunner)
    )
      findings.push(
        'Issue intake summary must bind a proposal ID to source SHA and omit user text.'
      );
  }

  if (issueSync) {
    const issueSyncJobs = workflowJobBlocks(issueSync);
    const planJob = issueSyncJobs.find((job) => job.name === 'plan');
    const applyJob = issueSyncJobs.find((job) => job.name === 'apply');
    const resumeCalls = issueSync.match(
      /node scripts\/roadmap\/resume-stale-issue-sync\.mjs/gu
    )?.length;
    if (
      !planJob?.source.includes('      actions: read') ||
      /actions:\s+write/u.test(planJob.source)
    )
      findings.push('Roadmap issue planning must keep Actions permission read-only.');
    if (
      !applyJob?.source.includes('      actions: write') ||
      !applyJob.source.includes('STALE_SYNC_RETRY_COUNT:') ||
      !issueSync.includes('stale_sync_retry_count:') ||
      resumeCalls !== 3
    )
      findings.push(
        'Stale roadmap issue applies must use a bounded dev workflow-dispatch resume from all three stale guards.'
      );
  }

  for (const [name, source, dependency, category] of [
    ['browser-matrix.yml', browserMatrix, 'browsers', 'browser-regression'],
    ['deep-regression.yml', deepRegression, 'postgres-recovery', 'deep-regression'],
  ]) {
    if (!source) continue;
    const expectedFailure = `if: always() && needs.${dependency}.result == 'failure' && github.ref == 'refs/heads/main'`;
    const expectedRecovery = `if: always() && needs.${dependency}.result == 'success' && github.ref == 'refs/heads/main'`;
    if (!source.includes(expectedFailure) || !source.includes(expectedRecovery))
      findings.push(`${name} incident reporting and recovery must be limited to main runs.`);
    if (
      (source.match(/group: maintenance-incident-/gu) ?? []).length !== 2 ||
      (source.match(/issues: write/gu) ?? []).length !== 2
    )
      findings.push(
        `${name} incident writes must use a category-specific coordinator and issues-only write scope.`
      );
    const checkouts = checkoutSteps(source);
    if (
      checkouts.length < 3 ||
      checkouts
        .slice(-2)
        .some(
          (checkout) =>
            !checkout.includes('ref: ${{ github.sha }}') ||
            !checkout.includes('persist-credentials: false')
        )
    )
      findings.push(
        `${name} incident handlers must check out the event SHA without persisted credentials.`
      );
    if (
      (source.match(new RegExp(`INCIDENT_CATEGORY: ${category}`, 'gu')) ?? []).length !== 2 ||
      (source.match(/INCIDENT_STATUS: (?:failed|recovered)/gu) ?? []).length !== 2 ||
      /INCIDENT_CATEGORY: security/u.test(source)
    )
      findings.push(
        `${name} must reconcile only its fixed non-security category for failure and recovery.`
      );
  }

  return findings;
}

async function main() {
  const [
    pages,
    visualReview,
    release,
    releasePrepare,
    dependencyCandidate,
    releasePlan,
    releaseOrchestrate,
    promote,
    promotionReportRefresh,
    issueIntake,
    issueIntakeRunner,
    issueSync,
    browserMatrix,
    deepRegression,
  ] = await Promise.all([
    readFile(path.join(repositoryRoot, '.github/workflows/pages.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/visual-review.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/release.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/release-prepare.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/dependency-candidate.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/release-plan.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/release-orchestrate.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/promote.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/refresh-promotion-report.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/roadmap-issue-intake.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'scripts/roadmap/run-issue-intake.mjs'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/roadmap-issue-plan.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/browser-matrix.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/deep-regression.yml'), 'utf8'),
  ]);
  const pagesAssetReconciler = await readFile(
    path.join(repositoryRoot, 'scripts/docs/reconcile-versioned-docs-asset.mjs'),
    'utf8'
  );
  const findings = inspectTrustedCheckoutPolicies({
    pages,
    pagesAssetReconciler,
    visualReview,
    release,
    releasePrepare,
    dependencyCandidate,
    releasePlan,
    releaseOrchestrate,
    promote,
    promotionReportRefresh,
    issueIntake,
    issueIntakeRunner,
    issueSync,
    browserMatrix,
    deepRegression,
  });
  const workflowFiles = (await readdir(path.join(repositoryRoot, '.github/workflows')))
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();
  const repositoryWriteWorkflows = await Promise.all(
    workflowFiles.map(async (file) => ({
      name: file,
      source: await readFile(path.join(repositoryRoot, '.github/workflows', file), 'utf8'),
    }))
  );
  findings.push(...inspectRepositoryWriteCoordination(repositoryWriteWorkflows));
  if (findings.length) {
    for (const finding of findings) process.stderr.write(`${finding}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    'Trusted checkout, promotion and issue-intake workflow policies are valid.\n'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
