import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalFileAttachmentStorage, S3AttachmentStorage } from '@moonwitness/orm-storage';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { createDatabase } from '../database/knex.js';
import { config } from '../config/env.js';
import { whatsappManifest } from '../whatsapp/manifest.js';

interface MigrationReference {
  key: string;
  sizeBytes?: number;
  checksum?: string;
  domains: Set<'attachment' | 'whatsapp'>;
}

interface MigrationResult {
  key: string;
  domains: string[];
  sizeBytes?: number;
  checksum?: string;
  status:
    | 'ready_to_copy'
    | 'copied_verified'
    | 'already_verified'
    | 'source_missing'
    | 'source_mismatch'
    | 'destination_conflict'
    | 'failed';
}

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(args: readonly string[]) {
  const apply = args.includes('--apply');
  const limitArg = args.find((item) => item.startsWith('--limit='))?.slice('--limit='.length);
  const offsetArg = args.find((item) => item.startsWith('--offset='))?.slice('--offset='.length);
  const limit = limitArg ? Number(limitArg) : 1000;
  const offset = offsetArg ? Number(offsetArg) : 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) {
    throw new Error('--limit must be an integer from 1 to 100000');
  }
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error('--offset must be a non-negative integer');
  return { apply, limit, offset };
}

export async function migrateAttachmentsToS3(options: ReturnType<typeof parseArgs>) {
  if (config.attachmentStorageDriver !== 's3') {
    throw new Error(
      'Set ATTACHMENT_STORAGE_DRIVER=s3 and configure the S3-compatible endpoint before running this command'
    );
  }
  const db = createDatabase();
  const source = new LocalFileAttachmentStorage(config.attachmentStorageDirectory);
  // Migration preserves valid legacy objects even when they predate the current 10 MiB ingress cap.
  const destination = new S3AttachmentStorage({
    ...config.s3Storage!,
    maxObjectBytes: Number.MAX_SAFE_INTEGER,
  });
  try {
    await installAddons(db, [baseManifest, whatsappManifest]);
    const references = new Map<string, MigrationReference>();
    const attachmentRows = await db('attachments').select('storage_key', 'size_bytes', 'checksum');
    for (const row of attachmentRows) {
      if (typeof row.storage_key !== 'string') continue;
      references.set(row.storage_key, {
        key: row.storage_key,
        ...(typeof row.size_bytes === 'number' ? { sizeBytes: row.size_bytes } : {}),
        ...(typeof row.checksum === 'string' ? { checksum: row.checksum.toLowerCase() } : {}),
        domains: new Set(['attachment']),
      });
    }
    const mediaRows = await db('whatsapp_messages').whereNotNull('media_key').select('media_key');
    for (const row of mediaRows) {
      if (typeof row.media_key !== 'string') continue;
      const existing = references.get(row.media_key);
      if (existing) existing.domains.add('whatsapp');
      else references.set(row.media_key, { key: row.media_key, domains: new Set(['whatsapp']) });
    }

    const ordered = [...references.values()].sort((a, b) => a.key.localeCompare(b.key));
    const batch = ordered.slice(options.offset, options.offset + options.limit);
    const results: MigrationResult[] = [];
    for (const reference of batch) {
      const base = {
        key: reference.key,
        domains: [...reference.domains].sort(),
      };
      try {
        const sourceBytes = await source.get(reference.key);
        if (!sourceBytes) {
          results.push({ ...base, status: 'source_missing' });
          continue;
        }
        const sourceChecksum = checksum(sourceBytes);
        if (
          (reference.sizeBytes !== undefined && sourceBytes.byteLength !== reference.sizeBytes) ||
          (reference.checksum && sourceChecksum !== reference.checksum)
        ) {
          results.push({
            ...base,
            sizeBytes: sourceBytes.byteLength,
            checksum: sourceChecksum,
            status: 'source_mismatch',
          });
          continue;
        }
        const targetBytes = await destination.get(reference.key);
        if (targetBytes) {
          if (
            targetBytes.byteLength !== sourceBytes.byteLength ||
            checksum(targetBytes) !== sourceChecksum
          ) {
            results.push({
              ...base,
              sizeBytes: sourceBytes.byteLength,
              checksum: sourceChecksum,
              status: 'destination_conflict',
            });
          } else {
            results.push({
              ...base,
              sizeBytes: sourceBytes.byteLength,
              checksum: sourceChecksum,
              status: 'already_verified',
            });
          }
          continue;
        }
        if (!options.apply) {
          results.push({
            ...base,
            sizeBytes: sourceBytes.byteLength,
            checksum: sourceChecksum,
            status: 'ready_to_copy',
          });
          continue;
        }
        await destination.put(reference.key, sourceBytes);
        const copiedBytes = await destination.get(reference.key);
        if (
          !copiedBytes ||
          copiedBytes.byteLength !== sourceBytes.byteLength ||
          checksum(copiedBytes) !== sourceChecksum
        ) {
          results.push({
            ...base,
            sizeBytes: sourceBytes.byteLength,
            checksum: sourceChecksum,
            status: 'destination_conflict',
          });
          continue;
        }
        results.push({
          ...base,
          sizeBytes: sourceBytes.byteLength,
          checksum: sourceChecksum,
          status: 'copied_verified',
        });
      } catch {
        results.push({ ...base, status: 'failed' });
      }
    }
    const counts = Object.fromEntries(
      [
        'ready_to_copy',
        'copied_verified',
        'already_verified',
        'source_missing',
        'source_mismatch',
        'destination_conflict',
        'failed',
      ].map((status) => [status, results.filter((item) => item.status === status).length])
    );
    return {
      mode: options.apply ? 'apply' : 'dry-run',
      totalReferences: ordered.length,
      offset: options.offset,
      limit: options.limit,
      processed: results.length,
      nextOffset:
        options.offset + results.length < ordered.length ? options.offset + results.length : null,
      counts,
      results,
    };
  } finally {
    destination.client.destroy();
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await migrateAttachmentsToS3(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const statuses = result.counts as Record<string, number>;
    if (
      statuses.source_missing ||
      statuses.source_mismatch ||
      statuses.destination_conflict ||
      statuses.failed
    ) {
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'S3 storage migration failed'}\n`
    );
    process.exitCode = 1;
  }
}
