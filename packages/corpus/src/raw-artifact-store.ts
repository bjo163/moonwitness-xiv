import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface PutRawArtifactRequest {
  storeDirectory: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface RawArtifactReceipt {
  sha256: string;
  bytes: number;
  relativePath: string;
  created: boolean;
}

export interface ReadRawArtifactRequest {
  storeDirectory: string;
  sha256: string;
}

function validateSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value))
    throw new TypeError('sha256 must be a lowercase SHA-256 digest');
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function assertStoreDirectory(directory: string): Promise<string> {
  const root = path.resolve(directory);
  const details = await lstat(root);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new TypeError('storeDirectory must be an existing real directory');
  }
  return root;
}

async function ensureDirectory(parent: string, name: string): Promise<string> {
  const directory = path.join(parent, name);
  try {
    await mkdir(directory);
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
  }
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new TypeError('Artifact store path contains a non-directory or symbolic link');
  }
  return directory;
}

async function requireDirectory(parent: string, name: string): Promise<string> {
  const directory = path.join(parent, name);
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new TypeError('Artifact store path contains a non-directory or symbolic link');
  }
  return directory;
}

async function readVerifiedFile(filePath: string, expectedSha256: string): Promise<Buffer> {
  const details = await lstat(filePath);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new TypeError('Artifact path must be a regular file');
  }
  const bytes = await readFile(filePath);
  const actualSha256 = digest(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new TypeError(
      `Stored artifact is corrupt: expected ${expectedSha256}, got ${actualSha256}`
    );
  }
  return bytes;
}

export async function putRawArtifact(request: PutRawArtifactRequest): Promise<RawArtifactReceipt> {
  validateSha256(request.sha256);
  const bytes = Buffer.from(request.bytes);
  const actualSha256 = digest(bytes);
  if (actualSha256 !== request.sha256) {
    throw new TypeError(
      `Artifact checksum mismatch: expected ${request.sha256}, got ${actualSha256}`
    );
  }

  const root = await assertStoreDirectory(request.storeDirectory);
  const hashDirectory = await ensureDirectory(root, 'sha256');
  const prefixDirectory = await ensureDirectory(hashDirectory, request.sha256.slice(0, 2));
  const relativePath = `sha256/${request.sha256.slice(0, 2)}/${request.sha256}`;
  const destination = path.join(prefixDirectory, request.sha256);
  try {
    const existing = await readVerifiedFile(destination, request.sha256);
    if (!existing.equals(bytes))
      throw new TypeError('SHA-256 collision detected; artifact was not replaced');
    return { sha256: request.sha256, bytes: bytes.byteLength, relativePath, created: false };
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }

  const stagingDirectory = await mkdtemp(path.join(prefixDirectory, '.staging-'));
  const stagingFile = path.join(stagingDirectory, 'blob');
  try {
    await writeFile(stagingFile, bytes, { flag: 'wx' });
    try {
      await link(stagingFile, destination);
      return { sha256: request.sha256, bytes: bytes.byteLength, relativePath, created: true };
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
      const existing = await readVerifiedFile(destination, request.sha256);
      if (!existing.equals(bytes)) {
        throw new TypeError('SHA-256 collision detected; artifact was not replaced', {
          cause: error,
        });
      }
      return { sha256: request.sha256, bytes: bytes.byteLength, relativePath, created: false };
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function readRawArtifact(request: ReadRawArtifactRequest): Promise<Buffer> {
  validateSha256(request.sha256);
  const root = await assertStoreDirectory(request.storeDirectory);
  const filePath = path.resolve(root, 'sha256', request.sha256.slice(0, 2), request.sha256);
  const relativeFilePath = path.relative(root, filePath);
  if (relativeFilePath.startsWith(`..${path.sep}`) || relativeFilePath === '..') {
    throw new TypeError('Artifact path escapes storeDirectory');
  }
  const hashDirectory = await requireDirectory(root, 'sha256');
  const prefixDirectory = await requireDirectory(hashDirectory, request.sha256.slice(0, 2));
  return readVerifiedFile(path.join(prefixDirectory, request.sha256), request.sha256);
}
