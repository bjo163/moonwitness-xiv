import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeJson } from '@moonwitness/knowledge';
import privateArchiveImportManifestSchema from '../schemas/private-archive-import-manifest.schema.json' with { type: 'json' };
import {
  createJsonSchemaValidator,
  type KnowledgeValidationIssue,
  type KnowledgeValidationResult,
} from '@moonwitness/knowledge';

export type PrivateArchiveSourceKind = 'account_export' | 'user_archive' | 'witness_archive';

export interface PrivateArchiveImportConsent {
  state: 'granted' | 'denied' | 'withdrawn';
  sourceKind: PrivateArchiveSourceKind;
  sourcePath: string;
  sourceSha256: string;
  subjectRef: string;
  authorizedByRef: string;
  authorizedAt: string;
  dataCategories: string[];
  purposes: string[];
  authorizedReviewers: string[];
  intendedDerivedUses: string[];
  publicationScope: 'none' | 'internal_only' | 'reviewed_projection';
  withdrawalPath: string;
  correctionPath: string;
  decisionRef: string;
}

export interface PrivateArchiveImportManifest {
  format: 'moonwitness-private-archive-import/v1';
  manifestId: string;
  recordedAt: string;
  source: {
    kind: PrivateArchiveSourceKind;
    path: string;
    exportedAt: string;
    sha256: string;
    byteLength: number;
  };
  consent: PrivateArchiveImportConsent;
}

export interface PrivateArchiveImportRequest {
  rootDirectory: string;
  workspaceRoot: string;
  sourcePath: string;
  manifestPath: string;
  manifestId: string;
  sourceKind: PrivateArchiveSourceKind;
  exportedAt: string;
  recordedAt: string;
  consent: PrivateArchiveImportConsent;
}

export interface ImportPrivateArchiveRequest extends PrivateArchiveImportRequest {
  sourceRootDirectory: string;
}

export { privateArchiveImportManifestSchema };

const validateSchema = createJsonSchemaValidator(
  privateArchiveImportManifestSchema,
  'does not match the private archive import manifest contract'
);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function semanticIssues(value: unknown): KnowledgeValidationIssue[] {
  if (!isObject(value) || !isObject(value.source) || !isObject(value.consent)) return [];
  const issues: KnowledgeValidationIssue[] = [];
  if (value.source.kind !== value.consent.sourceKind) {
    issues.push({
      path: '/consent/sourceKind',
      keyword: 'const',
      message: 'must match the exact source kind',
    });
  }
  if (value.source.path !== value.consent.sourcePath) {
    issues.push({
      path: '/consent/sourcePath',
      keyword: 'const',
      message: 'must match the exact local source path',
    });
  }
  if (value.source.sha256 !== value.consent.sourceSha256) {
    issues.push({
      path: '/consent/sourceSha256',
      keyword: 'const',
      message: 'must match the exact source checksum',
    });
  }
  return issues;
}

/** Validate manifest structure and source binding only; it does not verify the truth or legal sufficiency of consent. */
export function validatePrivateArchiveImportManifest(value: unknown): KnowledgeValidationResult {
  const structural = validateSchema(value);
  const issues = [...(structural.valid ? [] : structural.issues), ...semanticIssues(value)];
  return issues.length === 0 ? { valid: true, issues: [] } : { valid: false, issues };
}

function safeRelativePath(value: string, label: string): string {
  if (
    path.isAbsolute(value) ||
    /^[a-zA-Z]:/u.test(value) ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new TypeError(`${label} must be a safe relative POSIX path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError(`${label} must not contain empty, dot, or parent segments`);
  }
  return segments.join(path.sep);
}

async function resolveRegularFile(
  root: string,
  relativePath: string,
  label: string
): Promise<string> {
  const safePath = safeRelativePath(relativePath, label);
  const absolutePath = path.resolve(root, safePath);
  const fromRoot = path.relative(root, absolutePath);
  if (fromRoot.startsWith(`..${path.sep}`) || fromRoot === '..' || path.isAbsolute(fromRoot)) {
    throw new TypeError(`${label} escapes the local workspace`);
  }

  let current = root;
  for (const segment of fromRoot.split(path.sep)) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) throw new TypeError(`${label} cannot traverse symbolic links`);
  }
  const details = await lstat(absolutePath);
  if (!details.isFile()) throw new TypeError(`${label} must reference a regular file`);
  return absolutePath;
}

async function ensureSafeDirectoryAncestry(directory: string, label: string): Promise<void> {
  if (process.platform === 'win32') return;
  const filesystemRoot = path.parse(directory).root;
  let current = directory;
  while (true) {
    const details = await lstat(current);
    const permissions = details.mode & 0o7777;
    const hasUnsafeSharedWrite = (permissions & 0o022) !== 0 && (permissions & 0o1000) === 0;
    if (details.isSymbolicLink() || !details.isDirectory() || hasUnsafeSharedWrite) {
      throw new TypeError(`${label} has an unsafe writable directory ancestor`);
    }
    if (current === filesystemRoot) break;
    current = path.dirname(current);
  }
}

async function resolveExternalDirectory(
  workspacePath: string,
  directoryPath: string,
  label: string
): Promise<string> {
  const candidate = path.resolve(directoryPath);
  const details = await lstat(candidate);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new TypeError(`${label} must be a real local directory`);
  }
  const [directory, workspace] = await Promise.all([realpath(candidate), realpath(workspacePath)]);
  const relative = path.relative(workspace, directory);
  if (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  ) {
    throw new TypeError(`${label} must be outside the workspace`);
  }
  if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
    throw new TypeError(`${label} must be private to the current user`);
  }
  await ensureSafeDirectoryAncestry(directory, label);
  return directory;
}

async function ensureSafeOutputParent(
  root: string,
  destination: string,
  label = 'manifestPath'
): Promise<void> {
  const relativeParent = path.relative(root, path.dirname(destination));
  let current = root;
  for (const segment of relativeParent === '' ? [] : relativeParent.split(path.sep)) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
    const details = await lstat(current);
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      (process.platform !== 'win32' && (details.mode & 0o077) !== 0)
    ) {
      throw new TypeError(`${label} parent directories must be real private directories`);
    }
  }
}

async function createTemporaryFile(
  destination: string,
  writeContents: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>
): Promise<{ path: string; device: number; inode: number }> {
  const temporaryPath = path.join(
    path.dirname(destination),
    `.mw-private-intake-${randomUUID()}.partial`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await writeContents(handle);
    await handle.sync();
    const details = await handle.stat();
    await handle.close();
    handle = undefined;
    return { path: temporaryPath, device: details.dev, inode: details.ino };
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removePublishedFileIfOwned(
  temporaryPath: string,
  destination: string,
  device: number,
  inode: number
): Promise<void> {
  try {
    const details = await lstat(destination);
    if (
      details.isFile() &&
      details.dev === device &&
      details.ino === inode &&
      details.dev !== 0 &&
      details.ino !== 0
    ) {
      await rm(destination);
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function writePrivateFileNoReplace(destination: string, contents: string): Promise<void> {
  const temporary = await createTemporaryFile(destination, async (handle) => {
    await handle.writeFile(contents, 'utf8');
  });
  let published = false;
  try {
    await link(temporary.path, destination);
    published = true;
    await rm(temporary.path, { force: true });
  } catch (error) {
    if (published) {
      await removePublishedFileIfOwned(
        temporary.path,
        destination,
        temporary.device,
        temporary.inode
      );
    } else {
      await rm(temporary.path, { force: true });
    }
    throw error;
  }
}

async function hashFile(filePath: string): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    byteLength += bytes.byteLength;
  }
  if (byteLength === 0) throw new TypeError('source archive must not be empty');
  return { sha256: hash.digest('hex'), byteLength };
}

/**
 * Record an operator-supplied, source-scoped consent decision for a local archive.
 * This writes metadata only; it never copies or parses the archive contents.
 */
export async function createPrivateArchiveImportManifest(
  request: PrivateArchiveImportRequest
): Promise<PrivateArchiveImportManifest> {
  if (!request.consent || request.consent.state !== 'granted') {
    throw new TypeError('A granted, source-scoped consent decision is required');
  }
  const root = await resolveExternalDirectory(
    request.workspaceRoot,
    request.rootDirectory,
    'rootDirectory'
  );

  const sourceRelativePath = safeRelativePath(request.sourcePath, 'sourcePath');
  const manifestRelativePath = safeRelativePath(request.manifestPath, 'manifestPath');
  if (path.resolve(root, sourceRelativePath) === path.resolve(root, manifestRelativePath)) {
    throw new TypeError('manifestPath must not overwrite the source');
  }
  if (
    request.consent.sourcePath !== request.sourcePath ||
    request.consent.sourceKind !== request.sourceKind
  ) {
    throw new TypeError('Consent must be scoped to the exact local source path and kind');
  }

  const sourceFile = await resolveRegularFile(root, request.sourcePath, 'sourcePath');
  const source = await hashFile(sourceFile);
  if (source.sha256 !== request.consent.sourceSha256) {
    throw new TypeError('Consent source checksum does not match the supplied archive');
  }

  const manifest: PrivateArchiveImportManifest = {
    format: 'moonwitness-private-archive-import/v1',
    manifestId: request.manifestId,
    recordedAt: request.recordedAt,
    source: {
      kind: request.sourceKind,
      path: request.sourcePath,
      exportedAt: request.exportedAt,
      sha256: source.sha256,
      byteLength: source.byteLength,
    },
    consent: request.consent,
  };
  const validation = validatePrivateArchiveImportManifest(manifest);
  if (!validation.valid) {
    throw new TypeError(
      `Private archive manifest is invalid: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`
    );
  }

  const destination = path.resolve(root, manifestRelativePath);
  await ensureSafeOutputParent(root, destination);
  await writePrivateFileNoReplace(destination, `${canonicalizeJson(manifest)}\n`);
  return manifest;
}

/** Copy an approved local archive into external storage and bind its manifest to the copied bytes. */
export async function importPrivateArchive(
  request: ImportPrivateArchiveRequest
): Promise<PrivateArchiveImportManifest> {
  if (!request.consent || request.consent.state !== 'granted') {
    throw new TypeError('A granted, source-scoped consent decision is required');
  }
  if (
    request.consent.sourcePath !== request.sourcePath ||
    request.consent.sourceKind !== request.sourceKind
  ) {
    throw new TypeError('Consent must be scoped to the exact local source path and kind');
  }

  const [sourceRoot, destinationRoot] = await Promise.all([
    resolveExternalDirectory(
      request.workspaceRoot,
      request.sourceRootDirectory,
      'sourceRootDirectory'
    ),
    resolveExternalDirectory(request.workspaceRoot, request.rootDirectory, 'rootDirectory'),
  ]);
  if (sourceRoot === destinationRoot) {
    throw new TypeError('sourceRootDirectory and rootDirectory must be different directories');
  }
  const sourceFile = await resolveRegularFile(sourceRoot, request.sourcePath, 'sourcePath');
  const source = await hashFile(sourceFile);
  if (source.sha256 !== request.consent.sourceSha256) {
    throw new TypeError('Consent source checksum does not match the supplied archive');
  }

  const destination = path.resolve(
    destinationRoot,
    safeRelativePath(request.sourcePath, 'sourcePath')
  );
  await ensureSafeOutputParent(destinationRoot, destination, 'sourcePath');
  let temporaryFile: { path: string; device: number; inode: number } | undefined;
  let published = false;
  try {
    temporaryFile = await createTemporaryFile(destination, async (handle) => {
      for await (const chunk of createReadStream(sourceFile)) {
        await handle.writeFile(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    });
    const imported = await hashFile(temporaryFile.path);
    if (imported.sha256 !== source.sha256 || imported.byteLength !== source.byteLength) {
      throw new TypeError('Imported archive checksum does not match the supplied source');
    }
    await link(temporaryFile.path, destination);
    published = true;
    await rm(temporaryFile.path, { force: true });
    const manifest = await createPrivateArchiveImportManifest(request);
    return manifest;
  } catch (error) {
    if (published && temporaryFile) {
      await removePublishedFileIfOwned(
        temporaryFile.path,
        destination,
        temporaryFile.device,
        temporaryFile.inode
      );
    } else if (temporaryFile) {
      await rm(temporaryFile.path, { force: true });
    }
    throw error;
  }
}
