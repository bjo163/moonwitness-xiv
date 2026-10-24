import { createHash } from 'node:crypto';
import { createJsonSchemaValidator, type KnowledgeValidationResult } from '@moonwitness/knowledge';
import type { Knex } from 'knex';
import storyVersionSchema from '../../../ontology/domains/story-version.schema.json' with { type: 'json' };
import { canonicalResearchJson } from './research-release.js';

const storyIdPattern = /^mw:story:[a-z0-9][a-z0-9._-]{0,179}$/u;
const maxStoryBytes = 4 * 1024 * 1024;
const maxStoryPages = 100;

export interface StoryMediaReference {
  readonly artifact_id: string;
  readonly sha256: string;
  readonly media_type: string;
  readonly rights_ref: string;
}

export interface StoryPageDocument {
  readonly page_id: string;
  readonly page_order: number;
  /** Preserved exactly, including whitespace, line endings, and Unicode code points. */
  readonly original_text: string;
  readonly media?: StoryMediaReference;
}

export interface StoryVersionDocument {
  readonly schema_version: 1;
  readonly story_id: string;
  readonly version: number;
  readonly title: string;
  readonly visibility: 'INTERNAL';
  readonly pages: readonly StoryPageDocument[];
}

export interface AuthenticatedStoryEditor {
  readonly userId: number;
  readonly companyId: number;
  readonly role: 'user' | 'superadmin';
}

/** A trusted local resolver returns this only after verifying bytes and store rights. */
export interface VerifiedStoryMediaReference extends StoryMediaReference {
  readonly bytes_verified: true;
  readonly rights_state: 'permitted';
  readonly allowed_uses: readonly string[];
}

export type StoryVersionMediaResolver = (
  reference: StoryMediaReference
) => Promise<VerifiedStoryMediaReference | null>;

export interface StoreStoryVersionInput {
  readonly authenticatedActor: AuthenticatedStoryEditor;
  readonly story: unknown;
  readonly resolveMedia?: StoryVersionMediaResolver;
}

export interface ReadStoryVersionInput {
  readonly authenticatedReader: AuthenticatedStoryEditor;
  readonly storyId: string;
  readonly version?: number;
  readonly resolveMedia?: StoryVersionMediaResolver;
}

export interface StoredStoryVersion {
  readonly storyId: string;
  readonly version: number;
  readonly digest: string;
  readonly previousDigest: string | null;
  readonly visibility: 'INTERNAL';
  readonly story: StoryVersionDocument;
  readonly idempotent: boolean;
}

const validateSchema = createJsonSchemaValidator(
  storyVersionSchema,
  'does not match the versioned story/page contract'
);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthenticatedEditor(value: AuthenticatedStoryEditor): boolean {
  return (
    Number.isSafeInteger(value.userId) &&
    value.userId > 0 &&
    Number.isSafeInteger(value.companyId) &&
    value.companyId > 0 &&
    (value.role === 'user' || value.role === 'superadmin')
  );
}

/** Validate schema, stable contiguous page order, and unique page identities. */
export function validateStoryVersion(value: unknown): KnowledgeValidationResult {
  const schemaResult = validateSchema(value);
  if (!schemaResult.valid) return schemaResult;
  if (!isObject(value) || !Array.isArray(value.pages) || value.pages.length > maxStoryPages) {
    return {
      valid: false,
      issues: [{ path: '/pages', keyword: 'maxItems', message: 'must contain 1–100 pages' }],
    };
  }
  const pageIds = new Set<string>();
  for (const [index, rawPage] of value.pages.entries()) {
    if (!isObject(rawPage)) continue;
    if (rawPage.page_order !== index + 1) {
      return {
        valid: false,
        issues: [
          {
            path: `/pages/${index}/page_order`,
            keyword: 'contiguousOrder',
            message: 'must be in ascending contiguous order starting at 1',
          },
        ],
      };
    }
    if (typeof rawPage.page_id !== 'string' || pageIds.has(rawPage.page_id)) {
      return {
        valid: false,
        issues: [
          {
            path: `/pages/${index}/page_id`,
            keyword: 'unique',
            message: 'page IDs must be unique within a story version',
          },
        ],
      };
    }
    pageIds.add(rawPage.page_id);
  }
  try {
    if (Buffer.byteLength(canonicalResearchJson(value), 'utf8') > maxStoryBytes) {
      return {
        valid: false,
        issues: [{ path: '/', keyword: 'maxBytes', message: 'story version exceeds 4 MiB' }],
      };
    }
  } catch {
    return {
      valid: false,
      issues: [{ path: '/', keyword: 'json', message: 'story version is not canonical JSON data' }],
    };
  }
  return schemaResult;
}

async function assertActiveCompanyEditor(
  trx: Knex.Transaction,
  actor: AuthenticatedStoryEditor
): Promise<void> {
  const user = await trx('users')
    .where({ id: actor.userId, role: actor.role, active: true })
    .forUpdate()
    .first('id');
  const company = await trx('companies')
    .where({ id: actor.companyId, active: true })
    .forUpdate()
    .first('id');
  const membership = await trx('company_memberships')
    .where({ user_id: actor.userId, company_id: actor.companyId, active: true })
    .forUpdate()
    .first('id');
  if (!user || !company || !membership)
    throw new TypeError('Story version is unavailable in this company context');
}

function verifiedMedia(
  reference: StoryMediaReference,
  resolver: StoryVersionMediaResolver | undefined
): Promise<boolean> {
  if (!resolver) return Promise.resolve(false);
  return resolver(reference).then(
    (resolved) =>
      resolved !== null &&
      resolved.artifact_id === reference.artifact_id &&
      resolved.sha256 === reference.sha256 &&
      resolved.media_type === reference.media_type &&
      resolved.rights_ref === reference.rights_ref &&
      resolved.bytes_verified === true &&
      resolved.rights_state === 'permitted' &&
      resolved.allowed_uses.includes('store')
  );
}

async function readVersionRow(
  trx: Knex.Transaction,
  row: Record<string, unknown>,
  resolveMedia?: StoryVersionMediaResolver
): Promise<StoredStoryVersion | null> {
  const storyJson = String(row.story_json);
  if (
    typeof row.story_digest !== 'string' ||
    sha256(storyJson) !== row.story_digest ||
    Buffer.byteLength(storyJson, 'utf8') > maxStoryBytes
  ) {
    return null;
  }
  let story: unknown;
  try {
    story = JSON.parse(storyJson) as unknown;
  } catch {
    return null;
  }
  try {
    if (
      canonicalResearchJson(story) !== storyJson ||
      !validateStoryVersion(story).valid ||
      !isObject(story) ||
      story.story_id !== row.story_id ||
      story.version !== Number(row.version) ||
      story.title !== row.title ||
      story.visibility !== row.visibility
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const pages = story.pages as StoryPageDocument[];
  const rows = await trx('knowledge_story_page_versions')
    .where({ story_version_id: row.id })
    .orderBy('page_order', 'asc')
    .limit(maxStoryPages + 1);
  if (rows.length !== Number(row.page_count) || rows.length !== pages.length) return null;
  for (const [index, page] of pages.entries()) {
    const stored = rows[index];
    if (
      !stored ||
      stored.page_id !== page.page_id ||
      Number(stored.page_order) !== page.page_order ||
      stored.original_text !== page.original_text ||
      stored.original_text_digest !== sha256(page.original_text) ||
      (page.media === undefined
        ? stored.media_ref_json !== null
        : typeof stored.media_ref_json !== 'string' ||
          stored.media_ref_json !== canonicalResearchJson(page.media))
    ) {
      return null;
    }
    if (page.media && !(await verifiedMedia(page.media, resolveMedia))) return null;
  }
  const previousDigest = (row.previous_story_digest as string | null) ?? null;
  if (Number(row.version) === 1) {
    if (previousDigest !== null) return null;
  } else {
    if (!/^[a-f0-9]{64}$/u.test(String(previousDigest))) return null;
    const previous = await trx('knowledge_story_versions')
      .where({
        company_id: row.company_id,
        story_id: row.story_id,
        version: Number(row.version) - 1,
        story_digest: previousDigest,
      })
      .first('id');
    if (!previous) return null;
  }
  return {
    storyId: String(row.story_id),
    version: Number(row.version),
    digest: String(row.story_digest),
    previousDigest,
    visibility: 'INTERNAL',
    story: story as unknown as StoryVersionDocument,
    idempotent: false,
  };
}

/** Store immutable, tenant-scoped INTERNAL story/page versions in PostgreSQL. */
export async function storeStoryVersion(
  db: Knex,
  input: StoreStoryVersionInput
): Promise<StoredStoryVersion> {
  if (!isAuthenticatedEditor(input.authenticatedActor))
    throw new TypeError('Story version storage context is invalid');
  const validation = validateStoryVersion(input.story);
  if (!validation.valid) throw new TypeError('Story version failed its schema or page-order check');
  const storyJson = canonicalResearchJson(input.story);
  const story = JSON.parse(storyJson) as StoryVersionDocument;
  const storyDigest = sha256(storyJson);
  return db.transaction(async (trx) => {
    const actor = input.authenticatedActor;
    await assertActiveCompanyEditor(trx, actor);
    // Serialize version allocation for the tenant, including a story's first version.
    await trx('companies').where({ id: actor.companyId }).forUpdate().first('id');
    for (const page of story.pages) {
      if (page.media && !(await verifiedMedia(page.media, input.resolveMedia))) {
        throw new TypeError(
          'Story media must resolve to verified local bytes with store permission'
        );
      }
    }
    const existing = await trx('knowledge_story_versions')
      .where({ company_id: actor.companyId, story_id: story.story_id, version: story.version })
      .first();
    if (existing) {
      if (existing.story_digest !== storyDigest) {
        throw new TypeError('Story version already exists with different canonical content');
      }
      const verified = await readVersionRow(
        trx,
        existing as Record<string, unknown>,
        input.resolveMedia
      );
      if (!verified) throw new TypeError('Stored story version failed integrity verification');
      return { ...verified, idempotent: true };
    }
    const latest = await trx('knowledge_story_versions')
      .where({ company_id: actor.companyId, story_id: story.story_id })
      .orderBy('version', 'desc')
      .first('version', 'story_digest');
    const expectedVersion = Number(latest?.version ?? 0) + 1;
    if (story.version !== expectedVersion) {
      throw new TypeError(`Story version must append the next version (${expectedVersion})`);
    }
    const insertedVersions = await trx('knowledge_story_versions')
      .insert({
        company_id: actor.companyId,
        story_id: story.story_id,
        version: story.version,
        visibility: 'INTERNAL',
        title: story.title,
        story_json: storyJson,
        story_digest: storyDigest,
        page_count: story.pages.length,
        previous_story_digest: latest?.story_digest ?? null,
        recorded_by_id: actor.userId,
      })
      .returning('id');
    const insertedVersion = insertedVersions[0] as { id?: number | string } | number | undefined;
    const storyVersionId =
      typeof insertedVersion === 'object' && insertedVersion !== null
        ? insertedVersion.id
        : insertedVersion;
    if (storyVersionId === undefined) throw new Error('Story version ID was not returned');
    await trx('knowledge_story_page_versions').insert(
      story.pages.map((page) => ({
        story_version_id: storyVersionId,
        page_id: page.page_id,
        page_order: page.page_order,
        original_text: page.original_text,
        original_text_digest: sha256(page.original_text),
        media_ref_json: page.media === undefined ? null : canonicalResearchJson(page.media),
      }))
    );
    return {
      storyId: story.story_id,
      version: story.version,
      digest: storyDigest,
      previousDigest: (latest?.story_digest as string | undefined) ?? null,
      visibility: 'INTERNAL',
      story,
      idempotent: false,
    };
  });
}

/** Read and verify the complete requested version inside the authenticated company. */
export async function readStoryVersion(
  db: Knex,
  input: ReadStoryVersionInput
): Promise<StoredStoryVersion | null> {
  const actor = input.authenticatedReader;
  if (
    !isAuthenticatedEditor(actor) ||
    !storyIdPattern.test(input.storyId) ||
    (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 1))
  ) {
    throw new TypeError('Story version read context is invalid');
  }
  return db.transaction(async (trx) => {
    await assertActiveCompanyEditor(trx, actor);
    const query = trx('knowledge_story_versions').where({
      company_id: actor.companyId,
      story_id: input.storyId,
    });
    if (input.version !== undefined) query.andWhere({ version: input.version });
    const row = await query.orderBy('version', 'desc').first();
    return row ? readVersionRow(trx, row as Record<string, unknown>, input.resolveMedia) : null;
  });
}
