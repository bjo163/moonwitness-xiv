import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { isAttestedTextualAlignmentCandidateReviewDecision } from '@moonwitness/research';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as workflowManifest } from '@moonwitness/orm-workflow';
import {
  manifest,
  readTextualAlignmentCandidateVersion,
  recordTextualAlignmentCandidateReviewDecision,
  resolveTextualAlignmentCandidateReviewDecision,
  storeTextualAlignmentCandidates,
} from '../src/index.js';
import { canonicalResearchJson } from '../src/research-release.js';

let db: Knex;
let userId: number;
let companyId: number;
const leftText = 'Synthetic passage left.';
const rightText = 'Synthetic passage right.';
const selector = (tradition: string, text: string, quote: string) => {
  const start = Array.from(text.slice(0, text.indexOf(quote))).length;
  return {
    source_id: `mw:source:synthetic-${tradition}`,
    expression_id: `mw:expression:synthetic-${tradition}`,
    edition_id: `mw:edition:synthetic-${tradition}-v1`,
    locator: `synthetic:${tradition}:1`,
    content_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    range: { unit: 'unicode_scalar' as const, start, end: start + Array.from(quote).length },
    quote,
  };
};
const passages = [
  {
    evidence_id: 'mw:evidence:synthetic-left',
    tradition_context_id: 'mw:tradition:synthetic-left',
    ...selector('left', leftText, 'passage left'),
    text: leftText,
  },
  {
    evidence_id: 'mw:evidence:synthetic-right',
    tradition_context_id: 'mw:tradition:synthetic-right',
    ...selector('right', rightText, 'passage right'),
    text: rightText,
  },
];
function candidate(note = 'Synthetic only; unresolved review subject.') {
  return {
    id: 'mw:textual-alignment-candidate:synthetic-pair',
    left: {
      evidence_id: passages[0]!.evidence_id,
      selector: selector('left', leftText, 'passage left'),
    },
    right: {
      evidence_id: passages[1]!.evidence_id,
      selector: selector('right', rightText, 'passage right'),
    },
    similarity_score: 0.42,
    method: { id: 'mw:alignment-method:synthetic', version: '1.0.0' },
    uncertainty: { level: 'high', note },
  };
}
const resolver = async (evidenceId: string) =>
  passages.find((passage) => passage.evidence_id === evidenceId) ?? null;
const actor = () => ({ userId, companyId, role: 'superadmin' as const });

async function addReviewer(login = 'candidate-reviewer'): Promise<number> {
  await db('partners').insert({
    name: `Synthetic ${login}`,
    company_id: companyId,
    is_company: false,
  });
  const partnerId = Number(
    (
      await db('partners')
        .where({ name: `Synthetic ${login}` })
        .first('id')
    )?.id
  );
  await db('users').insert({ login, partner_id: partnerId, role: 'user' });
  const reviewerId = Number((await db('users').where({ login }).first('id'))?.id);
  await db('company_memberships').insert({
    user_id: reviewerId,
    company_id: companyId,
    is_default: false,
  });
  return reviewerId;
}

function review(
  reviewerId: number,
  candidateId: string,
  overrides: Partial<{
    outcome: 'accepted' | 'rejected';
    rationale: string;
    reviewedVersion: number;
    reviewerCompanyId: number;
    reviewerRole: 'user' | 'superadmin';
  }> = {}
) {
  return {
    authenticatedReviewer: {
      userId: reviewerId,
      companyId: overrides.reviewerCompanyId ?? companyId,
      role: overrides.reviewerRole ?? ('user' as const),
    },
    candidateId,
    ...(overrides.reviewedVersion === undefined
      ? {}
      : { reviewedVersion: overrides.reviewedVersion }),
    outcome: overrides.outcome ?? 'accepted',
    rationale:
      overrides.rationale ??
      'Checked both provenance-bound passages and the citation-only projection.',
  };
}

function reader(reviewerId: number, companyIdOverride = companyId) {
  return {
    authenticatedReader: {
      userId: reviewerId,
      companyId: companyIdOverride,
      role: 'user' as const,
    },
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

describe('tenant-scoped INTERNAL textual alignment candidate versions', () => {
  it('re-projects untrusted candidates, retries idempotently, appends changes, and reads scoped canonical bytes', async () => {
    const input = {
      authenticatedActor: actor(),
      resolvePassage: resolver,
      candidates: [candidate()],
    };
    const [first] = await storeTextualAlignmentCandidates(db, input);
    const [retry] = await storeTextualAlignmentCandidates(db, input);
    const [changed] = await storeTextualAlignmentCandidates(db, {
      ...input,
      candidates: [candidate('Different synthetic uncertainty.')],
    });
    expect(first).toMatchObject({ version: 1, visibility: 'INTERNAL', idempotent: false });
    expect(retry).toMatchObject({ version: 1, digest: first!.digest, idempotent: true });
    expect(changed).toMatchObject({ version: 2, idempotent: false });
    expect(first!.candidate.left).not.toHaveProperty('text');
    expect(await db('knowledge_textual_alignment_candidate_versions')).toHaveLength(2);
    expect(
      await readTextualAlignmentCandidateVersion(db, {
        authenticatedReader: actor(),
        candidateId: first!.candidateId,
      })
    ).toMatchObject({ version: 2, visibility: 'INTERNAL' });
    await expect(
      db('knowledge_textual_alignment_candidate_versions')
        .where({ id: 1 })
        .update({ visibility: 'PUBLIC' })
    ).rejects.toThrow(/append-only/u);
    await expect(
      db('knowledge_textual_alignment_candidate_versions').where({ id: 1 }).delete()
    ).rejects.toThrow(/append-only/u);
  });

  it('rejects duplicate IDs, resolver mismatch, inactive tenant membership, and cross-company reads', async () => {
    await expect(
      storeTextualAlignmentCandidates(db, {
        authenticatedActor: actor(),
        resolvePassage: resolver,
        candidates: [candidate(), candidate()],
      })
    ).rejects.toThrow(/duplicate candidate IDs/u);
    await expect(
      storeTextualAlignmentCandidates(db, {
        authenticatedActor: actor(),
        resolvePassage: async () => null,
        candidates: [candidate()],
      })
    ).rejects.toThrow();
    await storeTextualAlignmentCandidates(db, {
      authenticatedActor: actor(),
      resolvePassage: resolver,
      candidates: [candidate()],
    });
    await expect(
      readTextualAlignmentCandidateVersion(db, {
        authenticatedReader: { ...actor(), companyId: companyId + 1 },
        candidateId: 'mw:textual-alignment-candidate:synthetic-pair',
      })
    ).rejects.toThrow(/unavailable in this company context/u);
    await db('company_memberships')
      .where({ user_id: userId, company_id: companyId })
      .update({ active: false });
    await expect(
      storeTextualAlignmentCandidates(db, {
        authenticatedActor: actor(),
        resolvePassage: resolver,
        candidates: [candidate()],
      })
    ).rejects.toThrow(/unavailable in this company context/u);
  });

  it('rejects stored rows that add nested text outside the citation-only projection', async () => {
    const [stored] = await storeTextualAlignmentCandidates(db, {
      authenticatedActor: actor(),
      resolvePassage: resolver,
      candidates: [candidate()],
    });
    const candidateId = 'mw:textual-alignment-candidate:forged-read-shape';
    const forged = structuredClone(stored!.candidate) as unknown as {
      id: string;
      left: Record<string, unknown>;
    };
    forged.id = candidateId;
    forged.left.selector = { text: 'synthetic full passage must never be returned' };
    const candidateJson = canonicalResearchJson(forged);
    const candidateDigest = createHash('sha256').update(candidateJson, 'utf8').digest('hex');
    await db('knowledge_textual_alignment_candidate_versions').insert({
      company_id: companyId,
      candidate_id: candidateId,
      version: 1,
      visibility: 'INTERNAL',
      candidate_json: candidateJson,
      candidate_digest: candidateDigest,
      recorded_by_id: userId,
    });
    await expect(
      readTextualAlignmentCandidateVersion(db, {
        authenticatedReader: actor(),
        candidateId,
      })
    ).rejects.toThrow(
      'Stored textual alignment candidate failed canonical projection verification'
    );
  });
});

describe('candidate-digest review decisions', () => {
  it('binds an accepted decision to the stored version someone other than the submitter reviewed', async () => {
    const [stored] = await storeTextualAlignmentCandidates(db, {
      authenticatedActor: actor(),
      resolvePassage: resolver,
      candidates: [candidate()],
    });
    const candidateId = stored!.candidateId;
    await expect(
      recordTextualAlignmentCandidateReviewDecision(
        db,
        review(userId, candidateId, { reviewerRole: 'superadmin' })
      )
    ).rejects.toThrow(/someone other than its submitter/u);
    expect(await db('knowledge_textual_alignment_candidate_review_decisions')).toHaveLength(0);

    const reviewerId = await addReviewer();
    const decision = await recordTextualAlignmentCandidateReviewDecision(
      db,
      review(reviewerId, candidateId)
    );
    expect(decision).toMatchObject({
      kind: 'TextualAlignmentCandidateReviewDecision',
      candidate_id: candidateId,
      candidate_digest: stored!.digest,
      reviewed_version: 1,
      outcome: 'accepted',
      reviewer_id: String(reviewerId),
    });
    expect(
      isAttestedTextualAlignmentCandidateReviewDecision(decision, {
        company_id: String(companyId),
        reviewer_id: String(reviewerId),
      })
    ).toBe(true);
    await expect(
      resolveTextualAlignmentCandidateReviewDecision(db, {
        ...reader(reviewerId),
        candidateId,
        candidateDigest: stored!.digest,
      })
    ).resolves.toMatchObject({ id: decision.id });
    await expect(
      resolveTextualAlignmentCandidateReviewDecision(db, {
        ...reader(reviewerId),
        candidateId,
        candidateDigest: 'f'.repeat(64),
      })
    ).resolves.toBeNull();
  });

  it('pins a decision to one version, so an appended version needs a decision of its own', async () => {
    const input = {
      authenticatedActor: actor(),
      resolvePassage: resolver,
      candidates: [candidate()],
    };
    const [first] = await storeTextualAlignmentCandidates(db, input);
    await storeTextualAlignmentCandidates(db, {
      ...input,
      candidates: [candidate('Different synthetic uncertainty.')],
    });
    const reviewerId = await addReviewer();
    const pinned = await recordTextualAlignmentCandidateReviewDecision(
      db,
      review(reviewerId, first!.candidateId, { reviewedVersion: 1 })
    );
    expect(pinned.reviewed_version).toBe(1);
    expect(pinned.candidate_digest).toBe(first!.digest);
    const latest = await recordTextualAlignmentCandidateReviewDecision(
      db,
      review(reviewerId, first!.candidateId, { outcome: 'rejected' })
    );
    expect(latest).toMatchObject({ reviewed_version: 2, outcome: 'rejected' });
  });

  it('refuses a decision without a stored version, a blank rationale, or a forged row shape', async () => {
    const reviewerId = await addReviewer();
    await expect(
      recordTextualAlignmentCandidateReviewDecision(
        db,
        review(reviewerId, 'mw:textual-alignment-candidate:never-stored')
      )
    ).rejects.toThrow(/must bind a stored version/u);
    await storeTextualAlignmentCandidates(db, {
      authenticatedActor: actor(),
      resolvePassage: resolver,
      candidates: [candidate()],
    });
    const candidateId = 'mw:textual-alignment-candidate:synthetic-pair';
    await expect(
      recordTextualAlignmentCandidateReviewDecision(
        db,
        review(reviewerId, candidateId, { rationale: '   ' })
      )
    ).rejects.toThrow(/bounded rationale/u);
    await expect(
      recordTextualAlignmentCandidateReviewDecision(db, {
        ...review(reviewerId, candidateId),
        candidateId: 'textual-alignment-candidate:synthetic-pair',
      })
    ).rejects.toThrow(/review context is invalid/u);
    expect(await db('knowledge_textual_alignment_candidate_review_decisions')).toHaveLength(0);
  });

  it('replays one reviewer’s decision idempotently and refuses a contradictory second outcome', async () => {
    const input = {
      authenticatedActor: actor(),
      resolvePassage: resolver,
      candidates: [candidate()],
    };
    const [stored] = await storeTextualAlignmentCandidates(db, input);
    const reviewerId = await addReviewer();
    const first = await recordTextualAlignmentCandidateReviewDecision(
      db,
      review(reviewerId, stored!.candidateId)
    );
    const replay = await recordTextualAlignmentCandidateReviewDecision(
      db,
      review(reviewerId, stored!.candidateId)
    );
    expect(replay).toMatchObject({ id: first.id, outcome: 'accepted' });
    expect(await db('knowledge_textual_alignment_candidate_review_decisions')).toHaveLength(1);
    await expect(
      recordTextualAlignmentCandidateReviewDecision(
        db,
        review(reviewerId, stored!.candidateId, { outcome: 'rejected' })
      )
    ).rejects.toThrow(/already recorded/u);
    expect(await db('knowledge_textual_alignment_candidate_review_decisions')).toHaveLength(1);
  });

  it('keeps decisions append-only and invisible to another company', async () => {
    const [stored] = await storeTextualAlignmentCandidates(db, {
      authenticatedActor: actor(),
      resolvePassage: resolver,
      candidates: [candidate()],
    });
    const reviewerId = await addReviewer();
    const decision = await recordTextualAlignmentCandidateReviewDecision(
      db,
      review(reviewerId, stored!.candidateId)
    );
    const otherCompanyId = Number(
      await db('companies').insert({
        name: 'Separate candidate tenant',
        timezone: 'UTC',
        active: true,
      })
    );
    await db('company_memberships').insert({
      user_id: reviewerId,
      company_id: otherCompanyId,
      is_default: false,
    });
    await expect(
      resolveTextualAlignmentCandidateReviewDecision(db, {
        ...reader(reviewerId, otherCompanyId),
        candidateId: stored!.candidateId,
        candidateDigest: decision.candidate_digest,
      })
    ).resolves.toBeNull();
    await expect(
      recordTextualAlignmentCandidateReviewDecision(
        db,
        review(reviewerId, stored!.candidateId, { reviewerCompanyId: otherCompanyId })
      )
    ).rejects.toThrow(/must bind a stored version/u);

    const rowId = Number(
      (
        await db('knowledge_textual_alignment_candidate_review_decisions')
          .where({ candidate_digest: decision.candidate_digest })
          .first('id')
      )?.id
    );
    await expect(
      db('knowledge_textual_alignment_candidate_review_decisions')
        .where({ id: rowId })
        .update({ outcome: 'rejected' })
    ).rejects.toThrow(/append-only/u);
    await expect(
      db('knowledge_textual_alignment_candidate_review_decisions').where({ id: rowId }).delete()
    ).rejects.toThrow(/append-only/u);
  });

  it('yields nothing authorizing for a stored row that breaks the citation-only projection', async () => {
    const [stored] = await storeTextualAlignmentCandidates(db, {
      authenticatedActor: actor(),
      resolvePassage: resolver,
      candidates: [candidate()],
    });
    const reviewerId = await addReviewer();
    await recordTextualAlignmentCandidateReviewDecision(
      db,
      review(reviewerId, stored!.candidateId)
    );
    const forged = structuredClone(stored!.candidate) as unknown as {
      id: string;
      left: Record<string, unknown>;
    };
    const forgedId = 'mw:textual-alignment-candidate:forged-review-shape';
    forged.id = forgedId;
    forged.left.selector = { text: 'synthetic full passage must never be reviewed' };
    const candidateJson = canonicalResearchJson(forged);
    const candidateDigest = createHash('sha256').update(candidateJson, 'utf8').digest('hex');
    await db('knowledge_textual_alignment_candidate_versions').insert({
      company_id: companyId,
      candidate_id: forgedId,
      version: 1,
      visibility: 'INTERNAL',
      candidate_json: candidateJson,
      candidate_digest: candidateDigest,
      recorded_by_id: userId,
    });
    await expect(
      recordTextualAlignmentCandidateReviewDecision(db, review(reviewerId, forgedId))
    ).rejects.toThrow(/failed its own integrity check/u);
    expect(await db('knowledge_textual_alignment_candidate_review_decisions')).toHaveLength(1);
  });
});
