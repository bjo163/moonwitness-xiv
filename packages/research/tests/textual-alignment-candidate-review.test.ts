import { describe, expect, it } from 'vitest';
import {
  authorizesTextualAlignmentCandidate,
  isAttestedTextualAlignmentCandidateReviewDecision,
  isTextualAlignmentCandidateReviewDecisionForCompany,
  mintTextualAlignmentCandidateReviewDecision,
  type MintTextualAlignmentCandidateReviewInput,
  type TextualAlignmentCandidateReviewDecision,
} from '../src/index.js';

const candidateId = 'mw:textual-alignment-candidate:mercy-parallel-a';
const candidateDigest = 'a'.repeat(64);

function mintInput(
  overrides: Partial<MintTextualAlignmentCandidateReviewInput> = {}
): MintTextualAlignmentCandidateReviewInput {
  return {
    id: 'mw:textual-alignment-candidate-review:review-1',
    company_id: '4',
    reviewer_id: '9',
    candidate_id: candidateId,
    candidate_digest: candidateDigest,
    reviewed_version: 1,
    outcome: 'accepted',
    decided_at: '2026-10-25T00:00:00Z',
    rationale: 'Reviewed the two provenance-bound passages and the citation-only boundary.',
    ...overrides,
  };
}

function authority() {
  return { company_id: '4', reviewer_id: '9' };
}

function subject() {
  return { candidate_id: candidateId, candidate_digest: candidateDigest };
}

describe('textual alignment candidate review decisions', () => {
  it('mints an immutable decision bound to the minting authority', () => {
    const decision = mintTextualAlignmentCandidateReviewDecision(mintInput());
    expect(decision).toMatchObject({
      kind: 'TextualAlignmentCandidateReviewDecision',
      candidate_id: candidateId,
      candidate_digest: candidateDigest,
      reviewed_version: 1,
      outcome: 'accepted',
    });
    expect(isAttestedTextualAlignmentCandidateReviewDecision(decision, authority())).toBe(true);
    expect(isTextualAlignmentCandidateReviewDecisionForCompany(decision, '4')).toBe(true);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(() => {
      (decision as { outcome: string }).outcome = 'accepted';
    }).toThrow();
  });

  it('refuses to mint a decision with unusable bounds', () => {
    const cases: Array<[Partial<MintTextualAlignmentCandidateReviewInput>, string]> = [
      [{ id: '  ' }, 'id is invalid'],
      [{ id: 'x'.repeat(256) }, 'id is invalid'],
      [{ company_id: ' ' }, 'reviewing company'],
      [{ reviewer_id: '' }, 'reviewing actor'],
      [{ candidate_id: 'mw:textual-alignment:parallel' }, 'candidate identity is invalid'],
      [{ candidate_digest: 'z'.repeat(64) }, 'canonical candidate digest'],
      [{ reviewed_version: 0 }, 'reviewed candidate version'],
      [{ reviewed_version: 2.5 }, 'reviewed candidate version'],
      [{ outcome: 'pending' as 'accepted' }, 'accepted or rejected'],
      [{ decided_at: 'not-a-date' }, 'decision timestamp'],
      [{ rationale: '   ' }, 'bounded rationale'],
      [{ rationale: 'x'.repeat(4001) }, 'bounded rationale'],
    ];
    for (const [overrides, message] of cases) {
      expect(() => mintTextualAlignmentCandidateReviewDecision(mintInput(overrides))).toThrow(
        new RegExp(message, 'u')
      );
    }
  });

  it('attests the minted object, not a structurally identical copy', () => {
    const decision = mintTextualAlignmentCandidateReviewDecision(mintInput());
    const copied = { ...decision };
    const serialized = JSON.parse(
      JSON.stringify(decision)
    ) as TextualAlignmentCandidateReviewDecision;
    expect(isAttestedTextualAlignmentCandidateReviewDecision(copied, authority())).toBe(false);
    expect(isAttestedTextualAlignmentCandidateReviewDecision(serialized, authority())).toBe(false);
    expect(isTextualAlignmentCandidateReviewDecisionForCompany(copied, '4')).toBe(false);
    expect(isTextualAlignmentCandidateReviewDecisionForCompany(serialized, '4')).toBe(false);
  });

  it('confines authority to the minted company and reviewer', () => {
    const decision = mintTextualAlignmentCandidateReviewDecision(mintInput());
    expect(
      isAttestedTextualAlignmentCandidateReviewDecision(decision, {
        ...authority(),
        company_id: '7',
      })
    ).toBe(false);
    expect(
      isAttestedTextualAlignmentCandidateReviewDecision(decision, {
        ...authority(),
        reviewer_id: '11',
      })
    ).toBe(false);
    expect(isTextualAlignmentCandidateReviewDecisionForCompany(decision, '7')).toBe(false);
  });

  it('authorizes only an accepted, attested decision for the same candidate identity and digest', () => {
    const accepted = mintTextualAlignmentCandidateReviewDecision(mintInput());
    expect(authorizesTextualAlignmentCandidate(accepted, '4', subject())).toBe(true);
    expect(authorizesTextualAlignmentCandidate(accepted, '7', subject())).toBe(false);
    expect(
      authorizesTextualAlignmentCandidate(
        {
          ...accepted,
          candidate_id: 'mw:textual-alignment-candidate:other',
        } as TextualAlignmentCandidateReviewDecision,
        '4',
        subject()
      )
    ).toBe(false);
    expect(
      authorizesTextualAlignmentCandidate(accepted, '4', {
        candidate_id: candidateId,
        candidate_digest: 'c'.repeat(64),
      })
    ).toBe(false);
    expect(
      authorizesTextualAlignmentCandidate(
        mintTextualAlignmentCandidateReviewDecision(
          mintInput({ outcome: 'rejected', id: 'mw:textual-alignment-candidate-review:review-2' })
        ),
        '4',
        subject()
      )
    ).toBe(false);
    expect(authorizesTextualAlignmentCandidate(null, '4', subject())).toBe(false);
    // A forged object that reads exactly like a decision still authorizes nothing.
    expect(
      authorizesTextualAlignmentCandidate(
        JSON.parse(JSON.stringify(accepted)) as TextualAlignmentCandidateReviewDecision,
        '4',
        subject()
      )
    ).toBe(false);
  });
});
