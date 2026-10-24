import assert from 'node:assert/strict';
import test from 'node:test';
import { completeGitHubRelease } from './github-release-lifecycle.mjs';

const files = [
  {
    path: 'release-api.spdx.json',
    name: 'release-api.spdx.json',
    digest: `sha256:${'a'.repeat(64)}`,
    size: 10,
  },
  {
    path: 'release-board.spdx.json',
    name: 'release-board.spdx.json',
    digest: `sha256:${'b'.repeat(64)}`,
    size: 12,
  },
];

function fakeAdapter() {
  const releases = new Map();
  const assets = new Map();
  const calls = { creates: 0, uploads: [], verifies: [], publishes: 0 };
  const adapter = {
    async getReleaseByTag(tag) {
      const release = releases.get(tag);
      return release ? { ...release } : null;
    },
    async createDraft(tag, prerelease) {
      calls.creates += 1;
      releases.set(tag, { id: 42, tagName: tag, isDraft: true, isPrerelease: prerelease });
      if (adapter.loseCreateResponse)
        throw new Error('simulated accepted create with lost response');
    },
    async listAssets(releaseId) {
      assert.equal(releaseId, 42);
      return [...assets.values()].map((asset) => ({ ...asset }));
    },
    async uploadAsset(tag, path) {
      const file = files.find((candidate) => candidate.path === path);
      assert.ok(file);
      calls.uploads.push(file.name);
      if (adapter.failUploadBeforeAccept === file.name) throw new Error('simulated upload outage');
      assets.set(file.name, { name: file.name, digest: file.digest, size: file.size });
      if (adapter.failUploadAfterAccept === file.name)
        throw new Error('simulated accepted upload with lost response');
      assert.equal(tag, 'v1.2.3');
    },
    async verifyAsset(tag, path) {
      assert.equal(tag, 'v1.2.3');
      calls.verifies.push(path);
    },
    async publishRelease(tag, options) {
      calls.publishes += 1;
      assert.equal(options.prerelease, false);
      assert.equal(options.updateLatest, true);
      const release = releases.get(tag);
      assert.ok(release);
      release.isDraft = false;
      if (adapter.losePublishResponse)
        throw new Error('simulated accepted publish with lost response');
    },
  };
  return { adapter, calls, releases, assets };
}

function complete(adapter) {
  return completeGitHubRelease({
    tag: 'v1.2.3',
    prerelease: false,
    updateLatest: true,
    files,
    adapter,
  });
}

test('recovers an accepted draft create and publishes one verified release identity', async () => {
  const { adapter, calls, releases, assets } = fakeAdapter();
  adapter.loseCreateResponse = true;

  const result = await complete(adapter);

  assert.equal(releases.size, 1);
  assert.equal(result.releaseId, 42);
  assert.equal(result.recoveredPublish, false);
  assert.equal(calls.creates, 1);
  assert.equal(calls.publishes, 1);
  assert.deepEqual(
    calls.uploads,
    files.map((file) => file.name)
  );
  assert.deepEqual(
    calls.verifies,
    files.map((file) => file.path)
  );
  assert.equal(assets.size, files.length);
  assert.equal(releases.get('v1.2.3')?.isDraft, false);
});

test('retries a partial asset failure on the same draft without replacing accepted assets', async () => {
  const { adapter, calls, releases, assets } = fakeAdapter();
  adapter.failUploadBeforeAccept = files[1].name;

  await assert.rejects(complete(adapter), /Upload command failed for release asset/u);
  adapter.failUploadBeforeAccept = undefined;
  const firstAsset = assets.get(files[0].name);
  const result = await complete(adapter);

  assert.equal(releases.size, 1);
  assert.equal(result.releaseId, 42);
  assert.equal(calls.creates, 1);
  assert.equal(calls.publishes, 1);
  assert.equal(calls.uploads.filter((name) => name === files[0].name).length, 1);
  assert.deepEqual(assets.get(files[0].name), firstAsset);
  assert.equal(assets.size, files.length);
});

test('recovers a publish accepted remotely when the CLI response is lost', async () => {
  const { adapter, calls, releases } = fakeAdapter();
  adapter.losePublishResponse = true;

  const result = await complete(adapter);

  assert.equal(result.recoveredPublish, true);
  assert.equal(result.releaseId, 42);
  assert.equal(calls.creates, 1);
  assert.equal(calls.publishes, 1);
  assert.equal(releases.size, 1);
  assert.equal(releases.get('v1.2.3')?.isDraft, false);
});

test('reuses an already published release without attempting a second publication', async () => {
  const { adapter, calls, releases, assets } = fakeAdapter();
  releases.set('v1.2.3', {
    id: 42,
    tagName: 'v1.2.3',
    isDraft: false,
    isPrerelease: false,
  });
  for (const file of files)
    assets.set(file.name, { name: file.name, digest: file.digest, size: file.size });

  const result = await complete(adapter);

  assert.equal(result.releaseAction, 'reused');
  assert.equal(result.recoveredPublish, false);
  assert.equal(calls.publishes, 0);
  assert.equal(releases.get('v1.2.3')?.isDraft, false);
});

test('resumes the same draft after publish credentials expire and are restored', async () => {
  const { adapter, calls, releases, assets } = fakeAdapter();
  const publishRelease = adapter.publishRelease;
  adapter.expirePublishCredentials = true;
  adapter.publishRelease = async (...args) => {
    if (adapter.expirePublishCredentials) throw new Error('HTTP 401: token expired');
    return publishRelease(...args);
  };

  await assert.rejects(complete(adapter), /HTTP 401: token expired/u);

  assert.equal(releases.get('v1.2.3')?.isDraft, true);
  assert.equal(calls.creates, 1);
  assert.deepEqual(
    calls.uploads,
    files.map((file) => file.name)
  );
  const acceptedAssets = new Map(assets);

  adapter.expirePublishCredentials = false;
  const result = await complete(adapter);

  assert.equal(result.releaseAction, 'published');
  assert.equal(result.recoveredPublish, false);
  assert.equal(result.releaseId, 42);
  assert.equal(calls.creates, 1);
  assert.equal(calls.publishes, 1);
  assert.deepEqual(
    calls.uploads,
    files.map((file) => file.name)
  );
  assert.deepEqual([...assets], [...acceptedAssets]);
  assert.equal(releases.get('v1.2.3')?.isDraft, false);
});

test('rejects a tag already bound to a release with a different identity', async () => {
  const { adapter } = fakeAdapter();
  adapter.getReleaseByTag = async () => ({
    id: 43,
    tagName: 'v9.9.9',
    isDraft: true,
    isPrerelease: false,
  });

  await assert.rejects(complete(adapter), /does not match expected tag v1\.2\.3/u);
});

test('preflights release assets and adapter capabilities before creating a draft', async () => {
  const { adapter, calls } = fakeAdapter();
  adapter.verifyAsset = undefined;

  await assert.rejects(complete(adapter), /cannot verify and publish assets/u);

  assert.equal(calls.creates, 0);
  assert.equal(calls.uploads.length, 0);
});
