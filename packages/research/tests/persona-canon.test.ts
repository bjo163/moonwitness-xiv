import { describe, expect, it } from 'vitest';
import {
  recordIdentityDecision,
  type IdentityReconciliationCandidate,
} from '../src/identity-reconciliation.js';
import { validateNarrativePersona, type NarrativePersona } from '../src/persona-canon.js';

function persona(): NarrativePersona {
  return {
    id: 'mw:persona:traveler-a',
    kind: 'NarrativePersona',
    aliases: [
      { label: 'Traveler', language: 'en', script: 'Latn', source_ref: 'mw:source:synthetic-a' },
    ],
    roles: [{ label: 'Witness in the story', source_ref: 'mw:source:synthetic-a' }],
    source_refs: ['mw:source:synthetic-a'],
  };
}

function candidate(): IdentityReconciliationCandidate {
  return {
    id: 'mw:identity-candidate:persona-review',
    kind: 'IdentityReconciliationCandidate',
    status: 'candidate',
    left_identity_id: 'mw:persona:traveler-a',
    right_identity_id: 'mw:entity:historical-person-a',
    alias_observations: [],
    conflicts: [],
    created_at: '2026-10-17T00:00:00Z',
  };
}

function acceptedDecision(value: IdentityReconciliationCandidate) {
  return recordIdentityDecision(value, {
    id: 'mw:identity-decision:persona-review-accepted',
    kind: 'IdentityReconciliationDecision',
    outcome: 'accepted',
    evidence_refs: ['mw:evidence:review'],
    reviewer_id: 'mw:agent:reviewer',
    reviewed_at: '2026-10-17T01:00:00Z',
    preserved_conflict_ids: [],
  });
}

describe('narrative persona canon contract', () => {
  it('keeps narrative persona identifiers distinct and aliases observational', () => {
    const value = persona();
    expect(validateNarrativePersona(value)).toEqual({ valid: true, issues: [] });
    expect(value.id).toMatch(/^mw:persona:/);
    expect(value).not.toHaveProperty('same_as');
    expect(
      validateNarrativePersona({ ...value, id: 'mw:entity:historical-person-a' })
    ).toMatchObject({ valid: false });
    expect(
      validateNarrativePersona({ ...value, same_as: 'mw:entity:historical-person-a' })
    ).toMatchObject({ valid: false });
    expect(
      validateNarrativePersona({ ...value, canonical_entity_id: 'mw:entity:historical-person-a' })
    ).toMatchObject({ valid: false });
  });

  it('requires source-backed aliases and roles and rejects empty evidence', () => {
    const value = persona();
    expect(validateNarrativePersona({ ...value, source_refs: [] })).toMatchObject({ valid: false });
    expect(
      validateNarrativePersona({
        ...value,
        aliases: [{ ...value.aliases[0]!, source_ref: 'mw:source:missing' }],
      })
    ).toMatchObject({ valid: false, issues: [{ keyword: 'source_backed' }] });
    expect(validateNarrativePersona({ ...value, roles: [] })).toMatchObject({ valid: false });
  });

  it('requires a matching accepted K3-003 decision before an identity association', () => {
    const value = {
      ...persona(),
      historical_identity_association: {
        identity_id: 'mw:entity:historical-person-a',
        decision_id: 'mw:identity-decision:persona-review-accepted',
      },
    };
    expect(validateNarrativePersona(value)).toMatchObject({
      valid: false,
      issues: [{ keyword: 'review_required' }],
    });
    const reviewCandidate = candidate();
    const accepted = acceptedDecision(reviewCandidate);
    expect(validateNarrativePersona(value, accepted, reviewCandidate)).toEqual({
      valid: true,
      issues: [],
    });
    expect(
      validateNarrativePersona(value, { ...accepted, outcome: 'rejected' }, reviewCandidate)
    ).toMatchObject({ valid: false });
    expect(
      validateNarrativePersona(value, accepted, {
        ...reviewCandidate,
        id: 'mw:identity-candidate:other',
      })
    ).toMatchObject({ valid: false });
    expect(
      validateNarrativePersona(
        {
          ...persona(),
          historical_identity_association: {
            ...value.historical_identity_association,
            identity_id: 'mw:entity:outside-candidate',
          },
        },
        accepted,
        reviewCandidate
      )
    ).toMatchObject({ valid: false });
    expect(
      validateNarrativePersona(
        {
          ...persona(),
          historical_identity_association: {
            ...value.historical_identity_association,
            identity_id: 'mw:persona:traveler-a',
          },
        },
        accepted,
        reviewCandidate
      )
    ).toMatchObject({ valid: false });
    expect(
      validateNarrativePersona(
        {
          ...persona(),
          historical_identity_association: {
            ...value.historical_identity_association,
            identity_id: 'mw:concept:personhood',
          },
        },
        accepted,
        reviewCandidate
      )
    ).toMatchObject({ valid: false });
    const rejected = recordIdentityDecision(reviewCandidate, {
      id: 'mw:identity-decision:persona-review-rejected',
      kind: 'IdentityReconciliationDecision',
      outcome: 'rejected',
      evidence_refs: ['mw:evidence:review'],
      reviewer_id: 'mw:agent:reviewer',
      reviewed_at: '2026-10-17T02:00:00Z',
      preserved_conflict_ids: [],
    });
    expect(validateNarrativePersona(value, [accepted, rejected], reviewCandidate)).toMatchObject({
      valid: false,
    });
  });

  it('rejects an accepted decision that drops a candidate conflict', () => {
    const conflictedCandidate = {
      ...candidate(),
      conflicts: [
        {
          id: 'mw:identity-conflict:homonym',
          kind: 'homonym' as const,
          description: 'Similar narrative labels may refer to different people.',
          evidence_refs: ['mw:evidence:synthetic-conflict'],
        },
      ],
    };
    // Simulate a schema-valid stored decision from before the conflict was attached to this
    // candidate snapshot; it must not authorize association once the conflict is present.
    const completeDecision = acceptedDecision(candidate());
    const droppedConflictDecision = {
      ...completeDecision,
      preserved_conflict_ids: [],
    };
    const value = {
      ...persona(),
      historical_identity_association: {
        identity_id: 'mw:entity:historical-person-a',
        decision_id: completeDecision.id,
      },
    };
    expect(
      validateNarrativePersona(value, droppedConflictDecision, conflictedCandidate)
    ).toMatchObject({
      valid: false,
      issues: [{ keyword: 'accepted_decision' }],
    });
  });
});
