import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  parseCanonicalJson,
  validateSourceArtifactManifest,
  type SourceBytesManifest,
} from '@moonwitness/knowledge';

interface TextualWitnessIndexEntry {
  expression_id: string;
  edition_id: string;
  locator: string;
  source_artifact_id: string;
  source_manifest_path: string;
  artifact_path: string;
  sha256: string;
}

interface TextualWitnessIndex {
  format: 'moonwitness-textual-witness-index/v1';
  entries: TextualWitnessIndexEntry[];
}

export interface ReadTextualWitnessPassageRequest {
  rootDirectory: string;
  expressionId: string;
  editionId: string;
  locator: string;
  /** Requested use is checked against the pinned source manifest. */
  use?: 'read_analyze' | 'quote_excerpt' | 'store';
  indexPath?: string;
}

export interface TextualWitnessPassage {
  sourceId: string;
  expressionId: string;
  editionId: string;
  locale: string;
  locator: string;
  text: string;
  sha256: string;
  originalBytes: Buffer;
  attribution: string;
  references: string[];
}

export interface TextualWitnessPassageSnapshot {
  sourceArtifactId: string;
  passage: TextualWitnessPassage;
  sourceManifestBytes: Buffer;
}

const digestPattern = /^[a-f0-9]{64}$/u;
const identityPattern = /^mw:(?:expression|edition|artifact):[a-z0-9][a-z0-9._-]{0,99}$/u;
const locatorPattern = /^[A-Za-z][A-Za-z0-9 ]{0,63} [1-9][0-9]{0,2}:[1-9][0-9]{0,2}$/u;
const indexKeys = ['entries', 'format'];
const entryKeys = [
  'artifact_path',
  'edition_id',
  'expression_id',
  'locator',
  'sha256',
  'source_artifact_id',
  'source_manifest_path',
];

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
  let current = root;
  const segments = safeRelativePath(relativePath, label).split(path.sep);
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

function parseIndex(value: unknown): TextualWitnessIndex {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(',') !== indexKeys.join(',') ||
    value.format !== 'moonwitness-textual-witness-index/v1' ||
    !Array.isArray(value.entries)
  ) {
    throw new TypeError('Textual witness index has an unsupported format');
  }

  const seen = new Set<string>();
  const entries = value.entries.map((candidate, index) => {
    if (!isObject(candidate) || Object.keys(candidate).sort().join(',') !== entryKeys.join(',')) {
      throw new TypeError(`Textual witness index entry ${index} has an invalid shape`);
    }
    if (
      typeof candidate.expression_id !== 'string' ||
      !identityPattern.test(candidate.expression_id) ||
      !candidate.expression_id.startsWith('mw:expression:') ||
      typeof candidate.edition_id !== 'string' ||
      !identityPattern.test(candidate.edition_id) ||
      !candidate.edition_id.startsWith('mw:edition:') ||
      typeof candidate.source_artifact_id !== 'string' ||
      !identityPattern.test(candidate.source_artifact_id) ||
      !candidate.source_artifact_id.startsWith('mw:artifact:') ||
      typeof candidate.locator !== 'string' ||
      !locatorPattern.test(candidate.locator) ||
      typeof candidate.sha256 !== 'string' ||
      !digestPattern.test(candidate.sha256)
    ) {
      throw new TypeError(`Textual witness index entry ${index} has an invalid identity or digest`);
    }
    safeRelativePath(candidate.source_manifest_path, `entries[${index}].source_manifest_path`);
    safeRelativePath(candidate.artifact_path, `entries[${index}].artifact_path`);
    const key = `${candidate.expression_id}\0${candidate.edition_id}\0${candidate.locator}`;
    if (seen.has(key))
      throw new TypeError('Textual witness index contains a duplicate identity/locator');
    seen.add(key);
    return candidate as unknown as TextualWitnessIndexEntry;
  });
  return { format: 'moonwitness-textual-witness-index/v1', entries };
}

/** Read one exact, quote-cleared textual witness excerpt from the local repository. */
export async function readTextualWitnessPassage(
  request: ReadTextualWitnessPassageRequest
): Promise<TextualWitnessPassage> {
  return (await readTextualWitnessPassageSnapshotInternal(request)).passage;
}

/** Return a verified witness excerpt and the exact manifest bytes validated for it. */
export async function readTextualWitnessPassageSnapshot(
  request: ReadTextualWitnessPassageRequest
): Promise<TextualWitnessPassageSnapshot> {
  return readTextualWitnessPassageSnapshotInternal(request);
}

async function readTextualWitnessPassageSnapshotInternal(
  request: ReadTextualWitnessPassageRequest
): Promise<TextualWitnessPassageSnapshot> {
  if (
    !identityPattern.test(request.expressionId) ||
    !request.expressionId.startsWith('mw:expression:') ||
    !identityPattern.test(request.editionId) ||
    !request.editionId.startsWith('mw:edition:') ||
    !locatorPattern.test(request.locator)
  ) {
    throw new TypeError('expressionId, editionId, or locator is invalid');
  }

  const root = path.resolve(request.rootDirectory);
  const indexPath = request.indexPath ?? 'corpus/manifests/textual-witness-index.json';
  const indexBytes = await readRegularFile(root, indexPath, 'indexPath');
  const index = parseIndex(
    parseCanonicalJson(new TextDecoder('utf-8', { fatal: true }).decode(indexBytes))
  );
  const matches = index.entries.filter(
    (entry) =>
      entry.expression_id === request.expressionId &&
      entry.edition_id === request.editionId &&
      entry.locator === request.locator
  );
  if (matches.length !== 1) {
    throw new TypeError(
      `Unknown textual witness expression/edition/locator: ${request.expressionId} ${request.editionId} ${request.locator}`
    );
  }

  const entry = matches[0]!;
  const manifestBytes = await readRegularFile(
    root,
    entry.source_manifest_path,
    'sourceManifestPath'
  );
  const manifestValue = parseCanonicalJson(
    new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)
  );
  const validation = validateSourceArtifactManifest(manifestValue);
  if (!validation.valid || !isObject(manifestValue)) {
    throw new TypeError('Textual witness source manifest is invalid or missing rights evidence');
  }
  const manifest = manifestValue as unknown as SourceBytesManifest;
  const use = request.use ?? 'quote_excerpt';
  if (
    !manifest.source_id.startsWith('mw:source:') ||
    manifest.edition_id !== entry.edition_id ||
    manifest.artifact.representation !== 'source_bytes' ||
    manifest.artifact.sha256 !== entry.sha256 ||
    manifest.publication.mode !== 'source_bytes' ||
    manifest.rights.state !== 'permitted' ||
    !manifest.rights.allowed_uses.includes(use)
  ) {
    throw new TypeError(
      use === 'quote_excerpt'
        ? 'Textual witness rights do not permit excerpt quotation'
        : `Textual witness rights do not permit requested use: ${use}`
    );
  }

  const bytes = await readRegularFile(root, entry.artifact_path, 'artifactPath');
  const actualSha = createHash('sha256').update(bytes).digest('hex');
  if (
    actualSha !== entry.sha256 ||
    actualSha !== manifest.artifact.sha256 ||
    bytes.byteLength !== manifest.artifact.byte_length
  ) {
    throw new TypeError('Textual witness artifact checksum or size mismatch');
  }
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const text = decoded.endsWith('\n') ? decoded.slice(0, -1) : decoded;
  if (!text || text.includes('\n') || text.includes('\r')) {
    throw new TypeError('Textual witness artifact must contain exactly one UTF-8 source line');
  }

  return {
    sourceArtifactId: entry.source_artifact_id,
    passage: {
      sourceId: manifest.source_id,
      expressionId: entry.expression_id,
      editionId: entry.edition_id,
      locale: manifest.locale,
      locator: entry.locator,
      text,
      sha256: actualSha,
      originalBytes: bytes,
      attribution: manifest.attribution.text,
      references: [...(manifest.references ?? [])],
    },
    sourceManifestBytes: manifestBytes,
  };
}
