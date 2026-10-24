import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { readQuranPassageSnapshot, readTextualWitnessPassageSnapshot } from '@moonwitness/corpus';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as workflowManifest } from '@moonwitness/orm-workflow';
import {
  manifest as knowledgeManifest,
  readConceptProfileVersion,
  storeConceptProfiles,
} from '../src/index.js';

let db: Knex;
let userId: number;
let companyId: number;
const corpusRootDirectory = path.resolve(process.cwd(), '../..');

function profile(id: string, scope = 'Synthetic, provisional scope.') {
  return {
    id: `mw:concept-profile:${id}`,
    concept_id: 'mw:concept:synthetic-concept',
    tradition: 'Synthetic test tradition',
    interpretive_scope: scope,
    epistemic_status: 'provisional',
    uncertainty: { level: 'high', note: 'Synthetic fixture with no interpretive claim.' },
    interpretations: [
      {
        claim_type: 'human_interpretation',
        text: 'Synthetic candidate only.',
        status: 'candidate',
        evidence_ids: [],
      },
    ],
  };
}

function input(document: unknown, overrides: Partial<{ userId: number; companyId: number }> = {}) {
  return {
    authenticatedActor: {
      userId: overrides.userId ?? userId,
      companyId: overrides.companyId ?? companyId,
      role: 'superadmin' as const,
    },
    corpusRootDirectory,
    document,
  };
}

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
    knowledgeManifest,
  ]);
  userId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
  companyId = Number((await db('companies').first('id'))?.id);
  await db('company_memberships')
    .insert({ user_id: userId, company_id: companyId, is_default: true })
    .onConflict(['user_id', 'company_id'])
    .ignore();
});

afterEach(async () => db.destroy());

describe('company-scoped immutable concept profile versions', () => {
  it('stores only verified source-span metadata for the two locally pinned samples', async () => {
    const samples = [
      await readQuranPassageSnapshot({
        rootDirectory: corpusRootDirectory,
        editionId: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
        locator: 'Q7:46',
        use: 'read_analyze',
      }).then(({ sourceId, passage }) => ({
        sourceId,
        editionId: passage.editionId,
        locator: passage.locator,
        contentSha256: passage.sha256,
        text: passage.text,
      })),
      await readTextualWitnessPassageSnapshot({
        rootDirectory: corpusRootDirectory,
        expressionId: 'mw:expression:webp-protestant',
        editionId: 'mw:edition:webp-protestant-2020-stable',
        locator: 'Genesis 1:1',
        use: 'read_analyze',
      }).then(({ passage }) => ({
        sourceId: passage.sourceId,
        editionId: passage.editionId,
        locator: passage.locator,
        contentSha256: passage.sha256,
        text: passage.text,
      })),
    ];

    for (const [index, sample] of samples.entries()) {
      const selected = Array.from(sample.text).slice(0, 1).join('');
      const observation = {
        id: `mw:text-observation:approved-sample-${index + 1}`,
        source_id: sample.sourceId,
        edition_id: sample.editionId,
        locator: sample.locator,
        content_sha256: sample.contentSha256,
        range: { unit: 'unicode_scalar' as const, start: 0, end: 1 },
        selected_text_sha256: createHash('sha256').update(selected, 'utf8').digest('hex'),
        review_status: 'unreviewed' as const,
      };
      const document = {
        format: 'moonwitness-concept-profiles/v1',
        profiles: [
          {
            ...profile(`verified-sample-${index + 1}`),
            textual_observations: [observation],
          },
        ],
      };
      const [stored] = await storeConceptProfiles(db, input(document));
      expect(stored).toMatchObject({ visibility: 'INTERNAL', version: 1 });
      const persisted = String(
        (
          await db('knowledge_concept_profile_versions')
            .where({ profile_id: stored!.profileId })
            .first('profile_json')
        )?.profile_json
      );
      expect(persisted).not.toContain(sample.text);
      expect(persisted).toContain(observation.selected_text_sha256);
      const persistedDocument = JSON.parse(persisted) as {
        profiles: Array<{ textual_observations: Array<Record<string, unknown>> }>;
      };
      expect(persistedDocument.profiles[0]!.textual_observations[0]).not.toHaveProperty('text');
    }
    expect(await db('knowledge_concept_profile_versions')).toHaveLength(2);
  });

  it('fails closed for source, edition, locator, and source-byte digest mismatches', async () => {
    const passage = await readQuranPassageSnapshot({
      rootDirectory: corpusRootDirectory,
      editionId: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
      locator: 'Q7:46',
      use: 'read_analyze',
    });
    const observation = {
      id: 'mw:text-observation:selector-mismatch',
      source_id: passage.sourceId,
      edition_id: passage.passage.editionId,
      locator: passage.passage.locator,
      content_sha256: passage.passage.sha256,
      range: { unit: 'unicode_scalar' as const, start: 0, end: 1 },
      selected_text_sha256: createHash('sha256')
        .update(Array.from(passage.passage.text)[0]!, 'utf8')
        .digest('hex'),
      review_status: 'unreviewed' as const,
    };
    const variants = [
      { ...observation, source_id: 'mw:source:unapproved-source' },
      { ...observation, edition_id: 'mw:edition:unapproved-edition' },
      { ...observation, locator: 'Q7:45' },
      { ...observation, content_sha256: '0'.repeat(64) },
    ];
    for (const [index, invalidObservation] of variants.entries()) {
      const document = {
        format: 'moonwitness-concept-profiles/v1',
        profiles: [
          {
            ...profile(`invalid-selector-${index + 1}`),
            textual_observations: [invalidObservation],
          },
        ],
      };
      await expect(storeConceptProfiles(db, input(document))).rejects.toThrow(
        /cannot safely resolve/u
      );
    }
    expect(await db('knowledge_concept_profile_versions')).toHaveLength(0);
  });

  it('stores INTERNAL snapshots, retries idempotently, and preserves divergent scopes and IDs', async () => {
    const firstDocument = {
      format: 'moonwitness-concept-profiles/v1',
      profiles: [profile('synthetic-a')],
    };
    const [first] = await storeConceptProfiles(db, input(firstDocument));
    const [retry] = await storeConceptProfiles(db, input(firstDocument));
    const [revision] = await storeConceptProfiles(
      db,
      input({
        format: 'moonwitness-concept-profiles/v1',
        profiles: [profile('synthetic-a', 'A different synthetic scope.')],
      })
    );
    const [divergent] = await storeConceptProfiles(
      db,
      input({
        format: 'moonwitness-concept-profiles/v1',
        profiles: [profile('synthetic-b', 'Another synthetic scope.')],
      })
    );

    expect(first).toMatchObject({ version: 1, visibility: 'INTERNAL', idempotent: false });
    expect(retry).toMatchObject({ version: 1, digest: first.digest, idempotent: true });
    expect(revision).toMatchObject({ version: 2, idempotent: false });
    expect(divergent).toMatchObject({ profileId: 'mw:concept-profile:synthetic-b', version: 1 });
    expect(await db('knowledge_concept_profile_versions')).toHaveLength(3);
    await expect(
      db('knowledge_concept_profile_versions').where({ id: 1 }).update({ profile_json: '{}' })
    ).rejects.toThrow();
    await expect(
      db('knowledge_concept_profile_versions').where({ id: 1 }).delete()
    ).rejects.toThrow();
  });

  it('reads only active company membership and revalidates integrity and schema', async () => {
    const document = {
      format: 'moonwitness-concept-profiles/v1',
      profiles: [profile('read-synthetic')],
    };
    await storeConceptProfiles(db, input(document));
    const read = await readConceptProfileVersion(db, {
      authenticatedReader: { userId, companyId, role: 'superadmin' },
      corpusRootDirectory,
      profileId: 'mw:concept-profile:read-synthetic',
    });
    expect(read).toMatchObject({ version: 1, visibility: 'INTERNAL', document });
    await expect(
      readConceptProfileVersion(db, {
        authenticatedReader: { userId, companyId: companyId + 1, role: 'superadmin' },
        corpusRootDirectory,
        profileId: 'mw:concept-profile:read-synthetic',
      })
    ).rejects.toThrow(/unavailable in this company context/u);
    await expect(
      db('knowledge_concept_profile_versions')
        .where({ profile_id: 'mw:concept-profile:read-synthetic' })
        .update({ profile_json: '{}' })
    ).rejects.toThrow(/append-only/u);
  });

  it('rejects schema-invalid input and inactive membership', async () => {
    await expect(
      storeConceptProfiles(db, input({ format: 'wrong', profiles: [] }))
    ).rejects.toThrow(/schema check/u);
    await db('company_memberships')
      .where({ user_id: userId, company_id: companyId })
      .update({ active: false });
    await expect(
      storeConceptProfiles(
        db,
        input({ format: 'moonwitness-concept-profiles/v1', profiles: [profile('inactive')] })
      )
    ).rejects.toThrow(/unavailable in this company context/u);
  });

  it('fails closed when an accepted profile lacks an exact profile-digest review binding', async () => {
    const accepted = profile('unreviewed-accepted');
    accepted.interpretations[0] = {
      claim_type: 'human_interpretation',
      text: 'Synthetic accepted claim must be backed by current review.',
      status: 'accepted',
      evidence_ids: ['mw:evidence:synthetic-missing'],
    };
    await expect(
      storeConceptProfiles(
        db,
        input({ format: 'moonwitness-concept-profiles/v1', profiles: [accepted] })
      )
    ).rejects.toThrow(/exact profile-digest review binding/u);
    expect(await db('knowledge_concept_profile_versions')).toHaveLength(0);
  });

  it('rejects duplicate profile IDs before persisting any profile from the document', async () => {
    await expect(
      storeConceptProfiles(
        db,
        input({
          format: 'moonwitness-concept-profiles/v1',
          profiles: [profile('duplicate-id'), profile('duplicate-id', 'Divergent scope.')],
        })
      )
    ).rejects.toThrow(/duplicate profile IDs/u);
    expect(await db('knowledge_concept_profile_versions')).toHaveLength(0);
  });

  it('rejects missing evidence references even on candidate interpretations', async () => {
    const candidate = profile('candidate-missing-evidence');
    candidate.interpretations[0] = {
      claim_type: 'human_interpretation',
      text: 'Synthetic candidate with a dangling citation.',
      status: 'candidate',
      evidence_ids: ['mw:evidence:synthetic-missing-candidate'],
    };
    await expect(
      storeConceptProfiles(
        db,
        input({ format: 'moonwitness-concept-profiles/v1', profiles: [candidate] })
      )
    ).rejects.toThrow(/evidence is missing or unreadable/u);
    expect(await db('knowledge_concept_profile_versions')).toHaveLength(0);
  });
});
