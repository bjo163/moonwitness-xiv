import { describe, expect, it } from 'vitest';
import {
  isAttestedIdentityDecision,
  recordIdentityDecision,
  summarizeIdentityDecisions,
  validateIdentityCandidate,
  validateIdentityDecision,
  type IdentityReconciliationCandidate,
} from '../src/identity-reconciliation.js';

function candidate(): IdentityReconciliationCandidate {
  return {
    id: 'mw:identity-candidate:shared-name-1',
    kind: 'IdentityReconciliationCandidate',
    status: 'candidate',
    left_identity_id: 'mw:entity:person-a',
    right_identity_id: 'mw:entity:person-b',
    alias_observations: [
      {
        identity_id: 'mw:entity:person-a',
        label: 'Mary',
        language: 'en',
        script: 'Latn',
        context_ref: 'mw:passage:source-a',
        meaning_note: 'English transliteration in this passage.',
      },
      {
        identity_id: 'mw:entity:person-b',
        label: 'مريم',
        language: 'ar',
        script: 'Arab',
        context_ref: 'mw:passage:source-b',
      },
    ],
    conflicts: [
      {
        id: 'mw:identity-conflict:homonym-1',
        kind: 'homonym',
        description: 'The shared Latin label may name distinct people.',
        evidence_refs: ['mw:evidence:source-a'],
      },
      {
        id: 'mw:identity-conflict:alias-language-1',
        kind: 'multilingual_alias',
        description: 'The labels are multilingual forms; equivalence needs review.',
        evidence_refs: ['mw:evidence:source-b'],
      },
    ],
    created_at: '2026-10-16T00:00:00Z',
  };
}

function decide(
  value: IdentityReconciliationCandidate,
  outcome: 'accepted' | 'rejected',
  suffix: string
) {
  return recordIdentityDecision(
    value,
    {
      id: `mw:identity-decision:${suffix}`,
      kind: 'IdentityReconciliationDecision',
      outcome,
      evidence_refs: ['mw:evidence:review-1'],
      reviewer_id: 'mw:agent:reviewer-1',
      reviewed_at: '2026-10-16T01:00:00Z',
      preserved_conflict_ids: value.conflicts.map((conflict) => conflict.id),
    },
    authority()
  );
}

function authority() {
  return { company_id: 'company-alpha', reviewer_id: 'mw:agent:reviewer-1' };
}

describe('identity reconciliation records', () => {
  it('keeps proposed identity links unresolved and retains multilingual homonym context', () => {
    const value = candidate();
    expect(validateIdentityCandidate(value)).toEqual({ valid: true, issues: [] });
    expect(value.status).toBe('candidate');
    expect(value).not.toHaveProperty('same_as');
    expect(value.alias_observations.map((alias) => alias.language)).toEqual(['en', 'ar']);
    expect(value.conflicts.map((conflict) => conflict.kind)).toEqual([
      'homonym',
      'multilingual_alias',
    ]);
    expect(summarizeIdentityDecisions(value.id, [])).toEqual({
      status: 'candidate',
      decisions: [],
    });
  });

  it('records explicit reviewed outcomes with evidence and preserves every conflict', () => {
    const value = candidate();
    const decision = decide(value, 'accepted', 'review-accepted');
    expect(validateIdentityDecision(decision)).toEqual({ valid: true, issues: [] });
    expect(decision).toMatchObject({
      outcome: 'accepted',
      candidate_id: value.id,
      reviewer_id: 'mw:agent:reviewer-1',
      reviewed_at: '2026-10-16T01:00:00Z',
      preserved_conflict_ids: value.conflicts.map((conflict) => conflict.id),
    });
    expect(decision).not.toHaveProperty('same_as');
    expect(summarizeIdentityDecisions(value.id, [decision])).toMatchObject({
      status: 'accepted_decision',
    });

    const rejected = decide(value, 'rejected', 'review-rejected');
    expect(summarizeIdentityDecisions(value.id, [decision, rejected])).toMatchObject({
      status: 'conflicting_decisions',
      decisions: [decision, rejected],
    });
    const otherCandidateDecision = {
      ...decision,
      id: 'mw:identity-decision:other-candidate',
      candidate_id: 'mw:identity-candidate:another-candidate' as const,
    };
    expect(() => summarizeIdentityDecisions(value.id, [decision, otherCandidateDecision])).toThrow(
      'different identity candidates'
    );
  });

  it('rejects unsupported automatic or under-evidenced decisions', () => {
    const value = candidate();
    expect(
      validateIdentityCandidate({ ...value, left_identity_id: value.right_identity_id })
    ).toMatchObject({
      valid: false,
    });
    expect(
      validateIdentityCandidate({
        ...value,
        alias_observations: [
          ...value.alias_observations,
          {
            identity_id: 'mw:entity:unrelated-person',
            label: 'Mary',
            language: 'en',
            script: 'Latn',
            context_ref: 'mw:passage:source-c',
          },
        ],
      })
    ).toMatchObject({ valid: false });
    expect(
      validateIdentityCandidate({
        ...value,
        conflicts: [value.conflicts[0]!, { ...value.conflicts[0]!, description: 'Duplicate ID' }],
      })
    ).toMatchObject({ valid: false });
    expect(() =>
      recordIdentityDecision(
        value,
        {
          id: 'mw:identity-decision:missing-conflict',
          kind: 'IdentityReconciliationDecision',
          outcome: 'accepted',
          evidence_refs: ['mw:evidence:review-1'],
          reviewer_id: 'mw:agent:reviewer-1',
          reviewed_at: '2026-10-16T01:00:00Z',
          preserved_conflict_ids: [],
        },
        authority()
      )
    ).toThrow('preserve every conflict');

    const invalid = {
      ...decide(value, 'accepted', 'no-evidence'),
      evidence_refs: [],
    };
    expect(validateIdentityDecision(invalid)).toMatchObject({ valid: false });
  });

  it('binds authority to the minted object and its company, not to its bytes', () => {
    const value = candidate();
    const decision = decide(value, 'accepted', 'authority-accepted');
    expect(isAttestedIdentityDecision(decision, authority())).toBe(true);
    // Structurally identical copies, including an exact JSON round-trip, are not decisions anyone
    // reviewed: only the object returned by recordIdentityDecision carries the binding.
    expect(isAttestedIdentityDecision({ ...decision }, authority())).toBe(false);
    expect(
      isAttestedIdentityDecision(
        JSON.parse(JSON.stringify(decision)) as IdentityReconciliationDecision,
        authority()
      )
    ).toBe(false);
    expect(
      isAttestedIdentityDecision(decision, { ...authority(), company_id: 'company-beta' })
    ).toBe(false);
    expect(
      isAttestedIdentityDecision(decision, {
        ...authority(),
        reviewer_id: 'mw:agent:reviewer-2',
      })
    ).toBe(false);
    // Minting cannot attribute a review to someone other than the authenticated actor.
    expect(() =>
      recordIdentityDecision(
        value,
        {
          id: 'mw:identity-decision:reviewer-spoof',
          kind: 'IdentityReconciliationDecision',
          outcome: 'accepted',
          evidence_refs: ['mw:evidence:review-1'],
          reviewer_id: 'mw:agent:reviewer-2',
          reviewed_at: '2026-10-16T01:00:00Z',
          preserved_conflict_ids: value.conflicts.map((conflict) => conflict.id),
        },
        authority()
      )
    ).toThrow('reviewing actor');
    expect(() =>
      recordIdentityDecision(
        value,
        {
          id: 'mw:identity-decision:blank-company',
          kind: 'IdentityReconciliationDecision',
          outcome: 'accepted',
          evidence_refs: ['mw:evidence:review-1'],
          reviewer_id: 'mw:agent:reviewer-1',
          reviewed_at: '2026-10-16T01:00:00Z',
          preserved_conflict_ids: value.conflicts.map((conflict) => conflict.id),
        },
        { ...authority(), company_id: ' ' }
      )
    ).toThrow('reviewing actor');
  });
});
