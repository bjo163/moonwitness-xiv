import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const workflow = (
  await readFile(new globalThis.URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
).replace(/\r\n/gu, '\n');
const smokeScript = await readFile(
  new globalThis.URL('./smoke-containers.sh', import.meta.url),
  'utf8'
);
const imagePublisher = await readFile(
  new globalThis.URL('./publish-release-image.mjs', import.meta.url),
  'utf8'
);
const assetReconciler = await readFile(
  new globalThis.URL('./reconcile-release-assets.mjs', import.meta.url),
  'utf8'
);
const releaseLifecycle = await readFile(
  new globalThis.URL('./github-release-lifecycle.mjs', import.meta.url),
  'utf8'
);
const releaseLifecycleRunner = await readFile(
  new globalThis.URL('./complete-github-release.mjs', import.meta.url),
  'utf8'
);
const workflowDirectory = new globalThis.URL('../.github/workflows/', import.meta.url);
const releasePlanner = await readFile(
  new globalThis.URL('./release-plan.mjs', import.meta.url),
  'utf8'
);
const jobsStart = workflow.indexOf('jobs:');
const verifyStart = workflow.indexOf('  verify:', jobsStart);
const publishStart = workflow.indexOf('  publish:', jobsStart);
const verify = workflow.slice(verifyStart, publishStart);
const publish = workflow.slice(publishStart);

test('application deployment remains outside repository automation', async () => {
  const workflowNames = await readdir(workflowDirectory);
  assert.ok(!workflowNames.includes('deploy.yml'), 'legacy deploy workflow must stay removed');

  const workflowSources = await Promise.all(
    workflowNames
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => readFile(new globalThis.URL(name, workflowDirectory), 'utf8'))
  );
  const workflowText = workflowSources.join('\n');
  assert.doesNotMatch(workflowText, /STAGING_DEPLOY|PRODUCTION_DEPLOY|deployment hook/iu);
});

test('release tags require exact main ancestry and successful ci-gate for the same SHA', () => {
  assert.match(verify, /if \[\[ "\$version" != v\*/u);
  assert.match(verify, /echo "version=\$version" >> "\$GITHUB_OUTPUT"/u);
  assert.match(verify, /git merge-base --is-ancestor "\$SOURCE_SHA" refs\/remotes\/origin\/main/u);
  assert.match(verify, /head_sha=\$SOURCE_SHA&event=push/u);
  assert.match(verify, /\.head_sha == \$sha and \.head_branch == "main" and \.event == "push"/u);
  assert.match(verify, /\.name == "ci-gate" and \.conclusion == "success"/u);
});

test('tag releases reuse exact-SHA main CI while dry runs keep full local verification', () => {
  const verificationSteps = [
    'pnpm lint',
    'pnpm format:check',
    'pnpm typecheck',
    'pnpm docs:check:built',
    'pnpm --filter @moonwitness/board lint',
    'pnpm test:unit:built',
    'pnpm test:integration:built',
  ];
  const reusableCiCondition =
    "github.ref_type != 'tag' || (github.event_name == 'workflow_dispatch' && !inputs.publish)";
  assert.match(verify, /name: Require the exact source commit to be verified by main CI/u);
  const exactShaGate = verify.indexOf(
    'name: Require the exact source commit to be verified by main CI'
  );
  for (const command of verificationSteps) {
    const commandIndex = verify.indexOf(`run: ${command}`);
    assert.ok(commandIndex > exactShaGate, `${command} should follow the exact-SHA gate`);
    assert.ok(
      verify.slice(commandIndex - 150, commandIndex).includes(`if: ${reusableCiCondition}`),
      `${command} should only be skipped for a tag already verified by main CI`
    );
  }
  assert.match(verify, /name: Smoke test the exact release images against isolated PostgreSQL/u);
  assert.match(verify, /name: Scan the exact release images for critical vulnerabilities/u);
});

test('the verified and scanned API and Board images are smoke-tested and handed off unchanged', () => {
  for (const image of ['moonwitness-api:production', 'moonwitness-board:production']) {
    assert.ok(verify.includes(`--tag ${image}`) || verify.includes(`--tag ${image} .`));
    assert.ok(verify.includes(`image-ref: ${image}`));
    assert.ok(publish.includes(`SOURCE_IMAGE: ${image}`));
  }
  assert.match(verify, /org\.opencontainers\.image\.revision=\$GITHUB_SHA/u);
  assert.match(verify, /org\.opencontainers\.image\.version=\$RELEASE_VERSION/u);
  assert.match(verify, /SMOKE_USE_PREBUILT_IMAGES: 'true'/u);
  assert.match(smokeScript, /exec node "\$\(dirname "\$0"\)\/smoke-containers\.mjs"/u);
  assert.doesNotMatch(smokeScript, /docker compose|DATABASE_URL|JWT_SECRET/u);
  assert.match(verify, /docker save --output release-images\.tar/u);
  assert.match(verify, /docker image inspect moonwitness-api:production --format '\{\{\.Id\}\}'/u);
  assert.match(
    verify,
    /docker image inspect moonwitness-board:production --format '\{\{\.Id\}\}'/u
  );
  assert.match(
    verify,
    /sha256sum release-images\.tar release-image-manifest\.json release-api\.spdx\.json release-board\.spdx\.json > release-artifacts\.sha256/u
  );
  assert.match(publish, /actions\/download-artifact@/u);
  assert.match(verify, /name: release-images-\$\{\{ github\.sha \}\}/u);
  assert.match(
    verify,
    /release_artifact_id: \$\{\{ steps\.upload_images\.outputs\.artifact-id \}\}/u
  );
  assert.match(
    verify,
    /release_artifact_digest: \$\{\{ steps\.upload_images\.outputs\.artifact-digest \}\}/u
  );
  for (const consumerJob of [
    workflow.slice(workflow.indexOf('  attest-artifact:'), publishStart),
    publish,
  ]) {
    const identityValidation = consumerJob.indexOf(
      'run: node scripts/verify-release-artifact-identity.mjs'
    );
    const artifactDownload = consumerJob.indexOf('uses: actions/download-artifact@');
    assert.ok(identityValidation >= 0 && identityValidation < artifactDownload);
    assert.match(
      consumerJob,
      /artifact-ids: \$\{\{ needs\.verify\.outputs\.release_artifact_id \}\}/u
    );
  }
  const attestationJob = workflow.slice(workflow.indexOf('  attest-artifact:'), publishStart);
  assert.match(attestationJob, /uses: actions\/checkout@/u);
  assert.match(attestationJob, /persist-credentials: false/u);
  assert.match(verify, /steps\.upload_images\.outputs\.artifact-digest/u);
  assert.match(publish, /sha256sum --check release-artifacts\.sha256/u);
  assert.match(publish, /\.apiImageId' release-image-manifest\.json/u);
  assert.match(publish, /\.boardImageId' release-image-manifest\.json/u);
  assert.match(publish, /docker load --input release-images\.tar/u);
  assert.equal((publish.match(/node scripts\/publish-release-image\.mjs/gu) ?? []).length, 2);
  assert.match(publish, /test "\$revision" = "\$GITHUB_SHA"/u);
  assert.match(publish, /test "\$version" = "\$RELEASE_VERSION"/u);
  assert.equal((publish.match(/node scripts\/publish-release-image\.mjs/gu) ?? []).length, 2);
  assert.equal(
    (
      publish.match(
        /VERSION_DIGEST: \$\{\{ steps\.publish_(?:api|board)\.outputs\.digest \}\}/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal((publish.match(/test "\$latest_digest" = "\$VERSION_DIGEST"/gu) ?? []).length, 2);
  assert.doesNotMatch(publish, /docker (?:build|buildx build)/u);
  assert.match(publish, /needs: \[verify, attest-artifact\]/u);
  assert.match(
    publish,
    /github\.event_name == 'workflow_dispatch' && inputs\.publish && github\.ref_type == 'tag'/u
  );
  assert.doesNotMatch(publish, /deploy-pages|kubectl|docker compose up/u);
});

test('tag releases publish SPDX SBOMs and attest artifact/image subjects before Release completion', () => {
  assert.equal((verify.match(/uses: anchore\/sbom-action@/gu) ?? []).length, 2);
  assert.match(verify, /output-file: release-api\.spdx\.json/u);
  assert.match(verify, /output-file: release-board\.spdx\.json/u);
  assert.match(verify, /format: spdx-json/u);
  assert.match(verify, /upload-artifact: false/u);
  assert.match(publish, /needs: \[verify, attest-artifact\]/u);
  assert.equal((publish.match(/uses: actions\/attest@/gu) ?? []).length, 4);
  assert.equal((publish.match(/push-to-registry: true/gu) ?? []).length, 4);
  assert.equal((publish.match(/create-storage-record: false/gu) ?? []).length, 4);
  const attestationJob = workflow.slice(workflow.indexOf('  attest-artifact:'), publishStart);
  assert.match(attestationJob, /attestations: write/u);
  assert.match(attestationJob, /id-token: write/u);
  assert.match(attestationJob, /release-images\.tar/u);
  assert.match(attestationJob, /release-api\.spdx\.json/u);
  assert.ok(attestationJob.indexOf('uses: actions/attest@') >= 0);
  assert.ok(
    publish.indexOf('Attest API image SPDX SBOM') <
      publish.indexOf('Complete the same verified GitHub Release idempotently')
  );
  assert.ok(
    publish.indexOf('Attest Board image build provenance') <
      publish.indexOf('Complete the same verified GitHub Release idempotently')
  );
});

test('critical candidates fail verification and latest only advances for a newer stable release', () => {
  assert.equal((verify.match(/severity: CRITICAL/gu) ?? []).length, 2);
  assert.equal((verify.match(/exit-code: '1'/gu) ?? []).length, 2);
  assert.match(publish, /Plan stable latest promotion against published GitHub releases/u);
  assert.match(publish, /gh api --paginate .*releases\?per_page=100/u);
  assert.match(publish, /node scripts\/release-latest-policy\.mjs "\$CANDIDATE_TAG"/u);
  assert.match(publish, /if: \$\{\{ !contains\(github\.ref_name, '-'\) \}\}/u);
  assert.match(
    publish,
    /UPDATE_LATEST: \$\{\{ steps\.latest_policy\.outputs\.advance \|\| 'false' \}\}/u
  );
  assert.equal(
    (publish.match(/if: steps\.latest_policy\.outputs\.advance == 'true'/gu) ?? []).length,
    2
  );
  assert.equal((publish.match(/docker push "\$image:latest"/gu) ?? []).length, 2);
  assert.equal((publish.match(/test "\$latest_digest" = "\$VERSION_DIGEST"/gu) ?? []).length, 2);
  assert.ok(
    publish.indexOf('Complete the same verified GitHub Release idempotently') <
      publish.indexOf('Advance stable API latest')
  );
  assert.match(publish, /run: node scripts\/complete-github-release\.mjs/u);
  assert.match(releaseLifecycleRunner, /'--draft',\s*'--latest=false'/u);
  assert.match(releaseLifecycleRunner, /--prerelease/u);
  assert.match(releaseLifecycleRunner, /release', 'verify-asset'/u);
  assert.match(releaseLifecycleRunner, /release', 'edit'/u);
  assert.doesNotMatch(releaseLifecycleRunner, /--clobber/u);
  assert.match(assetReconciler, /actual\?\.digest === expected\.digest/u);
  assert.match(assetReconciler, /isDraft: release\.draft/u);
  assert.match(assetReconciler, /if \(!existing && !isDraft\)/u);
});

test('stable publication requires the exact confirmation after tag revalidation', () => {
  const header = workflow.slice(0, jobsStart);
  assert.match(header, /confirm_stable:\n\s+description: .*\n\s+required: false/u);
  const tagGuard = publish.indexOf('Require the source tag to remain on the verified SHA');
  const confirmation = publish.indexOf('Require explicit stable release confirmation');
  const registryLogin = publish.indexOf('uses: docker/login-action@');
  assert.ok(tagGuard >= 0 && tagGuard < confirmation);
  assert.ok(confirmation < registryLogin, 'confirmation must precede any registry write');
  const guard = publish.slice(confirmation, registryLogin);
  assert.match(guard, /RELEASE_TAG" == \*-\*/u);
  assert.match(guard, /CONFIRM_STABLE" != "\$RELEASE_TAG"/u);
  assert.match(publish, /CONFIRM_STABLE: \$\{\{ inputs\.confirm_stable \}\}/u);
});

test('publish revalidates the source tag after verification before any image write', () => {
  assert.match(
    publish,
    /git ls-remote origin "refs\/tags\/\$RELEASE_TAG" "refs\/tags\/\$RELEASE_TAG\^\{\}"/u
  );
  assert.match(publish, /test "\$remote_tag_sha" = "\$EXPECTED_SOURCE_SHA"/u);
  const tagGuard = publish.indexOf('Require the source tag to remain on the verified SHA');
  const firstRegistryWrite = publish.indexOf('node scripts/publish-release-image.mjs');
  assert.ok(tagGuard >= 0 && tagGuard < firstRegistryWrite);
  assert.match(imagePublisher, /refusing to overwrite it/u);
  assert.match(imagePublisher, /manifest unknown/iu);
});

test('release fault recovery preserves no-op plans and explicitly models hostile failures', () => {
  assert.match(releasePlanner, /classification\.changeKind === 'none'/u);
  assert.match(releasePlanner, /plan\.status = 'no-release'/u);
  assert.match(imagePublisher, /manifest unknown/iu);
  assert.match(imagePublisher, /if \(!missingImageManifest\(error\)\) throw error/u);
  assert.match(publish, /remote_tag_sha/u);
  assert.match(publish, /sha256sum --check release-artifacts\.sha256/u);
  assert.match(publish, /node scripts\/complete-github-release\.mjs/u);
  assert.match(releaseLifecycle, /getReleaseByTag\(tag\)/u);
  assert.match(releaseLifecycle, /Unable to verify draft release creation/u);
  assert.match(releaseLifecycle, /Unable to verify published release/u);
  assert.match(releaseLifecycle, /reconcileReleaseAssets/u);
  assert.match(assetReconciler, /adapter\.listAssets\(releaseId\)/u);
  assert.match(
    assetReconciler,
    /afterUpload = assetMap\(await adapter\.listAssets\(releaseId\)\)/u
  );
  assert.match(assetReconciler, /Cannot add missing asset .* to a published release/u);
  assert.match(assetReconciler, /Duplicate expected release asset/u);
  assert.doesNotMatch(publish, /gh release upload .*--clobber/u);
});
