import { createHash } from 'node:crypto';
import {
  authorizesConceptProfile,
  mintConceptProfileReviewDecision,
  validateConceptProfile,
  validateConceptProfileTextualObservations,
  type ConceptProfileReviewDecision,
  type TrustedConceptEvidenceResolution,
} from '@moonwitness/research';
import type { Knex } from 'knex';
import { readQuranPassageSnapshot, readTextualWitnessPassageSnapshot } from '@moonwitness/corpus';
import { canonicalResearchJson } from './research-release.js';
import {
  resolveConceptProfileEvidence,
  type AuthenticatedResearchReviewer,
} from './research-review.js';

const profileIdPattern = /^mw:concept-profile:[a-z0-9][a-z0-9._-]{0,179}$/u;
const conceptIdPattern = /^mw:concept:[a-z0-9][a-z0-9._-]{0,179}$/u;
const quranSourceId = 'mw:source:tanzil-quran-text';
const quranEditionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
const webpSourceId = 'mw:source:ebible-webp-protestant';
const webpEditionId = 'mw:edition:webp-protestant-2020-stable';
const webpExpressionId = 'mw:expression:webp-protestant';

export interface StoreConceptProfilesInput {
  readonly authenticatedActor: AuthenticatedResearchReviewer;
  readonly corpusRootDirectory: string;
  readonly document: unknown;
}

export interface ReadConceptProfileInput {
  readonly authenticatedReader: AuthenticatedResearchReviewer;
  readonly corpusRootDirectory: string;
  readonly profileId: string;
  readonly version?: number;
}

export interface StoredConceptProfileVersion {
  readonly profileId: string;
  readonly conceptId: string;
  readonly version: number;
  readonly digest: string;
  readonly visibility: 'INTERNAL';
  readonly document: unknown;
  readonly idempotent: boolean;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validActor(actor: AuthenticatedResearchReviewer): boolean {
  return (
    Number.isSafeInteger(actor.userId) &&
    actor.userId > 0 &&
    Number.isSafeInteger(actor.companyId) &&
    actor.companyId > 0 &&
    (actor.role === 'user' || actor.role === 'superadmin')
  );
}

async function assertActiveCompanyActor(
  trx: Knex.Transaction,
  actor: AuthenticatedResearchReviewer
): Promise<void> {
  // Keep authorization stable through the enclosing transaction's commit.
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
    fail('Concept profile is unavailable in this company context');
}

function oneProfileDocument(profile: unknown) {
  return { format: 'moonwitness-concept-profiles/v1', profiles: [profile] };
}

/** Resolve only the exact locally pinned source identities currently admitted by the corpus APIs. */
async function resolveCanonicalConceptPassage(
  sourceId: string,
  editionId: string,
  locator: string,
  corpusRootDirectory: string
) {
  if (sourceId === quranSourceId && editionId === quranEditionId && locator === 'Q7:46') {
    const resolved = await readQuranPassageSnapshot({
      rootDirectory: corpusRootDirectory,
      editionId,
      locator,
      use: 'read_analyze',
    });
    if (resolved.sourceId !== sourceId) return null;
    return {
      source_id: resolved.sourceId,
      edition_id: resolved.passage.editionId,
      locator: resolved.passage.locator,
      content_sha256: resolved.passage.sha256,
      text: resolved.passage.text,
      access: 'readable' as const,
    };
  }
  if (sourceId === webpSourceId && editionId === webpEditionId && locator === 'Genesis 1:1') {
    const resolved = await readTextualWitnessPassageSnapshot({
      rootDirectory: corpusRootDirectory,
      expressionId: webpExpressionId,
      editionId,
      locator,
      use: 'read_analyze',
    });
    if (resolved.passage.sourceId !== sourceId) return null;
    return {
      source_id: resolved.passage.sourceId,
      edition_id: resolved.passage.editionId,
      locator: resolved.passage.locator,
      content_sha256: resolved.passage.sha256,
      text: resolved.passage.text,
      access: 'readable' as const,
    };
  }
  return null;
}

async function validateForCompany(
  db: Knex,
  document: unknown,
  actor: AuthenticatedResearchReviewer,
  corpusRootDirectory: string
) {
  const structural = validateConceptProfile(document);
  if (!structural.valid) fail('Concept profile failed its schema check');
  const profiles = (
    document as {
      profiles: Array<{
        id: string;
        interpretations: Array<{ status: string; evidence_ids: string[] }>;
      }>;
    }
  ).profiles;
  for (const profile of profiles) {
    if (!profile.interpretations.some(({ status }) => status === 'accepted')) continue;
    // A K3 review event binds an Assertion revision in the shared canon and can never authorize a
    // tenant's interpretation; only a decision bound to this exact canonical profile digest can.
    const profileDigest = digest(canonicalResearchJson(oneProfileDocument(profile)));
    const decision = await readAcceptedReviewDecision(
      db,
      actor.companyId,
      profile.id,
      profileDigest
    );
    if (
      !decision ||
      !authorizesConceptProfile(decision, String(actor.companyId), {
        profile_id: profile.id,
        profile_digest: profileDigest,
      })
    ) {
      fail(
        'Accepted concept profile interpretations require an exact profile-digest review binding'
      );
    }
  }
  const evidenceIds = new Set(
    profiles.flatMap((profile) =>
      profile.interpretations.flatMap((interpretation) => interpretation.evidence_ids)
    )
  );
  for (const evidenceId of evidenceIds) {
    let resolution: TrustedConceptEvidenceResolution | null;
    try {
      resolution = await resolveConceptProfileEvidence(db, evidenceId, {
        authenticatedReader: actor,
        corpusRootDirectory,
      });
    } catch {
      fail('Concept profile evidence is missing or unreadable in this company context');
    }
    if (
      !resolution ||
      resolution.canonicalEvidence.id !== evidenceId ||
      resolution.access !== 'readable'
    ) {
      fail('Concept profile evidence is missing or unreadable in this company context');
    }
  }
  const observations = await validateConceptProfileTextualObservations(
    document,
    (sourceId, editionId, locator) =>
      resolveCanonicalConceptPassage(sourceId, editionId, locator, corpusRootDirectory)
  );
  if (!observations.valid) {
    fail(
      'Concept profile contains textual observations that this local adapter cannot safely resolve'
    );
  }
}

/** Append immutable, company-scoped INTERNAL concept profile versions. */
export async function storeConceptProfiles(
  db: Knex,
  input: StoreConceptProfilesInput
): Promise<StoredConceptProfileVersion[]> {
  if (!validActor(input.authenticatedActor) || !input.corpusRootDirectory) {
    fail('Concept profile storage context is invalid');
  }
  const actor = input.authenticatedActor;
  const snapshotJson = canonicalResearchJson(input.document);
  const snapshot = JSON.parse(snapshotJson) as { profiles: unknown[] };
  const validationDocument = JSON.parse(snapshotJson) as unknown;
  const documentProfiles = snapshot.profiles as Array<{ id?: unknown }>;
  const suppliedIds = documentProfiles
    .map((profile) => profile.id)
    .filter((id): id is string => typeof id === 'string');
  if (new Set(suppliedIds).size !== suppliedIds.length) {
    fail('Concept profile document contains duplicate profile IDs');
  }
  const results: StoredConceptProfileVersion[] = [];

  await db.transaction(async (trx) => {
    await assertActiveCompanyActor(trx, actor);
    // Serialize version allocation for this company on PostgreSQL.
    await trx('companies').where({ id: actor.companyId }).forUpdate().first('id');
    await validateForCompany(trx, validationDocument, actor, input.corpusRootDirectory);
    for (const rawProfile of snapshot.profiles) {
      const profileDocument = oneProfileDocument(rawProfile);
      const profileJson = canonicalResearchJson(profileDocument);
      const profileDigest = digest(profileJson);
      const profile = rawProfile as { id: string; concept_id: string };
      if (!profileIdPattern.test(profile.id) || !conceptIdPattern.test(profile.concept_id)) {
        fail('Concept profile identity is invalid');
      }
      const existing = await trx('knowledge_concept_profile_versions')
        .where({
          company_id: actor.companyId,
          profile_id: profile.id,
          profile_digest: profileDigest,
        })
        .orderBy('version', 'asc')
        .first('version', 'profile_json');
      if (existing) {
        if (
          String(existing.profile_json) !== profileJson ||
          digest(String(existing.profile_json)) !== profileDigest
        ) {
          fail('Existing concept profile version failed integrity verification');
        }
        results.push({
          profileId: profile.id,
          conceptId: profile.concept_id,
          version: Number(existing.version),
          digest: profileDigest,
          visibility: 'INTERNAL',
          document: profileDocument,
          idempotent: true,
        });
        continue;
      }
      const latest = await trx('knowledge_concept_profile_versions')
        .where({ company_id: actor.companyId, profile_id: profile.id })
        .max({ version: 'version' })
        .first();
      const version = Number(latest?.version ?? 0) + 1;
      await trx('knowledge_concept_profile_versions').insert({
        company_id: actor.companyId,
        profile_id: profile.id,
        concept_id: profile.concept_id,
        version,
        visibility: 'INTERNAL',
        profile_json: profileJson,
        profile_digest: profileDigest,
        recorded_by_id: actor.userId,
      });
      results.push({
        profileId: profile.id,
        conceptId: profile.concept_id,
        version,
        digest: profileDigest,
        visibility: 'INTERNAL',
        document: profileDocument,
        idempotent: false,
      });
    }
  });
  return results;
}

/** Read the latest or requested immutable version after rechecking tenant, evidence, and digest. */
export async function readConceptProfileVersion(
  db: Knex,
  input: ReadConceptProfileInput
): Promise<StoredConceptProfileVersion | null> {
  const actor = input.authenticatedReader;
  if (
    !validActor(actor) ||
    !input.corpusRootDirectory ||
    !profileIdPattern.test(input.profileId) ||
    (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 1))
  ) {
    fail('Concept profile read context is invalid');
  }
  return db.transaction(async (trx) => {
    await assertActiveCompanyActor(trx, actor);
    const query = trx('knowledge_concept_profile_versions').where({
      company_id: actor.companyId,
      profile_id: input.profileId,
    });
    if (input.version !== undefined) query.andWhere({ version: input.version });
    const row = await query.orderBy('version', 'desc').first();
    if (!row) return null;
    const profileJson = String(row.profile_json);
    if (digest(profileJson) !== row.profile_digest)
      fail('Stored concept profile failed integrity verification');
    let document: unknown;
    try {
      document = JSON.parse(profileJson) as unknown;
    } catch {
      fail('Stored concept profile is malformed');
    }
    if (
      canonicalResearchJson(document) !== profileJson ||
      !validateConceptProfile(document).valid ||
      (document as { profiles?: Array<{ id?: string; concept_id?: string }> }).profiles?.length !==
        1 ||
      (document as { profiles: Array<{ id?: string; concept_id?: string }> }).profiles[0]?.id !==
        row.profile_id ||
      (document as { profiles: Array<{ id?: string; concept_id?: string }> }).profiles[0]
        ?.concept_id !== row.concept_id
    ) {
      fail('Stored concept profile failed schema or canonical JSON verification');
    }
    await validateForCompany(trx, document, actor, input.corpusRootDirectory);
    return {
      profileId: String(row.profile_id),
      conceptId: String(row.concept_id),
      version: Number(row.version),
      digest: String(row.profile_digest),
      visibility: 'INTERNAL',
      document,
      idempotent: false,
    };
  });
}

interface StoredReviewDecisionRow {
  readonly id: number | string;
  readonly company_id: number | string;
  readonly profile_id: string;
  readonly profile_digest: string;
  readonly reviewed_version: number | string;
  readonly reviewed_digest: string;
  readonly outcome: string;
  readonly reviewer_id: number | string;
  readonly decided_at: string;
  readonly rationale: string;
}

/**
 * Re-verify a stored decision against the version it reviewed and mint it, so only this read path
 * produces an authorizing object. A reviewer who also authored the reviewed version, a missing
 * version, or a digest that no longer matches the stored bytes yields nothing authorizing.
 */
async function mintStoredReviewDecision(
  db: Knex | Knex.Transaction,
  row: StoredReviewDecisionRow
): Promise<ConceptProfileReviewDecision | null> {
  const reviewed = await db('knowledge_concept_profile_versions')
    .where({
      company_id: row.company_id,
      profile_id: row.profile_id,
      version: Number(row.reviewed_version),
    })
    .first('profile_digest', 'recorded_by_id');
  if (!reviewed) return null;
  if (String(reviewed.profile_digest) !== String(row.reviewed_digest)) return null;
  if (Number(reviewed.recorded_by_id) === Number(row.reviewer_id)) return null;
  return mintConceptProfileReviewDecision({
    id: `mw:concept-profile-review:${String(row.id)}`,
    company_id: String(row.company_id),
    profile_id: String(row.profile_id),
    profile_digest: String(row.profile_digest),
    reviewed_version: Number(row.reviewed_version),
    reviewed_digest: String(row.reviewed_digest),
    outcome: String(row.outcome) as 'accepted' | 'rejected',
    reviewer_id: String(row.reviewer_id),
    decided_at: String(row.decided_at),
    rationale: String(row.rationale),
  });
}

async function readAcceptedReviewDecision(
  db: Knex | Knex.Transaction,
  companyId: number,
  profileId: string,
  profileDigest: string
): Promise<ConceptProfileReviewDecision | null> {
  const row = (await db('knowledge_concept_profile_review_decisions')
    .where({
      company_id: companyId,
      profile_id: profileId,
      profile_digest: profileDigest,
      outcome: 'accepted',
    })
    .orderBy('id', 'desc')
    .first()) as StoredReviewDecisionRow | undefined;
  if (!row) return null;
  return mintStoredReviewDecision(db, row);
}

export interface RecordConceptProfileReviewInput {
  readonly authenticatedReviewer: AuthenticatedResearchReviewer;
  readonly profileId: string;
  readonly reviewedVersion?: number;
  /** The single profile object whose accepted interpretation this decision authorizes. */
  readonly proposalProfile: unknown;
  readonly outcome: 'accepted' | 'rejected';
  readonly rationale: string;
}

/**
 * Record one independent review of a stored concept profile version, bound to the canonical digest
 * of the proposed accepted document. The reviewer must not be the author of the reviewed version.
 */
export async function recordConceptProfileReviewDecision(
  db: Knex,
  input: RecordConceptProfileReviewInput
): Promise<ConceptProfileReviewDecision> {
  const actor = input.authenticatedReviewer;
  if (
    !validActor(actor) ||
    !profileIdPattern.test(input.profileId) ||
    (input.reviewedVersion !== undefined &&
      (!Number.isSafeInteger(input.reviewedVersion) || input.reviewedVersion < 1))
  ) {
    fail('Concept profile review context is invalid');
  }
  if (input.outcome !== 'accepted' && input.outcome !== 'rejected') {
    fail('Concept profile review outcome must be accepted or rejected');
  }
  const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : '';
  if (!rationale || rationale.length > 4000) {
    fail('Concept profile review needs a bounded rationale');
  }
  const proposalDocument = oneProfileDocument(input.proposalProfile);
  if (!validateConceptProfile(proposalDocument).valid) {
    fail('Proposed concept profile failed its schema check');
  }
  if ((input.proposalProfile as { id?: string }).id !== input.profileId) {
    fail('Proposed concept profile does not match the reviewed profile id');
  }
  const profileDigest = digest(canonicalResearchJson(proposalDocument));

  return db.transaction(async (trx) => {
    await assertActiveCompanyActor(trx, actor);
    await trx('companies').where({ id: actor.companyId }).forUpdate().first('id');
    const versionQuery = trx('knowledge_concept_profile_versions').where({
      company_id: actor.companyId,
      profile_id: input.profileId,
    });
    if (input.reviewedVersion !== undefined) {
      versionQuery.andWhere({ version: input.reviewedVersion });
    }
    const reviewed = await versionQuery.orderBy('version', 'desc').first();
    if (!reviewed) fail('Concept profile review must bind a stored version');
    if (Number(reviewed.recorded_by_id) === actor.userId) {
      fail('Concept profile review must come from someone other than the version author');
    }
    const reviewedDigest = String(reviewed.profile_digest);
    if (digest(String(reviewed.profile_json)) !== reviewedDigest) {
      fail('Reviewed concept profile version failed integrity verification');
    }
    const prior = (await trx('knowledge_concept_profile_review_decisions')
      .where({
        company_id: actor.companyId,
        profile_digest: profileDigest,
        reviewer_id: actor.userId,
      })
      .first()) as StoredReviewDecisionRow | undefined;
    if (prior) {
      if (
        String(prior.outcome) !== input.outcome ||
        Number(prior.reviewed_version) !== Number(reviewed.version)
      ) {
        fail('A different concept profile review is already recorded for this digest and reviewer');
      }
      const idempotent = await mintStoredReviewDecision(trx, prior);
      if (!idempotent) fail('Stored concept profile review failed its own integrity check');
      return idempotent;
    }
    await trx('knowledge_concept_profile_review_decisions').insert({
      company_id: actor.companyId,
      profile_id: input.profileId,
      profile_digest: profileDigest,
      reviewed_version: Number(reviewed.version),
      reviewed_digest: reviewedDigest,
      outcome: input.outcome,
      reviewer_id: actor.userId,
      decided_at: new Date().toISOString(),
      rationale,
    });
    const stored = (await trx('knowledge_concept_profile_review_decisions')
      .where({
        company_id: actor.companyId,
        profile_digest: profileDigest,
        reviewer_id: actor.userId,
      })
      .first()) as StoredReviewDecisionRow | undefined;
    const minted = await mintStoredReviewDecision(trx, stored as StoredReviewDecisionRow);
    if (!minted) fail('Concept profile review decision failed its own integrity check');
    return minted;
  });
}

export interface ResolveConceptProfileReviewInput {
  readonly authenticatedReader: AuthenticatedResearchReviewer;
  readonly profileId: string;
  readonly profileDigest: string;
}

/** Read the accepted decision for one exact canonical profile digest, within the reader company. */
export async function resolveConceptProfileReviewDecision(
  db: Knex,
  input: ResolveConceptProfileReviewInput
): Promise<ConceptProfileReviewDecision | null> {
  const actor = input.authenticatedReader;
  if (
    !validActor(actor) ||
    !profileIdPattern.test(input.profileId) ||
    !/^[a-f0-9]{64}$/.test(input.profileDigest)
  ) {
    fail('Concept profile review read context is invalid');
  }
  return db.transaction(async (trx) => {
    await assertActiveCompanyActor(trx, actor);
    return readAcceptedReviewDecision(trx, actor.companyId, input.profileId, input.profileDigest);
  });
}
