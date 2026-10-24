import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalizeJson,
  createKnowledgeSnapshot,
  parseCanonicalJson,
  validateKnowledgeRecord,
} from '@moonwitness/knowledge';
import {
  activateDatasetRelease,
  createDatasetRelease,
  readDatasetRelease,
} from './dataset-release.js';
import type { ActiveDatasetRelease } from './dataset-release.js';
import type { DatasetReleaseSnapshot } from './dataset-release.js';
import type { IngestionRecipe, IngestionReport, IngestionRequest } from './types.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecipe(value: unknown): IngestionRecipe {
  if (!isObject(value)) throw new TypeError('Recipe must be a JSON object');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'format,parser,recipeId,source') {
    throw new TypeError('Recipe must contain only format, recipeId, source, and parser');
  }
  if (value.format !== 'moonwitness-ingestion-recipe/v1') {
    throw new TypeError('Unsupported ingestion recipe format');
  }
  if (value.parser !== 'json-record-array/v1') throw new TypeError('Unsupported parser');
  if (typeof value.recipeId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(value.recipeId)) {
    throw new TypeError('recipeId must be a stable lowercase identifier');
  }
  if (!isObject(value.source) || Object.keys(value.source).sort().join(',') !== 'path,sha256') {
    throw new TypeError('source must contain only path and sha256');
  }
  if (typeof value.source.path !== 'string' || value.source.path.length === 0) {
    throw new TypeError('source.path is required');
  }
  if (typeof value.source.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.source.sha256)) {
    throw new TypeError('source.sha256 must be a lowercase SHA-256 digest');
  }
  return {
    format: 'moonwitness-ingestion-recipe/v1',
    recipeId: value.recipeId,
    parser: 'json-record-array/v1',
    source: { path: value.source.path, sha256: value.source.sha256 },
  };
}

function safeRelativePath(value: string, label: string): string {
  if (path.isAbsolute(value) || value.includes('\\') || value.includes('\0')) {
    throw new TypeError(`${label} must be a safe relative POSIX path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError(`${label} must not contain empty, dot, or parent segments`);
  }
  return segments.join(path.sep);
}

async function assertRegularFile(
  root: string,
  relativePath: string,
  label: string
): Promise<string> {
  const rootDetails = await lstat(root);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new TypeError('rootDirectory must be a real directory');
  }
  const safePath = safeRelativePath(relativePath, label);
  const absolutePath = path.resolve(root, safePath);
  const pathFromRoot = path.relative(path.resolve(root), absolutePath);
  if (
    pathFromRoot.startsWith(`..${path.sep}`) ||
    pathFromRoot === '..' ||
    path.isAbsolute(pathFromRoot)
  ) {
    throw new TypeError(`${label} escapes the workspace root`);
  }
  let current = path.resolve(root);
  for (const segment of pathFromRoot.split(path.sep)) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) throw new TypeError(`${label} cannot traverse symbolic links`);
  }
  const details = await lstat(absolutePath);
  if (!details.isFile()) throw new TypeError(`${label} must reference a regular file`);
  return absolutePath;
}

async function ensureSafeOutputParent(root: string, destination: string): Promise<void> {
  const relativeParent = path.relative(root, path.dirname(destination));
  let current = root;
  for (const segment of relativeParent === '' ? [] : relativeParent.split(path.sep)) {
    current = path.join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
    const details = await lstat(current);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new TypeError('outputPath parent directories must be real directories');
    }
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${label} must be valid UTF-8`);
  }
}

function validateRecords(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new TypeError('Parser output must be an array of records');
  const ids = new Set<string>();
  const records: JsonObject[] = [];
  for (const [index, candidate] of value.entries()) {
    const validation = validateKnowledgeRecord(candidate);
    if (!validation.valid) {
      const messages = validation.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join('; ');
      throw new TypeError(`Record at index ${index} is invalid: ${messages}`);
    }
    if (!isObject(candidate)) throw new TypeError(`Record at index ${index} must be an object`);
    if (typeof candidate.id !== 'string')
      throw new TypeError(`Record at index ${index} has no string ID`);
    if (ids.has(candidate.id)) throw new TypeError(`Duplicate record ID: ${candidate.id}`);
    ids.add(candidate.id);
    records.push(candidate);
  }
  return records;
}

function compareIds(left: JsonObject, right: JsonObject): number {
  const leftId = left.id;
  const rightId = right.id;
  if (typeof leftId !== 'string' || typeof rightId !== 'string') {
    throw new TypeError('Validated records must have string IDs');
  }
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function recordFilename(id: string): string {
  return `${createHash('sha256').update(id, 'utf8').digest('hex')}.json`;
}

export async function ingestDataset(request: IngestionRequest): Promise<IngestionReport> {
  const root = path.resolve(request.rootDirectory);
  const recipeFile = await assertRegularFile(root, request.recipePath, 'recipePath');
  const recipeBytes = await readFile(recipeFile);
  const recipe = parseRecipe(parseCanonicalJson(decodeUtf8(recipeBytes, 'Recipe')));
  const sourceFile = await assertRegularFile(root, recipe.source.path, 'source.path');
  const sourceBytes = await readFile(sourceFile);
  const actualSourceSha = sha256(sourceBytes);
  if (actualSourceSha !== recipe.source.sha256) {
    throw new TypeError(
      `Source checksum mismatch: expected ${recipe.source.sha256}, got ${actualSourceSha}`
    );
  }
  const records = validateRecords(parseCanonicalJson(decodeUtf8(sourceBytes, 'Source file'))).sort(
    compareIds
  );
  const snapshot = createKnowledgeSnapshot({ records, aliases: [], sourceArtifacts: [] });
  const outputRelativePath = safeRelativePath(request.outputPath, 'outputPath');
  const report: IngestionReport = {
    format: 'moonwitness-ingestion-report/v1',
    recipeId: recipe.recipeId,
    recipeSha256: sha256(recipeBytes),
    parser: recipe.parser,
    source: { path: recipe.source.path, sha256: actualSourceSha, bytes: sourceBytes.byteLength },
    records: records.length,
    snapshotSha256: snapshot.sha256,
    outputPath: outputRelativePath.split(path.sep).join('/'),
    dryRun: request.dryRun ?? false,
  };
  if (report.dryRun) return report;

  const destination = path.resolve(root, outputRelativePath);
  const relativeDestination = path.relative(root, destination);
  if (relativeDestination.startsWith(`..${path.sep}`) || relativeDestination === '..') {
    throw new TypeError('outputPath escapes the workspace root');
  }
  try {
    await lstat(destination);
    throw new TypeError('Output snapshots are immutable; choose a new outputPath');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(destination);
  await ensureSafeOutputParent(root, destination);
  const staging = await mkdtemp(path.join(parent, '.moonwitness-ingest-'));
  try {
    const recordDirectory = path.join(staging, 'records');
    await Promise.all([
      mkdir(recordDirectory),
      mkdir(path.join(staging, 'aliases')),
      mkdir(path.join(staging, 'source-artifacts')),
    ]);
    await Promise.all(
      records.map((record) => {
        if (typeof record.id !== 'string')
          throw new TypeError('Validated records must have string IDs');
        return writeFile(
          path.join(recordDirectory, recordFilename(record.id)),
          `${canonicalizeJson(record)}\n`,
          { flag: 'wx' }
        );
      })
    );
    await writeFile(path.join(staging, 'snapshot.json'), `${canonicalizeJson(snapshot)}\n`, {
      flag: 'wx',
    });
    await writeFile(path.join(staging, 'report.json'), `${canonicalizeJson(report)}\n`, {
      flag: 'wx',
    });
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  if (request.release) {
    const createdAt = request.release.createdAt ?? new Date().toISOString();
    const release = await createDatasetRelease(root, {
      ...request.release,
      createdAt,
      snapshotPath: report.outputPath,
      snapshot: snapshot as DatasetReleaseSnapshot,
      sourceRecipe: { path: request.recipePath, sha256: report.recipeSha256 },
    });
    await activateDatasetRelease(root, release.datasetId, release.releaseId, createdAt);
    report.releaseId = release.releaseId;
  }
  return report;
}

export interface ReplayDatasetReleaseRequest {
  rootDirectory: string;
  datasetId: string;
  releaseId: string;
  activatedAt: string;
}

/** Rebuild a missing immutable snapshot from its pinned local recipe before reactivating it. */
export async function replayDatasetRelease(
  request: ReplayDatasetReleaseRequest
): Promise<ActiveDatasetRelease> {
  const root = path.resolve(request.rootDirectory);
  const manifest = await readDatasetRelease(root, request.datasetId, request.releaseId);
  const snapshotPath = path.resolve(root, safeRelativePath(manifest.snapshotPath, 'snapshotPath'));

  try {
    await lstat(snapshotPath);
    return activateDatasetRelease(root, request.datasetId, request.releaseId, request.activatedAt);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }

  const recipeFile = await assertRegularFile(root, manifest.sourceRecipe.path, 'sourceRecipe.path');
  const recipeBytes = await readFile(recipeFile);
  if (sha256(recipeBytes) !== manifest.sourceRecipe.sha256) {
    throw new TypeError('Pinned source recipe checksum mismatch; release was not rebuilt');
  }
  const preview = await ingestDataset({
    rootDirectory: root,
    recipePath: manifest.sourceRecipe.path,
    outputPath: manifest.snapshotPath,
    dryRun: true,
  });
  if (preview.snapshotSha256 !== manifest.snapshot.sha256) {
    throw new TypeError('Replayed source does not match the immutable release snapshot');
  }

  const rebuilt = await ingestDataset({
    rootDirectory: root,
    recipePath: manifest.sourceRecipe.path,
    outputPath: manifest.snapshotPath,
  });
  if (rebuilt.snapshotSha256 !== manifest.snapshot.sha256) {
    throw new TypeError('Rebuilt snapshot does not match the immutable release snapshot');
  }
  return activateDatasetRelease(root, request.datasetId, request.releaseId, request.activatedAt);
}
