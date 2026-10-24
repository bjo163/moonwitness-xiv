import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeJson, hashCanonicalJson, parseCanonicalJson } from '@moonwitness/knowledge';

export interface DatasetReleaseSnapshot {
  format: 'moonwitness-knowledge-snapshot/v1';
  canonicalization: 'RFC8785';
  hashAlgorithm: 'sha256';
  records: readonly string[];
  aliases: readonly string[];
  sourceArtifacts: readonly string[];
  provenance: string | null;
  sha256: string;
}

export interface DatasetReleaseInput {
  datasetId: string;
  version: string;
  createdAt: string;
  ontologyVersion: string;
  corpusVersion: string;
  snapshotPath: string;
  snapshot: DatasetReleaseSnapshot;
  sourceRecipe: {
    path: string;
    sha256: string;
  };
}

export interface DatasetReleaseManifest extends DatasetReleaseInput {
  format: 'moonwitness-dataset-release/v1';
  releaseId: string;
  previousReleaseId: string | null;
}

export interface ActiveDatasetRelease {
  format: 'moonwitness-active-dataset-release/v1';
  datasetId: string;
  releaseId: string;
  snapshotPath: string;
  activatedAt: string;
}

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const datasetIdPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/u;

function releasePayload(input: DatasetReleaseInput, previousReleaseId: string | null) {
  return {
    format: 'moonwitness-dataset-release/v1' as const,
    ...input,
    previousReleaseId,
  };
}

function releaseDigest(payload: ReturnType<typeof releasePayload>): string {
  return createHash('sha256').update(canonicalizeJson(payload), 'utf8').digest('hex');
}

function releasePath(root: string, datasetId: string, releaseId: string): string {
  return path.join(root, 'datasets', datasetId, 'releases', `${releaseId}.json`);
}

function activePath(root: string, datasetId: string): string {
  return path.join(root, 'datasets', datasetId, 'active.json');
}

function safeRelativePath(value: string): string | null {
  if (path.isAbsolute(value) || value.includes('\\') || value.includes('\0')) return null;
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join(path.sep);
}

function validateInput(input: DatasetReleaseInput): void {
  if (!datasetIdPattern.test(input.datasetId)) throw new TypeError('datasetId is invalid');
  if (!semverPattern.test(input.version))
    throw new TypeError('version must be semantic versioning');
  if (!semverPattern.test(input.ontologyVersion) || !semverPattern.test(input.corpusVersion)) {
    throw new TypeError('ontologyVersion and corpusVersion must be semantic versions');
  }
  if (!Number.isFinite(Date.parse(input.createdAt)))
    throw new TypeError('createdAt must be a date-time');
  if (
    input.snapshot.format !== 'moonwitness-knowledge-snapshot/v1' ||
    input.snapshot.canonicalization !== 'RFC8785' ||
    input.snapshot.hashAlgorithm !== 'sha256' ||
    !Array.isArray(input.snapshot.records) ||
    !Array.isArray(input.snapshot.aliases) ||
    !Array.isArray(input.snapshot.sourceArtifacts) ||
    !(input.snapshot.provenance === null || digestPattern.test(input.snapshot.provenance)) ||
    [...input.snapshot.records, ...input.snapshot.aliases, ...input.snapshot.sourceArtifacts].some(
      (digest) => !digestPattern.test(digest)
    ) ||
    !digestPattern.test(input.snapshot.sha256)
  ) {
    throw new TypeError('snapshot must be a valid canonical SHA-256 knowledge snapshot');
  }
  if (safeRelativePath(input.snapshotPath) === null) {
    throw new TypeError('snapshotPath must be a safe relative path');
  }
  if (
    safeRelativePath(input.sourceRecipe.path) === null ||
    !digestPattern.test(input.sourceRecipe.sha256)
  ) {
    throw new TypeError('sourceRecipe must pin a safe relative path and SHA-256 digest');
  }
}

async function resolveSnapshotDirectory(root: string, snapshotPath: string): Promise<string> {
  const relative = safeRelativePath(snapshotPath);
  if (relative === null) throw new TypeError('snapshotPath must be a safe relative path');
  const destination = path.resolve(root, relative);
  const fromRoot = path.relative(root, destination);
  if (fromRoot.startsWith(`..${path.sep}`) || fromRoot === '..' || path.isAbsolute(fromRoot)) {
    throw new TypeError('snapshotPath escapes the release store');
  }
  let current = root;
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new TypeError('release store root must be a real directory');
  }
  for (const segment of fromRoot.split(path.sep)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError('snapshotPath cannot traverse symbolic links');
    if (current !== destination && !info.isDirectory()) {
      throw new TypeError('snapshotPath parent must be a directory');
    }
  }
  const destinationInfo = await lstat(destination);
  if (!destinationInfo.isDirectory()) throw new TypeError('snapshotPath must be a directory');
  return destination;
}

async function verifyDigestDirectory(
  directory: string,
  expectedDigests: readonly string[],
  label: string
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const actualDigests: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
      throw new TypeError(`${label} contains an unexpected file or symbolic link`);
    }
    const filename = path.join(directory, entry.name);
    const info = await lstat(filename);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new TypeError(`${label} entries must be regular files`);
    }
    const value = parseCanonicalJson(await readFile(filename, 'utf8'));
    actualDigests.push(hashCanonicalJson(value));
  }
  actualDigests.sort();
  if (canonicalizeJson(actualDigests) !== canonicalizeJson([...expectedDigests].sort())) {
    throw new TypeError(`${label} contents do not match the release snapshot`);
  }
}

async function verifySnapshotDirectory(
  root: string,
  snapshotPath: string,
  expected: DatasetReleaseSnapshot
): Promise<void> {
  const directory = await resolveSnapshotDirectory(root, snapshotPath);
  const snapshot = parseCanonicalJson(
    await readFile(path.join(directory, 'snapshot.json'), 'utf8')
  );
  if (
    canonicalizeJson(snapshot) !== canonicalizeJson(expected) ||
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot)
  ) {
    throw new TypeError('snapshot manifest does not match the release declaration');
  }
  const snapshotRecord = snapshot as Record<string, unknown>;
  const { sha256, ...content } = snapshotRecord;
  if (typeof sha256 !== 'string' || hashCanonicalJson(content) !== sha256) {
    throw new TypeError('snapshot manifest digest is invalid');
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const allowed = new Set([
    'records',
    'aliases',
    'source-artifacts',
    'snapshot.json',
    'report.json',
    'provenance.json',
  ]);
  if (entries.some((entry) => !allowed.has(entry.name))) {
    throw new TypeError('snapshot directory contains an unexpected entry');
  }
  for (const [name, expectedDigests] of [
    ['records', expected.records],
    ['aliases', expected.aliases],
    ['source-artifacts', expected.sourceArtifacts],
  ] as const) {
    const collectionDirectory = path.join(directory, name);
    const info = await lstat(collectionDirectory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError(`${name} must be a real directory`);
    }
    await verifyDigestDirectory(collectionDirectory, expectedDigests, name);
  }
  const provenancePath = path.join(directory, 'provenance.json');
  try {
    const provenance = parseCanonicalJson(await readFile(provenancePath, 'utf8'));
    if (expected.provenance === null || hashCanonicalJson(provenance) !== expected.provenance) {
      throw new TypeError('provenance contents do not match the release snapshot');
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      if (expected.provenance !== null) {
        throw new TypeError('snapshot provenance file is missing', { cause: error });
      }
    } else {
      throw error;
    }
  }
}

async function assertDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new TypeError('release store paths cannot traverse symbolic links');
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      await mkdir(directory);
      return;
    }
    throw error;
  }
}

async function ensureDirectoryTree(root: string, segments: readonly string[]): Promise<void> {
  await mkdir(root, { recursive: true });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new TypeError('release store root must be a real directory');
  }
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    await assertDirectory(current);
  }
}

async function assertExistingPath(
  root: string,
  segments: readonly string[],
  finalKind: 'file' | 'directory'
): Promise<boolean> {
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new TypeError('release store root must be a real directory');
  }
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
    if (info.isSymbolicLink())
      throw new TypeError('release store paths cannot traverse symbolic links');
    const isFinal = index === segments.length - 1;
    if (isFinal ? finalKind === 'file' && !info.isFile() : !info.isDirectory()) {
      throw new TypeError(`release store path must resolve to a regular ${finalKind}`);
    }
    if (isFinal && finalKind === 'directory' && !info.isDirectory()) {
      throw new TypeError('release store path must resolve to a directory');
    }
  }
  return true;
}

async function writeAtomically(destination: string, contents: string): Promise<void> {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { flag: 'wx' });
  try {
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readActiveDatasetRelease(
  storeDirectory: string,
  datasetId: string
): Promise<ActiveDatasetRelease | null> {
  if (!datasetIdPattern.test(datasetId)) throw new TypeError('datasetId is invalid');
  const root = path.resolve(storeDirectory);
  if (!(await assertExistingPath(root, ['datasets', datasetId, 'active.json'], 'file')))
    return null;
  const pointer = JSON.parse(
    await readFile(activePath(root, datasetId), 'utf8')
  ) as ActiveDatasetRelease;
  if (
    pointer.format !== 'moonwitness-active-dataset-release/v1' ||
    pointer.datasetId !== datasetId ||
    !digestPattern.test(pointer.releaseId)
  ) {
    throw new TypeError('active release pointer is invalid');
  }
  return pointer;
}

/** Store an immutable, content-addressed release manifest without changing the active release. */
export async function createDatasetRelease(
  storeDirectory: string,
  input: DatasetReleaseInput
): Promise<DatasetReleaseManifest> {
  validateInput(input);
  const root = path.resolve(storeDirectory);
  if (
    !(await assertExistingPath(root, input.sourceRecipe.path.split('/'), 'file')) ||
    createHash('sha256')
      .update(await readFile(path.join(root, ...input.sourceRecipe.path.split('/'))))
      .digest('hex') !== input.sourceRecipe.sha256
  ) {
    throw new TypeError('source recipe is missing or does not match its pinned SHA-256 digest');
  }
  await verifySnapshotDirectory(root, input.snapshotPath, input.snapshot);
  const current = await readActiveDatasetRelease(root, input.datasetId);
  const payload = releasePayload(input, current?.releaseId ?? null);
  const releaseId = releaseDigest(payload);
  const manifest: DatasetReleaseManifest = { ...payload, releaseId };
  await ensureDirectoryTree(root, ['datasets', input.datasetId, 'releases']);
  const releaseDirectory = path.dirname(releasePath(root, input.datasetId, releaseId));
  for (const entry of await readdir(releaseDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new TypeError('release directory contains an unexpected entry');
    }
    const existing = JSON.parse(
      await readFile(path.join(releaseDirectory, entry.name), 'utf8')
    ) as DatasetReleaseManifest;
    if (existing.version === input.version && existing.releaseId !== releaseId) {
      throw new TypeError('dataset semantic versions are immutable and already assigned');
    }
  }
  try {
    await writeFile(
      releasePath(root, input.datasetId, releaseId),
      `${canonicalizeJson(manifest)}\n`,
      {
        flag: 'wx',
      }
    );
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    if (
      !(await assertExistingPath(
        root,
        ['datasets', input.datasetId, 'releases', `${releaseId}.json`],
        'file'
      ))
    ) {
      throw new TypeError('immutable release manifest disappeared during creation', {
        cause: error,
      });
    }
    const existing = JSON.parse(
      await readFile(releasePath(root, input.datasetId, releaseId), 'utf8')
    ) as DatasetReleaseManifest;
    if (canonicalizeJson(existing) !== canonicalizeJson(manifest)) {
      throw new TypeError('release digest collision or corrupted immutable release manifest', {
        cause: error,
      });
    }
  }
  return manifest;
}

/** Read and verify an immutable release manifest without requiring its snapshot to be present. */
export async function readDatasetRelease(
  storeDirectory: string,
  datasetId: string,
  releaseId: string
): Promise<DatasetReleaseManifest> {
  if (!datasetIdPattern.test(datasetId) || !digestPattern.test(releaseId)) {
    throw new TypeError('datasetId or releaseId is invalid');
  }
  const root = path.resolve(storeDirectory);
  const segments = ['datasets', datasetId, 'releases', `${releaseId}.json`];
  if (!(await assertExistingPath(root, segments, 'file'))) {
    throw new TypeError('release manifest does not exist');
  }
  const manifest = JSON.parse(
    await readFile(releasePath(root, datasetId, releaseId), 'utf8')
  ) as DatasetReleaseManifest;
  const { releaseId: declaredId, previousReleaseId, ...input } = manifest;
  validateInput(input);
  if (
    manifest.datasetId !== datasetId ||
    declaredId !== releaseId ||
    !(previousReleaseId === null || digestPattern.test(previousReleaseId)) ||
    releaseDigest(releasePayload(input, previousReleaseId)) !== releaseId
  ) {
    throw new TypeError('release manifest failed integrity validation');
  }
  return manifest;
}

/** Switch the active pointer only to an existing intact release; replacement is an atomic same-directory rename. */
export async function activateDatasetRelease(
  storeDirectory: string,
  datasetId: string,
  releaseId: string,
  activatedAt: string
): Promise<ActiveDatasetRelease> {
  if (!datasetIdPattern.test(datasetId) || !digestPattern.test(releaseId)) {
    throw new TypeError('datasetId or releaseId is invalid');
  }
  if (!Number.isFinite(Date.parse(activatedAt)))
    throw new TypeError('activatedAt must be a date-time');
  const root = path.resolve(storeDirectory);
  const manifest = await readDatasetRelease(root, datasetId, releaseId);
  await verifySnapshotDirectory(root, manifest.snapshotPath, manifest.snapshot);
  await ensureDirectoryTree(root, ['datasets', datasetId]);
  const pointer: ActiveDatasetRelease = {
    format: 'moonwitness-active-dataset-release/v1',
    datasetId,
    releaseId,
    snapshotPath: manifest.snapshotPath,
    activatedAt,
  };
  await writeAtomically(activePath(root, datasetId), `${canonicalizeJson(pointer)}\n`);
  return pointer;
}
