import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ingestDataset } from '../src/index.js';

const temporaryRoots: string[] = [];

async function fixture(sourceText: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-corpus-'));
  temporaryRoots.push(root);
  await writeFile(path.join(root, 'source.json'), sourceText);
  const sourceSha = createHash('sha256').update(sourceText, 'utf8').digest('hex');
  await writeFile(
    path.join(root, 'recipe.json'),
    `${JSON.stringify(
      {
        format: 'moonwitness-ingestion-recipe/v1',
        recipeId: 'synthetic-test',
        parser: 'json-record-array/v1',
        source: { path: 'source.json', sha256: sourceSha },
      },
      null,
      2
    )}\n`
  );
  return root;
}

function record(id: string) {
  return {
    id,
    kind: 'Entity',
    schema_version: 1,
    lifecycle: 'draft',
    created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T00:00:00.000Z',
    origin_ref: 'urn:synthetic:test',
    visibility: 'INTERNAL',
    content_revision: 1,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('ingestDataset', () => {
  it('dry-runs without writing and emits a stable snapshot report', async () => {
    const root = await fixture(JSON.stringify([record('mw:entity:b'), record('mw:entity:a')]));
    const request = {
      rootDirectory: root,
      recipePath: 'recipe.json',
      outputPath: 'releases/test',
      dryRun: true,
    };
    const first = await ingestDataset(request);
    const second = await ingestDataset(request);
    expect(first).toEqual(second);
    expect(first.records).toBe(2);
    await expect(readdir(path.join(root, 'releases'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes a clean immutable snapshot and rejects overwrites', async () => {
    const root = await fixture(JSON.stringify([record('mw:entity:a')]));
    const request = { rootDirectory: root, recipePath: 'recipe.json', outputPath: 'releases/one' };
    const report = await ingestDataset(request);
    const snapshot = JSON.parse(
      await readFile(path.join(root, 'releases/one/snapshot.json'), 'utf8')
    );
    expect(snapshot.sha256).toBe(report.snapshotSha256);
    expect(await readdir(path.join(root, 'releases/one/records'))).toHaveLength(1);
    await expect(ingestDataset(request)).rejects.toThrow('immutable');
  });

  it('creates and activates a release from the ingested snapshot, then fails closed on corruption', async () => {
    const root = await fixture(JSON.stringify([record('mw:entity:a')]));
    const report = await ingestDataset({
      rootDirectory: root,
      recipePath: 'recipe.json',
      outputPath: 'snapshots/one',
      release: {
        datasetId: 'synthetic-corpus',
        version: '1.0.0',
        ontologyVersion: '1.0.0',
        corpusVersion: '1.0.0',
        createdAt: '2026-10-16T10:00:00.000Z',
      },
    });
    expect(report.releaseId).toMatch(/^[a-f0-9]{64}$/u);
    const { readActiveDatasetRelease, activateDatasetRelease } = await import('../src/index.js');
    const active = await readActiveDatasetRelease(root, 'synthetic-corpus');
    expect(active?.releaseId).toBe(report.releaseId);
    expect(active?.snapshotPath).toBe('snapshots/one');

    const [recordFile] = await readdir(path.join(root, 'snapshots/one/records'));
    await writeFile(path.join(root, 'snapshots/one/records', recordFile!), '{"tampered":true}\n');
    await expect(
      activateDatasetRelease(
        root,
        'synthetic-corpus',
        report.releaseId!,
        '2026-10-16T10:01:00.000Z'
      )
    ).rejects.toThrow(/snapshot|records/u);
    expect(await readActiveDatasetRelease(root, 'synthetic-corpus')).toEqual(active);
  });

  it('rejects checksum and parser failures before touching an existing snapshot', async () => {
    const root = await fixture(JSON.stringify([record('mw:entity:a')]));
    await writeFile(path.join(root, 'releases.json'), 'previous snapshot');
    const recipePath = path.join(root, 'recipe.json');
    const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
    recipe.source.sha256 = '0'.repeat(64);
    await writeFile(recipePath, JSON.stringify(recipe));
    await expect(
      ingestDataset({ rootDirectory: root, recipePath: 'recipe.json', outputPath: 'releases.json' })
    ).rejects.toThrow('checksum mismatch');
    await expect(readFile(path.join(root, 'releases.json'), 'utf8')).resolves.toBe(
      'previous snapshot'
    );

    const malformedSource = '{"unterminated":';
    await writeFile(path.join(root, 'source.json'), malformedSource);
    recipe.source.sha256 = createHash('sha256').update(malformedSource, 'utf8').digest('hex');
    await writeFile(recipePath, JSON.stringify(recipe));
    await expect(
      ingestDataset({ rootDirectory: root, recipePath: 'recipe.json', outputPath: 'releases.json' })
    ).rejects.toThrow();
    await expect(readFile(path.join(root, 'releases.json'), 'utf8')).resolves.toBe(
      'previous snapshot'
    );
  });

  it('rejects partial imports and leaves no published output', async () => {
    const root = await fixture(JSON.stringify([record('mw:entity:a'), { id: 'invalid' }]));
    await expect(
      ingestDataset({
        rootDirectory: root,
        recipePath: 'recipe.json',
        outputPath: 'releases/partial',
      })
    ).rejects.toThrow('Record at index 1 is invalid');
    await expect(readdir(path.join(root, 'releases'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects path traversal and unsupported parser recipes', async () => {
    const root = await fixture(JSON.stringify([record('mw:entity:a')]));
    const recipePath = path.join(root, 'recipe.json');
    const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
    recipe.source.path = '../outside.json';
    await writeFile(recipePath, JSON.stringify(recipe));
    await expect(
      ingestDataset({ rootDirectory: root, recipePath: 'recipe.json', outputPath: 'releases/path' })
    ).rejects.toThrow('parent segments');
    recipe.source.path = 'source.json';
    recipe.parser = 'network-fetch/v1';
    await writeFile(recipePath, JSON.stringify(recipe));
    await expect(
      ingestDataset({
        rootDirectory: root,
        recipePath: 'recipe.json',
        outputPath: 'releases/parser',
      })
    ).rejects.toThrow('Unsupported parser');
  });
});
