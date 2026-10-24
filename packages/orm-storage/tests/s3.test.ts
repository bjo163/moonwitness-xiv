import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { MAX_ATTACHMENT_BYTES } from '@moonwitness/types';
import { closeS3AttachmentStorage, S3AttachmentStorage } from '../src/index.js';

const keyA = '11111111-1111-4111-8111-111111111111';
const keyB = '22222222-2222-4222-8222-222222222222';

function provider(send: (command: unknown) => Promise<unknown>) {
  const sendMock = vi.fn(send);
  const client = {
    send: sendMock,
    destroy: vi.fn(),
    config: {
      endpoint: async () => ({ protocol: 'http:', hostname: 's3-backend.test', port: 9000 }),
      forcePathStyle: true,
      requestHandler: {},
    },
  } as unknown as S3Client;
  return {
    storage: new S3AttachmentStorage({
      endpoint: 'http://s3-backend.test:9000',
      bucket: 'private-attachments',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      client,
    }),
    sendMock,
  };
}

describe('S3AttachmentStorage', () => {
  it('creates short-lived presigned POST policies bound to key, media type, and size', async () => {
    const storage = new S3AttachmentStorage({
      endpoint: 'https://s3.example.test',
      region: 'garage',
      bucket: 'private-attachments',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      forcePathStyle: true,
    });
    try {
      const upload = await storage.createPresignedUpload(keyA, 'image/png', 1024, 300);
      const url = new URL(upload.url);
      const policy = JSON.parse(Buffer.from(upload.fields.Policy, 'base64').toString('utf8')) as {
        conditions: unknown[];
      };
      expect(upload).toMatchObject({
        method: 'POST',
        minSizeBytes: 1,
        maxSizeBytes: 1024,
        expiresInSeconds: 300,
      });
      expect(url.pathname).toBe('/private-attachments');
      expect(upload.fields['Content-Type']).toBe('image/png');
      expect(upload.fields.key).toBe(keyA);
      expect(upload.fields['X-Amz-Signature']).toMatch(/^[a-f0-9]{64}$/u);
      expect(policy.conditions).toContainEqual(['content-length-range', 1, 1024]);
      expect(policy.conditions).toContainEqual(['eq', '$Content-Type', 'image/png']);
      expect(policy.conditions).toContainEqual(['eq', '$key', keyA]);
      await expect(storage.createPresignedUpload('../unsafe', 'image/png')).rejects.toThrow(
        'Invalid attachment storage key'
      );
      await expect(storage.createPresignedUpload(keyA, 'image/png', 1024, 10)).rejects.toThrow(
        'between 30 and 900 seconds'
      );
      await expect(storage.createPresignedUpload(keyA, 'image/png', MAX_ATTACHMENT_BYTES + 1)).rejects.toThrow(
        'configured storage size limit'
      );
    } finally {
      await closeS3AttachmentStorage(storage);
    }
  });

  it('reads uploaded object metadata without downloading the body', async () => {
    const { storage, sendMock } = provider(async (command) => {
      if (command instanceof HeadObjectCommand)
        return { ContentLength: 68, ContentType: 'image/png', Metadata: { sha256: 'a'.repeat(64) } };
      throw new Error('Unexpected S3 command');
    });
    await expect(storage.head(keyA)).resolves.toEqual({
      sizeBytes: 68,
      contentType: 'image/png',
      checksum: 'a'.repeat(64),
    });
    expect(sendMock.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    await expect(storage.head('../unsafe')).rejects.toThrow('Invalid attachment storage key');
  });

  it.skipIf(process.env.ATTACHMENT_S3_ACCEPTANCE !== '1')(
    'restores an attachment object from a backup copy in the configured S3 bucket',
    async () => {
      const storage = new S3AttachmentStorage({
        endpoint: process.env.ATTACHMENT_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
        region: process.env.ATTACHMENT_S3_REGION ?? 'us-east-1',
        bucket: process.env.ATTACHMENT_S3_BUCKET ?? 'moonwitness-attachments',
        accessKeyId: process.env.ATTACHMENT_S3_ACCESS_KEY ?? '',
        secretAccessKey: process.env.ATTACHMENT_S3_SECRET_KEY ?? '',
        forcePathStyle: process.env.ATTACHMENT_S3_FORCE_PATH_STYLE !== 'false',
      });
      const key = randomUUID();
      const backupKey = randomUUID();
      const bytes = Buffer.from(`S3 backup restore acceptance ${randomUUID()}`);
      try {
        await storage.checkReady();
        await storage.put(key, bytes);
        await storage.put(backupKey, bytes);

        await storage.delete(key);
        await expect(storage.get(key)).resolves.toBeNull();
        const backedUpBytes = await storage.get(backupKey);
        expect(backedUpBytes).toEqual(bytes);
        await storage.put(key, backedUpBytes!);
        await expect(storage.get(key)).resolves.toEqual(bytes);
      } finally {
        await storage.delete(key).catch(() => undefined);
        await storage.delete(backupKey).catch(() => undefined);
        await closeS3AttachmentStorage(storage);
      }
    },
    30_000
  );

  it('writes a validated key and server-computed SHA-256 metadata', async () => {
    const { storage, sendMock } = provider(async () => ({}));
    const bytes = Buffer.from('S3-compatible bytes');
    const result = await storage.put(keyA, bytes);
    expect(result).toMatchObject({ key: keyA, sizeBytes: bytes.length });
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/u);
    const command = sendMock.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command).toMatchObject({
      input: { Bucket: 'private-attachments', Key: keyA, Metadata: { sha256: result.checksum } },
    });
    await expect(storage.put('../unsafe', bytes)).rejects.toThrow('Invalid attachment storage key');
  });

  it('uploads a bounded stream and computes its checksum', async () => {
    const { storage, sendMock } = provider(async () => ({}));
    const bytes = Buffer.from('streamed S3 object');
    const result = await storage.putStream(keyA, Readable.from([bytes]), 128);
    expect(result).toMatchObject({ key: keyA, sizeBytes: bytes.length });
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(sendMock).toHaveBeenCalled();
  });

  it('aborts streamed uploads that exceed the configured byte limit', async () => {
    const { storage, sendMock } = provider(async () => ({}));
    await expect(storage.putStream(keyA, Readable.from([Buffer.alloc(5)]), 4)).rejects.toThrow(
      /size limit/u
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('enforces the shared 10 MiB limit for provider writes', async () => {
    const { storage, sendMock } = provider(async () => ({}));
    await expect(storage.put(keyA, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).rejects.toThrow(
      /size limit/u
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns object bytes and maps only a missing key to null', async () => {
    const bytes = Buffer.from('download bytes');
    const { storage } = provider(async (command) => {
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
      }
      return {};
    });
    await expect(storage.get(keyA)).resolves.toEqual(bytes);

    const missing = provider(async () => {
      throw Object.assign(new Error('missing'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
    }).storage;
    await expect(missing.get(keyA)).resolves.toBeNull();
    const missingBucket = provider(async () => {
      throw Object.assign(new Error('bucket missing'), {
        name: 'NoSuchBucket',
        $metadata: { httpStatusCode: 404 },
      });
    }).storage;
    await expect(missingBucket.get(keyA)).rejects.toThrow('bucket missing');
    await expect(missing.get('../unsafe')).rejects.toThrow('Invalid attachment storage key');
  });

  it('returns a readable object stream without collecting its bytes', async () => {
    const bytes = Buffer.from('streamed object data');
    const { storage } = provider(async (command) =>
      command instanceof GetObjectCommand ? { Body: Readable.from([bytes]) } : {}
    );
    const stream = await storage.getStream(keyA);
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
  });

  it('deletes idempotently and paginates object listings without trusting ETags as hashes', async () => {
    let page = 0;
    const { storage, sendMock } = provider(async (command) => {
      if (command instanceof ListObjectsV2Command) {
        page += 1;
        return page === 1
          ? {
              Contents: [{ Key: keyA, Size: 7, LastModified: new Date(0), ETag: '"not-a-sha"' }],
              IsTruncated: true,
              NextContinuationToken: 'page-2',
            }
          : {
              Contents: [
                { Key: keyB, Size: 9, LastModified: new Date(0), ETag: '"also-not-a-sha"' },
              ],
              IsTruncated: false,
            };
      }
      return {};
    });
    const objects = [];
    for await (const object of storage.list()) objects.push(object);
    expect(objects.map(({ key }) => key)).toEqual([keyA, keyB]);
    expect(objects[0]).not.toHaveProperty('checksum');
    expect(
      sendMock.mock.calls.find(
        ([command]) =>
          command instanceof ListObjectsV2Command &&
          (command as ListObjectsV2Command).input.ContinuationToken === 'page-2'
      )?.[0]
    ).toMatchObject({
      input: { ContinuationToken: 'page-2' },
    });
    await storage.delete(keyA);
    expect(sendMock.mock.calls.at(-1)?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it('rejects invalid endpoints, embedded endpoint credentials, and empty bucket names', () => {
    const common = { bucket: 'bucket', accessKeyId: 'a', secretAccessKey: 'b' };
    expect(() => new S3AttachmentStorage({ ...common, endpoint: 'ftp://s3-backend.test' })).toThrow(
      /http or https/u
    );
    expect(
      () => new S3AttachmentStorage({ ...common, endpoint: 'http://user:pass@s3-backend.test' })
    ).toThrow();
    expect(
      () => new S3AttachmentStorage({ ...common, endpoint: 'http://s3-backend.test', bucket: '  ' })
    ).toThrow(/S3 bucket/u);
  });
});
