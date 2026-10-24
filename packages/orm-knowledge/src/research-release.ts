import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { validateResearchRelease } from './research-release-validation.js';

export interface ResearchGraphRecordInput {
  readonly key: string;
  readonly kind: 'node' | 'source' | 'expression' | 'assertion' | 'evidence' | 'relation';
  readonly visibility: 'PUBLIC' | 'INTERNAL' | 'RESTRICTED';
  readonly content: unknown;
}

export interface CreateResearchGraphReleaseInput {
  readonly corpusKey: string;
  readonly schemaVersion: string;
  readonly records: readonly ResearchGraphRecordInput[];
  readonly previousReleaseDigest?: string | null;
}

export interface StoredResearchGraphRecord extends ResearchGraphRecordInput {
  readonly contentDigest: string;
}

export interface StoredResearchGraphRelease {
  readonly corpusKey: string;
  readonly releaseDigest: string;
  readonly manifestDigest: string;
  readonly manifestJson: string;
  readonly schemaVersion: string;
  readonly previousReleaseDigest: string | null;
  readonly records: readonly StoredResearchGraphRecord[];
}

/** Active graph readers fail closed before materializing an unbounded release snapshot. */
export const MAX_RESEARCH_RELEASE_RECORDS = 5_000;
export const MAX_RESEARCH_RELEASE_CANONICAL_BYTES = 8 * 1024 * 1024;

function writeCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next < 0xdc00 || next > 0xdfff) throw new TypeError('Invalid Unicode surrogate');
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new TypeError('Invalid Unicode surrogate');
      }
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Research JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError('Research JSON arrays cannot be sparse');
      items.push(writeCanonicalJson(value[index]));
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Research content must be plain JSON data');
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return `{${entries
    .map(([key, item]) => {
      if (item === undefined) throw new TypeError('Research JSON cannot contain undefined');
      return `${writeCanonicalJson(key)}:${writeCanonicalJson(item)}`;
    })
    .join(',')}}`;
}

export function canonicalResearchJson(value: unknown): string {
  return writeCanonicalJson(value);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeInput(input: CreateResearchGraphReleaseInput) {
  if (!input.corpusKey.trim() || input.corpusKey.length > 255) {
    throw new TypeError('A corpus key of 1 to 255 characters is required');
  }
  if (!input.schemaVersion.trim() || input.schemaVersion.length > 64) {
    throw new TypeError('A schema version of 1 to 64 characters is required');
  }
  if (
    input.previousReleaseDigest !== undefined &&
    input.previousReleaseDigest !== null &&
    !/^[a-f0-9]{64}$/u.test(input.previousReleaseDigest)
  ) {
    throw new TypeError('Previous research release digest must be a SHA-256 hex digest');
  }
  if (input.records.length === 0) throw new TypeError('A research graph release cannot be empty');
  if (input.records.length > MAX_RESEARCH_RELEASE_RECORDS) {
    throw new TypeError('A research graph release exceeds the supported record limit');
  }
  const seen = new Set<string>();
  let aggregateContentBytes = 0;
  const records = input.records
    .map((record) => {
      if (!record.key.trim() || record.key.length > 255 || seen.has(record.key)) {
        throw new TypeError('Research record keys must be unique and contain 1 to 255 characters');
      }
      if (
        !['node', 'source', 'expression', 'assertion', 'evidence', 'relation'].includes(
          record.kind
        ) ||
        !['PUBLIC', 'INTERNAL', 'RESTRICTED'].includes(record.visibility)
      ) {
        throw new TypeError('Research record kind or visibility is invalid');
      }
      seen.add(record.key);
      const contentJson = canonicalResearchJson(record.content);
      aggregateContentBytes += Buffer.byteLength(contentJson, 'utf8');
      if (
        Buffer.byteLength(contentJson, 'utf8') > MAX_RESEARCH_RELEASE_CANONICAL_BYTES ||
        aggregateContentBytes > MAX_RESEARCH_RELEASE_CANONICAL_BYTES
      ) {
        throw new TypeError('A research graph record exceeds the supported content limit');
      }
      return {
        ...record,
        contentJson,
        contentDigest: digest(contentJson),
      };
    })
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const manifestJson = canonicalResearchJson({
    corpusKey: input.corpusKey,
    schemaVersion: input.schemaVersion,
    previousReleaseDigest: input.previousReleaseDigest ?? null,
    records: records.map(({ key, kind, visibility, contentDigest }) => ({
      key,
      kind,
      visibility,
      contentDigest,
    })),
  });
  if (
    aggregateContentBytes + Buffer.byteLength(manifestJson, 'utf8') >
    MAX_RESEARCH_RELEASE_CANONICAL_BYTES
  ) {
    throw new TypeError('A research graph release exceeds the supported byte limit');
  }
  const manifestDigest = digest(manifestJson);
  return { records, manifestJson, manifestDigest };
}

async function readByDigest(trx: Knex.Transaction, releaseDigest: string) {
  return trx('knowledge_research_graph_releases').where({ release_digest: releaseDigest }).first();
}

function contentSizeExpression(trx: Knex.Transaction): string {
  const client = String(trx.client.config.client);
  if (client.includes('sqlite')) return 'length(CAST(content_json AS BLOB))';
  if (client === 'pg' || client === 'postgres' || client === 'postgresql') {
    return 'octet_length(content_json)';
  }
  throw new TypeError('Research release reader does not support this database client');
}

/**
 * Insert a complete immutable release in the caller's transaction. The release
 * identity is its canonical manifest SHA-256; exact retries are safe.
 */
export async function createResearchGraphRelease(
  trx: Knex.Transaction,
  input: CreateResearchGraphReleaseInput
): Promise<StoredResearchGraphRelease> {
  const normalized = normalizeInput(input);
  if (input.previousReleaseDigest) {
    const parentRow = await readByDigest(trx, input.previousReleaseDigest);
    if (!parentRow) throw new Error('Previous research release does not exist');
    const parent = await readResearchGraphRelease(trx, input.previousReleaseDigest);
    if (!parent) throw new Error('Previous research release is corrupt');
    if (parent.corpusKey !== input.corpusKey) {
      throw new Error('Previous research release belongs to a different corpus');
    }
  }
  const existing = await readByDigest(trx, normalized.manifestDigest);
  if (existing) {
    if (
      existing.manifest_json !== normalized.manifestJson ||
      existing.manifest_digest !== normalized.manifestDigest ||
      existing.record_count !== normalized.records.length ||
      existing.schema_version !== input.schemaVersion ||
      (existing.previous_release_digest ?? null) !== (input.previousReleaseDigest ?? null)
    ) {
      throw new Error('Research release digest collision or inconsistent stored manifest');
    }
    const replay = await trx('knowledge_research_graph_records')
      .where({ release_id: existing.id })
      .orderBy('record_key', 'asc');
    if (replay.length !== normalized.records.length) {
      throw new Error('Stored research release is incomplete');
    }
    const records = normalized.records.map((expected, index) => {
      const actual = replay[index];
      if (
        !actual ||
        actual.record_key !== expected.key ||
        actual.record_kind !== expected.kind ||
        actual.visibility !== expected.visibility ||
        actual.content_json !== expected.contentJson ||
        actual.content_digest !== expected.contentDigest
      ) {
        throw new Error('Stored research release content does not match its manifest');
      }
      return {
        key: expected.key,
        kind: expected.kind,
        visibility: expected.visibility,
        content: JSON.parse(expected.contentJson) as unknown,
        contentDigest: expected.contentDigest,
      };
    });
    return {
      corpusKey: input.corpusKey,
      releaseDigest: normalized.manifestDigest,
      manifestDigest: normalized.manifestDigest,
      manifestJson: normalized.manifestJson,
      schemaVersion: input.schemaVersion,
      previousReleaseDigest: input.previousReleaseDigest ?? null,
      records,
    };
  }

  await trx('knowledge_research_graph_releases').insert({
    release_digest: normalized.manifestDigest,
    manifest_digest: normalized.manifestDigest,
    manifest_json: normalized.manifestJson,
    record_count: normalized.records.length,
    schema_version: input.schemaVersion,
    previous_release_digest: input.previousReleaseDigest ?? null,
  });
  const release = await readByDigest(trx, normalized.manifestDigest);
  if (!release) throw new Error('Research release insert was not visible in its transaction');
  for (const record of normalized.records) {
    await trx('knowledge_research_graph_records').insert({
      release_id: release.id,
      record_key: record.key,
      record_kind: record.kind,
      visibility: record.visibility,
      content_json: record.contentJson,
      content_digest: record.contentDigest,
    });
  }
  return {
    corpusKey: input.corpusKey,
    releaseDigest: normalized.manifestDigest,
    manifestDigest: normalized.manifestDigest,
    manifestJson: normalized.manifestJson,
    schemaVersion: input.schemaVersion,
    previousReleaseDigest: input.previousReleaseDigest ?? null,
    records: normalized.records.map((record) => ({
      key: record.key,
      kind: record.kind,
      visibility: record.visibility,
      content: JSON.parse(record.contentJson) as unknown,
      contentDigest: record.contentDigest,
    })),
  };
}

/** Select an intact immutable release, using an expected head for safe rollback/concurrency. */
export async function activateResearchGraphRelease(
  trx: Knex.Transaction,
  input: {
    readonly corpusKey: string;
    readonly releaseDigest: string;
    readonly expectedCurrentReleaseDigest: string | null;
    readonly activatedAt: string;
  }
): Promise<void> {
  const snapshot = await readResearchGraphRelease(trx, input.releaseDigest);
  const releaseRow = await readByDigest(trx, input.releaseDigest);
  if (!snapshot || !releaseRow) {
    throw new Error('Cannot activate a missing or corrupt research release');
  }
  if (snapshot.corpusKey !== input.corpusKey) {
    throw new Error('Research release belongs to a different corpus');
  }
  if (snapshot.schemaVersion !== 'research-graph/v1') {
    throw new Error('Cannot activate an unsupported research graph schema');
  }
  validateResearchRelease(snapshot.records);
  const active = await trx('knowledge_research_active_releases as active')
    .join('knowledge_research_graph_releases as release', 'release.id', 'active.release_id')
    .where('active.corpus_key', input.corpusKey)
    .forUpdate()
    .first('release.release_digest');
  const currentDigest = active?.release_digest ?? null;
  if (currentDigest !== input.expectedCurrentReleaseDigest) {
    throw new Error('Active research release changed; refresh and retry');
  }
  if (active) {
    await trx('knowledge_research_active_releases')
      .where({ corpus_key: input.corpusKey })
      .update({ release_id: releaseRow.id, activated_at: input.activatedAt });
  } else {
    try {
      await trx('knowledge_research_active_releases').insert({
        corpus_key: input.corpusKey,
        release_id: releaseRow.id,
        activated_at: input.activatedAt,
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (
        code === '23505' ||
        code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
      ) {
        throw new Error('Active research release changed; refresh and retry', { cause: error });
      }
      throw error;
    }
  }
}

/** Read and verify every digest in a release before returning any record. */
export async function readResearchGraphRelease(
  trx: Knex.Transaction,
  releaseDigest: string
): Promise<StoredResearchGraphRelease | null> {
  const release = await readByDigest(trx, releaseDigest);
  if (!release) return null;
  if (
    !Number.isInteger(release.record_count) ||
    Number(release.record_count) < 1 ||
    Number(release.record_count) > MAX_RESEARCH_RELEASE_RECORDS ||
    Buffer.byteLength(String(release.manifest_json), 'utf8') > MAX_RESEARCH_RELEASE_CANONICAL_BYTES
  ) {
    return null;
  }
  const boundedRecordSizes = trx('knowledge_research_graph_records')
    .where({ release_id: release.id })
    .select(trx.raw(`${contentSizeExpression(trx)} AS content_bytes`))
    .limit(MAX_RESEARCH_RELEASE_RECORDS + 1)
    .as('bounded_record_sizes');
  const sizeRow = await trx
    .select(
      trx.raw(
        'COUNT(*) AS bounded_record_count, COALESCE(SUM(content_bytes), 0) AS total_content_bytes'
      )
    )
    .from(boundedRecordSizes)
    .first();
  if (
    !sizeRow ||
    Number(sizeRow.bounded_record_count) !== Number(release.record_count) ||
    Number(sizeRow.bounded_record_count) > MAX_RESEARCH_RELEASE_RECORDS ||
    Number(sizeRow.total_content_bytes) + Buffer.byteLength(String(release.manifest_json), 'utf8') >
      MAX_RESEARCH_RELEASE_CANONICAL_BYTES
  ) {
    return null;
  }
  const rows = await trx('knowledge_research_graph_records')
    .where({ release_id: release.id })
    .limit(MAX_RESEARCH_RELEASE_RECORDS + 1)
    .orderBy('record_key', 'asc');
  if (rows.length !== release.record_count) return null;
  let canonicalBytes = Buffer.byteLength(String(release.manifest_json), 'utf8');
  const parsed = rows.map((row) => {
    const contentJson = String(row.content_json);
    canonicalBytes += Buffer.byteLength(contentJson, 'utf8');
    if (canonicalBytes > MAX_RESEARCH_RELEASE_CANONICAL_BYTES) return null;
    if (digest(contentJson) !== row.content_digest) return null;
    try {
      const content = JSON.parse(contentJson) as unknown;
      if (canonicalResearchJson(content) !== contentJson) return null;
      return {
        key: String(row.record_key),
        kind: row.record_kind as ResearchGraphRecordInput['kind'],
        visibility: row.visibility as ResearchGraphRecordInput['visibility'],
        content,
        contentDigest: String(row.content_digest),
      } satisfies StoredResearchGraphRecord;
    } catch {
      return null;
    }
  });
  if (parsed.some((record) => record === null)) return null;
  let corpusKey: string;
  let normalized: ReturnType<typeof normalizeInput>;
  try {
    const manifest = JSON.parse(String(release.manifest_json)) as { corpusKey?: unknown };
    if (typeof manifest.corpusKey !== 'string') return null;
    corpusKey = manifest.corpusKey;
    normalized = normalizeInput({
      corpusKey,
      schemaVersion: String(release.schema_version),
      previousReleaseDigest: release.previous_release_digest ?? null,
      records: parsed.map((record) => ({
        key: record!.key,
        kind: record!.kind,
        visibility: record!.visibility,
        content: record!.content,
      })),
    });
  } catch {
    return null;
  }
  if (
    normalized.manifestJson !== release.manifest_json ||
    normalized.manifestDigest !== release.manifest_digest ||
    normalized.manifestDigest !== release.release_digest
  ) {
    return null;
  }
  if (release.previous_release_digest) {
    // The parent is a lineage pointer. Its own content is verified when read or activated;
    // this snapshot read avoids walking the entire release history on every read.
    const parent = await readByDigest(trx, String(release.previous_release_digest));
    if (!parent) return null;
    try {
      const parentManifest = JSON.parse(String(parent.manifest_json)) as { corpusKey?: unknown };
      if (parentManifest.corpusKey !== corpusKey) return null;
    } catch {
      return null;
    }
  }
  return {
    corpusKey,
    releaseDigest: String(release.release_digest),
    manifestDigest: String(release.manifest_digest),
    manifestJson: String(release.manifest_json),
    schemaVersion: String(release.schema_version),
    previousReleaseDigest: (release.previous_release_digest as string | null) ?? null,
    records: parsed as StoredResearchGraphRecord[],
  };
}

/** Read the active pointer and its snapshot through the same transaction. */
export async function readActiveResearchGraphRelease(
  trx: Knex.Transaction,
  corpusKey: string
): Promise<StoredResearchGraphRelease | null> {
  const row = await trx('knowledge_research_active_releases as active')
    .join('knowledge_research_graph_releases as release', 'release.id', 'active.release_id')
    .where('active.corpus_key', corpusKey)
    .first('release.release_digest');
  if (!row) return null;
  const release = await readResearchGraphRelease(trx, String(row.release_digest));
  if (
    !release ||
    release.corpusKey !== corpusKey ||
    release.schemaVersion !== 'research-graph/v1'
  ) {
    return null;
  }
  try {
    validateResearchRelease(release.records);
  } catch {
    return null;
  }
  return release;
}
