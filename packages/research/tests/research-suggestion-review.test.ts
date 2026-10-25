import { describe, expect, it } from 'vitest';
import {
  authorizesResearchSuggestion,
  isAttestedResearchSuggestionReviewDecision,
  isResearchSuggestionReviewDecisionForCompany,
  mintResearchSuggestionReviewDecision,
  type MintResearchSuggestionReviewInput,
  type ResearchSuggestionReviewDecision,
} from '../src/index.js';

const suggestionId = 'mw:suggestion:synthetic-summary';
const suggestionDigest = 'a'.repeat(64);

function mintInput(
  overrides: Partial<MintResearchSuggestionReviewInput> = {}
): MintResearchSuggestionReviewInput {
  return {
    id: 'mw:suggestion-review:review-1',
    company_id: '4',
    reviewer_id: '9',
    suggestion_id: suggestionId,
    suggestion_digest: suggestionDigest,
    reviewed_version: 1,
    outcome: 'accepted',
    decided_at: '2026-10-25T00:00:00Z',
    rationale: 'Reviewed the extractive passage and its citation-only boundary.',
    ...overrides,
  };
}

function authority() {
  return { company_id: '4', reviewer_id: '9' };
}

function subject() {
  return { suggestion_id: suggestionId, suggestion_digest: suggestionDigest };
}

describe('research suggestion review decisions', () => {
  it('mints an immutable decision bound to the minting authority', () => {
    const decision = mintResearchSuggestionReviewDecision(mintInput());
    expect(decision).toMatchObject({
      kind: 'ResearchSuggestionReviewDecision',
      suggestion_id: suggestionId,
      suggestion_digest: suggestionDigest,
      reviewed_version: 1,
      outcome: 'accepted',
    });
    expect(isAttestedResearchSuggestionReviewDecision(decision, authority())).toBe(true);
    expect(isResearchSuggestionReviewDecisionForCompany(decision, '4')).toBe(true);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(() => {
      (decision as { outcome: string }).outcome = 'accepted';
    }).toThrow();
  });

  it('refuses to mint a decision with unusable bounds', () => {
    const cases: Array<[Partial<MintResearchSuggestionReviewInput>, string]> = [
      [{ id: '  ' }, 'decision id is invalid'],
      [{ id: 'x'.repeat(256) }, 'decision id is invalid'],
      [{ company_id: ' ' }, 'reviewing company'],
      [{ reviewer_id: '' }, 'reviewing actor'],
      [{ suggestion_id: 'mw:summary:synthetic' }, 'suggestion identity is invalid'],
      [{ suggestion_digest: 'z'.repeat(64) }, 'canonical suggestion digest'],
      [{ reviewed_version: 0 }, 'reviewed suggestion version'],
      [{ reviewed_version: 2.5 }, 'reviewed suggestion version'],
      [{ outcome: 'promoted' as 'accepted' }, 'accepted or rejected'],
      [{ decided_at: 'not-a-date' }, 'decision timestamp'],
      [{ rationale: '   ' }, 'bounded rationale'],
      [{ rationale: 'x'.repeat(4001) }, 'bounded rationale'],
    ];
    for (const [overrides, message] of cases) {
      expect(() => mintResearchSuggestionReviewDecision(mintInput(overrides))).toThrow(
        new RegExp(message, 'u')
      );
    }
  });

  it('attests the minted object, not a structurally identical copy', () => {
    const decision = mintResearchSuggestionReviewDecision(mintInput());
    const copied = { ...decision };
    const serialized = JSON.parse(JSON.stringify(decision)) as ResearchSuggestionReviewDecision;
    expect(isAttestedResearchSuggestionReviewDecision(copied, authority())).toBe(false);
    expect(isAttestedResearchSuggestionReviewDecision(serialized, authority())).toBe(false);
    expect(isResearchSuggestionReviewDecisionForCompany(copied, '4')).toBe(false);
    expect(isResearchSuggestionReviewDecisionForCompany(serialized, '4')).toBe(false);
  });

  it('confines authority to the minted company and reviewer', () => {
    const decision = mintResearchSuggestionReviewDecision(mintInput());
    expect(
      isAttestedResearchSuggestionReviewDecision(decision, { ...authority(), company_id: '7' })
    ).toBe(false);
    expect(
      isAttestedResearchSuggestionReviewDecision(decision, { ...authority(), reviewer_id: '11' })
    ).toBe(false);
    expect(isResearchSuggestionReviewDecisionForCompany(decision, '7')).toBe(false);
  });

  it('authorizes only an accepted, attested decision for the same suggestion identity and digest', () => {
    const accepted = mintResearchSuggestionReviewDecision(mintInput());
    expect(authorizesResearchSuggestion(accepted, '4', subject())).toBe(true);
    expect(authorizesResearchSuggestion(accepted, '7', subject())).toBe(false);
    expect(
      authorizesResearchSuggestion(
        {
          ...accepted,
          suggestion_id: 'mw:suggestion:synthetic-other',
        } as ResearchSuggestionReviewDecision,
        '4',
        subject()
      )
    ).toBe(false);
    expect(
      authorizesResearchSuggestion(accepted, '4', {
        suggestion_id: suggestionId,
        suggestion_digest: 'c'.repeat(64),
      })
    ).toBe(false);
    expect(
      authorizesResearchSuggestion(
        mintResearchSuggestionReviewDecision(
          mintInput({ outcome: 'rejected', id: 'mw:suggestion-review:review-2' })
        ),
        '4',
        subject()
      )
    ).toBe(false);
    expect(authorizesResearchSuggestion(null, '4', subject())).toBe(false);
    // A forged object that reads exactly like a decision still authorizes nothing.
    expect(
      authorizesResearchSuggestion(
        JSON.parse(JSON.stringify(accepted)) as ResearchSuggestionReviewDecision,
        '4',
        subject()
      )
    ).toBe(false);
  });

  it('gives an accepted verdict no field that could carry promotion', () => {
    expect(Object.keys(mintResearchSuggestionReviewDecision(mintInput())).sort()).toEqual([
      'company_id',
      'decided_at',
      'id',
      'kind',
      'outcome',
      'rationale',
      'reviewed_version',
      'reviewer_id',
      'suggestion_digest',
      'suggestion_id',
    ]);
  });
});
