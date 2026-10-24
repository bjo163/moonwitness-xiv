import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const fixture = fileURLToPath(
  new URL('../../packages/knowledge/tests/fixtures/validator-dataset/', import.meta.url)
);
const cli = fileURLToPath(new URL('./snapshot.mjs', import.meta.url));

async function withDataset(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'moonwitness-snapshot-'));
  const dataset = path.join(root, 'dataset');
  try {
    await cp(fixture, dataset, { recursive: true });
    await run(dataset);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function snapshot(dataset) {
  return spawnSync(process.execPath, [cli, dataset], { encoding: 'utf8' });
}

test('snapshot is identical across repeated runs, file names, key and graph collection order', async () => {
  await withDataset(async (dataset) => {
    const before = snapshot(dataset);
    assert.equal(before.status, 0, before.stderr);
    const edition = path.join(dataset, 'records/edition.json');
    const record = JSON.parse(await readFile(edition, 'utf8'));
    await writeFile(edition, JSON.stringify(Object.fromEntries(Object.entries(record).reverse())));
    await rename(edition, path.join(dataset, 'records/zz-renamed.json'));
    const graphFile = path.join(dataset, 'provenance.json');
    const graph = JSON.parse(await readFile(graphFile, 'utf8'));
    graph.records.reverse();
    graph.activities.reverse();
    await writeFile(graphFile, JSON.stringify(graph));
    const after = snapshot(dataset);
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, before.stdout);
    assert.equal(snapshot(dataset).stdout, before.stdout);
  });
});

test('changed valid record content changes the dataset digest', async () => {
  await withDataset(async (dataset) => {
    const before = snapshot(dataset);
    assert.equal(before.status, 0, before.stderr);
    const filename = path.join(dataset, 'records/edition.json');
    const record = JSON.parse(await readFile(filename, 'utf8'));
    record.content_revision += 1;
    await writeFile(filename, JSON.stringify(record));
    const after = snapshot(dataset);
    assert.equal(after.status, 0, after.stderr);
    assert.notEqual(JSON.parse(after.stdout).sha256, JSON.parse(before.stdout).sha256);
  });
});

test('duplicate decoded properties are rejected rather than silently hashed', async () => {
  await withDataset(async (dataset) => {
    const filename = path.join(dataset, 'records/edition.json');
    const original = await readFile(filename, 'utf8');
    await writeFile(filename, `{"kind":"Edition",${original.slice(1)}`);
    const result = snapshot(dataset);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Duplicate JSON property/);
  });
});

test('invalid datasets produce no success digest', async () => {
  await withDataset(async (dataset) => {
    await rm(path.join(dataset, 'records/edition.json'));
    const result = snapshot(dataset);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unresolvedReference/);
  });
});
