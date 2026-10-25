import { describe, expect, it } from 'vitest';
import {
  authorizesConceptProfile,
  isAttestedConceptProfileReviewDecision,
  isConceptProfileReviewDecisionForCompany,
  mintConceptProfileReviewDecision,
  type ConceptProfileReviewDecision,
  type MintConceptProfileReviewInput,
} from '../src/index.js';

const profileDigest = 'a'.repeat(64);
const versionDigest = 'b'.repeat(64);
const profileId = 'mw:concept-profile:mercy-context-a';

function mintInput(
  overrides: Partial<MintConceptProfileReviewInput> = {}
): MintConceptProfileReviewInput {
  return {
    id: 'mw:concept-profile-review:review-1',
    company_id: '4',
    reviewer_id: '9',
    profile_id: profileId,
    profile_digest: profileDigest,
    reviewed_version: 1,
    reviewed_digest: versionDigest,
    outcome: 'accepted',
    decided_at: '2026-10-25T00:00:00Z',
    rationale: 'Reviewed the bounded scope and the source-span observation.',
    ...overrides,
  };
}

function authority() {
  return { company_id: '4', reviewer_id: '9' };
}

describe('concept profile review decisions', () => {
  it('mints an immutable decision bound to the minting authority', () => {
    const decision = mintConceptProfileReviewDecision(mintInput());
    expect(decision).toMatchObject({
      kind: 'ConceptProfileReviewDecision',
      profile_id: profileId,
      profile_digest: profileDigest,
      reviewed_digest: versionDigest,
      outcome: 'accepted',
    });
    expect(isAttestedConceptProfileReviewDecision(decision, authority())).toBe(true);
    expect(isConceptProfileReviewDecisionForCompany(decision, '4')).toBe(true);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(() => {
      (decision as { rationale: string }).rationale = 'rewritten after review';
    }).toThrow();
  });

  it('refuses to mint a decision with unusable bounds', () => {
    const cases: Array<[Partial<MintConceptProfileReviewInput>, string]> = [
      [{ id: '  ' }, 'id is invalid'],
      [{ id: 'x'.repeat(256) }, 'id is invalid'],
      [{ company_id: ' ' }, 'reviewing company'],
      [{ reviewer_id: '' }, 'reviewing actor'],
      [{ profile_id: 'mw:concept:mercy' }, 'profile identity is invalid'],
      [{ profile_digest: 'z'.repeat(64) }, 'canonical profile digest'],
      [{ reviewed_digest: 'c'.repeat(63) }, 'reviewed version digest'],
      [{ reviewed_version: 0 }, 'reviewed profile version'],
      [{ reviewed_version: 1.5 }, 'reviewed profile version'],
      [{ outcome: 'pending' as 'accepted' }, 'accepted or rejected'],
      [{ decided_at: 'not-a-date' }, 'decision timestamp'],
      [{ rationale: '   ' }, 'bounded rationale'],
      [{ rationale: 'x'.repeat(4001) }, 'bounded rationale'],
    ];
    for (const [overrides, message] of cases) {
      expect(() => mintConceptProfileReviewDecision(mintInput(overrides))).toThrow(
        new RegExp(message, 'u')
      );
    }
  });

  it('attests the minted object, not a structurally identical copy', () => {
    const decision = mintConceptProfileReviewDecision(mintInput());
    const copied = { ...decision };
    const serialized = JSON.parse(JSON.stringify(decision)) as ConceptProfileReviewDecision;
    expect(isAttestedConceptProfileReviewDecision(copied, authority())).toBe(false);
    expect(isAttestedConceptProfileReviewDecision(serialized, authority())).toBe(false);
    expect(isConceptProfileReviewDecisionForCompany(copied, '4')).toBe(false);
    expect(isConceptProfileReviewDecisionForCompany(serialized, '4')).toBe(false);
  });

  it('confines authority to the minted company and reviewer', () => {
    const decision = mintConceptProfileReviewDecision(mintInput());
    expect(
      isAttestedConceptProfileReviewDecision(decision, { ...authority(), company_id: '7' })
    ).toBe(false);
    expect(
      isAttestedConceptProfileReviewDecision(decision, { ...authority(), reviewer_id: '11' })
    ).toBe(false);
    expect(isConceptProfileReviewDecisionForCompany(decision, '7')).toBe(false);
  });

  it('authorizes only an accepted, attested decision for the same identity and digest', () => {
    const accepted = mintConceptProfileReviewDecision(mintInput());
    expect(
      authorizesConceptProfile(accepted, '4', {
        profile_id: profileId,
        profile_digest: profileDigest,
      })
    ).toBe(true);
    expect(
      authorizesConceptProfile(accepted, '7', {
        profile_id: profileId,
        profile_digest: profileDigest,
      })
    ).toBe(false);
    expect(
      authorizesConceptProfile(
        { ...accepted, profile_id: 'mw:concept-profile:other' } as ConceptProfileReviewDecision,
        '4',
        { profile_id: profileId, profile_digest: profileDigest }
      )
    ).toBe(false);
    expect(
      authorizesConceptProfile(accepted, '4', {
        profile_id: profileId,
        profile_digest: 'c'.repeat(64),
      })
    ).toBe(false);
    expect(
      authorizesConceptProfile(
        mintConceptProfileReviewDecision(
          mintInput({ outcome: 'rejected', id: 'mw:concept-profile-review:review-2' })
        ),
        '4',
        { profile_id: profileId, profile_digest: profileDigest }
      )
    ).toBe(false);
    expect(
      authorizesConceptProfile(null, '4', { profile_id: profileId, profile_digest: profileDigest })
    ).toBe(false);
    // A forged object that reads exactly like a decision still authorizes nothing.
    expect(
      authorizesConceptProfile(
        JSON.parse(JSON.stringify(accepted)) as ConceptProfileReviewDecision,
        '4',
        { profile_id: profileId, profile_digest: profileDigest }
      )
    ).toBe(false);
  });
});
