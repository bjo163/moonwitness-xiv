import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

const source = (
  await readFile(new URL('../.github/workflows/release-orchestrate.yml', import.meta.url), 'utf8')
).replace(/\r\n/gu, '\n');
const jobsIndex = source.indexOf('\njobs:');
const header = source.slice(0, jobsIndex + 1);
const decide = source.slice(source.indexOf('  decide:'), source.indexOf('  prepare:'));
const prepare = source.slice(source.indexOf('  prepare:'), source.indexOf('  publish-rc:'));
const publishRc = source.slice(
  source.indexOf('  publish-rc:'),
  source.indexOf('  publish-stable:')
);
const publishStable = source.slice(source.indexOf('  publish-stable:'));

test('orchestration starts only from trusted main CI or an intentional main dispatch', () => {
  assert.match(
    header,
    /workflow_run:\n\s+workflows:\n\s+- CI\n\s+types: \[completed\]\n\s+branches: \[main\]/u
  );
  assert.match(header, /workflow_dispatch:/u);
  assert.match(
    decide,
    /github\.event\.workflow_run\.event == 'push' &&\n\s+github\.event\.workflow_run\.conclusion == 'success' &&\n\s+github\.event\.workflow_run\.head_branch == 'main' &&\n\s+github\.event\.workflow_run\.head_repository\.full_name == github\.repository/u
  );
  assert.match(decide, /\[\[ "\$DISPATCH_REF" == "refs\/heads\/main" \]\]/u);
  assert.match(decide, /\[\[ "\$source" =~ \^\[a-f0-9\]\{40\}\$ \]\]/u);
  assert.match(decide, /gh api "repos\/\$GH_REPO\/git\/ref\/heads\/main"/u);
  assert.match(decide, /if \[\[ "\$current" != "\$source" \]\]/u);
  assert.match(decide, /ref: \$\{\{ steps\.source\.outputs\.source \}\}/u);
  assert.doesNotMatch(decide, /ref: \$\{\{ inputs\./u);
});

test('the newest exact-SHA main ci-gate is required before any release decision', () => {
  assert.match(decide, /head_sha=\$SOURCE_SHA&event=push/u);
  assert.match(decide, /sort_by\(\.created_at, \.run_attempt\) \| last/u);
  assert.match(decide, /"\$EVENT_RUN_ID" != "\$run_id"/u);
  assert.match(decide, /\.name == "ci-gate" and \.conclusion == "success"/u);
  assert.match(decide, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/u);
  assert.match(decide, /if: steps\.source\.outputs\.stale != 'true'\n\s+id: gate/u);
  assert.ok(
    decide.indexOf('Verify the exact main ci-gate for the source SHA') <
      decide.indexOf('Decide the next idempotent release action')
  );
});

test('the dev and remote-state snapshot is verified before the orchestrator decides', () => {
  assert.match(decide, /dev_sha="\$\(git ls-remote origin refs\/heads\/dev \| cut -f1\)"/u);
  assert.match(decide, /\[\[ "\$dev_sha" =~ \^\[a-f0-9\]\{40\}\$ \]\]/u);
  assert.match(decide, /git fetch --no-tags origin refs\/heads\/dev:refs\/remotes\/origin\/dev/u);
  assert.match(decide, /test "\$\(git rev-parse refs\/remotes\/origin\/dev\)" = "\$dev_sha"/u);
  assert.match(decide, /git ls-remote --tags origin > "\$RUNNER_TEMP\/remote-tags\.txt"/u);
  assert.match(decide, /--slurp "repos\/\$GH_REPO\/releases\?per_page=100"/u);
  assert.match(decide, /echo "dev-sha=\$dev_sha" >> "\$GITHUB_OUTPUT"/u);
  // Every state read must stay behind both staleness flags, and the decision must consume them.
  assert.match(
    decide,
    /if: steps\.source\.outputs\.stale != 'true' && steps\.gate\.outputs\.stale != 'true'\n\s+id: state/u
  );
  assert.match(
    decide,
    /if: steps\.source\.outputs\.stale != 'true' && steps\.gate\.outputs\.stale != 'true'\n\s+id: decision/u
  );
  assert.ok(
    decide.indexOf('Collect remote tags, dev state, and published releases') <
      decide.indexOf('Decide the next idempotent release action')
  );
});

test('stable confirmation reaches the orchestrator only from the deliberate dispatch input', () => {
  assert.match(header, /confirm_version:/u);
  assert.match(decide, /CONFIRM_VERSION: \$\{\{ inputs\.confirm_version \|\| '' \}\}/u);
  assert.match(decide, /args\+=\(--confirm-version "\$CONFIRM_VERSION"\)/u);
  assert.match(decide, /CHANNEL="\$INPUT_CHANNEL"/u);
  assert.match(
    decide,
    /if \[\[ -n "\$INPUT_SHA" \]\]; then source="\$INPUT_SHA"; else source="\$DISPATCH_SHA"; fi/u
  );
  // The automatic path never reads a caller channel and never offers stable or hotfix.
  assert.match(decide, /echo "manual-required=true" >> "\$GITHUB_OUTPUT"/u);
  assert.equal((source.match(/--confirm-version/gu) || []).length, 1);
});

test('automation advances only release candidates and reserves stable publication for dispatch', () => {
  assert.match(decide, /version="\$\(jq -r '\.version' package\.json\)"/u);
  assert.match(decide, /if \[\[ "\$version" != \*-rc\.\* \]\]/u);
  assert.match(decide, /stable and hotfix publication require an explicit dispatch/u);
  assert.match(decide, /node scripts\/release-orchestrator\.mjs/u);
  assert.match(decide, /--remote-tags-file/u);
  assert.match(decide, /--releases-file/u);
  assert.match(decide, /if \[\[ "\$status" == "blocked" \]\]/u);
  assert.match(decide, /exit 1/u);
});

test('preparation is dispatched explicitly on dev with the expected SHA and channel', () => {
  assert.match(prepare, /if: needs\.decide\.outputs\.action == 'prepare'/u);
  assert.match(prepare, /actions: write/u);
  assert.match(prepare, /\[\[ "\$EXPECTED_DEV_SHA" =~ \^\[a-f0-9\]\{40\}\$ \]\]/u);
  assert.match(prepare, /gh workflow run release-prepare\.yml --repo "\$GH_REPO" --ref dev/u);
  assert.match(prepare, /-f expected_dev_sha="\$EXPECTED_DEV_SHA" -f channel="\$CHANNEL"/u);
});

test('release candidates tag only the revalidated main SHA and dispatch the trusted workflow', () => {
  assert.match(publishRc, /needs\.decide\.outputs\.confirm_stable == ''/u);
  assert.match(publishRc, /ref: \$\{\{ needs\.decide\.outputs\.source_sha \}\}/u);
  assert.match(publishRc, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/u);
  assert.match(
    publishRc,
    /test "\$\(git ls-remote origin refs\/heads\/main \| cut -f1\)" = "\$SOURCE_SHA"/u
  );
  assert.match(publishRc, /node scripts\/create-release-tag\.mjs "\$TAG" "\$SOURCE_SHA"/u);
  assert.match(
    publishRc,
    /gh workflow run release\.yml --repo "\$GH_REPO" --ref "\$TAG" \\\n\s+-f version="\$TAG" -f publish=true/u
  );
  assert.doesNotMatch(
    publishRc.slice(publishRc.indexOf('gh workflow run release.yml')),
    /confirm_stable/u
  );
  assert.ok(
    publishRc.indexOf('create-release-tag.mjs') < publishRc.indexOf('gh workflow run release.yml')
  );
});

test('stable publication is environment-gated and forwards the exact confirmation', () => {
  assert.match(publishStable, /needs\.decide\.outputs\.confirm_stable != ''/u);
  assert.match(publishStable, /environment: release/u);
  assert.match(publishStable, /test "\$CONFIRM_STABLE" = "\$TAG"/u);
  assert.match(publishStable, /node scripts\/create-release-tag\.mjs "\$TAG" "\$SOURCE_SHA"/u);
  assert.match(
    publishStable,
    /gh workflow run release\.yml --repo "\$GH_REPO" --ref "\$TAG" \\\n\s+-f version="\$TAG" -f publish=true -f confirm_stable="\$TAG"/u
  );
  assert.ok(
    publishStable.indexOf('test "$CONFIRM_STABLE" = "$TAG"') <
      publishStable.indexOf('create-release-tag.mjs')
  );
});

test('orchestration keeps job-scoped writes under a non-cancelling resource lock', () => {
  assert.match(
    header,
    /permissions:\n {2}contents: read\n\nconcurrency:\n {2}group: release-orchestration\n {2}cancel-in-progress: false/u
  );
  assert.match(decide, /permissions:\n {6}contents: read\n {6}actions: read/u);
  assert.match(prepare, /permissions:\n {6}actions: write\n {6}contents: read/u);
  for (const publishJob of [publishRc, publishStable]) {
    assert.match(publishJob, /permissions:\n {6}contents: write\n {6}actions: write/u);
    assert.match(
      publishJob,
      /concurrency:\n {6}group: release-asset-updates\n {6}cancel-in-progress: false/u
    );
  }
  assert.doesNotMatch(
    source,
    /\bgit push\b|gh release create|docker push|packages:\s+write|deploy-pages/u
  );
});
