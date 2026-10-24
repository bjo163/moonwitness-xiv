import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = path.join(root, 'scripts/knowledge/ingest.mjs');

test('offline ingestion CLI dry-runs and publishes the same pinned synthetic snapshot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-ingest-cli-'));
  try {
    const source = JSON.stringify([
      {
        id: 'mw:entity:cli',
        kind: 'Entity',
        schema_version: 1,
        lifecycle: 'draft',
        created_at: '2026-10-15T00:00:00.000Z',
        updated_at: '2026-10-15T00:00:00.000Z',
        origin_ref: 'urn:synthetic:cli',
        visibility: 'INTERNAL',
        content_revision: 1,
      },
    ]);
    await writeFile(path.join(directory, 'source.json'), source);
    await writeFile(
      path.join(directory, 'recipe.json'),
      JSON.stringify({
        format: 'moonwitness-ingestion-recipe/v1',
        recipeId: 'cli-test',
        parser: 'json-record-array/v1',
        source: {
          path: 'source.json',
          sha256: createHash('sha256').update(source, 'utf8').digest('hex'),
        },
      })
    );
    const dryRun = spawnSync(
      process.execPath,
      [cliPath, 'recipe.json', '--output', 'releases/test', '--dry-run'],
      { cwd: directory, encoding: 'utf8', windowsHide: true }
    );
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryRunReport = JSON.parse(dryRun.stdout);
    assert.equal(dryRunReport.dryRun, true);
    assert.equal(dryRunReport.records, 1);
    await assert.rejects(readdir(path.join(directory, 'releases')), { code: 'ENOENT' });

    const imported = spawnSync(
      process.execPath,
      [cliPath, 'recipe.json', '--output', 'releases/test'],
      { cwd: directory, encoding: 'utf8', windowsHide: true }
    );
    assert.equal(imported.status, 0, imported.stderr);
    const importReport = JSON.parse(imported.stdout);
    assert.equal(importReport.dryRun, false);
    assert.equal(importReport.snapshotSha256, dryRunReport.snapshotSha256);
    const savedReport = JSON.parse(
      await readFile(path.join(directory, 'releases/test/report.json'), 'utf8')
    );
    assert.equal(savedReport.snapshotSha256, importReport.snapshotSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('offline ingestion CLI rejects incomplete arguments with usage status', () => {
  const result = spawnSync(process.execPath, [cliPath], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^Usage:/u);
});
