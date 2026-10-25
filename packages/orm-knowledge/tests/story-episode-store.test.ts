import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as workflowManifest } from '@moonwitness/orm-workflow';
import {
  manifest,
  readStoryEpisode,
  storeStoryEpisode,
  storeStoryVersion,
  validateStoryEpisode,
  type StoryEpisodeDocument,
  type StoryMediaReference,
  type StoryVersionDocument,
  type VerifiedStoryMediaReference,
} from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const webpMedia: StoryMediaReference = {
  artifact_id: 'mw:artifact:webp-protestant-genesis-1-1',
  sha256: 'ae5c2799fad97b0e65334aa39be6193d487419f0d31713caaac58a47f6b4d8b1',
  media_type: 'text/plain; charset=utf-8',
  rights_ref: 'docs/roadmap/evidence/K2-006.md#source-and-rights',
};

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function resolveApprovedLocalMedia(
  reference: StoryMediaReference
): Promise<VerifiedStoryMediaReference | null> {
  const corpusManifest = JSON.parse(
    await readFile(path.join(repoRoot, 'corpus/manifests/webp-protestant-genesis-1-1.json'), 'utf8')
  ) as {
    artifact: { media_type: string; sha256: string; byte_length: number };
    rights: { state: string; allowed_uses: string[]; evidence_ref: string };
  };
  const identity = await readFile(
    path.join(repoRoot, 'corpus/reference/webp-protestant-genesis-1-1.identity.json'),
    'utf8'
  );
  const bytes = await readFile(
    path.join(repoRoot, 'corpus/reference/sha256', reference.sha256.slice(0, 2), reference.sha256)
  );
  if (
    !identity.includes(reference.artifact_id) ||
    corpusManifest.artifact.sha256 !== reference.sha256 ||
    corpusManifest.artifact.media_type !== reference.media_type ||
    corpusManifest.rights.evidence_ref !== reference.rights_ref ||
    corpusManifest.rights.state !== 'permitted' ||
    !corpusManifest.rights.allowed_uses.includes('store') ||
    bytes.byteLength !== corpusManifest.artifact.byte_length ||
    sha256(bytes) !== reference.sha256
  ) {
    return null;
  }
  return {
    ...reference,
    bytes_verified: true,
    rights_state: 'permitted',
    allowed_uses: corpusManifest.rights.allowed_uses,
  };
}

function story(): StoryVersionDocument {
  return {
    schema_version: 1,
    story_id: 'mw:story:synthetic-three-page',
    version: 1,
    title: 'Synthetic three-page story',
    visibility: 'INTERNAL',
    pages: [
      {
        page_id: 'mw:story-page:synthetic-three-page-001',
        page_order: 1,
        original_text: 'Synthetic opening.  Keep both spaces.\r\n',
      },
      {
        page_id: 'mw:story-page:synthetic-three-page-002',
        page_order: 2,
        original_text: 'Synthetic middle: لا تُغيّر النص.',
        media: webpMedia,
      },
      {
        page_id: 'mw:story-page:synthetic-three-page-003',
        page_order: 3,
        original_text: 'Synthetic closing.',
      },
    ],
  };
}

function episode(
  version: number,
  firstPageOrder: number,
  lastPageOrder: number,
  overrides: Partial<StoryEpisodeDocument> = {}
): StoryEpisodeDocument {
  return {
    schema_version: 1,
    episode_id: 'mw:story-episode:synthetic-part-one',
    version,
    title: 'Synthetic episode one',
    visibility: 'INTERNAL',
    story_id: 'mw:story:synthetic-three-page',
    story_version: 1,
    story_digest: '',
    first_page_order: firstPageOrder,
    last_page_order: lastPageOrder,
    ...overrides,
  };
}

describe('tenant-scoped immutable story episodes', () => {
  let db: Knex;
  let userId: number;
  let companyId: number;
  let storyDigest: string;

  const actor = () => ({ userId, companyId, role: 'superadmin' as const });

  beforeEach(async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    await installAddons(db, [
      baseManifest,
      jobsManifest,
      notificationManifest,
      workflowManifest,
      manifest,
    ]);
    userId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
    companyId = Number((await db('companies').first('id'))?.id);
    await db('company_memberships')
      .insert({ user_id: userId, company_id: companyId, is_default: true })
      .onConflict(['user_id', 'company_id'])
      .ignore();
    const stored = await storeStoryVersion(db, {
      authenticatedActor: actor(),
      story: story(),
      resolveMedia: resolveApprovedLocalMedia,
    });
    storyDigest = stored.digest;
  });

  afterEach(async () => db.destroy());

  it('slices the bound story version, replays idempotently, and appends an episode version', async () => {
    const first = await storeStoryEpisode(db, {
      authenticatedActor: actor(),
      episode: episode(1, 1, 1, { story_digest: storyDigest }),
      resolveMedia: resolveApprovedLocalMedia,
    });
    const replay = await storeStoryEpisode(db, {
      authenticatedActor: actor(),
      episode: episode(1, 1, 1, { story_digest: storyDigest }),
      resolveMedia: resolveApprovedLocalMedia,
    });
    const second = await storeStoryEpisode(db, {
      authenticatedActor: actor(),
      episode: episode(2, 2, 3, { story_digest: storyDigest, title: 'Synthetic episode two' }),
      resolveMedia: resolveApprovedLocalMedia,
    });

    expect(first).toMatchObject({
      episodeId: 'mw:story-episode:synthetic-part-one',
      version: 1,
      previousDigest: null,
      visibility: 'INTERNAL',
      idempotent: false,
    });
    expect(first.pages).toEqual([
      {
        page_id: 'mw:story-page:synthetic-three-page-001',
        page_order: 1,
        original_text: 'Synthetic opening.  Keep both spaces.\r\n',
      },
    ]);
    expect(replay).toMatchObject({ digest: first.digest, idempotent: true });
    expect(second).toMatchObject({ version: 2, previousDigest: first.digest, idempotent: false });
    expect(second.pages.map(({ page_order }) => page_order)).toEqual([2, 3]);
    expect(second.pages[0]?.media).toEqual(webpMedia);
    expect(await db('knowledge_story_episode_versions')).toHaveLength(2);
    expect(
      (await db('knowledge_story_episode_versions').orderBy('version', 'asc')).map(
        ({ page_count }) => Number(page_count)
      )
    ).toEqual([1, 2]);

    const readFirst = await readStoryEpisode(db, {
      authenticatedReader: actor(),
      episodeId: first.episodeId,
      version: 1,
      resolveMedia: resolveApprovedLocalMedia,
    });
    const readLatest = await readStoryEpisode(db, {
      authenticatedReader: actor(),
      episodeId: first.episodeId,
      resolveMedia: resolveApprovedLocalMedia,
    });
    expect(readFirst?.pages[0]?.original_text).toBe('Synthetic opening.  Keep both spaces.\r\n');
    expect(readFirst?.episode.story_digest).toBe(storyDigest);
    expect(readLatest?.version).toBe(2);
    expect(
      await readStoryEpisode(db, {
        authenticatedReader: actor(),
        episodeId: first.episodeId,
        version: 1,
        resolveMedia: async () => null,
      })
    ).toBeNull();

    await expect(
      db('knowledge_story_episode_versions').where({ version: 1 }).update({ visibility: 'PUBLIC' })
    ).rejects.toThrow('Knowledge story episodes are append-only');
    await expect(
      db('knowledge_story_episode_versions').where({ version: 2 }).delete()
    ).rejects.toThrow('Knowledge story episodes are append-only');
  });

  it('refuses unstored versions, digest drift, out-of-range slices, gaps, and foreign tenants', async () => {
    await expect(
      storeStoryEpisode(db, {
        authenticatedActor: actor(),
        episode: episode(1, 1, 1, { story_version: 7, story_digest: storyDigest }),
        resolveMedia: resolveApprovedLocalMedia,
      })
    ).rejects.toThrow(/stored in this company/u);
    await expect(
      storeStoryEpisode(db, {
        authenticatedActor: actor(),
        episode: episode(1, 1, 1, { story_digest: 'f'.repeat(64) }),
        resolveMedia: resolveApprovedLocalMedia,
      })
    ).rejects.toThrow(/exact digest/u);
    await expect(
      storeStoryEpisode(db, {
        authenticatedActor: actor(),
        episode: episode(1, 2, 4, { story_digest: storyDigest }),
        resolveMedia: resolveApprovedLocalMedia,
      })
    ).rejects.toThrow(/inside the bound story version/u);
    expect(validateStoryEpisode(episode(1, 3, 2, { story_digest: storyDigest })).valid).toBe(false);
    await expect(
      storeStoryEpisode(db, {
        authenticatedActor: actor(),
        episode: episode(1, 3, 2, { story_digest: storyDigest }),
      })
    ).rejects.toThrow(/page-range check/u);

    const first = await storeStoryEpisode(db, {
      authenticatedActor: actor(),
      episode: episode(1, 1, 2, { story_digest: storyDigest }),
      resolveMedia: resolveApprovedLocalMedia,
    });
    await expect(
      storeStoryEpisode(db, {
        authenticatedActor: actor(),
        episode: episode(3, 1, 2, { story_digest: storyDigest }),
        resolveMedia: resolveApprovedLocalMedia,
      })
    ).rejects.toThrow(/next version/u);
    await expect(
      storeStoryEpisode(db, {
        authenticatedActor: actor(),
        episode: episode(1, 1, 2, { story_digest: storyDigest, title: 'Synthetic conflicting' }),
        resolveMedia: resolveApprovedLocalMedia,
      })
    ).rejects.toThrow(/different canonical content/u);
    expect(await db('knowledge_story_episode_versions')).toHaveLength(1);

    await expect(
      readStoryEpisode(db, {
        authenticatedReader: { userId, companyId: companyId + 1, role: 'superadmin' },
        episodeId: first.episodeId,
      })
    ).rejects.toThrow(/unavailable in this company context/u);
    expect(
      await readStoryEpisode(db, {
        authenticatedReader: actor(),
        episodeId: 'mw:story-episode:never-stored',
      })
    ).toBeNull();
    await expect(
      readStoryEpisode(db, { authenticatedReader: actor(), episodeId: 'synthetic-part-one' })
    ).rejects.toThrow(/read context is invalid/u);
  });
});
