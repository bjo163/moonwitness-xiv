import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  parseCanonicalJson,
  validateSourceArtifactManifest,
  type SourceAllowedUse,
  type SourceArtifactManifest,
  type SourceBytesManifest,
} from '@moonwitness/knowledge';
import { putRawArtifact } from './raw-artifact-store.js';
import type { RawArtifactReceipt } from './raw-artifact-store.js';

type PassageUse = Extract<SourceAllowedUse, 'read_analyze' | 'store' | 'quote_excerpt'>;

interface QuranPassageIndexEntry {
  edition_id: string;
  locator: string;
  source_manifest_path: string;
  artifact_path: string;
  sha256: string;
}

interface QuranPassageIndex {
  format: 'moonwitness-quran-passage-index/v1';
  entries: QuranPassageIndexEntry[];
}

export interface ReadQuranPassageRequest {
  rootDirectory: string;
  editionId: string;
  locator: string;
  use?: PassageUse;
  indexPath?: string;
}

export interface QuranPassage {
  editionId: string;
  locator: string;
  text: string;
  sha256: string;
  originalBytes: Buffer;
  attribution: string;
}

export interface QuranPassageSnapshot {
  passage: QuranPassage;
  sourceManifestBytes: Buffer;
  /** Source identity validated from the same canonical source-bytes manifest. */
  sourceId: string;
}

export interface ImportQuranPassageRequest extends ReadQuranPassageRequest {
  artifactStorePath: string;
}

export interface ImportedQuranPassage {
  passage: QuranPassage;
  artifact: RawArtifactReceipt;
}

const digestPattern = /^[a-f0-9]{64}$/u;
const editionPattern = /^mw:edition:[a-z0-9][a-z0-9._-]{0,99}$/u;
const locatorPattern = /^Q([1-9]\d{0,2}):([1-9]\d{0,2})$/u;
const indexKeys = ['entries', 'format'];
const entryKeys = ['artifact_path', 'edition_id', 'locator', 'sha256', 'source_manifest_path'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    path.isAbsolute(value) ||
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

async function readRegularFile(root: string, relativePath: string, label: string): Promise<Buffer> {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new TypeError('rootDirectory must be a real directory');
  }
  const normalized = safeRelativePath(relativePath, label);
  let current = root;
  const segments = normalized.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError(`${label} cannot traverse symbolic links`);
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new TypeError(`${label} parents must be directories`);
    }
    if (index === segments.length - 1 && !info.isFile()) {
      throw new TypeError(`${label} must reference a regular file`);
    }
  }
  return readFile(current);
}

function parseIndex(value: unknown): QuranPassageIndex {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(',') !== indexKeys.join(',') ||
    value.format !== 'moonwitness-quran-passage-index/v1' ||
    !Array.isArray(value.entries)
  ) {
    throw new TypeError('Quran passage index has an unsupported format');
  }

  const seen = new Set<string>();
  const entries = value.entries.map((candidate, index) => {
    if (!isObject(candidate) || Object.keys(candidate).sort().join(',') !== entryKeys.join(',')) {
      throw new TypeError(`Quran passage index entry ${index} has an invalid shape`);
    }
    if (
      typeof candidate.edition_id !== 'string' ||
      !editionPattern.test(candidate.edition_id) ||
      typeof candidate.locator !== 'string' ||
      !locatorPattern.test(candidate.locator) ||
      typeof candidate.sha256 !== 'string' ||
      !digestPattern.test(candidate.sha256)
    ) {
      throw new TypeError(`Quran passage index entry ${index} has an invalid identity or digest`);
    }
    safeRelativePath(candidate.source_manifest_path, `entries[${index}].source_manifest_path`);
    safeRelativePath(candidate.artifact_path, `entries[${index}].artifact_path`);
    const key = `${candidate.edition_id}\0${candidate.locator}`;
    if (seen.has(key))
      throw new TypeError('Quran passage index contains a duplicate edition/locator');
    seen.add(key);
    return candidate as unknown as QuranPassageIndexEntry;
  });

  return { format: 'moonwitness-quran-passage-index/v1', entries };
}

async function lookupPassage(request: ReadQuranPassageRequest): Promise<{
  entry: QuranPassageIndexEntry;
  manifest: SourceBytesManifest;
  manifestBytes: Buffer;
  bytes: Buffer;
}> {
  if (!editionPattern.test(request.editionId) || !locatorPattern.test(request.locator)) {
    throw new TypeError('editionId or locator is invalid');
  }
  const root = path.resolve(request.rootDirectory);
  const indexPath = request.indexPath ?? 'corpus/manifests/quran-passage-index.json';
  const indexBytes = await readRegularFile(root, indexPath, 'indexPath');
  const index = parseIndex(
    parseCanonicalJson(new TextDecoder('utf-8', { fatal: true }).decode(indexBytes))
  );
  const matches = index.entries.filter(
    (entry) => entry.edition_id === request.editionId && entry.locator === request.locator
  );
  if (matches.length !== 1) {
    throw new TypeError(`Unknown Quran edition/passage: ${request.editionId} ${request.locator}`);
  }
  const [entry] = matches;
  const manifestBytes = await readRegularFile(
    root,
    entry!.source_manifest_path,
    'sourceManifestPath'
  );
  const manifestValue = parseCanonicalJson(
    new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)
  );
  const validation = validateSourceArtifactManifest(manifestValue);
  if (!validation.valid || !isObject(manifestValue)) {
    throw new TypeError('Quran passage source manifest is invalid or missing rights evidence');
  }
  const manifestCandidate = manifestValue as unknown as SourceArtifactManifest;
  const use = request.use ?? 'read_analyze';
  if (
    manifestCandidate.edition_id !== entry!.edition_id ||
    manifestCandidate.artifact.representation !== 'source_bytes' ||
    manifestCandidate.artifact.sha256 !== entry!.sha256 ||
    manifestCandidate.publication.mode !== 'source_bytes' ||
    manifestCandidate.rights.state !== 'permitted' ||
    !manifestCandidate.rights.allowed_uses.includes(use) ||
    !('attribution' in manifestCandidate)
  ) {
    throw new TypeError(`Quran passage rights do not permit requested use: ${use}`);
  }
  const manifest = manifestCandidate as SourceBytesManifest;
  const bytes = await readRegularFile(root, entry!.artifact_path, 'artifactPath');
  const actualSha = createHash('sha256').update(bytes).digest('hex');
  if (
    actualSha !== entry!.sha256 ||
    actualSha !== manifest.artifact.sha256 ||
    bytes.byteLength !== manifest.artifact.byte_length
  ) {
    throw new TypeError('Quran passage artifact checksum or size mismatch');
  }
  return { entry: entry!, manifest, manifestBytes, bytes };
}

/** Return exact local source text for a pinned edition and verse; this function never fetches data. */
async function readQuranPassageSnapshotInternal(
  request: ReadQuranPassageRequest
): Promise<QuranPassageSnapshot> {
  const { entry, manifest, manifestBytes, bytes } = await lookupPassage(request);
  const sourceLine = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const line = sourceLine.endsWith('\n') ? sourceLine.slice(0, -1) : sourceLine;
  if (line.includes('\n') || line.includes('\r')) {
    throw new TypeError('Quran passage artifact must contain one unmodified source line');
  }
  const firstSeparator = line.indexOf('|');
  const secondSeparator = line.indexOf('|', firstSeparator + 1);
  if (firstSeparator < 1 || secondSeparator < 0) {
    throw new TypeError('Quran passage artifact has an unsupported source line format');
  }
  const sourceLocator = `Q${line.slice(0, firstSeparator)}:${line.slice(firstSeparator + 1, secondSeparator)}`;
  const text = line.slice(secondSeparator + 1);
  if (sourceLocator !== entry.locator || text.length === 0) {
    throw new TypeError('Quran passage source line does not match its edition locator');
  }
  return {
    passage: {
      editionId: entry.edition_id,
      locator: entry.locator,
      text,
      sha256: entry.sha256,
      originalBytes: bytes,
      attribution: manifest.attribution.text,
    },
    sourceManifestBytes: manifestBytes,
    sourceId: manifest.source_id,
  };
}

export async function readQuranPassage(request: ReadQuranPassageRequest): Promise<QuranPassage> {
  return (await readQuranPassageSnapshotInternal(request)).passage;
}

/** Return a verified passage and the exact manifest bytes validated for it. */
export async function readQuranPassageSnapshot(
  request: ReadQuranPassageRequest
): Promise<QuranPassageSnapshot> {
  return readQuranPassageSnapshotInternal(request);
}

/** Idempotently add the passage's exact source bytes to a local content-addressed store. */
export async function importQuranPassage(
  request: ImportQuranPassageRequest
): Promise<ImportedQuranPassage> {
  const passage = await readQuranPassage({ ...request, use: 'store' });
  const root = path.resolve(request.rootDirectory);
  const storePath = path.resolve(
    root,
    safeRelativePath(request.artifactStorePath, 'artifactStorePath')
  );
  const storeRelative = path.relative(root, storePath);
  if (
    storeRelative.startsWith(`..${path.sep}`) ||
    storeRelative === '..' ||
    path.isAbsolute(storeRelative)
  ) {
    throw new TypeError('artifactStorePath escapes rootDirectory');
  }
  const receipt = await putRawArtifact({
    storeDirectory: storePath,
    sha256: passage.sha256,
    bytes: passage.originalBytes,
  });
  return { passage, artifact: receipt };
}
