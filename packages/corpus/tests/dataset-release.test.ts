import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  createKnowledgeSnapshot,
  hashCanonicalJson,
} from '@moonwitness/knowledge';
import {
  activateDatasetRelease,
  createDatasetRelease,
  readActiveDatasetRelease,
  replayDatasetRelease,
  type DatasetReleaseInput,
} from '../src/index.js';

const roots: string[] = [];

async function storeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-dataset-release-'));
  roots.push(root);
  return root;
}

async function release(
  root: string,
  version: string,
  marker: string
): Promise<DatasetReleaseInput> {
  const records = [
    {
      id: `mw:entity:${marker}`,
      kind: 'Entity',
      schema_version: 1,
      lifecycle: 'draft',
      created_at: '2026-10-16T10:00:00.000Z',
      updated_at: '2026-10-16T10:00:00.000Z',
      origin_ref: `urn:synthetic:${marker}`,
      visibility: 'INTERNAL',
      content_revision: 1,
    },
  ];
  const snapshot = createKnowledgeSnapshot({ records, aliases: [], sourceArtifacts: [] });
  const snapshotPath = `snapshots/${version}-${marker}`;
  const directory = path.join(root, snapshotPath);
  await mkdir(path.join(directory, 'records'), { recursive: true });
  await mkdir(path.join(directory, 'aliases'), { recursive: true });
  await mkdir(path.join(directory, 'source-artifacts'), { recursive: true });
  await mkdir(path.join(root, 'sources'), { recursive: true });
  await mkdir(path.join(root, 'recipes'), { recursive: true });
  const sourcePath = `sources/${version}.json`;
  const sourceBytes = Buffer.from(`${JSON.stringify(records)}\n`, 'utf8');
  await writeFile(path.join(root, sourcePath), sourceBytes);
  const recipePath = `recipes/${version}.json`;
  const recipeBytes = Buffer.from(
    `${JSON.stringify(
      {
        format: 'moonwitness-ingestion-recipe/v1',
        recipeId: `synthetic-${version.replaceAll('.', '-')}`,
        parser: 'json-record-array/v1',
        source: {
          path: sourcePath,
          sha256: createHash('sha256').update(sourceBytes).digest('hex'),
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeFile(path.join(root, recipePath), recipeBytes);
  await writeFile(path.join(directory, 'snapshot.json'), `${canonicalizeJson(snapshot)}\n`);
  await writeFile(
    path.join(directory, 'records', `${hashCanonicalJson(records[0])}.json`),
    `${canonicalizeJson(records[0])}\n`
  );
  return {
    datasetId: 'synthetic-corpus',
    version,
    createdAt: '2026-10-16T10:00:00.000Z',
    ontologyVersion: '1.0.0',
    corpusVersion: '1.0.0',
    snapshotPath,
    snapshot,
    sourceRecipe: {
      path: recipePath,
      sha256: createHash('sha256').update(recipeBytes).digest('hex'),
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('immutable dataset releases and active pointers', () => {
  it('stores deterministic immutable release manifests without activating them', async () => {
    const root = await storeRoot();
    const input = await release(root, '1.0.0', 'a');
    const first = await createDatasetRelease(root, input);
    const repeated = await createDatasetRelease(root, input);

    expect(repeated).toEqual(first);
    expect(first.previousReleaseId).toBeNull();
    expect(await readActiveDatasetRelease(root, input.datasetId)).toBeNull();
    expect(await readdir(path.join(root, 'datasets', input.datasetId, 'releases'))).toEqual([
      `${first.releaseId}.json`,
    ]);
  });

  it('does not let a semantic dataset version be rebound to different content', async () => {
    const root = await storeRoot();
    await createDatasetRelease(root, await release(root, '1.0.0', 'a'));
    await expect(createDatasetRelease(root, await release(root, '1.0.0', 'b'))).rejects.toThrow(
      /immutable/
    );
  });

  it('activates only an existing intact release and can roll back to an earlier release', async () => {
    const root = await storeRoot();
    const first = await createDatasetRelease(root, await release(root, '1.0.0', 'a'));
    const activeFirst = await activateDatasetRelease(
      root,
      first.datasetId,
      first.releaseId,
      '2026-10-16T10:01:00.000Z'
    );
    const second = await createDatasetRelease(root, await release(root, '1.1.0', 'b'));
    expect(second.previousReleaseId).toBe(first.releaseId);
    await activateDatasetRelease(
      root,
      second.datasetId,
      second.releaseId,
      '2026-10-16T10:02:00.000Z'
    );

    const rolledBack = await activateDatasetRelease(
      root,
      first.datasetId,
      first.releaseId,
      '2026-10-16T10:03:00.000Z'
    );
    expect(rolledBack.releaseId).toBe(activeFirst.releaseId);
    expect(await readActiveDatasetRelease(root, first.datasetId)).toEqual(rolledBack);
    expect(
      JSON.parse(
        await readFile(
          path.join(root, 'datasets', first.datasetId, 'releases', `${first.releaseId}.json`),
          'utf8'
        )
      )
    ).toEqual(first);
  });

  it('leaves the active pointer unchanged when an activation target is missing', async () => {
    const root = await storeRoot();
    const first = await createDatasetRelease(root, await release(root, '1.0.0', 'a'));
    const active = await activateDatasetRelease(
      root,
      first.datasetId,
      first.releaseId,
      '2026-10-16T10:01:00.000Z'
    );
    await expect(
      activateDatasetRelease(root, first.datasetId, 'f'.repeat(64), '2026-10-16T10:02:00.000Z')
    ).rejects.toThrow();
    expect(await readActiveDatasetRelease(root, first.datasetId)).toEqual(active);
  });

  it('replays a missing snapshot from its pinned recipe and source before switching releases', async () => {
    const root = await storeRoot();
    const first = await createDatasetRelease(root, await release(root, '1.0.0', 'a'));
    const second = await createDatasetRelease(root, await release(root, '1.1.0', 'b'));
    const activeSecond = await activateDatasetRelease(
      root,
      second.datasetId,
      second.releaseId,
      '2026-10-16T10:02:00.000Z'
    );
    await rm(path.join(root, first.snapshotPath), { recursive: true, force: true });

    const restored = await replayDatasetRelease({
      rootDirectory: root,
      datasetId: first.datasetId,
      releaseId: first.releaseId,
      activatedAt: '2026-10-16T10:03:00.000Z',
    });

    expect(restored.releaseId).toBe(first.releaseId);
    expect(restored.snapshotPath).toBe(first.snapshotPath);
    expect(restored.releaseId).not.toBe(activeSecond.releaseId);
    expect(await readActiveDatasetRelease(root, first.datasetId)).toEqual(restored);
    const rebuiltSnapshot = JSON.parse(
      await readFile(path.join(root, first.snapshotPath, 'snapshot.json'), 'utf8')
    );
    expect(rebuiltSnapshot.sha256).toBe(first.snapshot.sha256);
    const repeated = await replayDatasetRelease({
      rootDirectory: root,
      datasetId: first.datasetId,
      releaseId: first.releaseId,
      activatedAt: '2026-10-16T10:04:00.000Z',
    });
    expect(repeated.releaseId).toBe(first.releaseId);
    expect(await readActiveDatasetRelease(root, first.datasetId)).toEqual(repeated);
  });

  it('keeps the active release unchanged when a missing snapshot cannot be replayed', async () => {
    const root = await storeRoot();
    const first = await createDatasetRelease(root, await release(root, '1.0.0', 'a'));
    const second = await createDatasetRelease(root, await release(root, '1.1.0', 'b'));
    const activeSecond = await activateDatasetRelease(
      root,
      second.datasetId,
      second.releaseId,
      '2026-10-16T10:02:00.000Z'
    );
    await rm(path.join(root, first.snapshotPath), { recursive: true, force: true });
    const recipeFile = path.join(root, first.sourceRecipe.path);
    const sourceFile = path.join(root, 'sources/1.0.0.json');
    const originalSource = await readFile(sourceFile);
    await writeFile(sourceFile, `${originalSource.toString('utf8')} `);

    await expect(
      replayDatasetRelease({
        rootDirectory: root,
        datasetId: first.datasetId,
        releaseId: first.releaseId,
        activatedAt: '2026-10-16T10:03:00.000Z',
      })
    ).rejects.toThrow(/Source checksum mismatch/u);
    await writeFile(sourceFile, originalSource);
    await writeFile(recipeFile, 'tampered recipe\n');
    await expect(
      replayDatasetRelease({
        rootDirectory: root,
        datasetId: first.datasetId,
        releaseId: first.releaseId,
        activatedAt: '2026-10-16T10:04:00.000Z',
      })
    ).rejects.toThrow(/Pinned source recipe checksum mismatch/u);
    expect(await readActiveDatasetRelease(root, first.datasetId)).toEqual(activeSecond);
    await expect(readdir(path.join(root, first.snapshotPath))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects invalid versions and malformed snapshot digests before writing files', async () => {
    const root = await storeRoot();
    const invalidVersion = await release(root, '1.0.0', 'a');
    await expect(createDatasetRelease(root, { ...invalidVersion, version: '1.0' })).rejects.toThrow(
      /semantic/
    );
    await expect(
      createDatasetRelease(root, {
        ...invalidVersion,
        snapshot: { ...invalidVersion.snapshot, sha256: 'bad' },
      })
    ).rejects.toThrow(/snapshot/);
    await expect(readdir(path.join(root, 'datasets'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
