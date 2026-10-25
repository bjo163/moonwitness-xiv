import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { Model } from 'objection';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as workflowManifest, startWorkflow } from '@moonwitness/orm-workflow';
import { readQuranPassage, readTextualWitnessPassageSnapshot } from '@moonwitness/corpus';
import {
  activateResearchGraphRelease,
  applyPrivacyRevocation,
  createResearchGraphRelease,
  manifest,
  readActiveResearchGraphRelease,
  readConceptProfileVersion,
  readOwnedSyntheticWitness,
  appendOwnedSyntheticWitnessCorrection,
  readResearchReviewHistory,
  recordConceptProfileReviewDecision,
  recordTextualAlignmentCandidateReviewDecision,
  resolveConceptProfileEvidence,
  resolveConceptProfileReviewDecision,
  readTextualAlignmentCandidateVersion,
  resolveTextualAlignmentCandidateReviewDecision,
  readStoryEpisode,
  readStoryVersion,
  syntheticWitnessSubjectRefSha256,
  type StoryMediaReference,
  type WitnessCorrectionSourceResolver,
  ResearchGraphRecord,
  storeTextualAlignmentCandidates,
  storeStoryEpisode,
  storeStoryVersion,
  transitionResearchReview,
  storeConceptProfiles,
  WitnessCorrection,
  WitnessInterpretation,
  WitnessTestimony,
} from '../src/index.js';

const resolveCorrectionSource: WitnessCorrectionSourceResolver = async (reference) => ({
  ...reference,
  bytes_verified: true,
  rights_state: 'permitted',
  allowed_uses: ['read_analyze', 'quote_excerpt'],
});

const connectionString = process.env.POSTGRES_TEST_URL;
const postgresDescribe = connectionString ? describe : describe.skip;
const pilotScopeId = 'mw:concept:postgres-synthetic-pilot';
const pilotAssertionId = 'mw:assertion:postgres-synthetic-pilot';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pgStoryMedia: StoryMediaReference = {
  artifact_id: 'mw:artifact:webp-protestant-genesis-1-1',
  sha256: 'ae5c2799fad97b0e65334aa39be6193d487419f0d31713caaac58a47f6b4d8b1',
  media_type: 'text/plain; charset=utf-8',
  rights_ref: 'docs/roadmap/evidence/K2-006.md#source-and-rights',
};

function artifactSha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function resolvePgStoryMedia(reference: StoryMediaReference) {
  const manifest = JSON.parse(
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
    manifest.artifact.sha256 !== reference.sha256 ||
    manifest.artifact.media_type !== reference.media_type ||
    manifest.rights.evidence_ref !== reference.rights_ref ||
    manifest.rights.state !== 'permitted' ||
    !manifest.rights.allowed_uses.includes('store') ||
    bytes.byteLength !== manifest.artifact.byte_length ||
    artifactSha256(bytes) !== reference.sha256
  ) {
    return null;
  }
  return {
    ...reference,
    bytes_verified: true as const,
    rights_state: 'permitted' as const,
    allowed_uses: manifest.rights.allowed_uses,
  };
}

function syntheticAssertionContent(revision: number, claim: string) {
  return {
    id: pilotAssertionId,
    kind: 'Assertion',
    schema_version: 1,
    lifecycle: 'candidate',
    created_at: '2026-10-16T00:00:00Z',
    updated_at: '2026-10-16T00:00:00Z',
    origin_ref: 'fixture://postgres/synthetic-release',
    visibility: 'PUBLIC_APPROVED',
    content_revision: revision,
    claim,
    polarity: 'positive',
    scope: { kind: 'research_context', reference_id: pilotScopeId },
    context: { mode: 'analysis', reference_id: pilotScopeId },
    epistemic_status: 'hypothesized',
    review_status: 'pending',
  };
}

postgresDescribe('knowledge addon PostgreSQL integration', () => {
  const schema = `mw_knowledge_${randomUUID().replaceAll('-', '')}`;
  const applicationName = `mw_knowledge_test_${randomUUID().replaceAll('-', '')}`;
  let adminDb: Knex;
  let db: Knex;

  beforeAll(async () => {
    if (!connectionString) throw new Error('POSTGRES_TEST_URL is required');
    adminDb = knex({ client: 'pg', connection: connectionString, pool: { min: 0, max: 2 } });
    await adminDb.raw('select 1');
    await adminDb.raw('create schema ??', [schema]);
    const testConnection = new URL(connectionString);
    testConnection.searchParams.set('application_name', applicationName);
    db = knex({
      client: 'pg',
      connection: testConnection.toString(),
      searchPath: [schema],
      pool: { min: 0, max: 2 },
    });
  }, 30000);

  afterAll(async () => {
    if (db) await db.destroy();
    if (adminDb) {
      await adminDb.raw('drop schema if exists ?? cascade', [schema]);
      await adminDb.destroy();
    }
  });

  it('installs restricted records and blocks ORM and SQL mutation in an isolated schema', async () => {
    await installAddons(db, [manifest, baseManifest]);
    const testimony = await WitnessTestimony.query().findOne({
      external_key: 'synthetic-witness-001',
    });

    expect(testimony).toMatchObject({
      visibility: 'RESTRICTED',
      synthetic: true,
      received_time_text: 'spring',
      original_text: 'Synthetic example: the meeting began sometime in spring.',
    });
    expect(await WitnessCorrection.query().where('testimony_id', testimony?.id)).toHaveLength(1);
    expect(await WitnessInterpretation.query().where('testimony_id', testimony?.id)).toHaveLength(
      1
    );
    const superadmin = await db('users').where({ login: 'superadmin' }).first('id');
    const company = await db('companies').first('id');
    const ownerScopedFixture = await db('knowledge_witness_testimonies')
      .where({ external_key: 'synthetic-witness-scoped-001' })
      .first('id', 'company_id', 'synthetic');
    expect(superadmin && company && ownerScopedFixture).toBeTruthy();
    expect(ownerScopedFixture).toMatchObject({ synthetic: true });
    expect(Number(ownerScopedFixture?.company_id)).toBe(Number(company?.id));
    const scopedWitness = await readOwnedSyntheticWitness(
      db,
      {
        userId: Number(superadmin?.id),
        companyId: Number(company?.id),
        role: 'superadmin',
      },
      Number(ownerScopedFixture?.id)
    );
    expect(scopedWitness).toMatchObject({
      externalKey: 'synthetic-witness-scoped-001',
      corrections: [{ sequence: 1 }],
      interpretations: [{ epistemicStatus: 'hypothesis' }],
    });
    const scopedWitnessRow = await db('knowledge_witness_testimonies')
      .where({ id: ownerScopedFixture?.id })
      .first('external_key');
    const witnessSubjectHash = syntheticWitnessSubjectRefSha256(
      Number(company?.id),
      String(scopedWitnessRow?.external_key)
    );
    const projectionJson = JSON.stringify({ canary: 'synthetic witness projection' });
    await db('knowledge_privacy_projections').insert(
      [1, 2].map((sequence) => ({
        company_id: Number(company?.id),
        projection_key: `synthetic-witness-${sequence}-${randomUUID()}`,
        subject_ref_sha256: witnessSubjectHash,
        projection_json: projectionJson,
        projection_digest: artifactSha256(Buffer.from(projectionJson)),
        synthetic: true,
        visibility: 'RESTRICTED',
        state: 'active',
      }))
    );
    const lockId = randomInt(1, 2_000_000_000);
    await db.raw(`
      CREATE FUNCTION hold_witness_withdrawal()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${lockId});
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.raw(`
      CREATE TRIGGER hold_witness_withdrawal
      BEFORE UPDATE ON knowledge_privacy_projections
      FOR EACH ROW EXECUTE FUNCTION hold_witness_withdrawal()
    `);
    const gate = await adminDb.transaction();
    await gate.raw('SELECT pg_advisory_lock(?)', [lockId]);
    const withdrawal = applyPrivacyRevocation(db, {
      steward: {
        userId: Number(superadmin?.id),
        companyId: Number(company?.id),
        role: 'superadmin',
      },
      subjectRefSha256: witnessSubjectHash,
      consentDecisionRefSha256: artifactSha256(Buffer.from('synthetic consent fixture')),
      idempotencyKey: `witness-withdrawal-${randomUUID()}`,
    });
    let concurrentRead: Promise<Awaited<ReturnType<typeof readOwnedSyntheticWitness>>> | null =
      null;
    const waitForProjectionWaiters = async (minimum: number) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const result = await adminDb.raw(
          `SELECT count(*)::int AS count
           FROM pg_stat_activity
           WHERE wait_event_type = 'Lock'
             AND query LIKE '%knowledge_privacy_projections%'
             AND application_name = ?
             AND pid <> pg_backend_pid()`,
          [applicationName]
        );
        if (Number(result.rows[0]?.count) >= minimum) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Expected ${minimum} witness projection lock waiters`);
    };
    let lockWaitError: unknown;
    try {
      await waitForProjectionWaiters(1);
      concurrentRead = readOwnedSyntheticWitness(
        db,
        {
          userId: Number(superadmin?.id),
          companyId: Number(company?.id),
          role: 'superadmin',
        },
        Number(ownerScopedFixture?.id)
      );
      await waitForProjectionWaiters(2);
    } catch (error) {
      lockWaitError = error;
    } finally {
      await gate.raw('SELECT pg_advisory_unlock(?)', [lockId]);
      await gate.commit();
    }
    if (lockWaitError) {
      await Promise.allSettled([withdrawal, ...(concurrentRead ? [concurrentRead] : [])]);
      throw lockWaitError;
    }
    const [withdrawalResult, readResult] = await Promise.allSettled([
      withdrawal,
      concurrentRead as Promise<Awaited<ReturnType<typeof readOwnedSyntheticWitness>>>,
    ]);
    expect(withdrawalResult.status).toBe('fulfilled');
    expect(readResult).toMatchObject({ status: 'rejected', reason: { code: 'NOT_FOUND' } });
    await expect(
      readOwnedSyntheticWitness(
        db,
        {
          userId: Number(superadmin?.id),
          companyId: Number(company?.id),
          role: 'superadmin',
        },
        Number(ownerScopedFixture?.id)
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      await db('knowledge_witness_testimonies').where({ id: ownerScopedFixture?.id })
    ).toHaveLength(1);
    await expect(
      readOwnedSyntheticWitness(
        db,
        {
          userId: Number(superadmin?.id),
          companyId: Number(company?.id),
          role: 'superadmin',
        },
        Number(testimony?.id)
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const correction = await WitnessCorrection.query().findOne({ sequence: 1 });
    const interpretation = await WitnessInterpretation.query().first();
    await expect(WitnessTestimony.query().patch({ original_text: 'replacement' })).rejects.toThrow(
      'cannot be updated or deleted'
    );

    const rows = [
      { table: 'knowledge_witness_testimonies', id: testimony?.id, column: 'original_text' },
      { table: 'knowledge_witness_corrections', id: correction?.id, column: 'correction_text' },
      {
        table: 'knowledge_witness_interpretations',
        id: interpretation?.id,
        column: 'interpretation_text',
      },
    ] as const;
    for (const row of rows) {
      await expect(
        db(row.table)
          .where({ id: row.id })
          .update({ [row.column]: 'raw SQL replacement' })
      ).rejects.toThrow('Knowledge witness records are append-only');
      await expect(db(row.table).where({ id: row.id }).delete()).rejects.toThrow(
        'Knowledge witness records are append-only'
      );
    }

    const attempts = await Promise.allSettled(
      [1, 2].map(() =>
        db('knowledge_witness_corrections').insert({
          testimony_id: testimony?.id,
          sequence: 2,
          correction_text: 'Concurrent synthetic correction.',
          reason: 'Synthetic concurrent sequence test.',
          source_label: 'Synthetic test',
          source_locator: 'fixture://concurrent-correction',
          source_digest: 'c'.repeat(64),
          asserted_time_text: 'unknown',
          asserted_time_precision: 'unknown',
          recorded_by_id: correction?.recorded_by_id,
        })
      )
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(
      await WitnessCorrection.query().where({ testimony_id: testimony?.id, sequence: 2 })
    ).toHaveLength(1);
  }, 30000);

  it('serializes PostgreSQL correction appends and returns an exact retry idempotently', async () => {
    await installAddons(db, [manifest, baseManifest]);
    const actor = await db('users').where({ login: 'superadmin' }).first('id');
    const testimony = await db('knowledge_witness_testimonies')
      .where({ external_key: 'synthetic-witness-scoped-001' })
      .first('id', 'company_id');
    expect(actor && testimony).toBeTruthy();
    const steward = {
      userId: Number(actor?.id),
      companyId: Number(testimony?.company_id),
      role: 'superadmin',
    } as const;
    const input = {
      sequence: 2,
      correctionText: 'Synthetic PostgreSQL correction append.',
      reason: 'Synthetic transaction test.',
      sourceLabel: 'Synthetic test source',
      sourceLocator: 'fixture://postgres/correction-002',
      sourceDigest: 'f'.repeat(64),
      assertedTimeText: '2026',
      assertedTimePrecision: 'year' as const,
      resolveSource: resolveCorrectionSource,
    };
    const results = await Promise.allSettled([
      appendOwnedSyntheticWitnessCorrection(db, steward, Number(testimony?.id), input),
      appendOwnedSyntheticWitnessCorrection(db, steward, Number(testimony?.id), input),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(
      await db('knowledge_witness_corrections').where({
        testimony_id: testimony?.id,
        sequence: 2,
      })
    ).toHaveLength(1);
    const retry = await appendOwnedSyntheticWitnessCorrection(
      db,
      steward,
      Number(testimony?.id),
      input
    );
    expect(retry.idempotent).toBe(true);
    const competingPayloads = await Promise.allSettled([
      appendOwnedSyntheticWitnessCorrection(db, steward, Number(testimony?.id), {
        ...input,
        sequence: 3,
        correctionText: 'Synthetic PostgreSQL competing correction A.',
      }),
      appendOwnedSyntheticWitnessCorrection(db, steward, Number(testimony?.id), {
        ...input,
        sequence: 3,
        correctionText: 'Synthetic PostgreSQL competing correction B.',
      }),
    ]);
    expect(competingPayloads.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejectedCompetingPayloads = competingPayloads.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(rejectedCompetingPayloads).toHaveLength(1);
    expect(rejectedCompetingPayloads[0]?.reason).toMatchObject({
      message: 'Correction sequence already exists with a different payload',
    });
    const winningPayload = await db('knowledge_witness_corrections')
      .where({ testimony_id: testimony?.id, sequence: 3 })
      .first('correction_text');
    expect([
      'Synthetic PostgreSQL competing correction A.',
      'Synthetic PostgreSQL competing correction B.',
    ]).toContain(winningPayload?.correction_text);
  }, 30000);

  it('stores, activates, rolls back, and protects synthetic graph releases in PostgreSQL', async () => {
    await installAddons(db, [manifest, baseManifest]);
    const input = {
      corpusKey: 'postgres-synthetic-pilot',
      schemaVersion: 'research-graph/v1',
      records: [
        {
          key: pilotScopeId,
          kind: 'node' as const,
          visibility: 'INTERNAL' as const,
          content: {
            id: pilotScopeId,
            kind: 'Concept',
            identity_class: 'ConceptIdentity',
            visibility: 'INTERNAL',
          },
        },
        {
          key: pilotAssertionId,
          kind: 'assertion' as const,
          visibility: 'PUBLIC' as const,
          content: syntheticAssertionContent(1, 'Synthetic PostgreSQL pilot record.'),
        },
      ],
    };
    const first = await db.transaction((trx) => createResearchGraphRelease(trx, input));
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey: input.corpusKey,
        releaseDigest: first.releaseDigest,
        expectedCurrentReleaseDigest: null,
        activatedAt: new Date().toISOString(),
      })
    );
    const second = await db.transaction((trx) =>
      createResearchGraphRelease(trx, {
        ...input,
        previousReleaseDigest: first.releaseDigest,
        records: input.records.map((record) =>
          record.key === pilotAssertionId
            ? {
                ...record,
                content: syntheticAssertionContent(2, 'Synthetic PostgreSQL pilot revision.'),
              }
            : record
        ),
      })
    );
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey: input.corpusKey,
        releaseDigest: second.releaseDigest,
        expectedCurrentReleaseDigest: first.releaseDigest,
        activatedAt: new Date().toISOString(),
      })
    );
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey: input.corpusKey,
        releaseDigest: first.releaseDigest,
        expectedCurrentReleaseDigest: second.releaseDigest,
        activatedAt: new Date().toISOString(),
      })
    );
    await expect(
      db.transaction((trx) => readActiveResearchGraphRelease(trx, input.corpusKey))
    ).resolves.toMatchObject({ releaseDigest: first.releaseDigest });

    const releaseRow = await db('knowledge_research_graph_releases')
      .where({ release_digest: first.releaseDigest })
      .first();
    const recordRow = await db('knowledge_research_graph_records')
      .where({ release_id: releaseRow.id })
      .first();
    await expect(
      db('knowledge_research_graph_releases')
        .where({ id: releaseRow.id })
        .update({ record_count: 7 })
    ).rejects.toThrow('Knowledge witness records are append-only');
    await expect(
      db('knowledge_research_graph_records').where({ id: recordRow.id }).delete()
    ).rejects.toThrow('Knowledge witness records are append-only');
  }, 30000);

  it('serializes immutable company-scoped concept profile versions in PostgreSQL', async () => {
    await installAddons(db, [baseManifest, manifest]);
    const userId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
    const companyId = Number((await db('companies').first('id'))?.id);
    if (!userId || !companyId) throw new Error('Required synthetic profile actor is missing');
    await db('company_memberships')
      .insert({ user_id: userId, company_id: companyId, is_default: true })
      .onConflict(['user_id', 'company_id'])
      .ignore();
    const sourcePassage = await readTextualWitnessPassageSnapshot({
      rootDirectory: repoRoot,
      expressionId: 'mw:expression:webp-protestant',
      editionId: 'mw:edition:webp-protestant-2020-stable',
      locator: 'Genesis 1:1',
      use: 'read_analyze',
    });
    const selectedText = Array.from(sourcePassage.passage.text)[0];
    if (selectedText === undefined) throw new Error('Approved source sample has no text');
    const selectedTextSha256 = createHash('sha256').update(selectedText, 'utf8').digest('hex');
    const document = {
      format: 'moonwitness-concept-profiles/v1',
      profiles: [
        {
          id: 'mw:concept-profile:pg-synthetic-profile',
          concept_id: 'mw:concept:pg-synthetic-concept',
          tradition: 'Synthetic PostgreSQL test tradition',
          interpretive_scope: 'Synthetic provisional scope only.',
          epistemic_status: 'provisional',
          uncertainty: { level: 'high', note: 'No interpretation is asserted.' },
          interpretations: [
            {
              claim_type: 'human_interpretation',
              text: 'Synthetic candidate only.',
              status: 'candidate',
              evidence_ids: [],
            },
          ],
          textual_observations: [
            {
              id: 'mw:text-observation:pg-webp-genesis-1-1',
              source_id: sourcePassage.passage.sourceId,
              edition_id: sourcePassage.passage.editionId,
              locator: sourcePassage.passage.locator,
              content_sha256: sourcePassage.passage.sha256,
              range: { unit: 'unicode_scalar', start: 0, end: 1 },
              selected_text_sha256: selectedTextSha256,
              review_status: 'unreviewed',
            },
          ],
        },
      ],
    };
    const actor = { userId, companyId, role: 'superadmin' as const };
    const corpusRootDirectory = path.resolve(process.cwd(), '../..');
    const parallel = await Promise.all([
      storeConceptProfiles(db, { authenticatedActor: actor, corpusRootDirectory, document }),
      storeConceptProfiles(db, { authenticatedActor: actor, corpusRootDirectory, document }),
    ]);
    expect(parallel.flat().map((entry) => entry.version)).toEqual([1, 1]);
    expect(parallel.flat().filter((entry) => entry.idempotent)).toHaveLength(1);
    const acceptedDocument = structuredClone(document);
    acceptedDocument.profiles[0]!.interpretations[0] = {
      claim_type: 'human_interpretation',
      text: 'Synthetic claim that has no profile-level review binding.',
      status: 'accepted',
      evidence_ids: ['mw:evidence:pg-synthetic-placeholder'],
    };
    await expect(
      storeConceptProfiles(db, {
        authenticatedActor: actor,
        corpusRootDirectory,
        document: acceptedDocument,
      })
    ).rejects.toThrow('exact profile-digest review binding');
    const duplicateDocument = {
      format: 'moonwitness-concept-profiles/v1',
      profiles: [
        document.profiles[0],
        { ...document.profiles[0], interpretive_scope: 'Divergent synthetic scope.' },
      ],
    };
    await expect(
      storeConceptProfiles(db, {
        authenticatedActor: actor,
        corpusRootDirectory,
        document: duplicateDocument,
      })
    ).rejects.toThrow('duplicate profile IDs');
    const missingEvidenceDocument = structuredClone(document);
    missingEvidenceDocument.profiles[0]!.id = 'mw:concept-profile:pg-missing-evidence';
    missingEvidenceDocument.profiles[0]!.interpretations[0]!.evidence_ids = [
      'mw:evidence:pg-synthetic-missing-candidate',
    ];
    await expect(
      storeConceptProfiles(db, {
        authenticatedActor: actor,
        corpusRootDirectory,
        document: missingEvidenceDocument,
      })
    ).rejects.toThrow('Concept profile evidence is missing or unreadable');
    const read = await readConceptProfileVersion(db, {
      authenticatedReader: actor,
      corpusRootDirectory,
      profileId: 'mw:concept-profile:pg-synthetic-profile',
    });
    expect(read).toMatchObject({ version: 1, visibility: 'INTERNAL', document });
    await expect(
      readConceptProfileVersion(db, {
        authenticatedReader: { ...actor, companyId: companyId + 1000 },
        corpusRootDirectory,
        profileId: 'mw:concept-profile:pg-synthetic-profile',
      })
    ).rejects.toThrow('unavailable in this company context');
    await db('partners').insert({
      name: 'Synthetic PostgreSQL profile reviewer',
      company_id: companyId,
      is_company: false,
    });
    await db('users').insert({
      login: 'pg-profile-reviewer',
      partner_id: (
        await db('partners').where({ name: 'Synthetic PostgreSQL profile reviewer' }).first('id')
      )?.id,
      role: 'user',
    });
    const reviewerId = Number(
      (await db('users').where({ login: 'pg-profile-reviewer' }).first('id'))?.id
    );
    await db('company_memberships').insert({
      user_id: reviewerId,
      company_id: companyId,
      is_default: false,
    });
    const pgDecision = await recordConceptProfileReviewDecision(db, {
      authenticatedReviewer: { userId: reviewerId, companyId, role: 'user' },
      profileId: 'mw:concept-profile:pg-synthetic-profile',
      proposalProfile: acceptedDocument.profiles[0],
      outcome: 'accepted',
      rationale: 'Synthetic PostgreSQL review of the accepted wording.',
    });
    await expect(
      resolveConceptProfileReviewDecision(db, {
        authenticatedReader: { userId: reviewerId, companyId, role: 'user' },
        profileId: pgDecision.profile_id,
        profileDigest: pgDecision.profile_digest,
      })
    ).resolves.toMatchObject({ id: pgDecision.id, outcome: 'accepted' });
    const decisionRowId = Number(
      (
        await db('knowledge_concept_profile_review_decisions')
          .where({ profile_digest: pgDecision.profile_digest })
          .first('id')
      )?.id
    );
    await expect(
      db('knowledge_concept_profile_review_decisions')
        .where({ id: decisionRowId })
        .update({ outcome: 'rejected' })
    ).rejects.toThrow('Concept profile review decisions are append-only');
    await expect(
      db('knowledge_concept_profile_review_decisions').where({ id: decisionRowId }).delete()
    ).rejects.toThrow('Concept profile review decisions are append-only');
    await expect(
      db('knowledge_concept_profile_versions')
        .where({ profile_id: 'mw:concept-profile:pg-synthetic-profile' })
        .delete()
    ).rejects.toThrow('Knowledge concept profiles are append-only');
  }, 30000);

  it('persists tenant-scoped INTERNAL textual alignment candidate versions in PostgreSQL', async () => {
    await installAddons(db, [baseManifest, manifest]);
    const userId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
    const companyId = Number((await db('companies').first('id'))?.id);
    if (!userId || !companyId) throw new Error('Required synthetic alignment actor is missing');
    await db('company_memberships')
      .insert({ user_id: userId, company_id: companyId, is_default: true })
      .onConflict(['user_id', 'company_id'])
      .ignore();
    const actor = { userId, companyId, role: 'superadmin' as const };
    const passages = [
      {
        evidence_id: 'mw:evidence:pg-alignment-left',
        tradition_context_id: 'mw:tradition:synthetic-left',
        source_id: 'mw:source:synthetic-left',
        expression_id: 'mw:expression:synthetic-left',
        edition_id: 'mw:edition:synthetic-left-v1',
        locator: 'synthetic:left:1',
        text: 'Synthetic PostgreSQL alignment passage left.',
      },
      {
        evidence_id: 'mw:evidence:pg-alignment-right',
        tradition_context_id: 'mw:tradition:synthetic-right',
        source_id: 'mw:source:synthetic-right',
        expression_id: 'mw:expression:synthetic-right',
        edition_id: 'mw:edition:synthetic-right-v1',
        locator: 'synthetic:right:1',
        text: 'Synthetic PostgreSQL alignment passage right.',
      },
    ].map((passage) => {
      const quote = passage.text;
      return {
        evidence_id: passage.evidence_id,
        tradition_context_id: passage.tradition_context_id,
        source_id: passage.source_id,
        expression_id: passage.expression_id,
        edition_id: passage.edition_id,
        locator: passage.locator,
        content_sha256: createHash('sha256').update(passage.text, 'utf8').digest('hex'),
        range: { unit: 'unicode_scalar' as const, start: 0, end: Array.from(quote).length },
        quote,
        text: passage.text,
      };
    });
    const resolvePassage = async (evidenceId: string) =>
      passages.find((passage) => passage.evidence_id === evidenceId) ?? null;
    const candidate = (note = 'Synthetic only; review subject intentionally unresolved.') => ({
      id: 'mw:textual-alignment-candidate:pg-synthetic-pair',
      left: {
        evidence_id: passages[0]!.evidence_id,
        selector: {
          source_id: passages[0]!.source_id,
          expression_id: passages[0]!.expression_id,
          edition_id: passages[0]!.edition_id,
          locator: passages[0]!.locator,
          content_sha256: passages[0]!.content_sha256,
          range: passages[0]!.range,
          quote: passages[0]!.quote,
        },
      },
      right: {
        evidence_id: passages[1]!.evidence_id,
        selector: {
          source_id: passages[1]!.source_id,
          expression_id: passages[1]!.expression_id,
          edition_id: passages[1]!.edition_id,
          locator: passages[1]!.locator,
          content_sha256: passages[1]!.content_sha256,
          range: passages[1]!.range,
          quote: passages[1]!.quote,
        },
      },
      similarity_score: 0.42,
      method: { id: 'mw:alignment-method:synthetic', version: '1.0.0' },
      uncertainty: { level: 'high', note },
    });
    const input = { authenticatedActor: actor, resolvePassage, candidates: [candidate()] };
    const parallel = await Promise.all([
      storeTextualAlignmentCandidates(db, input),
      storeTextualAlignmentCandidates(db, input),
    ]);
    expect(parallel.flat().map((entry) => entry.version)).toEqual([1, 1]);
    expect(parallel.flat().filter((entry) => entry.idempotent)).toHaveLength(1);
    const [changed] = await storeTextualAlignmentCandidates(db, {
      ...input,
      candidates: [candidate('Changed synthetic uncertainty; still unreviewed.')],
    });
    expect(changed).toMatchObject({ version: 2, visibility: 'INTERNAL', idempotent: false });
    expect(changed!.candidate.left).not.toHaveProperty('text');
    expect(
      await readTextualAlignmentCandidateVersion(db, {
        authenticatedReader: actor,
        candidateId: 'mw:textual-alignment-candidate:pg-synthetic-pair',
      })
    ).toMatchObject({ version: 2, visibility: 'INTERNAL' });
    await expect(
      readTextualAlignmentCandidateVersion(db, {
        authenticatedReader: { ...actor, companyId: companyId + 1000 },
        candidateId: 'mw:textual-alignment-candidate:pg-synthetic-pair',
      })
    ).rejects.toThrow('unavailable in this company context');
    await db('partners').insert({
      name: 'Synthetic PostgreSQL alignment reviewer',
      company_id: companyId,
      is_company: false,
    });
    await db('users').insert({
      login: 'pg-alignment-reviewer',
      partner_id: (
        await db('partners').where({ name: 'Synthetic PostgreSQL alignment reviewer' }).first('id')
      )?.id,
      role: 'user',
    });
    const alignmentReviewerId = Number(
      (await db('users').where({ login: 'pg-alignment-reviewer' }).first('id'))?.id
    );
    await db('company_memberships').insert({
      user_id: alignmentReviewerId,
      company_id: companyId,
      is_default: false,
    });
    const candidateDecision = await recordTextualAlignmentCandidateReviewDecision(db, {
      authenticatedReviewer: { userId: alignmentReviewerId, companyId, role: 'user' },
      candidateId: 'mw:textual-alignment-candidate:pg-synthetic-pair',
      outcome: 'accepted',
      rationale: 'Synthetic PostgreSQL review of the citation-only pairing.',
    });
    await expect(
      resolveTextualAlignmentCandidateReviewDecision(db, {
        authenticatedReader: { userId: alignmentReviewerId, companyId, role: 'user' },
        candidateId: candidateDecision.candidate_id,
        candidateDigest: candidateDecision.candidate_digest,
      })
    ).resolves.toMatchObject({ id: candidateDecision.id, reviewed_version: 2 });
    const candidateDecisionRowId = Number(
      (
        await db('knowledge_textual_alignment_candidate_review_decisions')
          .where({ candidate_digest: candidateDecision.candidate_digest })
          .first('id')
      )?.id
    );
    await expect(
      db('knowledge_textual_alignment_candidate_review_decisions')
        .where({ id: candidateDecisionRowId })
        .update({ outcome: 'rejected' })
    ).rejects.toThrow('Textual alignment candidate review decisions are append-only');
    await expect(
      db('knowledge_textual_alignment_candidate_review_decisions')
        .where({ id: candidateDecisionRowId })
        .delete()
    ).rejects.toThrow('Textual alignment candidate review decisions are append-only');
    await expect(
      db('knowledge_textual_alignment_candidate_versions')
        .where({ candidate_id: 'mw:textual-alignment-candidate:pg-synthetic-pair' })
        .delete()
    ).rejects.toThrow('Knowledge textual alignment candidates are append-only');
  }, 30000);

  it('persists exact two-page story versions atomically in PostgreSQL', async () => {
    await installAddons(db, [baseManifest, manifest]);
    const userId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
    const companyId = Number((await db('companies').first('id'))?.id);
    if (!userId || !companyId) throw new Error('Required synthetic story actor is missing');
    await db('company_memberships')
      .insert({ user_id: userId, company_id: companyId, is_default: true })
      .onConflict(['user_id', 'company_id'])
      .ignore();
    const actor = { userId, companyId, role: 'superadmin' as const };
    const firstText = 'Synthetic PG page one.\r\nKeep exact spacing.  ';
    const story = (version: number, text: string) => ({
      schema_version: 1 as const,
      story_id: 'mw:story:pg-synthetic-two-page',
      version,
      title: 'Synthetic PostgreSQL two-page story',
      visibility: 'INTERNAL' as const,
      pages: [
        {
          page_id: 'mw:story-page:pg-synthetic-two-page-001',
          page_order: 1,
          original_text: text,
        },
        {
          page_id: 'mw:story-page:pg-synthetic-two-page-002',
          page_order: 2,
          original_text: 'Synthetic page two: Arabic علامة.',
          ...(version === 1 ? { media: pgStoryMedia } : {}),
        },
      ],
    });
    const first = await storeStoryVersion(db, {
      authenticatedActor: actor,
      story: story(1, firstText),
      resolveMedia: resolvePgStoryMedia,
    });
    const second = await storeStoryVersion(db, {
      authenticatedActor: actor,
      story: story(2, 'Synthetic PG page one, version two.'),
    });
    const read = await readStoryVersion(db, {
      authenticatedReader: actor,
      storyId: first.storyId,
      version: 1,
      resolveMedia: resolvePgStoryMedia,
    });
    expect(first).toMatchObject({ version: 1, visibility: 'INTERNAL' });
    expect(second).toMatchObject({ version: 2, previousDigest: first.digest });
    expect(read?.story.pages.map((page) => [page.page_order, page.original_text])).toEqual([
      [1, firstText],
      [2, 'Synthetic page two: Arabic علامة.'],
    ]);
    expect(read?.story.pages[1]?.media).toEqual(pgStoryMedia);
    const versionTwo = await readStoryVersion(db, {
      authenticatedReader: actor,
      storyId: first.storyId,
      version: 2,
    });
    expect(versionTwo?.story.pages[1]?.media).toBeUndefined();
    expect(await db('knowledge_story_versions')).toHaveLength(2);
    expect(await db('knowledge_story_page_versions')).toHaveLength(4);
    const storedMedia = await db('knowledge_story_page_versions')
      .where({
        story_version_id: (await db('knowledge_story_versions').where({ version: 1 }).first('id'))
          ?.id,
      })
      .whereNotNull('media_ref_json')
      .first('media_ref_json');
    expect(JSON.parse(String(storedMedia?.media_ref_json))).toEqual(pgStoryMedia);
    const pgEpisode = await storeStoryEpisode(db, {
      authenticatedActor: actor,
      episode: {
        schema_version: 1,
        episode_id: 'mw:story-episode:pg-synthetic-part-one',
        version: 1,
        title: 'Synthetic PostgreSQL episode one',
        visibility: 'INTERNAL',
        story_id: first.storyId,
        story_version: 1,
        story_digest: first.digest,
        first_page_order: 1,
        last_page_order: 2,
      },
      resolveMedia: resolvePgStoryMedia,
    });
    expect(pgEpisode.pages.map((page) => [page.page_order, page.original_text])).toEqual([
      [1, firstText],
      [2, 'Synthetic page two: Arabic علامة.'],
    ]);
    expect(
      await readStoryEpisode(db, {
        authenticatedReader: actor,
        episodeId: pgEpisode.episodeId,
        resolveMedia: resolvePgStoryMedia,
      })
    ).toMatchObject({ version: 1, previousDigest: null, idempotent: false });
    expect(await db('knowledge_story_episode_versions')).toHaveLength(1);
    await expect(
      db('knowledge_story_episode_versions')
        .where({ episode_id: pgEpisode.episodeId, version: 1 })
        .delete()
    ).rejects.toThrow('Knowledge story episodes are append-only');
    await expect(
      db('knowledge_story_versions').where({ story_id: first.storyId, version: 1 }).update({
        visibility: 'PUBLIC',
      })
    ).rejects.toThrow('Knowledge story versions and pages are append-only');
  }, 30000);

  it('commits and replays a review decision atomically with the PostgreSQL workflow event', async () => {
    Model.knex(db);
    await installAddons(db, [
      baseManifest,
      jobsManifest,
      notificationManifest,
      workflowManifest,
      manifest,
    ]);
    const systemId = Number((await db('users').where({ login: 'system' }).first('id'))?.id);
    const reviewerId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
    const companyId = Number((await db('companies').first('id'))?.id);
    if (!systemId || !reviewerId || !companyId)
      throw new Error('Required synthetic actors are missing');
    await db('company_memberships')
      .insert({ user_id: reviewerId, company_id: companyId, is_default: true })
      .onConflict(['user_id', 'company_id'])
      .ignore();
    await db('knowledge_research_actor_identities').insert([
      { user_id: systemId, canonical_user_id: 'mw:user:pg-synthetic-requester' },
      { user_id: reviewerId, canonical_user_id: 'mw:user:pg-synthetic-reviewer' },
    ]);

    const corpusRootDirectory = path.resolve(process.cwd(), '../..');
    const editionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
    const sourceId = 'mw:source:tanzil-quran-text';
    const subjectId = 'mw:assertion:pg-review-adapter-fixture';
    const evidenceId = 'mw:evidence:pg-review-adapter-quran-746';
    const scopeId = 'mw:concept:pg-review-adapter-fixture';
    const passage = await readQuranPassage({
      rootDirectory: corpusRootDirectory,
      editionId,
      locator: 'Q7:46',
      use: 'read_analyze',
    });
    const releaseInput = {
      corpusKey: 'research',
      schemaVersion: 'research-graph/v1',
      records: [
        {
          key: sourceId,
          kind: 'source' as const,
          visibility: 'PUBLIC' as const,
          content: { id: sourceId, kind: 'Artifact', visibility: 'PUBLIC_APPROVED' },
        },
        {
          key: editionId,
          kind: 'expression' as const,
          visibility: 'PUBLIC' as const,
          content: { id: editionId, kind: 'Edition', visibility: 'PUBLIC_APPROVED' },
        },
        {
          key: scopeId,
          kind: 'node' as const,
          visibility: 'INTERNAL' as const,
          content: {
            id: scopeId,
            kind: 'Concept',
            identity_class: 'ConceptIdentity',
            visibility: 'INTERNAL',
          },
        },
        {
          key: subjectId,
          kind: 'assertion' as const,
          visibility: 'PUBLIC' as const,
          content: {
            id: subjectId,
            kind: 'Assertion',
            schema_version: 1,
            lifecycle: 'candidate',
            created_at: '2026-10-16T00:00:00.000Z',
            updated_at: '2026-10-16T00:00:00.000Z',
            origin_ref: 'fixture://postgres/review-adapter',
            visibility: 'PUBLIC_APPROVED',
            content_revision: 1,
            claim: 'Synthetic adapter test fixture; no claim is made about the selected passage.',
            polarity: 'positive',
            scope: { kind: 'research_context', reference_id: scopeId },
            context: { mode: 'analysis', reference_id: scopeId },
            epistemic_status: 'hypothesized',
            review_status: 'pending',
          },
        },
        {
          key: evidenceId,
          kind: 'evidence' as const,
          visibility: 'INTERNAL' as const,
          content: {
            id: evidenceId,
            kind: 'Evidence',
            visibility: 'INTERNAL',
            assertion_id: subjectId,
            direction: 'supporting',
            selector: {
              source_id: sourceId,
              edition_id: editionId,
              locator: 'Q7:46',
              content_sha256: passage.sha256,
            },
          },
        },
      ],
    };
    const release = await db.transaction((trx) => createResearchGraphRelease(trx, releaseInput));
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey: releaseInput.corpusKey,
        releaseDigest: release.releaseDigest,
        expectedCurrentReleaseDigest: null,
        activatedAt: '2026-10-16T00:00:01.000Z',
      })
    );
    const activeRecord = await db('knowledge_research_graph_records')
      .join(
        'knowledge_research_active_releases',
        'knowledge_research_active_releases.release_id',
        'knowledge_research_graph_records.release_id'
      )
      .where({
        'knowledge_research_active_releases.corpus_key': releaseInput.corpusKey,
        'knowledge_research_graph_records.record_key': subjectId,
      })
      .first('knowledge_research_graph_records.id');
    if (!activeRecord) throw new Error('Active synthetic research subject is missing');

    await db('workflow_definitions').insert({
      code: 'research.review',
      version: 1,
      name: 'Synthetic PostgreSQL research review',
      config: JSON.stringify({
        startState: 'submitted',
        startRoles: ['system'],
        timeoutMinutes: 1440,
        resourceModels: [ResearchGraphRecord.modelName],
        transitions: [
          {
            action: 'approve',
            from: 'submitted',
            to: 'approved',
            roles: ['user', 'superadmin'],
            requireDifferentActor: true,
          },
          {
            action: 'reject',
            from: 'submitted',
            to: 'rejected',
            roles: ['user', 'superadmin'],
            requireDifferentActor: true,
          },
        ],
      }),
      enabled: true,
    });

    const start = async (key: string) =>
      startWorkflow(db, {
        code: 'research.review',
        companyId,
        actorId: systemId,
        role: 'system',
        resourceModel: ResearchGraphRecord.modelName,
        resourceId: Number(activeRecord.id),
        idempotencyKey: key,
        now: new Date('2026-10-16T00:01:00.000Z'),
      });
    const review = async (instanceId: number, key: string) =>
      transitionResearchReview(db, {
        instanceId,
        authenticatedReviewer: { userId: reviewerId, companyId, role: 'superadmin' },
        action: 'approve',
        expectedWorkflowRevision: 0,
        subjectId,
        expectedSubjectRevision: 1,
        evidenceIds: [evidenceId],
        idempotencyKey: key,
        corpusRootDirectory,
        now: new Date('2026-10-16T00:02:00.000Z'),
      });

    const started = await start('pg-review-start-primary-01');
    const completed = await review(started.id, 'pg-review-action-primary-01');
    expect(completed).toMatchObject({ status: 'completed', currentState: 'approved', revision: 1 });
    const workflowEvent = await db('workflow_events')
      .where({ instance_id: started.id, sequence: 1 })
      .first('payload');
    const reviewRow = await db('knowledge_research_review_events')
      .where({ workflow_instance_id: started.id, workflow_event_sequence: 1 })
      .first();
    expect(JSON.parse(String(workflowEvent?.payload))).toMatchObject({
      event: {
        subject_id: subjectId,
        subject_revision: 1,
        research_release_digest: release.releaseDigest,
        workflow_instance_id: started.id,
        reviewer_id: 'mw:user:pg-synthetic-reviewer',
        requester_id: 'mw:user:pg-synthetic-requester',
        visibility: 'INTERNAL',
      },
    });
    expect(JSON.parse(String(reviewRow?.event_json))).toMatchObject({
      subject_id: subjectId,
      workflow_event_sequence: 1,
      workflow_revision: 1,
      research_release_digest: release.releaseDigest,
    });
    await expect(readResearchReviewHistory(db, { subjectId, companyId })).resolves.toMatchObject({
      truncated: false,
      events: [
        {
          subject_id: subjectId,
          research_release_digest: release.releaseDigest,
          workflow_instance_id: started.id,
        },
      ],
    });
    await expect(review(started.id, 'pg-review-action-primary-01')).resolves.toMatchObject({
      revision: 1,
      status: 'completed',
    });
    expect(await db('knowledge_research_review_events')).toHaveLength(1);
    expect(
      await db('workflow_events').where({ instance_id: started.id, sequence: 1 })
    ).toHaveLength(1);

    const failed = await start('pg-review-start-rollback-01');
    await db.raw(`
      CREATE OR REPLACE FUNCTION mw_test_fail_research_review_insert()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected PostgreSQL review persistence failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.raw(`
      CREATE TRIGGER mw_test_fail_research_review_insert
      BEFORE INSERT ON knowledge_research_review_events
      FOR EACH ROW EXECUTE FUNCTION mw_test_fail_research_review_insert()
    `);
    await expect(review(failed.id, 'pg-review-action-rollback-01')).rejects.toThrow(
      'injected PostgreSQL review persistence failure'
    );
    expect(
      await db('workflow_instances').where({ id: failed.id }).first('revision', 'status')
    ).toMatchObject({
      revision: 0,
      status: 'active',
    });
    expect(await db('workflow_approvals').where({ instance_id: failed.id })).toHaveLength(0);
    expect(await db('workflow_events').where({ instance_id: failed.id, sequence: 1 })).toHaveLength(
      0
    );
    expect(
      await db('knowledge_research_review_events').where({ workflow_instance_id: failed.id })
    ).toHaveLength(0);
    await db.raw(
      'DROP TRIGGER IF EXISTS mw_test_fail_research_review_insert ON knowledge_research_review_events'
    );

    const tampered = await start('pg-review-start-tampered-01');
    await review(tampered.id, 'pg-review-action-tampered-01');
    const tamperedPayload = await db('workflow_events')
      .where({ instance_id: tampered.id, sequence: 1 })
      .first('payload');
    const envelope = JSON.parse(String(tamperedPayload?.payload)) as Record<string, unknown>;
    await db.raw('DROP TRIGGER IF EXISTS workflow_events_append_only ON workflow_events');
    await db('workflow_events')
      .where({ instance_id: tampered.id, sequence: 1 })
      .update({
        payload: JSON.stringify({
          ...envelope,
          event: { ...(envelope.event as object), outcome: 'rejected' },
        }),
      });
    await expect(review(tampered.id, 'pg-review-action-tampered-01')).rejects.toMatchObject({
      code: 'INVALID_EVENT_PAYLOAD',
    });
    await expect(readResearchReviewHistory(db, { subjectId, companyId })).rejects.toMatchObject({
      code: 'INVALID_EVENT_PAYLOAD',
    });
    await expect(
      resolveConceptProfileEvidence(db, evidenceId, {
        authenticatedReader: { userId: reviewerId, companyId, role: 'superadmin' },
        corpusRootDirectory,
      })
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    await db.raw(`
      CREATE TRIGGER workflow_events_append_only
      BEFORE UPDATE OR DELETE ON workflow_events
      FOR EACH ROW EXECUTE FUNCTION moonwitness_reject_workflow_event_mutation()
    `);

    await expect(
      db('knowledge_research_review_events')
        .where({ workflow_instance_id: started.id })
        .update({ event_json: '{}' })
    ).rejects.toThrow('Knowledge witness records are append-only');
    await expect(
      db('knowledge_research_review_events').where({ workflow_instance_id: started.id }).delete()
    ).rejects.toThrow('Knowledge witness records are append-only');
  }, 30000);
});
