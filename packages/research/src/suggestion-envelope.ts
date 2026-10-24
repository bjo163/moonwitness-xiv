import { createHash } from 'node:crypto';
import { createJsonSchemaValidator, type JsonSchemaContract } from '@moonwitness/knowledge';
import suggestionEnvelopeSchema from './suggestion-envelope.schema.json' with { type: 'json' };

export interface SuggestionSpanSelector {
  source_id: string;
  edition_id: string;
  locator: string;
  content_sha256: string;
  range: { unit: 'unicode_scalar'; start: number; end: number };
  selected_span_sha256: string;
}

export interface SuggestionCitation {
  evidence_id: `mw:evidence:${string}`;
  assertion_id: `mw:assertion:${string}`;
  selector: SuggestionSpanSelector;
}

interface SuggestionBase {
  id: `mw:suggestion:${string}`;
  status: 'unreviewed';
  visibility: 'INTERNAL';
  citations: SuggestionCitation[];
}

export interface SummarySuggestion extends SuggestionBase {
  kind: 'summary';
  text: string;
}

export interface TermSuggestion extends SuggestionBase {
  kind: 'term';
  text: string;
}

export interface DuplicateSuggestion extends SuggestionBase {
  kind: 'duplicate';
  assertion_ids: [`mw:assertion:${string}`, `mw:assertion:${string}`];
}

export type ResearchSuggestion = SummarySuggestion | TermSuggestion | DuplicateSuggestion;
export interface ResearchSuggestionEnvelope {
  format: 'mw-local-ai-suggestion-envelope/v1';
  suggestions: ResearchSuggestion[];
}

export interface TrustedSuggestionPassage {
  source_id: string;
  edition_id: string;
  locator: string;
  content_sha256: string;
  text: string;
  readable: boolean;
}

export interface TrustedSuggestionAssertion {
  active: boolean;
  readable: boolean;
}

export interface TrustedSuggestionEvidence {
  assertion_id: string;
  active: boolean;
  readable: boolean;
}

/** Implementations must read authoritative source and tenant-scoped records, never model input. */
export interface TrustedSuggestionResolver {
  resolvePassage(selector: SuggestionSpanSelector): Promise<TrustedSuggestionPassage | null>;
  resolveAssertion(assertionId: string): Promise<TrustedSuggestionAssertion | null>;
  resolveEvidence(evidenceId: string): Promise<TrustedSuggestionEvidence | null>;
}

export type SuggestionEnvelopeErrorCode =
  | 'invalid_envelope'
  | 'duplicate_identifier'
  | 'passage_unavailable'
  | 'source_identity_mismatch'
  | 'source_digest_mismatch'
  | 'source_access_denied'
  | 'span_invalid'
  | 'span_digest_mismatch'
  | 'unsupported_text'
  | 'assertion_unavailable'
  | 'evidence_unavailable'
  | 'evidence_binding_mismatch';

export class SuggestionEnvelopeError extends Error {
  constructor(
    readonly code: SuggestionEnvelopeErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SuggestionEnvelopeError';
  }
}

export const researchSuggestionEnvelopeSchema = suggestionEnvelopeSchema;
const validateSchema = createJsonSchemaValidator(
  suggestionEnvelopeSchema as unknown as JsonSchemaContract,
  'does not match the closed suggestion envelope contract'
);

export function validateResearchSuggestionEnvelope(value: unknown) {
  return validateSchema(value);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Validate model output and re-resolve every cited source span and duplicate link against trusted
 * local state. This contract does not authorize sources: route-level allowlists remain mandatory.
 */
export async function validateResearchSuggestionEnvelopeWithResolver(
  value: unknown,
  resolver: TrustedSuggestionResolver
): Promise<ResearchSuggestionEnvelope> {
  const shape = validateSchema(value);
  if (!shape.valid)
    throw new SuggestionEnvelopeError('invalid_envelope', 'Suggestion envelope is invalid');
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    throw new SuggestionEnvelopeError('invalid_envelope', 'Suggestion envelope is not JSON data');
  }
  const snapshotShape = validateSchema(snapshot);
  if (!snapshotShape.valid)
    throw new SuggestionEnvelopeError('invalid_envelope', 'Suggestion envelope is invalid');
  const envelope = snapshot as ResearchSuggestionEnvelope;
  const ids = new Set<string>();

  for (const suggestion of envelope.suggestions) {
    if (ids.has(suggestion.id)) {
      throw new SuggestionEnvelopeError('duplicate_identifier', 'Suggestion IDs must be unique');
    }
    ids.add(suggestion.id);
    const excerpts: string[] = [];
    for (const citation of suggestion.citations) {
      const selector = {
        ...citation.selector,
        range: { ...citation.selector.range },
      };
      const passage = await resolver.resolvePassage({
        ...selector,
        range: { ...selector.range },
      });
      if (!passage)
        throw new SuggestionEnvelopeError('passage_unavailable', 'Cited passage is unavailable');
      if (
        passage.source_id !== selector.source_id ||
        passage.edition_id !== selector.edition_id ||
        passage.locator !== selector.locator
      ) {
        throw new SuggestionEnvelopeError(
          'source_identity_mismatch',
          'Cited passage identity does not match'
        );
      }
      // The resolver verifies content_sha256 against the exact stored source bytes; passage.text
      // may be a decoded logical line whose byte representation includes a terminal LF.
      if (passage.content_sha256 !== selector.content_sha256) {
        throw new SuggestionEnvelopeError(
          'source_digest_mismatch',
          'Cited source digest does not match its bytes'
        );
      }
      if (passage.readable !== true)
        throw new SuggestionEnvelopeError('source_access_denied', 'Cited passage is not readable');
      const scalars = Array.from(passage.text);
      const { start, end } = selector.range;
      if (start >= end || end > scalars.length) {
        throw new SuggestionEnvelopeError('span_invalid', 'Cited Unicode-scalar range is invalid');
      }
      const excerpt = scalars.slice(start, end).join('');
      if (sha256(excerpt) !== selector.selected_span_sha256) {
        throw new SuggestionEnvelopeError(
          'span_digest_mismatch',
          'Selected span digest does not match'
        );
      }
      const assertion = await resolver.resolveAssertion(citation.assertion_id);
      if (!assertion || assertion.active !== true || assertion.readable !== true) {
        throw new SuggestionEnvelopeError(
          'assertion_unavailable',
          'Cited Assertion is not active and readable'
        );
      }
      const evidence = await resolver.resolveEvidence(citation.evidence_id);
      if (!evidence || evidence.active !== true || evidence.readable !== true) {
        throw new SuggestionEnvelopeError(
          'evidence_unavailable',
          'Cited Evidence is not active and readable'
        );
      }
      if (evidence.assertion_id !== citation.assertion_id) {
        throw new SuggestionEnvelopeError(
          'evidence_binding_mismatch',
          'Cited Evidence is not bound to its Assertion'
        );
      }
      excerpts.push(excerpt);
    }

    if (suggestion.kind === 'summary' && suggestion.text !== excerpts.join('')) {
      throw new SuggestionEnvelopeError(
        'unsupported_text',
        'Summary must be the exact concatenation of cited spans'
      );
    }
    if (suggestion.kind === 'term' && suggestion.text !== excerpts[0]) {
      throw new SuggestionEnvelopeError(
        'unsupported_text',
        'Term text must exactly equal its cited span'
      );
    }
    if (suggestion.kind === 'duplicate') {
      const [left, right] = suggestion.assertion_ids;
      if (left === right)
        throw new SuggestionEnvelopeError(
          'invalid_envelope',
          'Duplicate pair must contain distinct Assertions'
        );
      for (const citation of suggestion.citations) {
        if (!suggestion.assertion_ids.includes(citation.assertion_id)) {
          throw new SuggestionEnvelopeError(
            'evidence_binding_mismatch',
            'Duplicate citation must bind to one requested Assertion'
          );
        }
      }
      const citedAssertions = new Set(
        suggestion.citations.map((citation) => citation.assertion_id)
      );
      if (!suggestion.assertion_ids.every((assertionId) => citedAssertions.has(assertionId))) {
        throw new SuggestionEnvelopeError(
          'evidence_binding_mismatch',
          'Duplicate pair requires cited Evidence for both Assertions'
        );
      }
    }
  }
  return envelope;
}
