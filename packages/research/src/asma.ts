import { createHash } from 'node:crypto';
import profile from '../../../research/profiles/quran-primary-v1.json' with { type: 'json' };
import {
  projectResearchSemanticAnnotation,
  validateResearchSemanticAnnotation,
  type ResearchSemanticAnnotation,
  type SemanticSpan,
} from './semantics.js';
import { isAttestedEvidenceResolution, type ResolvedEvidenceReference } from './evidence.js';

const methodIdentifier = /^mw:asma-method:[a-z0-9][a-z0-9._-]{0,159}$/u;
const methodVersion = /^\d+\.\d+\.\d+$/u;

export interface AsmaAnalysisMethod {
  id: string;
  version: string;
}

export interface AsmaResearchProfile {
  id: string;
  authorized_passages: readonly {
    source_id: string;
    edition_id: string;
    locator: string;
    content_sha256: string;
    allowed_use: 'read_analyze';
    rights_evidence_ref: string;
  }[];
}

export interface AsmaAttributeCandidate {
  id: `mw:asma-candidate:${string}`;
  kind: 'AsmaAttributeCandidate';
  schema_version: 1;
  profile_id: string;
  predicate: 'candidate_divine_attribute';
  status: 'candidate';
  term: {
    original_text: string;
    span: SemanticSpan;
  };
  source: {
    source_id: string;
    edition_id: string;
    locator: string;
    content_sha256: string;
    evidence_id: string;
    assertion_id: string;
    rights_evidence_ref: string;
  };
  polarity: 'positive';
  context_mode: 'narration' | 'analysis';
  method: AsmaAnalysisMethod;
  interpretation_scope: 'analysis_not_revelation';
}

export type AsmaCandidateProjection =
  | { status: 'candidate'; candidate: AsmaAttributeCandidate }
  | {
      status: 'rejected';
      reason:
        'evidence_attestation' | 'profile_source' | 'semantic_annotation' | 'term_span' | 'method';
    };

function spanMatchesExcerpt(span: SemanticSpan, excerpt: string): string | undefined {
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
    return undefined;
  }
  const scalars = Array.from(excerpt);
  if (span.scalar_end > scalars.length) return undefined;
  const prefix = scalars.slice(0, span.scalar_start).join('');
  const originalText = scalars.slice(span.scalar_start, span.scalar_end).join('');
  const byteStart = new TextEncoder().encode(prefix).length;
  const byteEnd = byteStart + new TextEncoder().encode(originalText).length;
  return byteStart === span.byte_start && byteEnd === span.byte_end ? originalText : undefined;
}

interface AsmaProjectionInput {
  annotation: ResearchSemanticAnnotation;
  evidence: ResolvedEvidenceReference;
  term_span: SemanticSpan;
  method: AsmaAnalysisMethod;
}

function projectWithProfile(
  input: AsmaProjectionInput,
  selectedProfile: AsmaResearchProfile
): AsmaCandidateProjection {
  const { annotation, evidence, term_span, method } = input;
  if (!isAttestedEvidenceResolution(evidence)) {
    return { status: 'rejected', reason: 'evidence_attestation' };
  }
  const allowedPassage = selectedProfile.authorized_passages?.find(
    (passage) =>
      passage.source_id === evidence.source_id &&
      passage.edition_id === evidence.edition_id &&
      passage.locator === evidence.locator &&
      passage.content_sha256 === evidence.content_sha256 &&
      passage.content_sha256 === evidence.evidence.selector.content_sha256 &&
      passage.allowed_use === 'read_analyze' &&
      passage.rights_evidence_ref.trim().length > 0
  );
  if (typeof selectedProfile.id !== 'string' || !allowedPassage) {
    return { status: 'rejected', reason: 'profile_source' };
  }
  if (!methodIdentifier.test(method.id) || !methodVersion.test(method.version)) {
    return { status: 'rejected', reason: 'method' };
  }

  const validation = validateResearchSemanticAnnotation(annotation, evidence);
  const projection = projectResearchSemanticAnnotation(annotation, evidence);
  if (
    !validation.valid ||
    evidence.direction !== 'supporting' ||
    projection.status !== 'projected' ||
    projection.polarity !== 'positive' ||
    (annotation.context.mode !== 'narration' && annotation.context.mode !== 'analysis')
  ) {
    return { status: 'rejected', reason: 'semantic_annotation' };
  }

  const originalText = spanMatchesExcerpt(term_span, evidence.excerpt);
  if (
    originalText === undefined ||
    term_span.scalar_start < annotation.source_range.scalar_start ||
    term_span.scalar_end > annotation.source_range.scalar_end
  ) {
    return { status: 'rejected', reason: 'term_span' };
  }

  // Every field the candidate persists and that can differ while the evidence id stays the same
  // belongs here; omitting one makes two distinct candidates share a single identity.
  const identity = createHash('sha256')
    .update(
      JSON.stringify([
        selectedProfile.id,
        evidence.evidence.id,
        evidence.source_id,
        evidence.edition_id,
        evidence.locator,
        evidence.content_sha256,
        annotation.id,
        annotation.subject_assertion_id,
        annotation.context.mode,
        term_span.byte_start,
        term_span.byte_end,
        term_span.scalar_start,
        term_span.scalar_end,
        method.id,
        method.version,
      ]),
      'utf8'
    )
    .digest('hex');

  return {
    status: 'candidate',
    candidate: {
      id: `mw:asma-candidate:${identity}`,
      kind: 'AsmaAttributeCandidate',
      schema_version: 1,
      profile_id: selectedProfile.id,
      predicate: 'candidate_divine_attribute',
      status: 'candidate',
      term: { original_text: originalText, span: { ...term_span } },
      source: {
        source_id: evidence.source_id,
        edition_id: evidence.edition_id,
        locator: evidence.locator,
        content_sha256: evidence.content_sha256,
        evidence_id: evidence.evidence.id,
        assertion_id: annotation.subject_assertion_id,
        rights_evidence_ref: allowedPassage.rights_evidence_ref,
      },
      polarity: 'positive',
      context_mode: annotation.context.mode,
      method: { ...method },
      interpretation_scope: 'analysis_not_revelation',
    },
  };
}

/**
 * Project a separately analyzed, exact source term into a noncanonical Asma candidate.
 * Uses only the fixed passage-specific profile. The evidence reference must be one the
 * corpus resolver minted. It does not discover terms, infer morphology, or assert
 * theological truth.
 */
export function projectAsmaAttributeCandidate(input: AsmaProjectionInput): AsmaCandidateProjection {
  return projectWithProfile(input, profile as AsmaResearchProfile);
}

/** @internal Synthetic-profile core for isolated tests; package consumers use the fixed profile. */
export function projectAsmaAttributeCandidateWithProfile(
  input: AsmaProjectionInput & { profile: AsmaResearchProfile }
): AsmaCandidateProjection {
  return projectWithProfile(input, input.profile);
}
