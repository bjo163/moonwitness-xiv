import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildVerificationPlan, verifyReleaseBundle } from './verify-release-attestations.mjs';

const inputs = {
  repository: 'bjo163/moonwitness-xiv',
  workflow: 'bjo163/moonwitness-xiv/.github/workflows/release.yml',
  tag: 'v1.2.3-rc.1',
  directory: 'bundle',
};

test('consumer verification binds every asset and image to the exact repository workflow', () => {
  const plan = buildVerificationPlan(inputs);
  assert.equal(plan.length, 6);
  for (const command of plan) {
    assert.ok(command.args.includes('--repo'));
    assert.ok(command.args.includes(inputs.repository));
    assert.ok(command.args.includes('--signer-workflow'));
    assert.ok(command.args.includes(inputs.workflow));
  }
  assert.equal(plan[2].args.at(-1), 'https://spdx.dev/Document/v2.3');
  assert.match(plan[4].args[2], /^oci:\/\/ghcr\.io\/bjo163\/moonwitness-xiv:/u);
  assert.throws(
    () => buildVerificationPlan({ ...inputs, repository: 'attacker/project' }),
    /repository/u
  );
  assert.throws(
    () =>
      buildVerificationPlan({ ...inputs, workflow: 'other/project/.github/workflows/release.yml' }),
    /workflow/u
  );
  assert.throws(() => buildVerificationPlan({ ...inputs, tag: 'latest' }), /Tag/u);
});

test('bundle verifier accepts exact checksums and source metadata, rejects tampering and wrong identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-release-'));
  const directory = path.join(root, 'bundle');
  await mkdir(directory);
  try {
    const { createHash } = await import('node:crypto');
    const files = {
      'release-images.tar': 'image archive',
      'release-image-manifest.json': JSON.stringify({
        sourceSha: 'a'.repeat(40),
        version: 'v1.2.3',
      }),
      'release-api.spdx.json': '{"spdxVersion":"SPDX-2.3"}',
      'release-board.spdx.json': '{"spdxVersion":"SPDX-2.3"}',
    };
    for (const [name, content] of Object.entries(files))
      await writeFile(path.join(directory, name), content);
    const checksums = Object.entries(files)
      .map(([name, content]) => `${createHash('sha256').update(content).digest('hex')}  ${name}`)
      .join('\n');
    await writeFile(path.join(directory, 'release-artifacts.sha256'), `${checksums}\n`);
    const releaseAssets = ['release-api.spdx.json', 'release-board.spdx.json']
      .map((name) => `${createHash('sha256').update(files[name]).digest('hex')}  ${name}`)
      .join('\n');
    await writeFile(path.join(directory, 'release-assets.sha256'), `${releaseAssets}\n`);
    assert.deepEqual(
      await verifyReleaseBundle({
        directory,
        expectedSourceSha: 'a'.repeat(40),
        expectedVersion: 'v1.2.3',
      }),
      { filesVerified: 4, releaseAssetsVerified: 2, sourceSha: 'a'.repeat(40), version: 'v1.2.3' }
    );
    await assert.rejects(
      verifyReleaseBundle({
        directory,
        expectedSourceSha: 'b'.repeat(40),
        expectedVersion: 'v1.2.3',
      }),
      /source SHA/u
    );
    await writeFile(path.join(directory, 'release-api.spdx.json'), 'tampered');
    await assert.rejects(
      verifyReleaseBundle({
        directory,
        expectedSourceSha: 'a'.repeat(40),
        expectedVersion: 'v1.2.3',
      }),
      /Checksum mismatch/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
