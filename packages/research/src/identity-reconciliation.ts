import { createJsonSchemaValidator, type JsonSchemaContract } from '@moonwitness/knowledge';
import identityDecisionSchema from '../../../ontology/mappings/identity-decision.schema.json' with { type: 'json' };

export type IdentityOutcome = 'accepted' | 'rejected';
export type IdentityConflictKind =
  'homonym' | 'multilingual_alias' | 'competing_identity' | 'other';

export interface IdentityAliasObservation {
  identity_id: string;
  label: string;
  language: string;
  script: string;
  context_ref: string;
  meaning_note?: string;
}

export interface IdentityConflict {
  id: `mw:identity-conflict:${string}`;
  kind: IdentityConflictKind;
  description: string;
  evidence_refs: string[];
}

/** A candidate records a hypothesis only; it does not assert identity equivalence. */
export interface IdentityReconciliationCandidate {
  id: `mw:identity-candidate:${string}`;
  kind: 'IdentityReconciliationCandidate';
  status: 'candidate';
  left_identity_id: string;
  right_identity_id: string;
  alias_observations: IdentityAliasObservation[];
  conflicts: IdentityConflict[];
  created_at: string;
}

/** An explicit human decision. It records adjudication without creating a relation. */
export interface IdentityReconciliationDecision {
  id: `mw:identity-decision:${string}`;
  kind: 'IdentityReconciliationDecision';
  candidate_id: IdentityReconciliationCandidate['id'];
  outcome: IdentityOutcome;
  evidence_refs: string[];
  reviewer_id: string;
  reviewed_at: string;
  preserved_conflict_ids: IdentityConflict['id'][];
}

export type IdentityDecisionSummary =
  | { status: 'candidate'; decisions: [] }
  | {
      status: 'accepted_decision' | 'rejected_decision';
      decisions: IdentityReconciliationDecision[];
    }
  | { status: 'conflicting_decisions'; decisions: IdentityReconciliationDecision[] };

const validateSchema = createJsonSchemaValidator(
  identityDecisionSchema as unknown as JsonSchemaContract,
  'does not match the identity reconciliation contract'
);

export function validateIdentityCandidate(value: unknown) {
  const result = validateSchema(value);
  if (!result.valid) return result;
  const candidate = value as IdentityReconciliationCandidate;
  if (candidate.kind !== 'IdentityReconciliationCandidate' || candidate.status !== 'candidate') {
    return {
      valid: false as const,
      issues: [{ path: '/kind', keyword: 'const', message: 'must be an identity candidate' }],
    };
  }
  if (candidate.left_identity_id === candidate.right_identity_id) {
    return {
      valid: false as const,
      issues: [
        {
          path: '/right_identity_id',
          keyword: 'identity_distinct',
          message: 'candidate identities must differ',
        },
      ],
    };
  }
  const allowedIdentityIds = new Set([candidate.left_identity_id, candidate.right_identity_id]);
  const unrelatedObservation = candidate.alias_observations.find(
    (observation) => !allowedIdentityIds.has(observation.identity_id)
  );
  if (unrelatedObservation) {
    return {
      valid: false as const,
      issues: [
        {
          path: '/alias_observations',
          keyword: 'candidate_identity',
          message: 'alias observations must belong to one of the candidate identities',
        },
      ],
    };
  }
  const conflictIds = candidate.conflicts.map((conflict) => conflict.id);
  if (new Set(conflictIds).size !== conflictIds.length) {
    return {
      valid: false as const,
      issues: [
        {
          path: '/conflicts',
          keyword: 'unique_conflict_id',
          message: 'conflict IDs must be unique within a candidate',
        },
      ],
    };
  }
  return result;
}

export function validateIdentityDecision(value: unknown) {
  const result = validateSchema(value);
  if (!result.valid) return result;
  const decision = value as IdentityReconciliationDecision;
  return decision.kind === 'IdentityReconciliationDecision'
    ? result
    : {
        valid: false as const,
        issues: [{ path: '/kind', keyword: 'const', message: 'must be an identity decision' }],
      };
}

/** Record a deliberate review while requiring every known conflict to stay attached. */
export function recordIdentityDecision(
  candidate: IdentityReconciliationCandidate,
  input: Omit<IdentityReconciliationDecision, 'candidate_id' | 'preserved_conflict_ids'> & {
    candidate_id?: IdentityReconciliationCandidate['id'];
    preserved_conflict_ids: IdentityConflict['id'][];
  }
): IdentityReconciliationDecision {
  const candidateValidation = validateIdentityCandidate(candidate);
  if (!candidateValidation.valid) throw new TypeError('Identity candidate is invalid');
  if (input.candidate_id !== undefined && input.candidate_id !== candidate.id) {
    throw new TypeError('Decision candidate_id does not match the reviewed candidate');
  }
  const expected = new Set(candidate.conflicts.map((conflict) => conflict.id));
  const provided = new Set(input.preserved_conflict_ids);
  if (
    expected.size !== provided.size ||
    [...expected].some((conflictId) => !provided.has(conflictId))
  ) {
    throw new TypeError('Decision must preserve every conflict recorded on its candidate');
  }
  const decision: IdentityReconciliationDecision = {
    id: input.id,
    kind: input.kind,
    candidate_id: candidate.id,
    outcome: input.outcome,
    evidence_refs: [...input.evidence_refs],
    reviewer_id: input.reviewer_id,
    reviewed_at: input.reviewed_at,
    preserved_conflict_ids: [...input.preserved_conflict_ids],
  };
  const decisionValidation = validateIdentityDecision(decision);
  if (!decisionValidation.valid) throw new TypeError('Identity decision is invalid');
  return decision;
}

/** Keep every decision visible; contradictory reviews are surfaced as a conflict. */
export function summarizeIdentityDecisions(
  candidateId: IdentityReconciliationCandidate['id'],
  decisions: readonly IdentityReconciliationDecision[]
): IdentityDecisionSummary {
  const retained = [...decisions];
  if (retained.some((decision) => decision.candidate_id !== candidateId)) {
    throw new TypeError('Cannot summarize decisions from different identity candidates');
  }
  if (retained.some((decision) => !validateIdentityDecision(decision).valid)) {
    throw new TypeError('Cannot summarize invalid identity decisions');
  }
  const outcomes = new Set(retained.map((decision) => decision.outcome));
  if (outcomes.size > 1) return { status: 'conflicting_decisions', decisions: retained };
  if (outcomes.has('accepted')) return { status: 'accepted_decision', decisions: retained };
  if (outcomes.has('rejected')) return { status: 'rejected_decision', decisions: retained };
  return { status: 'candidate', decisions: [] };
}
