import {
  createJsonSchemaValidator,
  type JsonSchemaContract,
  type KnowledgeValidationResult,
} from '@moonwitness/knowledge';
import semanticAnnotationSchema from '../../../ontology/domains/research-semantic-annotation.schema.json' with { type: 'json' };
import { validateResearchEvidenceReference, type ResolvedEvidenceReference } from './evidence.js';

export type SemanticPolarity = 'positive' | 'negative' | 'ambiguous' | 'unknown';
export type SemanticContextMode = 'direct_quote' | 'reported_speech' | 'narration' | 'analysis';
export type SemanticCueKind = 'affirmation' | 'negation' | 'quotation' | 'speaker_attribution';

export interface SemanticSpan {
  byte_start: number;
  byte_end: number;
  scalar_start: number;
  scalar_end: number;
}

export interface SemanticCue {
  kind: SemanticCueKind;
  span: SemanticSpan;
  text: string;
}

export interface ResearchSemanticAnnotation {
  id: `mw:semantic-annotation:${string}`;
  kind: 'ResearchSemanticAnnotation';
  schema_version: 1;
  subject_assertion_id: `mw:assertion:${string}`;
  evidence_id: `mw:evidence:${string}`;
  source_content_sha256: string;
  offset_basis: 'resolved_evidence_excerpt';
  source_range: SemanticSpan;
  polarity: SemanticPolarity;
  polarity_basis:
    'explicit_affirmation' | 'explicit_negation' | 'human_scope_judgment' | 'insufficient_context';
  polarity_cue?: SemanticCue;
  context: {
    mode: SemanticContextMode;
    speaker_id?: `mw:agent:${string}` | `mw:entity:${string}`;
    cue?: SemanticCue;
  };
  review_status: 'candidate' | 'accepted' | 'rejected';
  reviewer_id?: `mw:user:${string}`;
  reviewed_at?: string;
}

export type SemanticAnnotationValidation = KnowledgeValidationResult;

export type SemanticAssertionProjection =
  | {
      status: 'projected';
      polarity: 'positive' | 'negative';
      context: ResearchSemanticAnnotation['context'];
    }
  | {
      status: 'scoped';
      polarity: 'positive' | 'negative';
      context: ResearchSemanticAnnotation['context'];
    }
  | { status: 'review_required'; reason: 'not_accepted' | 'polarity_uncertain' }
  | { status: 'rejected' }
  | { status: 'invalid'; issues: KnowledgeValidationResult['issues'] };

const validateSchema = createJsonSchemaValidator(
  semanticAnnotationSchema as unknown as JsonSchemaContract,
  'does not match the source-bound semantic annotation contract'
);

function spanMatchesText(span: SemanticSpan, exactText: string): boolean {
  if (
    !Number.isSafeInteger(span.byte_start) ||
    !Number.isSafeInteger(span.byte_end) ||
    !Number.isSafeInteger(span.scalar_start) ||
    !Number.isSafeInteger(span.scalar_end) ||
    span.byte_start < 0 ||
    span.scalar_start < 0 ||
    span.byte_end <= span.byte_start ||
    span.scalar_end <= span.scalar_start
  ) {
    return false;
  }
  const scalars = Array.from(exactText);
  if (span.scalar_end > scalars.length) return false;
  const before = scalars.slice(0, span.scalar_start).join('');
  const selected = scalars.slice(span.scalar_start, span.scalar_end).join('');
  const startBytes = new TextEncoder().encode(before).length;
  const selectedBytes = new TextEncoder().encode(selected).length;
  return span.byte_start === startBytes && span.byte_end === startBytes + selectedBytes;
}

function cueMatchesText(cue: SemanticCue | undefined, exactText: string): boolean {
  if (!cue) return true;
  if (!spanMatchesText(cue.span, exactText)) return false;
  const selected = Array.from(exactText).slice(cue.span.scalar_start, cue.span.scalar_end).join('');
  return selected === cue.text;
}

function resolvedEvidenceMatchesSelector(evidence: ResolvedEvidenceReference): boolean {
  const selector = evidence.evidence.selector;
  const range = selector.range;
  const resolvedRange = evidence.range;
  const rangeMatches = range
    ? resolvedRange?.unit === range.unit &&
      resolvedRange.start === range.start &&
      resolvedRange.end === range.end
    : resolvedRange === undefined;
  return (
    evidence.source_id === selector.source_id &&
    evidence.edition_id === selector.edition_id &&
    evidence.locator === selector.locator &&
    evidence.direction === evidence.evidence.direction &&
    ('expression_id' in selector
      ? evidence.expression_id === selector.expression_id
      : evidence.expression_id === undefined) &&
    rangeMatches &&
    (selector.quote === undefined || selector.quote === evidence.excerpt)
  );
}

/** Validate annotation schema, exact evidence binding, and UTF-8/scalar spans. */
export function validateResearchSemanticAnnotation(
  value: unknown,
  evidence: ResolvedEvidenceReference
): SemanticAnnotationValidation {
  const schemaResult = validateSchema(value);
  if (!schemaResult.valid) return schemaResult;
  const annotation = value as ResearchSemanticAnnotation;
  if (
    !validateResearchEvidenceReference(evidence.evidence).valid ||
    !resolvedEvidenceMatchesSelector(evidence) ||
    evidence.evidence.id !== annotation.evidence_id ||
    evidence.evidence.assertion_id !== annotation.subject_assertion_id ||
    evidence.content_sha256 !== annotation.source_content_sha256 ||
    evidence.evidence.selector.content_sha256 !== annotation.source_content_sha256
  ) {
    return {
      valid: false,
      issues: [
        {
          path: '/evidence_id',
          keyword: 'evidence_binding',
          message: 'semantic annotation must match its resolved assertion evidence',
        },
      ],
    };
  }
  // The selector range is applied by the evidence resolver before span offsets begin.
  const exactText = evidence.excerpt;
  const cuesMatch =
    spanMatchesText(annotation.source_range, exactText) &&
    cueMatchesText(annotation.polarity_cue, exactText) &&
    cueMatchesText(annotation.context.cue, exactText) &&
    [annotation.polarity_cue, annotation.context.cue]
      .filter((cue): cue is SemanticCue => cue !== undefined)
      .every(
        (cue) =>
          cue.span.scalar_start >= annotation.source_range.scalar_start &&
          cue.span.scalar_end <= annotation.source_range.scalar_end
      );
  if (!cuesMatch) {
    return {
      valid: false,
      issues: [
        {
          path: '/source_range',
          keyword: 'source_span',
          message: 'semantic annotation spans must round-trip against the exact evidence text',
        },
      ],
    };
  }
  return schemaResult;
}

/** Accepted polarity remains explicitly scoped to its narration or speaker context. */
export function projectResearchSemanticAnnotation(
  value: unknown,
  evidence: ResolvedEvidenceReference
): SemanticAssertionProjection {
  const validation = validateResearchSemanticAnnotation(value, evidence);
  if (!validation.valid) return { status: 'invalid', issues: validation.issues };
  const annotation = value as ResearchSemanticAnnotation;
  if (annotation.review_status === 'rejected') return { status: 'rejected' };
  if (annotation.review_status !== 'accepted')
    return { status: 'review_required', reason: 'not_accepted' };
  if (annotation.polarity !== 'positive' && annotation.polarity !== 'negative')
    return { status: 'review_required', reason: 'polarity_uncertain' };
  const projection = {
    polarity: annotation.polarity,
    context: { ...annotation.context },
  };
  return annotation.context.mode === 'direct_quote' || annotation.context.mode === 'reported_speech'
    ? { status: 'scoped', ...projection }
    : { status: 'projected', ...projection };
}
