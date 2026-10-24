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
  readStoryVersion,
  storeStoryVersion,
  validateStoryVersion,
  type StoryMediaReference,
  type StoryVersionDocument,
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

function story(version: number, firstPageText = 'Synthetic first page.'): StoryVersionDocument {
  return {
    schema_version: 1,
    story_id: 'mw:story:synthetic-two-page',
    version,
    title: 'Synthetic two-page story',
    visibility: 'INTERNAL',
    pages: [
      {
        page_id: 'mw:story-page:synthetic-two-page-001',
        page_order: 1,
        original_text: firstPageText,
      },
      {
        page_id: 'mw:story-page:synthetic-two-page-002',
        page_order: 2,
        original_text: 'Synthetic second page: لا تُغيّر النص.',
        media: webpMedia,
      },
    ],
  };
}

async function resolveApprovedLocalMedia(reference: StoryMediaReference): Promise<{
  artifact_id: string;
  sha256: string;
  media_type: string;
  rights_ref: string;
  bytes_verified: true;
  rights_state: 'permitted';
  allowed_uses: readonly string[];
} | null> {
  const manifestPath = path.join(repoRoot, 'corpus/manifests/webp-protestant-genesis-1-1.json');
  const identityPath = path.join(
    repoRoot,
    'corpus/reference/webp-protestant-genesis-1-1.identity.json'
  );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    artifact: { media_type: string; sha256: string; byte_length: number };
    rights: { state: string; allowed_uses: string[]; evidence_ref: string };
  };
  const identity = await readFile(identityPath, 'utf8');
  const artifactPath = path.join(
    repoRoot,
    'corpus/reference/sha256',
    reference.sha256.slice(0, 2),
    reference.sha256
  );
  const bytes = await readFile(artifactPath);
  if (
    !identity.includes(reference.artifact_id) ||
    manifest.artifact.sha256 !== reference.sha256 ||
    manifest.artifact.media_type !== reference.media_type ||
    manifest.rights.evidence_ref !== reference.rights_ref ||
    manifest.rights.state !== 'permitted' ||
    !manifest.rights.allowed_uses.includes('store') ||
    bytes.byteLength !== manifest.artifact.byte_length ||
    sha256(bytes) !== reference.sha256
  ) {
    return null;
  }
  return {
    ...reference,
    bytes_verified: true,
    rights_state: 'permitted',
    allowed_uses: manifest.rights.allowed_uses,
  };
}

describe('tenant-scoped immutable story/page versions', () => {
  let db: Knex;
  let userId: number;
  let companyId: number;

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
  });

  afterEach(async () => db.destroy());

  it('stores two ordered pages, verifies a real optional file reference, and appends a new version', async () => {
    const exactText = 'Synthetic first page.\r\n Keep both spaces.  ';
    const first = await storeStoryVersion(db, {
      authenticatedActor: { userId, companyId, role: 'superadmin' },
      story: story(1, exactText),
      resolveMedia: resolveApprovedLocalMedia,
    });
    const replay = await storeStoryVersion(db, {
      authenticatedActor: { userId, companyId, role: 'superadmin' },
      story: story(1, exactText),
      resolveMedia: resolveApprovedLocalMedia,
    });
    const version2 = story(2, 'Synthetic first page, revised.');
    const version2WithoutMedia: StoryVersionDocument = {
      ...version2,
      pages: version2.pages.map(({ page_id, page_order, original_text }) => ({
        page_id,
        page_order,
        original_text,
      })),
    };
    const second = await storeStoryVersion(db, {
      authenticatedActor: { userId, companyId, role: 'superadmin' },
      story: version2WithoutMedia,
    });

    expect(first).toMatchObject({ version: 1, visibility: 'INTERNAL', idempotent: false });
    expect(replay).toMatchObject({ version: 1, digest: first.digest, idempotent: true });
    expect(second).toMatchObject({
      version: 2,
      previousDigest: first.digest,
      visibility: 'INTERNAL',
      idempotent: false,
    });
    expect(second.digest).not.toBe(first.digest);
    expect(await db('knowledge_story_versions')).toHaveLength(2);
    expect(await db('knowledge_story_page_versions')).toHaveLength(4);
    const firstVersionId = (await db('knowledge_story_versions').where({ version: 1 }).first('id'))
      ?.id;
    const storedPages = await db('knowledge_story_page_versions')
      .where({ story_version_id: firstVersionId })
      .orderBy('page_order', 'asc')
      .select('page_order', 'original_text', 'media_ref_json');
    expect(
      storedPages.map(({ page_order, original_text }) => ({ page_order, original_text }))
    ).toEqual([
      { page_order: 1, original_text: exactText },
      { page_order: 2, original_text: 'Synthetic second page: لا تُغيّر النص.' },
    ]);
    expect(storedPages[0]?.media_ref_json).toBeNull();
    expect(JSON.parse(String(storedPages[1]?.media_ref_json))).toEqual(webpMedia);
    const readFirst = await readStoryVersion(db, {
      authenticatedReader: { userId, companyId, role: 'superadmin' },
      storyId: first.storyId,
      version: 1,
      resolveMedia: resolveApprovedLocalMedia,
    });
    const readSecond = await readStoryVersion(db, {
      authenticatedReader: { userId, companyId, role: 'superadmin' },
      storyId: second.storyId,
      version: 2,
    });
    expect(readFirst?.story.pages[0]).toEqual({
      page_id: 'mw:story-page:synthetic-two-page-001',
      page_order: 1,
      original_text: exactText,
    });
    expect(readFirst?.story.pages[1]?.media).toEqual(webpMedia);
    expect(readSecond?.story.pages[0]?.original_text).toBe('Synthetic first page, revised.');
    expect(readSecond?.story.pages[1]?.media).toBeUndefined();
    expect(
      await readStoryVersion(db, {
        authenticatedReader: { userId, companyId, role: 'superadmin' },
        storyId: first.storyId,
        version: 1,
        resolveMedia: async () => null,
      })
    ).toBeNull();
    await expect(
      db('knowledge_story_versions').where({ version: 1 }).update({ visibility: 'PUBLIC' })
    ).rejects.toThrow('Knowledge story versions and pages are append-only');
    await expect(
      db('knowledge_story_page_versions').where({ page_order: 1 }).delete()
    ).rejects.toThrow('Knowledge story versions and pages are append-only');
  });

  it('rejects unstable order, missing or unpermitted media, gaps, and cross-company reads', async () => {
    const outOfOrder = story(1);
    outOfOrder.pages[1] = { ...outOfOrder.pages[1]!, page_order: 3 };
    expect(validateStoryVersion(outOfOrder).valid).toBe(false);
    const duplicatePage = story(1);
    duplicatePage.pages[1] = {
      ...duplicatePage.pages[1]!,
      page_id: duplicatePage.pages[0]!.page_id,
    };
    expect(validateStoryVersion(duplicatePage).valid).toBe(false);
    await expect(
      storeStoryVersion(db, {
        authenticatedActor: { userId, companyId, role: 'superadmin' },
        story: story(1),
      })
    ).rejects.toThrow(/verified local bytes/u);
    await expect(
      storeStoryVersion(db, {
        authenticatedActor: { userId, companyId, role: 'superadmin' },
        story: story(1),
        resolveMedia: async () => null,
      })
    ).rejects.toThrow(/verified local bytes/u);
    await storeStoryVersion(db, {
      authenticatedActor: { userId, companyId, role: 'superadmin' },
      story: story(1),
      resolveMedia: resolveApprovedLocalMedia,
    });
    await expect(
      storeStoryVersion(db, {
        authenticatedActor: { userId, companyId, role: 'superadmin' },
        story: story(3),
        resolveMedia: resolveApprovedLocalMedia,
      })
    ).rejects.toThrow(/next version/u);
    await expect(
      readStoryVersion(db, {
        authenticatedReader: { userId, companyId: companyId + 1, role: 'superadmin' },
        storyId: 'mw:story:synthetic-two-page',
      })
    ).rejects.toThrow(/unavailable in this company context/u);
    expect(await db('knowledge_story_versions')).toHaveLength(1);
  });
});
