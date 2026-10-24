import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

const workflowUrl = new URL('../.github/workflows/release-prepare.yml', import.meta.url);

test('release preparation is manual, restricted to dev, and guards the expected SHA', async () => {
  const source = await readFile(workflowUrl, 'utf8');
  assert.match(source, /workflow_dispatch:/u);
  assert.match(source, /if: github\.ref == 'refs\/heads\/dev'/u);
  assert.match(source, /EXPECTED_SOURCE_SHA: \$\{\{ inputs\.expected_dev_sha \}\}/u);
  assert.match(source, /ACTUAL_SOURCE_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(source, /pnpm release:prepare -- --expected-head .*--apply/u);
  assert.match(source, /git ls-remote origin refs\/heads\/dev/u);
  assert.match(source, /node scripts\/push-expected-ref\.mjs origin HEAD refs\/heads\/dev/u);
  assert.match(
    source,
    /README\.md\|apps\/\*\/package\.json\|packages\/\*\/package\.json\|docs\/\*/u
  );
  assert.match(source, /group: dev-branch-updates/u);
  assert.doesNotMatch(source, /refs\/heads\/release/u);
});

test('release preparation selects a channel and dispatches the trusted follow-ups after its push', async () => {
  const source = (await readFile(workflowUrl, 'utf8')).replace(/\r\n/gu, '\n');
  assert.match(
    source,
    /channel:\n\s+description: Release channel to prepare\n\s+required: true\n\s+type: choice\n\s+options:\n\s+- rc\n\s+- stable\n\s+- hotfix/u
  );
  assert.match(source, /RELEASE_CHANNEL: \$\{\{ inputs\.channel \}\}/u);
  assert.match(source, /--channel "\$RELEASE_CHANNEL" --apply/u);
  assert.match(source, /actions: write/u);
  assert.match(source, /if: steps\.publish\.outputs\.pushed == 'true'/u);
  assert.match(source, /gh workflow run ci\.yml --repo "\$GH_REPO" --ref dev/u);
  assert.match(source, /gh workflow run promote\.yml --repo "\$GH_REPO" --ref dev/u);
});

test('release preparation never publishes images or creates a GitHub release', async () => {
  const source = await readFile(workflowUrl, 'utf8');
  assert.doesNotMatch(source, /docker\/build-push-action|gh release create|refs\/tags\//u);
});
