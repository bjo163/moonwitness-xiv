import { createJsonSchemaValidator, type JsonSchemaContract } from '@moonwitness/knowledge';
import narrativePersonaSchema from '../../../ontology/mappings/narrative-persona.schema.json' with { type: 'json' };
import type {
  IdentityReconciliationCandidate,
  IdentityReconciliationDecision,
} from './identity-reconciliation.js';
import { validateIdentityCandidate, validateIdentityDecision } from './identity-reconciliation.js';

export interface NarrativePersonaAlias {
  label: string;
  language: string;
  script: string;
  source_ref: string;
}

export interface NarrativePersonaRole {
  label: string;
  source_ref: string;
}

export interface NarrativePersona {
  id: `mw:persona:${string}`;
  kind: 'NarrativePersona';
  aliases: NarrativePersonaAlias[];
  roles: NarrativePersonaRole[];
  source_refs: string[];
  historical_identity_association?: {
    identity_id: string;
    decision_id: IdentityReconciliationDecision['id'];
  };
}

const validateSchema = createJsonSchemaValidator(
  narrativePersonaSchema as unknown as JsonSchemaContract,
  'does not match the narrative persona contract'
);

/**
 * Validate the shape and internal references of a persona draft.
 *
 * `acceptedDecision` and `candidate` are caller-supplied evidence for structural checking only.
 * Production persistence must resolve the canonical review decision and candidate from trusted
 * storage, verify company scope and review history, and must not use this function to authorize
 * identity merging or persistence.
 */
export function validateNarrativePersona(
  value: unknown,
  acceptedDecision?: IdentityReconciliationDecision | readonly IdentityReconciliationDecision[],
  candidate?: IdentityReconciliationCandidate
) {
  const result = validateSchema(value);
  if (!result.valid) return result;
  const persona = value as NarrativePersona;
  if (persona.kind !== 'NarrativePersona') {
    return {
      valid: false as const,
      issues: [{ path: '/kind', keyword: 'const', message: 'must be a narrative persona' }],
    };
  }

  const sourceRefs = new Set(persona.source_refs);
  const unsupportedAlias = persona.aliases.find((alias) => !sourceRefs.has(alias.source_ref));
  if (unsupportedAlias) {
    return {
      valid: false as const,
      issues: [
        {
          path: '/aliases',
          keyword: 'source_backed',
          message: 'each alias source must appear in source_refs',
        },
      ],
    };
  }
  const unsupportedRole = persona.roles.find((role) => !sourceRefs.has(role.source_ref));
  if (unsupportedRole) {
    return {
      valid: false as const,
      issues: [
        {
          path: '/roles',
          keyword: 'source_backed',
          message: 'each role source must appear in source_refs',
        },
      ],
    };
  }

  const association = persona.historical_identity_association;
  if (!association) return result;
  const decisions = Array.isArray(acceptedDecision)
    ? acceptedDecision
    : acceptedDecision
      ? [acceptedDecision]
      : [];
  if (decisions.length !== 1 || !candidate) {
    return {
      valid: false as const,
      issues: [
        {
          path: '/historical_identity_association',
          keyword: 'review_required',
          message: 'association requires its accepted K3-003 decision and candidate',
        },
      ],
    };
  }
  const decision = decisions[0]!;
  const candidateConflictIds = new Set(candidate.conflicts.map((conflict) => conflict.id));
  const preservedConflictIds = new Set(decision.preserved_conflict_ids);
  if (
    !validateIdentityCandidate(candidate).valid ||
    !validateIdentityDecision(decision).valid ||
    decision.outcome !== 'accepted' ||
    decision.id !== association.decision_id ||
    decision.candidate_id !== candidate.id ||
    ![candidate.left_identity_id, candidate.right_identity_id].includes(persona.id) ||
    ![candidate.left_identity_id, candidate.right_identity_id].includes(association.identity_id) ||
    association.identity_id === persona.id ||
    preservedConflictIds.size !== decision.preserved_conflict_ids.length ||
    preservedConflictIds.size !== candidateConflictIds.size ||
    [...candidateConflictIds].some((conflictId) => !preservedConflictIds.has(conflictId))
  ) {
    return {
      valid: false as const,
      issues: [
        {
          path: '/historical_identity_association',
          keyword: 'accepted_decision',
          message: 'association must reference a matching accepted K3-003 decision',
        },
      ],
    };
  }
  return result;
}
