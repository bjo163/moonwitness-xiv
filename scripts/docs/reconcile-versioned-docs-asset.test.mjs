import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileVersionedDocsAsset } from './reconcile-versioned-docs-asset.mjs';

const tag = 'v2.0.0';
const sourceSha = 'a'.repeat(40);
const file = {
  path: `versioned-docs/docs-site-${tag}.tar.gz`,
  name: `docs-site-${tag}.tar.gz`,
  digest: `sha256:${'b'.repeat(64)}`,
  size: 1234,
};
const release = {
  id: 42,
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: '2026-10-16T00:00:00Z',
};

function fakeAdapter(initial = []) {
  const assets = new Map(initial.map((asset) => [asset.name, { ...asset }]));
  const uploads = [];
  let failBeforeAccept = false;
  let failAfterAccept = false;
  return {
    assets,
    uploads,
    set failBeforeAccept(value) {
      failBeforeAccept = value;
    },
    set failAfterAccept(value) {
      failAfterAccept = value;
    },
    async listAssets() {
      return [...assets.values()];
    },
    async uploadAsset(uploadTag, path) {
      assert.equal(uploadTag, tag);
      assert.equal(path, file.path);
      uploads.push(path);
      if (failBeforeAccept) throw new Error('simulated pre-accept failure');
      assets.set(file.name, { name: file.name, digest: file.digest, size: file.size });
      if (failAfterAccept) throw new Error('simulated accepted upload with lost response');
    },
  };
}

function reconcile(adapter, overrides = {}) {
  return reconcileVersionedDocsAsset({
    tag,
    sourceSha,
    release,
    resolveTagCommit: async () => sourceSha,
    file,
    adapter,
    ...overrides,
  });
}

test('recovers an accepted upload with lost response and reruns as a no-op', async () => {
  const adapter = fakeAdapter();
  adapter.failAfterAccept = true;

  const recovered = await reconcile(adapter);
  assert.equal(recovered[0].action, 'recovered');
  assert.equal(adapter.uploads.length, 1);

  adapter.failAfterAccept = false;
  const rerun = await reconcile(adapter);
  assert.equal(rerun[0].action, 'reused');
  assert.equal(adapter.uploads.length, 1);
});

test('keeps a pre-accept failure retryable without claiming an asset was stored', async () => {
  const adapter = fakeAdapter();
  adapter.failBeforeAccept = true;

  await assert.rejects(reconcile(adapter), /Upload command failed/u);
  assert.equal(adapter.assets.has(file.name), false);
  assert.equal(adapter.uploads.length, 1);

  adapter.failBeforeAccept = false;
  const retry = await reconcile(adapter);
  assert.equal(retry[0].action, 'uploaded');
  assert.equal(adapter.uploads.length, 2);
});

test('refuses a conflicting same-name asset without overwriting it', async () => {
  const conflict = { name: file.name, digest: `sha256:${'c'.repeat(64)}`, size: file.size };
  const adapter = fakeAdapter([conflict]);

  await assert.rejects(reconcile(adapter), /conflicts with the verified file/u);
  assert.deepEqual(adapter.uploads, []);
  assert.deepEqual(adapter.assets.get(file.name), conflict);
});

test('rejects source SHA and release-tag mismatches before any upload', async () => {
  const adapter = fakeAdapter();
  await assert.rejects(
    reconcile(adapter, { resolveTagCommit: async () => 'd'.repeat(40) }),
    /exact documentation source SHA/u
  );
  await assert.rejects(
    reconcile(adapter, { release: { ...release, tag_name: 'v2.0.1' } }),
    /matching published stable release/u
  );
  assert.deepEqual(adapter.uploads, []);
});
