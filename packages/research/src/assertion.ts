import { createJsonSchemaValidator } from '@moonwitness/knowledge';
import assertionSchema from '../../../ontology/core/assertion.schema.json' with { type: 'json' };

export type AssertionPolarity = 'positive' | 'negative';
export type AssertionScopeKind =
  'passage' | 'speaker' | 'document' | 'work' | 'community' | 'time' | 'research_context';
export type AssertionContextMode = 'direct_quote' | 'reported_speech' | 'narration' | 'analysis';
export type AssertionEpistemicStatus = 'asserted' | 'reported' | 'hypothesized' | 'uncertain';
export type AssertionReviewStatus =
  'unreviewed' | 'pending' | 'accepted' | 'rejected' | 'disputed' | 'withdrawn';

export interface ResearchAssertion {
  id: `mw:assertion:${string}`;
  kind: 'Assertion';
  schema_version: 1;
  lifecycle: 'draft' | 'candidate' | 'active' | 'superseded' | 'withdrawn';
  created_at: string;
  updated_at: string;
  origin_ref: string;
  visibility: 'PUBLIC_APPROVED' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED' | 'CHILD_SENSITIVE';
  content_revision: number;
  claim: string;
  polarity: AssertionPolarity;
  scope: { kind: AssertionScopeKind; reference_id: string };
  context:
    | {
        mode: 'direct_quote' | 'reported_speech';
        reference_id: string;
        speaker_id: `mw:agent:${string}` | `mw:entity:${string}`;
      }
    | {
        mode: 'narration' | 'analysis';
        reference_id: string;
        speaker_id?: `mw:agent:${string}` | `mw:entity:${string}`;
      };
  epistemic_status: AssertionEpistemicStatus;
  review_status: AssertionReviewStatus;
}

export type AssertionLookup =
  { status: 'found'; assertion: ResearchAssertion } | { status: 'missing' };

const validateSchema = createJsonSchemaValidator(
  assertionSchema,
  'does not match the scoped research assertion contract'
);

/** Validate the runtime value against the versioned core assertion schema. */
export function validateResearchAssertion(value: unknown) {
  return validateSchema(value);
}

/** Lookup is explicitly tri-state: absence is never represented as negative polarity. */
export function findResearchAssertion(
  assertions: readonly ResearchAssertion[],
  assertionId: string
): AssertionLookup {
  const assertion = assertions.find((candidate) => candidate.id === assertionId);
  return assertion ? { status: 'found', assertion } : { status: 'missing' };
}
