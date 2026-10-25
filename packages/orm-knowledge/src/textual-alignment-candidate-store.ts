import { createHash } from 'node:crypto';
import {
  mintTextualAlignmentCandidateReviewDecision,
  projectTextualAlignmentCandidate,
  type TextualAlignmentCandidate,
  type TextualAlignmentCandidateReviewDecision,
  type TextualAlignmentPassageResolver,
} from '@moonwitness/research';
import type { Knex } from 'knex';
import { canonicalResearchJson } from './research-release.js';
import type { AuthenticatedResearchReviewer } from './research-review.js';

const candidateIdPattern = /^mw:textual-alignment-candidate:[a-z0-9][a-z0-9._-]{0,159}$/u;
const identifierPattern = /^[a-z][a-z0-9+.-]*(?::[a-z0-9][a-z0-9._-]{0,179})+$/u;

export interface StoreTextualAlignmentCandidatesInput {
  readonly authenticatedActor: AuthenticatedResearchReviewer;
  /** Must resolve exact evidence only inside this authenticated company and verify rights. */
  readonly resolvePassage: TextualAlignmentPassageResolver;
  readonly candidates: readonly unknown[];
}

export interface ReadTextualAlignmentCandidateInput {
  readonly authenticatedReader: AuthenticatedResearchReviewer;
  readonly candidateId: string;
  readonly version?: number;
}

export interface StoredTextualAlignmentCandidateVersion {
  readonly candidateId: string;
  readonly version: number;
  readonly digest: string;
  readonly visibility: 'INTERNAL';
  readonly candidate: TextualAlignmentCandidate;
  readonly idempotent: boolean;
}

function fail(message: string): never {
  throw new TypeError(message);
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

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isCitation(value: unknown): boolean {
  if (
    !record(value) ||
    !hasExactKeys(value, [
      'evidence_id',
      'tradition_context_id',
      'source_id',
      'expression_id',
      'edition_id',
      'locator',
      'content_sha256',
      'range',
      'quote',
    ]) ||
    !record(value.range) ||
    !hasExactKeys(value.range, ['unit', 'start', 'end'])
  ) {
    return false;
  }
  return (
    typeof value.evidence_id === 'string' &&
    value.evidence_id.startsWith('mw:evidence:') &&
    identifierPattern.test(value.evidence_id) &&
    typeof value.tradition_context_id === 'string' &&
    value.tradition_context_id.startsWith('mw:tradition:') &&
    identifierPattern.test(value.tradition_context_id) &&
    typeof value.source_id === 'string' &&
    value.source_id.startsWith('mw:source:') &&
    identifierPattern.test(value.source_id) &&
    typeof value.expression_id === 'string' &&
    value.expression_id.startsWith('mw:expression:') &&
    identifierPattern.test(value.expression_id) &&
    typeof value.edition_id === 'string' &&
    value.edition_id.startsWith('mw:edition:') &&
    identifierPattern.test(value.edition_id) &&
    typeof value.locator === 'string' &&
    value.locator.trim().length > 0 &&
    value.locator.length <= 240 &&
    /^[a-f0-9]{64}$/u.test(String(value.content_sha256)) &&
    value.range.unit === 'unicode_scalar' &&
    Number.isSafeInteger(value.range.start) &&
    Number(value.range.start) >= 0 &&
    Number.isSafeInteger(value.range.end) &&
    Number(value.range.end) > Number(value.range.start) &&
    typeof value.quote === 'string' &&
    value.quote.length > 0 &&
    value.quote.length <= 4000 &&
    isWellFormedUnicode(value.quote) &&
    Number(value.range.end) - Number(value.range.start) === Array.from(value.quote).length
  );
}

function isProjectedCandidate(value: unknown): value is TextualAlignmentCandidate {
  if (
    !record(value) ||
    !hasExactKeys(value, [
      'id',
      'kind',
      'status',
      'left',
      'right',
      'similarity_score',
      'method',
      'uncertainty',
      'interpretation_boundary',
    ]) ||
    !candidateIdPattern.test(String(value.id)) ||
    value.kind !== 'TextualParallelCandidate' ||
    value.status !== 'candidate' ||
    !isCitation(value.left) ||
    !isCitation(value.right) ||
    typeof value.similarity_score !== 'number' ||
    !Number.isFinite(value.similarity_score) ||
    value.similarity_score < 0 ||
    value.similarity_score > 1 ||
    !record(value.method) ||
    !hasExactKeys(value.method, ['id', 'version']) ||
    typeof value.method.id !== 'string' ||
    !/^mw:alignment-method:[a-z0-9][a-z0-9._-]{0,159}$/u.test(value.method.id) ||
    typeof value.method.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(value.method.version) ||
    !record(value.uncertainty) ||
    !hasExactKeys(value.uncertainty, ['level', 'note']) ||
    !['low', 'moderate', 'high', 'unassessed'].includes(String(value.uncertainty.level)) ||
    typeof value.uncertainty.note !== 'string' ||
    !record(value.interpretation_boundary) ||
    !hasExactKeys(value.interpretation_boundary, [
      'basis',
      'asserts_identity',
      'asserts_quotation',
      'asserts_fulfillment',
      'asserts_doctrine',
    ])
  ) {
    return false;
  }
  return (
    value.interpretation_boundary.basis === 'similarity_only' &&
    value.interpretation_boundary.asserts_identity === false &&
    value.interpretation_boundary.asserts_quotation === false &&
    value.interpretation_boundary.asserts_fulfillment === false &&
    value.interpretation_boundary.asserts_doctrine === false
  );
}

async function assertActiveCompanyActor(
  trx: Knex.Transaction,
  actor: AuthenticatedResearchReviewer
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
    fail('Textual alignment candidate is unavailable in this company context');
}

/** Re-project untrusted candidate requests through canonical tenant-bound source resolution and append INTERNAL versions. */
export async function storeTextualAlignmentCandidates(
  db: Knex,
  input: StoreTextualAlignmentCandidatesInput
): Promise<StoredTextualAlignmentCandidateVersion[]> {
  if (
    !validActor(input.authenticatedActor) ||
    !Array.isArray(input.candidates) ||
    !input.resolvePassage
  ) {
    fail('Textual alignment candidate storage context is invalid');
  }
  const ids = input.candidates.map((candidate) =>
    candidate && typeof candidate === 'object' ? (candidate as { id?: unknown }).id : undefined
  );
  if (
    ids.some((id) => typeof id !== 'string' || !candidateIdPattern.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    fail('Textual alignment candidate document contains invalid or duplicate candidate IDs');
  }
  const results: StoredTextualAlignmentCandidateVersion[] = [];
  await db.transaction(async (trx) => {
    const actor = input.authenticatedActor;
    await assertActiveCompanyActor(trx, actor);
    // Serialize version allocation per company; authorization locks remain held through commit.
    await trx('companies').where({ id: actor.companyId }).forUpdate().first('id');
    const projected: TextualAlignmentCandidate[] = [];
    for (const candidate of input.candidates) {
      projected.push(await projectTextualAlignmentCandidate(candidate, input.resolvePassage));
    }
    for (const candidate of projected) {
      const candidateJson = canonicalResearchJson(candidate);
      const candidateDigest = digest(candidateJson);
      const existing = await trx('knowledge_textual_alignment_candidate_versions')
        .where({
          company_id: actor.companyId,
          candidate_id: candidate.id,
          candidate_digest: candidateDigest,
        })
        .orderBy('version', 'asc')
        .first('version', 'candidate_json');
      if (existing) {
        if (
          String(existing.candidate_json) !== candidateJson ||
          digest(String(existing.candidate_json)) !== candidateDigest
        ) {
          fail('Existing textual alignment candidate version failed integrity verification');
        }
        results.push({
          candidateId: candidate.id,
          version: Number(existing.version),
          digest: candidateDigest,
          visibility: 'INTERNAL',
          candidate,
          idempotent: true,
        });
        continue;
      }
      const latest = await trx('knowledge_textual_alignment_candidate_versions')
        .where({ company_id: actor.companyId, candidate_id: candidate.id })
        .max({ version: 'version' })
        .first();
      const version = Number(latest?.version ?? 0) + 1;
      await trx('knowledge_textual_alignment_candidate_versions').insert({
        company_id: actor.companyId,
        candidate_id: candidate.id,
        version,
        visibility: 'INTERNAL',
        candidate_json: candidateJson,
        candidate_digest: candidateDigest,
        recorded_by_id: actor.userId,
      });
      results.push({
        candidateId: candidate.id,
        version,
        digest: candidateDigest,
        visibility: 'INTERNAL',
        candidate,
        idempotent: false,
      });
    }
  });
  return results;
}

/** Read a tenant-scoped immutable candidate version and verify its canonical digest and projection boundary. */
export async function readTextualAlignmentCandidateVersion(
  db: Knex,
  input: ReadTextualAlignmentCandidateInput
): Promise<StoredTextualAlignmentCandidateVersion | null> {
  const actor = input.authenticatedReader;
  if (
    !validActor(actor) ||
    !candidateIdPattern.test(input.candidateId) ||
    (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 1))
  ) {
    fail('Textual alignment candidate read context is invalid');
  }
  return db.transaction(async (trx) => {
    await assertActiveCompanyActor(trx, actor);
    const query = trx('knowledge_textual_alignment_candidate_versions').where({
      company_id: actor.companyId,
      candidate_id: input.candidateId,
    });
    if (input.version !== undefined) query.andWhere({ version: input.version });
    const row = await query.orderBy('version', 'desc').first();
    if (!row) return null;
    if (row.visibility !== 'INTERNAL')
      fail('Stored textual alignment candidate exceeded the INTERNAL visibility ceiling');
    const candidateJson = String(row.candidate_json);
    if (digest(candidateJson) !== row.candidate_digest)
      fail('Stored textual alignment candidate failed integrity verification');
    let candidate: unknown;
    try {
      candidate = JSON.parse(candidateJson) as unknown;
    } catch {
      fail('Stored textual alignment candidate is malformed');
    }
    const value = candidate as Partial<TextualAlignmentCandidate>;
    if (
      canonicalResearchJson(candidate) !== candidateJson ||
      value.id !== row.candidate_id ||
      !isProjectedCandidate(candidate)
    ) {
      fail('Stored textual alignment candidate failed canonical projection verification');
    }
    return {
      candidateId: String(row.candidate_id),
      version: Number(row.version),
      digest: String(row.candidate_digest),
      visibility: 'INTERNAL',
      candidate: candidate as TextualAlignmentCandidate,
      idempotent: false,
    };
  });
}

interface StoredCandidateReviewRow {
  readonly id: number | string;
  readonly company_id: number | string;
  readonly candidate_id: string;
  readonly candidate_digest: string;
  readonly reviewed_version: number | string;
  readonly outcome: string;
  readonly reviewer_id: number | string;
  readonly decided_at: string;
  readonly rationale: string;
}

/**
 * Re-verify a stored decision against the candidate version it reviewed, then mint it, so only this
 * read path produces a decision object. A reviewer who submitted the reviewed version, a missing
 * version, stored bytes that no longer match the bound digest, or a version that no longer satisfies
 * the citation-only projection yields nothing authorizing.
 */
async function mintStoredCandidateReviewDecision(
  db: Knex | Knex.Transaction,
  row: StoredCandidateReviewRow
): Promise<TextualAlignmentCandidateReviewDecision | null> {
  const reviewed = await db('knowledge_textual_alignment_candidate_versions')
    .where({
      company_id: row.company_id,
      candidate_id: row.candidate_id,
      version: Number(row.reviewed_version),
    })
    .first('candidate_digest', 'candidate_json', 'recorded_by_id');
  if (!reviewed) return null;
  if (String(reviewed.candidate_digest) !== String(row.candidate_digest)) return null;
  if (Number(reviewed.recorded_by_id) === Number(row.reviewer_id)) return null;
  const candidateJson = String(reviewed.candidate_json);
  if (digest(candidateJson) !== String(row.candidate_digest)) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(candidateJson) as unknown;
  } catch {
    return null;
  }
  if (!isProjectedCandidate(candidate)) return null;
  return mintTextualAlignmentCandidateReviewDecision({
    id: `mw:textual-alignment-candidate-review:${String(row.id)}`,
    company_id: String(row.company_id),
    candidate_id: String(row.candidate_id),
    candidate_digest: String(row.candidate_digest),
    reviewed_version: Number(row.reviewed_version),
    outcome: String(row.outcome) as 'accepted' | 'rejected',
    reviewer_id: String(row.reviewer_id),
    decided_at: String(row.decided_at),
    rationale: String(row.rationale),
  });
}

async function readAcceptedCandidateReviewDecision(
  db: Knex | Knex.Transaction,
  companyId: number,
  candidateId: string,
  candidateDigest: string
): Promise<TextualAlignmentCandidateReviewDecision | null> {
  const row = (await db('knowledge_textual_alignment_candidate_review_decisions')
    .where({
      company_id: companyId,
      candidate_id: candidateId,
      candidate_digest: candidateDigest,
      outcome: 'accepted',
    })
    .orderBy('id', 'desc')
    .first()) as StoredCandidateReviewRow | undefined;
  if (!row) return null;
  return mintStoredCandidateReviewDecision(db, row);
}

export interface RecordTextualAlignmentCandidateReviewInput {
  readonly authenticatedReviewer: AuthenticatedResearchReviewer;
  readonly candidateId: string;
  readonly reviewedVersion?: number;
  readonly outcome: 'accepted' | 'rejected';
  readonly rationale: string;
}

/**
 * Record one independent review of a stored candidate version, bound to the canonical digest of the
 * candidate bytes actually read from storage. The reviewer must not be the actor who stored it.
 */
export async function recordTextualAlignmentCandidateReviewDecision(
  db: Knex,
  input: RecordTextualAlignmentCandidateReviewInput
): Promise<TextualAlignmentCandidateReviewDecision> {
  const actor = input.authenticatedReviewer;
  if (
    !validActor(actor) ||
    !candidateIdPattern.test(input.candidateId) ||
    (input.reviewedVersion !== undefined &&
      (!Number.isSafeInteger(input.reviewedVersion) || input.reviewedVersion < 1))
  ) {
    fail('Textual alignment candidate review context is invalid');
  }
  if (input.outcome !== 'accepted' && input.outcome !== 'rejected') {
    fail('Textual alignment candidate review outcome must be accepted or rejected');
  }
  const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : '';
  if (!rationale || rationale.length > 4000) {
    fail('Textual alignment candidate review needs a bounded rationale');
  }

  return db.transaction(async (trx) => {
    await assertActiveCompanyActor(trx, actor);
    await trx('companies').where({ id: actor.companyId }).forUpdate().first('id');
    const versionQuery = trx('knowledge_textual_alignment_candidate_versions').where({
      company_id: actor.companyId,
      candidate_id: input.candidateId,
    });
    if (input.reviewedVersion !== undefined) {
      versionQuery.andWhere({ version: input.reviewedVersion });
    }
    const reviewed = (await versionQuery.orderBy('version', 'desc').first()) as
      | {
          version: number | string;
          candidate_digest: string;
          candidate_json: string;
          recorded_by_id: number | string;
        }
      | undefined;
    if (!reviewed) fail('Textual alignment candidate review must bind a stored version');
    if (Number(reviewed.recorded_by_id) === actor.userId) {
      fail('Textual alignment candidate review must come from someone other than its submitter');
    }
    const candidateDigest = String(reviewed.candidate_digest);
    if (digest(String(reviewed.candidate_json)) !== candidateDigest) {
      fail('Reviewed textual alignment candidate version failed integrity verification');
    }
    const prior = (await trx('knowledge_textual_alignment_candidate_review_decisions')
      .where({
        company_id: actor.companyId,
        candidate_digest: candidateDigest,
        reviewer_id: actor.userId,
      })
      .first()) as StoredCandidateReviewRow | undefined;
    if (prior) {
      if (
        String(prior.outcome) !== input.outcome ||
        Number(prior.reviewed_version) !== Number(reviewed.version)
      ) {
        fail(
          'A different textual alignment candidate review is already recorded for this digest and reviewer'
        );
      }
      const idempotent = await mintStoredCandidateReviewDecision(trx, prior);
      if (!idempotent)
        fail('Stored textual alignment candidate review failed its own integrity check');
      return idempotent;
    }
    await trx('knowledge_textual_alignment_candidate_review_decisions').insert({
      company_id: actor.companyId,
      candidate_id: input.candidateId,
      candidate_digest: candidateDigest,
      reviewed_version: Number(reviewed.version),
      outcome: input.outcome,
      reviewer_id: actor.userId,
      decided_at: new Date().toISOString(),
      rationale,
    });
    const stored = (await trx('knowledge_textual_alignment_candidate_review_decisions')
      .where({
        company_id: actor.companyId,
        candidate_digest: candidateDigest,
        reviewer_id: actor.userId,
      })
      .first()) as StoredCandidateReviewRow | undefined;
    const minted = await mintStoredCandidateReviewDecision(trx, stored as StoredCandidateReviewRow);
    if (!minted) fail('Textual alignment candidate review decision failed its own integrity check');
    return minted;
  });
}

export interface ResolveTextualAlignmentCandidateReviewInput {
  readonly authenticatedReader: AuthenticatedResearchReviewer;
  readonly candidateId: string;
  readonly candidateDigest: string;
}

/** Read the accepted decision for one exact canonical candidate digest, within the reader company. */
export async function resolveTextualAlignmentCandidateReviewDecision(
  db: Knex,
  input: ResolveTextualAlignmentCandidateReviewInput
): Promise<TextualAlignmentCandidateReviewDecision | null> {
  const actor = input.authenticatedReader;
  if (
    !validActor(actor) ||
    !candidateIdPattern.test(input.candidateId) ||
    !/^[a-f0-9]{64}$/.test(input.candidateDigest)
  ) {
    fail('Textual alignment candidate review read context is invalid');
  }
  return db.transaction(async (trx) => {
    await assertActiveCompanyActor(trx, actor);
    return readAcceptedCandidateReviewDecision(
      trx,
      actor.companyId,
      input.candidateId,
      input.candidateDigest
    );
  });
}
