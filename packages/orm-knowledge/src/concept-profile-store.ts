import { createHash } from 'node:crypto';
import {
  validateConceptProfile,
  validateConceptProfileTextualObservations,
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
        interpretations: Array<{ status: string; evidence_ids: string[] }>;
      }>;
    }
  ).profiles;
  if (
    profiles.some((profile) => profile.interpretations.some(({ status }) => status === 'accepted'))
  ) {
    // K3 decisions bind Assertion revisions, not profile interpretation digests.
    // There is no profile-digest review binding yet, so an Assertion decision
    // cannot authorize promotion of a human interpretation to accepted.
    fail('Accepted concept profile interpretations require an exact profile-digest review binding');
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
