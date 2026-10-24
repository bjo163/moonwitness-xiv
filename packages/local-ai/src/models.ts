import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface LocalModelArtifact {
  id: string;
  version: string;
  sourceUrl: string;
  license: {
    identifier: string;
    referenceUrl: string;
    reviewed: boolean;
    reviewedAt: string;
    reviewRef: string;
  };
  file: {
    path: string;
    sha256: string;
    byteLength: number;
  };
  requirements: {
    minimumRamGiB: number;
    minimumVramGiB: number | null;
  };
}

export interface LocalModelRegistry {
  format: 'moonwitness-local-model-registry/v1';
  activeArtifactId: string | null;
  artifacts: readonly LocalModelArtifact[];
}

export type ModelArtifactVerification =
  | { valid: true; artifactId: string; sha256: string; byteLength: number }
  | {
      valid: false;
      reason:
        | 'registry_invalid'
        | 'license_unreviewed'
        | 'model_missing'
        | 'storage_inside_worktree'
        | 'path_invalid'
        | 'integrity_mismatch';
    };

const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/u;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isIsoTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/u.exec(
      value
    );
  if (!match || !Number.isFinite(Date.parse(value))) return false;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHour,
    offsetMinute,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetIsValid =
    offsetHour === undefined || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !offsetIsValid
  ) {
    return false;
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function isLocalModelRegistry(value: unknown): value is LocalModelRegistry {
  if (
    !isRecord(value) ||
    value.format !== 'moonwitness-local-model-registry/v1' ||
    !(value.activeArtifactId === null || typeof value.activeArtifactId === 'string') ||
    !Array.isArray(value.artifacts)
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const candidate of value.artifacts) {
    if (
      !isRecord(candidate) ||
      !isRecord(candidate.license) ||
      !isRecord(candidate.file) ||
      !isRecord(candidate.requirements)
    ) {
      return false;
    }
    if (
      typeof candidate.id !== 'string' ||
      !identifierPattern.test(candidate.id) ||
      ids.has(candidate.id) ||
      typeof candidate.version !== 'string' ||
      !semverPattern.test(candidate.version) ||
      typeof candidate.sourceUrl !== 'string' ||
      !isHttpsUrl(candidate.sourceUrl) ||
      typeof candidate.license.identifier !== 'string' ||
      candidate.license.identifier.trim().length === 0 ||
      typeof candidate.license.referenceUrl !== 'string' ||
      !isHttpsUrl(candidate.license.referenceUrl) ||
      typeof candidate.license.reviewed !== 'boolean' ||
      typeof candidate.license.reviewedAt !== 'string' ||
      !isIsoTimestamp(candidate.license.reviewedAt) ||
      typeof candidate.license.reviewRef !== 'string' ||
      candidate.license.reviewRef.trim().length === 0 ||
      typeof candidate.file.path !== 'string' ||
      candidate.file.path.length === 0 ||
      !sha256Pattern.test(String(candidate.file.sha256)) ||
      typeof candidate.file.byteLength !== 'number' ||
      !Number.isSafeInteger(candidate.file.byteLength) ||
      candidate.file.byteLength < 1 ||
      typeof candidate.requirements.minimumRamGiB !== 'number' ||
      !Number.isFinite(candidate.requirements.minimumRamGiB) ||
      candidate.requirements.minimumRamGiB <= 0 ||
      !(
        candidate.requirements.minimumVramGiB === null ||
        (typeof candidate.requirements.minimumVramGiB === 'number' &&
          Number.isFinite(candidate.requirements.minimumVramGiB) &&
          candidate.requirements.minimumVramGiB >= 0)
      )
    ) {
      return false;
    }
    ids.add(candidate.id);
  }
  return value.activeArtifactId === null || ids.has(value.activeArtifactId);
}

function relativeModelPath(value: string): string | null {
  if (path.isAbsolute(value) || value.includes('\\') || value.includes('\0')) return null;
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join(path.sep);
}

async function hashFile(filename: string): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(filename)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    byteLength += bytes.byteLength;
  }
  return { sha256: hash.digest('hex'), byteLength };
}

/** Verify an approved artifact without downloading it or allowing storage inside the Git worktree. */
export async function verifyLocalModelArtifact(
  workspaceRoot: string,
  modelStorageRoot: string,
  artifact: LocalModelArtifact
): Promise<ModelArtifactVerification> {
  const registry: LocalModelRegistry = {
    format: 'moonwitness-local-model-registry/v1',
    activeArtifactId: artifact.id,
    artifacts: [artifact],
  };
  if (!isLocalModelRegistry(registry)) return { valid: false, reason: 'registry_invalid' };
  if (!artifact.license.reviewed) return { valid: false, reason: 'license_unreviewed' };
  const relative = relativeModelPath(artifact.file.path);
  if (relative === null) return { valid: false, reason: 'path_invalid' };
  let workspace: string;
  let storage: string;
  try {
    workspace = await realpath(workspaceRoot);
    storage = await realpath(modelStorageRoot);
  } catch {
    return { valid: false, reason: 'model_missing' };
  }
  const fromWorkspace = path.relative(workspace, storage);
  if (
    fromWorkspace === '' ||
    (fromWorkspace !== '..' &&
      !fromWorkspace.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(fromWorkspace))
  ) {
    return { valid: false, reason: 'storage_inside_worktree' };
  }

  const candidate = path.resolve(storage, relative);
  const fromStorage = path.relative(storage, candidate);
  if (
    fromStorage.startsWith(`..${path.sep}`) ||
    fromStorage === '..' ||
    path.isAbsolute(fromStorage)
  ) {
    return { valid: false, reason: 'path_invalid' };
  }
  let current = storage;
  for (const segment of fromStorage.split(path.sep)) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return { valid: false, reason: 'model_missing' };
    }
    if (info.isSymbolicLink()) return { valid: false, reason: 'path_invalid' };
  }
  const fileInfo = await lstat(candidate);
  if (!fileInfo.isFile()) return { valid: false, reason: 'path_invalid' };
  const digest = await hashFile(candidate);
  if (digest.sha256 !== artifact.file.sha256 || digest.byteLength !== artifact.file.byteLength) {
    return { valid: false, reason: 'integrity_mismatch' };
  }
  return { valid: true, artifactId: artifact.id, ...digest };
}
