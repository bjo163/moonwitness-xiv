import { createHash } from 'node:crypto';
import { createJsonSchemaValidator, type KnowledgeValidationResult } from '@moonwitness/knowledge';
import type { Knex } from 'knex';
import storyEpisodeSchema from '../../../ontology/domains/story-episode.schema.json' with { type: 'json' };
import { canonicalResearchJson } from './research-release.js';
import {
  assertActiveCompanyEditor,
  isAuthenticatedEditor,
  readVersionRow,
  type AuthenticatedStoryEditor,
  type StoryPageDocument,
  type StoryVersionDocument,
  type StoryVersionMediaResolver,
} from './story-version-store.js';

const episodeIdPattern = /^mw:story-episode:[a-z0-9][a-z0-9._-]{0,179}$/u;

export interface StoryEpisodeDocument {
  readonly schema_version: 1;
  readonly episode_id: string;
  readonly version: number;
  readonly title: string;
  readonly visibility: 'INTERNAL';
  readonly story_id: string;
  readonly story_version: number;
  readonly story_digest: string;
  readonly first_page_order: number;
  readonly last_page_order: number;
}

export interface StoredStoryEpisode {
  readonly episodeId: string;
  readonly version: number;
  readonly digest: string;
  readonly previousDigest: string | null;
  readonly visibility: 'INTERNAL';
  readonly episode: StoryEpisodeDocument;
  readonly pages: readonly StoryPageDocument[];
  readonly idempotent: boolean;
}

export interface StoreStoryEpisodeInput {
  readonly authenticatedActor: AuthenticatedStoryEditor;
  readonly episode: unknown;
  readonly resolveMedia?: StoryVersionMediaResolver;
}

export interface ReadStoryEpisodeInput {
  readonly authenticatedReader: AuthenticatedStoryEditor;
  readonly episodeId: string;
  readonly version?: number;
  readonly resolveMedia?: StoryVersionMediaResolver;
}

const validateSchema = createJsonSchemaValidator(
  storyEpisodeSchema,
  'does not match the versioned story episode contract'
);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate schema and a forward-facing contiguous page range. */
export function validateStoryEpisode(value: unknown): KnowledgeValidationResult {
  const schemaResult = validateSchema(value);
  if (!schemaResult.valid) return schemaResult;
  if (!isObject(value)) return schemaResult;
  const first = value.first_page_order;
  const last = value.last_page_order;
  if (typeof first !== 'number' || typeof last !== 'number' || first > last) {
    return {
      valid: false,
      issues: [
        {
          path: '/last_page_order',
          keyword: 'rangeOrder',
          message: 'must not be below first_page_order',
        },
      ],
    };
  }
  return schemaResult;
}

function pageSlice(story: StoryVersionDocument, first: number, last: number): StoryPageDocument[] {
  const pages = story.pages.slice(first - 1, last);
  const matches =
    pages.length === last - first + 1 &&
    pages.every((page, index) => page.page_order === first + index);
  if (!matches) throw new Error('Story episode page range no longer matches the story version');
  return pages;
}

async function readEpisodeRow(
  trx: Knex.Transaction,
  row: Record<string, unknown>,
  resolveMedia?: StoryVersionMediaResolver
): Promise<StoredStoryEpisode | null> {
  const episodeJson = String(row.episode_json);
  if (typeof row.episode_digest !== 'string' || sha256(episodeJson) !== row.episode_digest)
    return null;
  let episode: unknown;
  try {
    episode = JSON.parse(episodeJson) as unknown;
  } catch {
    return null;
  }
  try {
    if (
      canonicalResearchJson(episode) !== episodeJson ||
      !validateStoryEpisode(episode).valid ||
      !isObject(episode) ||
      episode.episode_id !== row.episode_id ||
      episode.version !== Number(row.version) ||
      episode.title !== row.title ||
      episode.visibility !== row.visibility ||
      episode.story_id !== row.story_id ||
      episode.story_version !== Number(row.story_version) ||
      episode.story_digest !== row.story_digest ||
      episode.first_page_order !== Number(row.first_page_order) ||
      episode.last_page_order !== Number(row.last_page_order) ||
      episode.last_page_order - episode.first_page_order + 1 !== Number(row.page_count)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const document = episode as unknown as StoryEpisodeDocument;
  const storyRow = await trx('knowledge_story_versions')
    .where({
      company_id: row.company_id,
      story_id: document.story_id,
      version: document.story_version,
    })
    .first();
  if (!storyRow) return null;
  const verifiedStory = await readVersionRow(
    trx,
    storyRow as Record<string, unknown>,
    resolveMedia
  );
  if (!verifiedStory || verifiedStory.digest !== document.story_digest) return null;
  let pages: readonly StoryPageDocument[];
  try {
    pages = pageSlice(verifiedStory.story, document.first_page_order, document.last_page_order);
  } catch {
    return null;
  }
  const previousDigest = (row.previous_episode_digest as string | null) ?? null;
  if (Number(row.version) === 1) {
    if (previousDigest !== null) return null;
  } else {
    if (!/^[a-f0-9]{64}$/u.test(String(previousDigest))) return null;
    const previous = await trx('knowledge_story_episode_versions')
      .where({
        company_id: row.company_id,
        episode_id: row.episode_id,
        version: Number(row.version) - 1,
        episode_digest: previousDigest,
      })
      .first('id');
    if (!previous) return null;
  }
  return {
    episodeId: String(row.episode_id),
    version: Number(row.version),
    digest: String(row.episode_digest),
    previousDigest,
    visibility: 'INTERNAL',
    episode: document,
    pages,
    idempotent: false,
  };
}

/** Store an immutable, tenant-scoped INTERNAL episode that points at one exact stored story version. */
export async function storeStoryEpisode(
  db: Knex,
  input: StoreStoryEpisodeInput
): Promise<StoredStoryEpisode> {
  if (!isAuthenticatedEditor(input.authenticatedActor))
    throw new TypeError('Story episode storage context is invalid');
  const validation = validateStoryEpisode(input.episode);
  if (!validation.valid) throw new TypeError('Story episode failed its schema or page-range check');
  const episodeJson = canonicalResearchJson(input.episode);
  const episode = JSON.parse(episodeJson) as StoryEpisodeDocument;
  const episodeDigest = sha256(episodeJson);
  return db.transaction(async (trx) => {
    const actor = input.authenticatedActor;
    await assertActiveCompanyEditor(trx, actor);
    // Serialize version allocation for the tenant, including an episode's first version.
    await trx('companies').where({ id: actor.companyId }).forUpdate().first('id');
    const storyRow = await trx('knowledge_story_versions')
      .where({
        company_id: actor.companyId,
        story_id: episode.story_id,
        version: episode.story_version,
      })
      .first();
    if (!storyRow)
      throw new TypeError('Story episode must bind a story version stored in this company');
    const verifiedStory = await readVersionRow(
      trx,
      storyRow as Record<string, unknown>,
      input.resolveMedia
    );
    if (!verifiedStory)
      throw new TypeError('Story episode must bind a story version that still verifies');
    if (verifiedStory.digest !== episode.story_digest)
      throw new TypeError('Story episode must bind the exact digest of the stored story version');
    let pages: readonly StoryPageDocument[];
    try {
      pages = pageSlice(verifiedStory.story, episode.first_page_order, episode.last_page_order);
    } catch {
      throw new TypeError('Story episode page range must stay inside the bound story version');
    }
    const existing = await trx('knowledge_story_episode_versions')
      .where({
        company_id: actor.companyId,
        episode_id: episode.episode_id,
        version: episode.version,
      })
      .first();
    if (existing) {
      if (existing.episode_digest !== episodeDigest) {
        throw new TypeError(
          'Story episode version already exists with different canonical content'
        );
      }
      const verified = await readEpisodeRow(
        trx,
        existing as Record<string, unknown>,
        input.resolveMedia
      );
      if (!verified) throw new TypeError('Stored story episode failed integrity verification');
      return { ...verified, idempotent: true };
    }
    const latest = await trx('knowledge_story_episode_versions')
      .where({ company_id: actor.companyId, episode_id: episode.episode_id })
      .orderBy('version', 'desc')
      .first('version', 'episode_digest');
    const expectedVersion = Number(latest?.version ?? 0) + 1;
    if (episode.version !== expectedVersion) {
      throw new TypeError(`Story episode must append the next version (${expectedVersion})`);
    }
    const inserted = await trx('knowledge_story_episode_versions')
      .insert({
        company_id: actor.companyId,
        episode_id: episode.episode_id,
        version: episode.version,
        visibility: 'INTERNAL',
        title: episode.title,
        episode_json: episodeJson,
        episode_digest: episodeDigest,
        story_id: episode.story_id,
        story_version: episode.story_version,
        story_digest: episode.story_digest,
        first_page_order: episode.first_page_order,
        last_page_order: episode.last_page_order,
        page_count: pages.length,
        previous_episode_digest: latest?.episode_digest ?? null,
        recorded_by_id: actor.userId,
      })
      .returning('id');
    if (inserted[0]?.id === undefined) throw new Error('Story episode ID was not returned');
    return {
      episodeId: episode.episode_id,
      version: episode.version,
      digest: episodeDigest,
      previousDigest: (latest?.episode_digest as string | undefined) ?? null,
      visibility: 'INTERNAL',
      episode,
      pages,
      idempotent: false,
    };
  });
}

/** Read and verify an episode, returning only the page slice the bound story version still proves. */
export async function readStoryEpisode(
  db: Knex,
  input: ReadStoryEpisodeInput
): Promise<StoredStoryEpisode | null> {
  const actor = input.authenticatedReader;
  if (
    !isAuthenticatedEditor(actor) ||
    !episodeIdPattern.test(input.episodeId) ||
    (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 1))
  ) {
    throw new TypeError('Story episode read context is invalid');
  }
  return db.transaction(async (trx) => {
    await assertActiveCompanyEditor(trx, actor);
    const query = trx('knowledge_story_episode_versions').where({
      company_id: actor.companyId,
      episode_id: input.episodeId,
    });
    if (input.version !== undefined) query.andWhere({ version: input.version });
    const row = await query.orderBy('version', 'desc').first();
    return row ? readEpisodeRow(trx, row as Record<string, unknown>, input.resolveMedia) : null;
  });
}
