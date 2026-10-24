import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { putRawArtifact, readRawArtifact } from '../src/index.js';

const temporaryRoots: string[] = [];

async function storeDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-artifacts-'));
  temporaryRoots.push(root);
  return root;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('content-addressed raw artifact store', () => {
  it('stores exact binary bytes once and verifies them on read', async () => {
    const root = await storeDirectory();
    const bytes = Buffer.from([0, 1, 127, 128, 255]);
    const digest = sha256(bytes);
    const [first, second] = await Promise.all([
      putRawArtifact({ storeDirectory: root, sha256: digest, bytes }),
      putRawArtifact({ storeDirectory: root, sha256: digest, bytes }),
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.relativePath).toBe(`sha256/${digest.slice(0, 2)}/${digest}`);
    await expect(readRawArtifact({ storeDirectory: root, sha256: digest })).resolves.toEqual(bytes);
    const prefix = path.join(root, 'sha256', digest.slice(0, 2));
    expect((await readdir(prefix)).filter((name) => name === digest)).toHaveLength(1);
    expect((await readdir(prefix)).filter((name) => name.startsWith('.staging-'))).toHaveLength(0);
  });

  it('rejects bytes whose digest differs from the requested address', async () => {
    const root = await storeDirectory();
    const bytes = Buffer.from('pinned bytes');
    await expect(
      putRawArtifact({ storeDirectory: root, sha256: '0'.repeat(64), bytes })
    ).rejects.toThrow('checksum mismatch');
    await expect(readdir(path.join(root, 'sha256'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects corruption and never replaces an existing blob', async () => {
    const root = await storeDirectory();
    const bytes = Buffer.from('original bytes');
    const digest = sha256(bytes);
    const receipt = await putRawArtifact({ storeDirectory: root, sha256: digest, bytes });
    const filePath = path.join(root, receipt.relativePath);
    await writeFile(filePath, Buffer.from('corrupted bytes'));
    await expect(readRawArtifact({ storeDirectory: root, sha256: digest })).rejects.toThrow(
      'Stored artifact is corrupt'
    );
    await expect(putRawArtifact({ storeDirectory: root, sha256: digest, bytes })).rejects.toThrow(
      'Stored artifact is corrupt'
    );
    await expect(readFile(filePath)).resolves.toEqual(Buffer.from('corrupted bytes'));
  });

  it('rejects malformed digests before deriving filesystem paths', async () => {
    const root = await storeDirectory();
    await expect(readRawArtifact({ storeDirectory: root, sha256: '../outside' })).rejects.toThrow(
      'lowercase SHA-256'
    );
    await expect(readdir(root)).resolves.toEqual([]);
  });
});
