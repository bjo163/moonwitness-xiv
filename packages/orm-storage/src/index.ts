import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { defineAddon } from '@moonwitness/orm';
import {
  mkdir,
  lstat,
  open,
  opendir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_ATTACHMENT_BYTES } from '@moonwitness/types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface StoredObjectMetadata {
  readonly key: string;
  readonly sizeBytes: number;
  readonly checksum?: string;
  readonly lastModified?: Date;
}

export interface AttachmentStorage {
  checkReady?(): Promise<void>;
  put(key: string, content: Uint8Array): Promise<StoredObjectMetadata>;
  get(key: string): Promise<Buffer | null>;
  putStream?(key: string, content: Readable, maxBytes?: number): Promise<StoredObjectMetadata>;
  getStream?(key: string): Promise<Readable | null>;
  delete(key: string): Promise<void>;
  list(): AsyncIterable<StoredObjectMetadata>;
}

function validateKey(key: string): string {
  if (!UUID_PATTERN.test(key)) throw new Error('Invalid attachment storage key');
  return key.toLowerCase();
}

function isValidKey(key: string): boolean {
  return UUID_PATTERN.test(key);
}

function validateScanOptions(olderThan: Date, limit: number): void {
  if (!Number.isFinite(olderThan.getTime())) throw new Error('olderThan must be a valid date');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
    throw new Error('limit must be an integer from 1 to 10000');
}

function objectMetadata(key: string, content: Uint8Array): StoredObjectMetadata {
  return {
    key: validateKey(key),
    sizeBytes: content.byteLength,
    checksum: createHash('sha256').update(content).digest('hex'),
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Local provider compatible with legacy attachments stored directly under ATTACHMENT_STORAGE_DIR. */
export class LocalFileAttachmentStorage implements AttachmentStorage {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }

  async checkReady(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const probePath = path.join(this.directory, `.readiness-${randomUUID()}.tmp`);
    let probe: Awaited<ReturnType<typeof open>> | undefined;
    try {
      probe = await open(probePath, 'wx', 0o600);
      await probe.writeFile(Buffer.from([0]));
      await probe.sync();
    } finally {
      try {
        await probe?.close();
      } finally {
        await rm(probePath, { force: true });
      }
    }
  }

  private objectPath(key: string): string {
    return path.join(this.directory, validateKey(key));
  }

  async put(key: string, content: Uint8Array): Promise<StoredObjectMetadata> {
    const target = this.objectPath(key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return objectMetadata(key, content);
  }

  async putStream(
    key: string,
    content: Readable,
    maxBytes = MAX_ATTACHMENT_BYTES
  ): Promise<StoredObjectMetadata> {
    const safeKey = validateKey(key);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error('maxBytes must be a positive safe integer');
    const target = this.objectPath(safeKey);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer | Uint8Array, _encoding, callback) {
        const bytes = Buffer.from(chunk);
        sizeBytes += bytes.byteLength;
        if (sizeBytes > maxBytes) {
          callback(new Error('Attachment exceeds the configured storage size limit'));
          return;
        }
        hash.update(bytes);
        callback(null, bytes);
      },
    });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await pipeline(content, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return { key: safeKey, sizeBytes, checksum: hash.digest('hex') };
  }

  async get(key: string): Promise<Buffer | null> {
    const objectPath = this.objectPath(key);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(objectPath, 'r');
      const opened = await file.stat();
      const current = await lstat(objectPath);
      if (
        !opened.isFile() ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino
      ) {
        throw new Error('Attachment object must be a regular file');
      }
      return await file.readFile();
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    } finally {
      await file?.close();
    }
  }

  async getStream(key: string): Promise<Readable | null> {
    const objectPath = this.objectPath(key);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(objectPath, 'r');
      const opened = await file.stat();
      const current = await lstat(objectPath);
      if (
        !opened.isFile() ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino
      ) {
        throw new Error('Attachment object must be a regular file');
      }
      return file.createReadStream({ autoClose: true });
    } catch (error) {
      if (isMissing(error)) return null;
      await file?.close().catch(() => undefined);
      throw error;
    }
  }

  async getWithMetadata(key: string): Promise<StoredObjectMetadata | null> {
    const content = await this.get(key);
    return content ? objectMetadata(key, content) : null;
  }

  async delete(key: string): Promise<void> {
    await rm(this.objectPath(key), { force: true });
  }

  async *list(): AsyncIterable<StoredObjectMetadata> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !UUID_PATTERN.test(entry.name)) continue;
      const key = entry.name.toLowerCase();
      const objectPath = this.objectPath(key);
      const [content, details] = await Promise.all([readFile(objectPath), stat(objectPath)]);
      yield {
        ...objectMetadata(key, content),
        sizeBytes: details.size,
        lastModified: details.mtime,
      };
    }
  }

  async scanStale(
    olderThan: Date,
    limit: number,
    protectedKeys: ReadonlySet<string> = new Set()
  ): Promise<StaleObjectScan> {
    validateScanOptions(olderThan, limit);
    const objects: StoredObjectMetadata[] = [];
    let directory;
    try {
      directory = await opendir(this.directory);
    } catch (error) {
      if (isMissing(error)) return { objects, checked: 0, scannedEntries: 0, truncated: false };
      throw error;
    }

    let scannedEntries = 0;
    let checked = 0;
    let truncated = false;
    const entries = directory[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await entries.next();
        if (next.done) break;
        scannedEntries += 1;
        const entry = next.value;
        if (!entry.isFile() || !UUID_PATTERN.test(entry.name)) continue;
        const key = entry.name.toLowerCase();
        const objectPath = this.objectPath(key);
        const details = await stat(objectPath);
        if (details.mtimeMs > olderThan.getTime()) continue;
        if (protectedKeys.has(key)) {
          checked += 1;
          continue;
        }
        if (objects.length === limit) {
          truncated = true;
          break;
        }
        checked += 1;

        const file = await open(objectPath, 'r');
        const hash = createHash('sha256');
        try {
          for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
        } finally {
          await file.close();
        }
        objects.push({ key, sizeBytes: details.size, checksum: hash.digest('hex') });
      }
    } finally {
      await directory.close().catch(() => undefined);
    }

    return { objects, checked, scannedEntries, truncated };
  }
}

export interface AttachmentReference {
  readonly storageKey: string;
  readonly sizeBytes?: number;
  readonly checksum?: string | null;
}

export interface StaleObjectScan {
  readonly objects: readonly StoredObjectMetadata[];
  readonly checked: number;
  readonly scannedEntries: number;
  readonly truncated: boolean;
}

export interface ReconcileResult {
  readonly checked: number;
  readonly scannedEntries: number;
  readonly scanTruncated: boolean;
  readonly missing: readonly string[];
  readonly corrupt: readonly string[];
  readonly orphaned: readonly string[];
  readonly deleted: readonly string[];
  readonly failures: readonly string[];
  readonly unsupportedReferences: readonly string[];
}

export interface ReconcileOptions {
  readonly apply: boolean;
  readonly olderThan: Date;
  readonly limit?: number;
}

/** Provider primitives are independent of the optional base attachment model. */
export const manifest = defineAddon({
  name: 'orm-storage',
  version: '1.0.0',
  models: [],
});

export const storageManifest = manifest;

/** Read-only by default; only the local provider supports guarded stale-object cleanup. */
export async function reconcileLocalAttachmentStorage(
  storage: LocalFileAttachmentStorage,
  references: AsyncIterable<AttachmentReference>,
  options: ReconcileOptions
): Promise<ReconcileResult> {
  const limit = options.limit ?? 1000;
  validateScanOptions(options.olderThan, limit);
  if (options.apply && options.olderThan.getTime() > Date.now())
    throw new Error('olderThan must not be in the future when apply is enabled');

  const byKey = new Map<string, AttachmentReference>();
  const unsupportedReferences: string[] = [];
  let totalReferences = 0;
  for await (const reference of references) {
    totalReferences += 1;
    if (totalReferences > limit * 100)
      throw new Error('Attachment reconciliation reference snapshot exceeds the safe bound');
    if (!isValidKey(reference.storageKey)) {
      unsupportedReferences.push(reference.storageKey);
      continue;
    }
    byKey.set(validateKey(reference.storageKey), reference);
  }
  const missing: string[] = [];
  const corrupt: string[] = [];
  let referenceCount = 0;
  for (const reference of byKey.values()) {
    referenceCount += 1;
    if (referenceCount > limit * 100)
      throw new Error('Attachment reconciliation reference snapshot exceeds the safe bound');
    const object = await storage.getWithMetadata(reference.storageKey);
    if (!object) {
      missing.push(reference.storageKey);
    } else if (
      object.sizeBytes !== reference.sizeBytes ||
      (reference.checksum && object.checksum?.toLowerCase() !== reference.checksum.toLowerCase())
    ) {
      corrupt.push(reference.storageKey);
    }
  }

  const orphaned: string[] = [];
  const deleted: string[] = [];
  const failures: string[] = [];
  const scan = await storage.scanStale(options.olderThan, limit, new Set(byKey.keys()));
  const checked = scan.checked;
  for (const object of scan.objects) {
    const reference = byKey.get(object.key);
    if (reference) {
      continue;
    }
    orphaned.push(object.key);
    if (!options.apply) continue;
    try {
      await storage.delete(object.key);
      deleted.push(object.key);
    } catch {
      failures.push(object.key);
    }
  }
  return {
    checked,
    scannedEntries: scan.scannedEntries,
    scanTruncated: scan.truncated,
    missing,
    corrupt,
    orphaned,
    deleted,
    failures,
    unsupportedReferences,
  };
}

/** Provider-neutral reconciliation. References may come from more than one database domain. */
export async function reconcileAttachmentStorage(
  storage: AttachmentStorage,
  references: AsyncIterable<AttachmentReference>,
  options: ReconcileOptions
): Promise<ReconcileResult> {
  const limit = options.limit ?? 1000;
  validateScanOptions(options.olderThan, limit);
  if (options.apply && options.olderThan.getTime() > Date.now()) {
    throw new Error('olderThan must not be in the future when apply is enabled');
  }
  const byKey = new Map<string, AttachmentReference>();
  const unsupportedReferences: string[] = [];
  let totalReferences = 0;
  for await (const reference of references) {
    totalReferences += 1;
    if (totalReferences > limit * 100) {
      throw new Error('Attachment reconciliation reference snapshot exceeds the safe bound');
    }
    if (!isValidKey(reference.storageKey)) {
      unsupportedReferences.push(reference.storageKey);
      continue;
    }
    byKey.set(validateKey(reference.storageKey), reference);
    if (byKey.size > limit * 100) {
      throw new Error('Attachment reconciliation reference snapshot exceeds the safe bound');
    }
  }

  const missing: string[] = [];
  const corrupt: string[] = [];
  for (const reference of byKey.values()) {
    const content = await storage.get(reference.storageKey);
    if (!content) {
      missing.push(reference.storageKey);
      continue;
    }
    const actual = objectMetadata(reference.storageKey, content);
    if (
      (reference.sizeBytes !== undefined && actual.sizeBytes !== reference.sizeBytes) ||
      (reference.checksum && actual.checksum?.toLowerCase() !== reference.checksum.toLowerCase())
    ) {
      corrupt.push(reference.storageKey);
    }
  }

  const orphaned: string[] = [];
  const deleted: string[] = [];
  const failures: string[] = [];
  let scannedEntries = 0;
  let checked = 0;
  let truncated = false;
  for await (const object of storage.list()) {
    scannedEntries += 1;
    if (!object.lastModified || !Number.isFinite(object.lastModified.getTime())) continue;
    const modified = object.lastModified.getTime();
    if (modified > options.olderThan.getTime()) continue;
    if (byKey.has(object.key)) {
      checked += 1;
      continue;
    }
    if (orphaned.length === limit) {
      truncated = true;
      break;
    }
    checked += 1;
    orphaned.push(object.key);
    if (!options.apply) continue;
    try {
      await storage.delete(object.key);
      deleted.push(object.key);
    } catch {
      failures.push(object.key);
    }
  }
  return {
    checked,
    scannedEntries,
    scanTruncated: truncated,
    missing,
    corrupt,
    orphaned,
    deleted,
    failures,
    unsupportedReferences,
  };
}

export { S3AttachmentStorage, closeS3AttachmentStorage } from './s3.js';
export type { S3AttachmentStorageOptions } from './s3.js';
