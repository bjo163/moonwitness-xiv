import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knex from 'knex';
import { Model } from 'objection';
import { afterEach, describe, expect, it } from 'vitest';
import { enqueueJob, jobsManifest, runOneJob } from '@moonwitness/jobs';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { installAddons } from '@moonwitness/orm';
import { LocalFileAttachmentStorage, manifest as storageManifest } from '@moonwitness/orm-storage';
import { whatsappManifest } from '../src/whatsapp/manifest.js';
import {
  ensureWhatsAppAttachmentCron,
  registerWhatsAppAttachmentJob,
} from '../src/commands/whatsapp-attachments-job.js';

describe('WhatsApp orphan attachment schedule', () => {
  let db: ReturnType<typeof knex> | undefined;
  let unregister: (() => void) | undefined;
  let storageDirectory: string | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await db?.destroy();
    db = undefined;
    if (storageDirectory) await rm(storageDirectory, { recursive: true, force: true });
    storageDirectory = undefined;
  });

  it('creates one enabled daily cleanup schedule idempotently', async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    await db.schema.createTable('crons', (table) => {
      table.increments('id').primary();
      table.string('code').notNullable().unique();
      table.string('name').notNullable();
      table.string('handler').notNullable();
      table.integer('handler_version').notNullable();
      table.text('payload').notNullable();
      table.string('cron_expression').notNullable();
      table.string('timezone').notNullable();
      table.boolean('enabled').notNullable();
      table.string('next_run_at').notNullable();
      table.string('misfire_policy').notNullable();
      table.string('concurrency_policy').notNullable();
      table.integer('max_catch_up').notNullable();
    });

    await ensureWhatsAppAttachmentCron(db);
    await ensureWhatsAppAttachmentCron(db);

    const schedules = await db('crons').select('*');
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      code: 'whatsapp.attachments.reconcile',
      handler: 'whatsapp.attachments.reconcile',
      cron_expression: '17 3 * * *',
      timezone: 'UTC',
      enabled: 1,
      concurrency_policy: 'forbid',
      max_catch_up: 1,
    });
    expect(Date.parse(schedules[0].next_run_at)).toBeGreaterThan(Date.now());
  });

  it('rejects a job payload that could broaden the storage scan', async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    unregister = registerWhatsAppAttachmentJob(db);

    await expect(
      enqueueJob('whatsapp.attachments.reconcile', { delete_all: true })
    ).rejects.toThrow('payload must be an empty object');
  });

  it('deletes only stale orphan objects and preserves a referenced attachment', async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    Model.knex(db);
    await installAddons(db, [baseManifest, jobsManifest, storageManifest, whatsappManifest]);
    storageDirectory = await mkdtemp(path.join(tmpdir(), 'moonwitness-wa-cleanup-'));
    const storage = new LocalFileAttachmentStorage(storageDirectory);
    const referencedKey = '11111111-1111-4111-8111-111111111111';
    const orphanKey = '22222222-2222-4222-8222-222222222222';
    await storage.put(referencedKey, Buffer.from('referenced'));
    await storage.put(orphanKey, Buffer.from('orphan'));
    const staleDate = new Date('2020-01-01T00:00:00.000Z');
    await Promise.all(
      [referencedKey, orphanKey].map((key) =>
        utimes(path.join(storageDirectory!, key), staleDate, staleDate)
      )
    );
    await db('attachments').insert({
      name: 'kept.bin',
      resource_model: 'base.partner',
      resource_id: 1,
      mimetype: 'application/octet-stream',
      size_bytes: 10,
      storage_key: referencedKey,
    });
    unregister = registerWhatsAppAttachmentJob(db, () => storage);

    await enqueueJob('whatsapp.attachments.reconcile', {});
    await expect(runOneJob({ workerId: 'whatsapp-attachment-test' })).resolves.toBe(true);

    const job = await db('jobs').first();
    expect(job.status).toBe('succeeded');
    const run = await db('job_runs').first();
    expect(JSON.parse(run.result)).toMatchObject({
      orphaned: 1,
      deleted: 1,
      scan_truncated: false,
    });
    await expect(storage.get(referencedKey)).resolves.toEqual(Buffer.from('referenced'));
    await expect(storage.get(orphanKey)).resolves.toBeNull();
  });
});
