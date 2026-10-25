import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knex, { type Knex } from 'knex';
import { Model } from 'objection';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob, jobsManifest, runOneJob } from '@moonwitness/jobs';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { installAddons } from '@moonwitness/orm';
import { LocalFileAttachmentStorage, manifest as storageManifest } from '@moonwitness/orm-storage';
import { createPostgresKnexConfig } from '../src/config/knexfile.js';
import {
  ensureWhatsAppAttachmentCron,
  registerWhatsAppAttachmentJob,
} from '../src/commands/whatsapp-attachments-job.js';
import { whatsappManifest } from '../src/whatsapp/manifest.js';

const connectionString = process.env.POSTGRES_TEST_URL;
const postgresDescribe = connectionString ? describe : describe.skip;

postgresDescribe('WhatsApp attachment reconciliation on PostgreSQL', () => {
  let adminDb: Knex;
  let db: Knex;
  let unregister: (() => void) | undefined;
  let storageDirectory: string;
  let storage: LocalFileAttachmentStorage;
  const schema = `mw_whatsapp_cleanup_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (!connectionString) throw new Error('POSTGRES_TEST_URL is required');
    adminDb = knex({ client: 'pg', connection: connectionString, pool: { min: 0, max: 2 } });
    await adminDb.raw('create schema ??', [schema]);
    db = knex(
      createPostgresKnexConfig(
        connectionString,
        { poolMin: 0, poolMax: 4, acquireTimeoutMs: 5000, statementTimeoutMs: 30_000 },
        { searchPath: [schema] }
      )
    );
    Model.knex(db);
    await installAddons(db, [baseManifest, jobsManifest, storageManifest, whatsappManifest]);
    storageDirectory = await mkdtemp(path.join(tmpdir(), 'moonwitness-wa-cleanup-pg-'));
    storage = new LocalFileAttachmentStorage(storageDirectory);
  }, 30_000);

  afterAll(async () => {
    unregister?.();
    if (db) await db.destroy();
    if (adminDb) {
      await adminDb.raw('drop schema if exists ?? cascade', [schema]);
      await adminDb.destroy();
    }
    if (storageDirectory) await rm(storageDirectory, { recursive: true, force: true });
  });

  it('schedules idempotently and removes only old unreferenced WhatsApp storage objects', async () => {
    await ensureWhatsAppAttachmentCron(db);
    await ensureWhatsAppAttachmentCron(db);
    await expect(
      db('crons').where({ code: 'whatsapp.attachments.reconcile' })
    ).resolves.toMatchObject([
      {
        handler: 'whatsapp.attachments.reconcile',
        cron_expression: '17 3 * * *',
        timezone: 'UTC',
        enabled: true,
        concurrency_policy: 'forbid',
        max_catch_up: 1,
      },
    ]);

    const retainedAttachment = '11111111-1111-4111-8111-111111111111';
    const retainedMessageMedia = '22222222-2222-4222-8222-222222222222';
    const retainedUploadTicket = '33333333-3333-4333-8333-333333333333';
    const staleOrphan = '44444444-4444-4444-8444-444444444444';
    await Promise.all(
      [retainedAttachment, retainedMessageMedia, retainedUploadTicket, staleOrphan].map((key) =>
        storage.put(key, Buffer.from(key))
      )
    );
    const staleDate = new Date('2020-01-01T00:00:00.000Z');
    await Promise.all(
      [retainedAttachment, retainedMessageMedia, retainedUploadTicket, staleOrphan].map((key) =>
        utimes(path.join(storageDirectory, key), staleDate, staleDate)
      )
    );
    await db('attachments').insert({
      name: 'kept.bin',
      resource_model: 'base.partner',
      resource_id: 1,
      mimetype: 'application/octet-stream',
      size_bytes: 10,
      storage_key: retainedAttachment,
    });
    const company = await db('companies').first('id');
    if (!company) throw new Error('PostgreSQL test schema did not seed a company');
    const [account] = await db('whatsapp_accounts')
      .insert({ company_id: company.id, status: 'connected' })
      .returning(['id']);
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: company.id,
        account_id: account.id,
        jid: '628111111111@s.whatsapp.net',
        name: 'Cleanup test',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    await db('whatsapp_messages').insert({
      company_id: company.id,
      account_id: account.id,
      conversation_id: conversation.id,
      external_id: 'cleanup-message-pg',
      direction: 'inbound',
      message_type: 'image',
      status: 'received',
      media_key: retainedMessageMedia,
      media_mime_type: 'image/png',
      media_size_bytes: 12,
    });
    await db('whatsapp_upload_tickets').insert({
      company_id: company.id,
      conversation_id: conversation.id,
      user_id: 1,
      storage_key: retainedUploadTicket,
      file_name: 'active.png',
      content_type: 'image/png',
      size_bytes: 13,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    unregister = registerWhatsAppAttachmentJob(db, () => storage);

    await enqueueJob('whatsapp.attachments.reconcile', {});
    await expect(runOneJob({ workerId: `whatsapp-cleanup-pg-${randomUUID()}` })).resolves.toBe(
      true
    );
    await expect(db('jobs').first('status')).resolves.toMatchObject({ status: 'succeeded' });
    await expect(storage.get(retainedAttachment)).resolves.toEqual(Buffer.from(retainedAttachment));
    await expect(storage.get(retainedMessageMedia)).resolves.toEqual(
      Buffer.from(retainedMessageMedia)
    );
    await expect(storage.get(retainedUploadTicket)).resolves.toEqual(
      Buffer.from(retainedUploadTicket)
    );
    await expect(storage.get(staleOrphan)).resolves.toBeNull();
  }, 30_000);
});
