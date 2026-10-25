import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createHash } from 'node:crypto';
import { Readable, Transform, type Readable as NodeReadable } from 'node:stream';
import { Upload } from '@aws-sdk/lib-storage';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { MAX_ATTACHMENT_BYTES } from '@moonwitness/types';
import type { AttachmentStorage, StoredObjectMetadata } from './index.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface S3AttachmentStorageOptions {
  readonly endpoint: string;
  readonly region?: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle?: boolean;
  readonly maxAttempts?: number;
  readonly connectionTimeoutMs?: number;
  readonly socketTimeoutMs?: number;
  readonly maxObjectBytes?: number;
  /** Client override for isolated tests; production callers should leave this unset. */
  readonly client?: S3Client;
}

export interface PresignedAttachmentUpload {
  readonly url: string;
  readonly method: 'POST';
  readonly fields: Readonly<Record<string, string>>;
  readonly minSizeBytes: 1;
  readonly maxSizeBytes: number;
  readonly expiresInSeconds: number;
}

export interface S3AttachmentObjectMetadata {
  readonly sizeBytes: number;
  readonly contentType: string | null;
  readonly checksum: string | null;
}

function validateKey(key: string): string {
  if (!UUID_PATTERN.test(key)) throw new Error('Invalid attachment storage key');
  return key.toLowerCase();
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (candidate.name === 'NoSuchBucket') return false;
  return (
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function digest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Private S3-compatible object storage provider for Garage and other S3-compatible services. */
export class S3AttachmentStorage implements AttachmentStorage {
  readonly client: S3Client;
  readonly bucket: string;
  readonly maxObjectBytes: number;

  constructor(options: S3AttachmentStorageOptions) {
    const endpoint = new URL(options.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol)) {
      throw new Error('S3 endpoint must use http or https');
    }
    if (endpoint.username || endpoint.password) {
      throw new Error('S3 endpoint must not contain embedded credentials');
    }
    if (!options.bucket.trim()) throw new Error('S3 bucket must not be empty');
    if (!options.accessKeyId || !options.secretAccessKey) {
      throw new Error('S3 credentials must be configured');
    }
    const maxObjectBytes = options.maxObjectBytes ?? MAX_ATTACHMENT_BYTES;
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) {
      throw new Error('maxObjectBytes must be a positive safe integer');
    }
    const config: S3ClientConfig = {
      endpoint: endpoint.toString().replace(/\/$/u, ''),
      region: options.region ?? 'us-east-1',
      forcePathStyle: options.forcePathStyle ?? true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: options.connectionTimeoutMs ?? 3_000,
        socketTimeout: options.socketTimeoutMs ?? 15_000,
      }),
    };
    this.client = options.client ?? new S3Client(config);
    this.bucket = options.bucket;
    this.maxObjectBytes = maxObjectBytes;
  }

  async checkReady(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async createPresignedUpload(
    key: string,
    contentType: string,
    maxSizeBytes = this.maxObjectBytes,
    expiresInSeconds = 300
  ): Promise<PresignedAttachmentUpload> {
    const safeKey = validateKey(key);
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(contentType)) {
      throw new Error('Invalid attachment content type');
    }
    if (
      !Number.isSafeInteger(maxSizeBytes) ||
      maxSizeBytes < 1 ||
      maxSizeBytes > this.maxObjectBytes
    ) {
      throw new Error('Presigned upload size exceeds the configured storage size limit');
    }
    if (
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 30 ||
      expiresInSeconds > 900
    ) {
      throw new Error('Presigned upload expiry must be between 30 and 900 seconds');
    }
    const post = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: safeKey,
      Expires: expiresInSeconds,
      Fields: { 'Content-Type': contentType },
      Conditions: [
        ['eq', '$key', safeKey],
        ['eq', '$Content-Type', contentType],
        ['content-length-range', 1, maxSizeBytes],
      ],
    });
    return {
      url: post.url,
      method: 'POST',
      fields: post.fields,
      minSizeBytes: 1,
      maxSizeBytes,
      expiresInSeconds,
    };
  }

  async head(key: string): Promise<S3AttachmentObjectMetadata | null> {
    const safeKey = validateKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: safeKey })
      );
      return {
        sizeBytes: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
        checksum: result.Metadata?.sha256 ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async put(key: string, content: Uint8Array): Promise<StoredObjectMetadata> {
    const safeKey = validateKey(key);
    if (content.byteLength > this.maxObjectBytes) {
      throw new Error('Attachment exceeds the configured storage size limit');
    }
    const checksum = digest(content);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: safeKey,
        Body: content,
        ContentLength: content.byteLength,
        Metadata: { sha256: checksum },
      })
    );
    return { key: safeKey, sizeBytes: content.byteLength, checksum };
  }

  async putStream(
    key: string,
    content: NodeReadable,
    maxBytes = this.maxObjectBytes
  ): Promise<StoredObjectMetadata> {
    const safeKey = validateKey(key);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error('maxBytes must be a positive safe integer');
    const limit = Math.min(maxBytes, this.maxObjectBytes);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer | Uint8Array, _encoding, callback) {
        const bytes = Buffer.from(chunk);
        sizeBytes += bytes.byteLength;
        if (sizeBytes > limit) {
          callback(new Error('Attachment exceeds the configured storage size limit'));
          return;
        }
        hash.update(bytes);
        callback(null, bytes);
      },
    });
    try {
      const upload = new Upload({
        client: this.client,
        params: { Bucket: this.bucket, Key: safeKey, Body: content.pipe(meter) },
        queueSize: 1,
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false,
      });
      await upload.done();
    } catch (error) {
      content.destroy(error instanceof Error ? error : undefined);
      throw error;
    }
    return { key: safeKey, sizeBytes, checksum: hash.digest('hex') };
  }

  async get(key: string): Promise<Buffer | null> {
    const safeKey = validateKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: safeKey })
      );
      if (!result.Body) return null;
      const bytes = await result.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getStream(key: string): Promise<Readable | null> {
    const safeKey = validateKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: safeKey })
      );
      if (!result.Body) return null;
      return Readable.from(result.Body as AsyncIterable<Uint8Array>);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getWithMetadata(key: string): Promise<StoredObjectMetadata | null> {
    const content = await this.get(key);
    return content
      ? { key: validateKey(key), sizeBytes: content.byteLength, checksum: digest(content) }
      : null;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: validateKey(key) }));
  }

  async *list(): AsyncIterable<StoredObjectMetadata> {
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: continuationToken })
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key || !UUID_PATTERN.test(object.Key)) continue;
        const key = validateKey(object.Key);
        yield {
          key,
          sizeBytes: object.Size ?? 0,
          ...(object.LastModified ? { lastModified: object.LastModified } : {}),
        };
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}

export async function closeS3AttachmentStorage(storage: S3AttachmentStorage): Promise<void> {
  storage.client.destroy();
}
