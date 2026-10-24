import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import knex from 'knex';
import { Model } from 'objection';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import {
  ingestDataset,
  readActiveDatasetRelease,
  readDatasetRelease,
  replayDatasetRelease,
} from '../../corpus/dist/index.js';
import { manifest as workflowManifest } from '../dist/manifest.js';
import { startWorkflow, transitionWorkflow } from '../dist/runtime.js';

const timestamp = '2026-10-16T10:00:00.000Z';

function sourceRecord(revision) {
  return {
    id: 'mw:entity:synthetic-storage-pilot',
    kind: 'Entity',
    schema_version: 1,
    lifecycle: 'draft',
    created_at: timestamp,
    updated_at: timestamp,
    origin_ref: 'urn:synthetic:storage-compatibility-pilot',
    visibility: 'INTERNAL',
    content_revision: revision,
  };
}

async function writeRecipe(root, version, record) {
  const sourcePath = `source-${version}.json`;
  const sourceBytes = Buffer.from(`${JSON.stringify([record])}\n`, 'utf8');
  await writeFile(path.join(root, sourcePath), sourceBytes);
  const recipe = {
    format: 'moonwitness-ingestion-recipe/v1',
    recipeId: `synthetic-storage-pilot-${version}`,
    parser: 'json-record-array/v1',
    source: {
      path: sourcePath,
      sha256: createHash('sha256').update(sourceBytes).digest('hex'),
    },
  };
  const recipePath = `recipe-${version}.json`;
  await writeFile(path.join(root, recipePath), `${JSON.stringify(recipe, null, 2)}\n`);
  return recipePath;
}

test('synthetic compatibility pilot: immutable file release bound to append-only workflow event', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mw-storage-compatibility-pilot-'));
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  try {
    Model.knex(database);
    await installAddons(database, [
      baseManifest,
      jobsManifest,
      notificationManifest,
      workflowManifest,
    ]);

    const firstRecord = sourceRecord(1);
    const firstRecipe = await writeRecipe(root, '1', firstRecord);
    const firstBuild = await ingestDataset({
      rootDirectory: root,
      recipePath: firstRecipe,
      outputPath: 'snapshots/1.0.0',
      release: {
        datasetId: 'synthetic-storage-pilot',
        version: '1.0.0',
        ontologyVersion: '1.0.0',
        corpusVersion: '1.0.0',
        createdAt: timestamp,
      },
    });
    assert.equal(firstBuild.records, 1);
    assert.equal(firstBuild.releaseId?.length, 64);

    const firstRelease = await readDatasetRelease(
      root,
      'synthetic-storage-pilot',
      firstBuild.releaseId
    );
    const firstManifestPath = path.join(
      root,
      'datasets',
      firstRelease.datasetId,
      'releases',
      `${firstRelease.releaseId}.json`
    );
    const firstManifestBytes = await readFile(firstManifestPath);

    const secondRecord = sourceRecord(2);
    const secondRecipe = await writeRecipe(root, '2', secondRecord);
    const secondBuild = await ingestDataset({
      rootDirectory: root,
      recipePath: secondRecipe,
      outputPath: 'snapshots/1.1.0',
      release: {
        datasetId: 'synthetic-storage-pilot',
        version: '1.1.0',
        ontologyVersion: '1.0.0',
        corpusVersion: '1.1.0',
        createdAt: '2026-10-16T10:01:00.000Z',
      },
    });
    assert.notEqual(secondBuild.snapshotSha256, firstBuild.snapshotSha256);
    assert.equal(
      (await readDatasetRelease(root, 'synthetic-storage-pilot', secondBuild.releaseId))
        .previousReleaseId,
      firstRelease.releaseId
    );

    const activeSecond = await readActiveDatasetRelease(root, 'synthetic-storage-pilot');
    assert.equal(activeSecond?.releaseId, secondBuild.releaseId);
    await rm(path.join(root, firstRelease.snapshotPath), { recursive: true, force: true });
    const replayedFirst = await replayDatasetRelease({
      rootDirectory: root,
      datasetId: 'synthetic-storage-pilot',
      releaseId: firstRelease.releaseId,
      activatedAt: '2026-10-16T10:02:00.000Z',
    });
    assert.equal(replayedFirst.releaseId, firstRelease.releaseId);
    assert.equal(replayedFirst.releaseId === activeSecond?.releaseId, false);
    assert.deepEqual(await readFile(firstManifestPath), firstManifestBytes);
    assert.equal(
      (await readActiveDatasetRelease(root, 'synthetic-storage-pilot'))?.releaseId,
      firstRelease.releaseId
    );

    const system = await database('users').where({ login: 'system' }).first('id');
    const company = await database('companies').first('id');
    const partner = await database('partners').first('id');
    assert.ok(system && company && partner, 'synthetic base addon fixtures must exist');
    const actorId = Number(system.id);
    const started = await startWorkflow(database, {
      code: 'sample.request_approval',
      companyId: Number(company.id),
      actorId,
      role: 'system',
      resourceModel: 'base.partner',
      resourceId: Number(partner.id),
      idempotencyKey: 'storage-pilot-start-01',
      now: new Date(timestamp),
    });

    await database.raw(`
      CREATE TRIGGER storage_pilot_reject_submit
      BEFORE INSERT ON workflow_events WHEN NEW.action = 'submit'
      BEGIN SELECT RAISE(ABORT, 'synthetic pilot event failure'); END
    `);
    await assert.rejects(
      transitionWorkflow(database, {
        instanceId: started.id,
        companyId: Number(company.id),
        actorId,
        role: 'system',
        action: 'submit',
        expectedRevision: 0,
        idempotencyKey: 'storage-pilot-submit-01',
        payload: {
          recordId: firstRecord.id,
          recordRevision: firstRecord.content_revision,
          releaseId: firstRelease.releaseId,
          snapshotSha256: firstBuild.snapshotSha256,
        },
        now: new Date(timestamp),
      }),
      /synthetic pilot event failure/u
    );
    assert.deepEqual(
      await database('workflow_instances')
        .where({ id: started.id })
        .first('current_state', 'revision'),
      { current_state: 'draft', revision: 0 }
    );
    assert.equal(
      await database('workflow_events')
        .where({ instance_id: started.id })
        .count({ count: '*' })
        .first()
        .then((row) => Number(row?.count)),
      1,
      'failed transition must not append an event'
    );
    await database.raw('DROP TRIGGER storage_pilot_reject_submit');

    const eventPayload = {
      recordId: firstRecord.id,
      recordRevision: firstRecord.content_revision,
      releaseId: firstRelease.releaseId,
      snapshotSha256: firstBuild.snapshotSha256,
    };
    const transitionInput = {
      instanceId: started.id,
      companyId: Number(company.id),
      actorId,
      role: 'system',
      action: 'submit',
      expectedRevision: 0,
      idempotencyKey: 'storage-pilot-submit-01',
      payload: eventPayload,
      now: new Date(timestamp),
    };
    const transitioned = await transitionWorkflow(database, transitionInput);
    assert.equal(transitioned.revision, 1);
    assert.equal((await transitionWorkflow(database, transitionInput)).revision, 1);
    await assert.rejects(
      transitionWorkflow(database, {
        ...transitionInput,
        payload: { ...eventPayload, snapshotSha256: secondBuild.snapshotSha256 },
      }),
      { code: 'IDEMPOTENCY_CONFLICT' }
    );
    await assert.rejects(
      transitionWorkflow(database, {
        ...transitionInput,
        action: 'approve',
        expectedRevision: 0,
        idempotencyKey: 'storage-pilot-stale-01',
      }),
      { code: 'STALE_REVISION' }
    );

    const storedEvent = await database('workflow_events')
      .where({ instance_id: started.id, action: 'submit' })
      .first('payload');
    assert.deepEqual(JSON.parse(String(storedEvent?.payload)), {
      recordId: firstRecord.id,
      recordRevision: 1,
      releaseId: firstRelease.releaseId,
      snapshotSha256: firstBuild.snapshotSha256,
    });
    await assert.rejects(
      database('workflow_events')
        .where({ instance_id: started.id, action: 'submit' })
        .update({ comment: 'mutated' }),
      /append-only/u
    );
    await assert.rejects(
      database('workflow_events').where({ instance_id: started.id, action: 'submit' }).del(),
      /append-only/u
    );
  } finally {
    await database.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
