import type { Knex } from 'knex';
import { CronExpressionParser } from 'cron-parser';
import { registerJobHandler, type JobContext } from '@moonwitness/jobs';
import {
  closeS3AttachmentStorage,
  pruneOrphanAttachmentStorage,
  S3AttachmentStorage,
  type AttachmentStorage,
} from '@moonwitness/orm-storage';
import { createAttachmentStorage } from '../storage/attachment-storage.js';
import { whatsappAttachmentReferences } from './whatsapp-attachment-references.js';

const HANDLER_NAME = 'whatsapp.attachments.reconcile';
const CRON_EXPRESSION = '17 3 * * *';
const ORPHAN_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const PRUNE_LIMIT = 1000;

export async function ensureWhatsAppAttachmentCron(db: Knex): Promise<void> {
  const nextRunAt = CronExpressionParser.parse(CRON_EXPRESSION, {
    currentDate: new Date(),
    tz: 'UTC',
  })
    .next()
    .toDate();
  await db('crons')
    .insert({
      code: HANDLER_NAME,
      name: 'Clean orphaned WhatsApp attachments',
      handler: HANDLER_NAME,
      handler_version: 1,
      payload: '{}',
      cron_expression: CRON_EXPRESSION,
      timezone: 'UTC',
      enabled: true,
      next_run_at: nextRunAt.toISOString(),
      misfire_policy: 'coalesce',
      concurrency_policy: 'forbid',
      max_catch_up: 1,
    })
    .onConflict('code')
    .ignore();
}

export function registerWhatsAppAttachmentJob(
  db: Knex,
  storageFactory: () => AttachmentStorage = createAttachmentStorage
): () => void {
  return registerJobHandler({
    name: HANDLER_NAME,
    version: 1,
    parse(payload: unknown) {
      if (
        payload === null ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        Object.keys(payload).length !== 0
      )
        throw new Error('WhatsApp attachment cleanup payload must be an empty object');
      return {};
    },
    async run(_payload: Record<string, never>, context: JobContext) {
      if (context.signal.aborted) throw new Error('WhatsApp attachment cleanup was cancelled');
      const storage = storageFactory();
      const olderThan = new Date(Date.now() - ORPHAN_GRACE_PERIOD_MS);
      try {
        async function* references(): AsyncIterable<string> {
          const attachmentRows = await db('attachments').select('storage_key');
          for (const row of attachmentRows)
            if (typeof row.storage_key === 'string') yield row.storage_key;
          for await (const reference of whatsappAttachmentReferences(db, olderThan))
            yield reference.storageKey;
        }
        const result = await pruneOrphanAttachmentStorage(storage, references(), {
          apply: true,
          olderThan,
          limit: PRUNE_LIMIT,
        });
        await db('whatsapp_upload_tickets')
          .where('expires_at', '<=', olderThan.toISOString())
          .delete();
        if (result.failures.length) throw new Error('Orphaned attachments could not be deleted');
        return {
          scanned_entries: result.scannedEntries,
          orphaned: result.orphaned.length,
          deleted: result.deleted.length,
          scan_truncated: result.scanTruncated,
        };
      } finally {
        if (storage instanceof S3AttachmentStorage) await closeS3AttachmentStorage(storage);
      }
    },
  });
}
