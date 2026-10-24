import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  projectResearchSemanticAnnotation,
  resolveResearchEvidenceReference,
  validateResearchSemanticAnnotation,
  validateResearchEvidenceReference,
  type ResearchEvidenceReference,
  type ResolvablePassage,
  type ResearchSemanticAnnotation,
} from '../src/index.js';

// Synthetic wording keeps the tests separate from any source-text interpretation.
const sourceText = 'They said “I do not agree.”';
const fullPassageText = `é header — ${sourceText}`;
const selectorRangeStart = Array.from(
  fullPassageText.slice(0, fullPassageText.indexOf(sourceText))
).length;
const sourceHash = createHash('sha256').update(fullPassageText, 'utf8').digest('hex');
const passage: ResolvablePassage = {
  source_id: 'mw:source:ebible-webp-protestant',
  expression_id: 'mw:expression:webp-protestant',
  edition_id: 'mw:edition:webp-protestant-2020-stable',
  locator: 'Genesis 1:1',
  text: fullPassageText,
  content_sha256: sourceHash,
  citation: 'synthetic:test:semantic-annotation',
};

const evidence: ResearchEvidenceReference = {
  id: 'mw:evidence:semantic-fixture',
  assertion_id: 'mw:assertion:semantic-fixture',
  direction: 'supporting',
  selector: {
    source_id: passage.source_id as 'mw:source:ebible-webp-protestant',
    expression_id: 'mw:expression:webp-protestant',
    edition_id: passage.edition_id as 'mw:edition:webp-protestant-2020-stable',
    locator: 'Genesis 1:1',
    content_sha256: sourceHash,
    range: {
      unit: 'unicode_scalar',
      start: selectorRangeStart,
      end: Array.from(fullPassageText).length,
    },
  },
};

async function resolvedEvidence() {
  expect(validateResearchEvidenceReference(evidence)).toEqual({ valid: true, issues: [] });
  return resolveResearchEvidenceReference(evidence, async () => passage);
}

function span(text: string, start: number, end: number) {
  const scalars = Array.from(text);
  const before = scalars.slice(0, start).join('');
  const selected = scalars.slice(start, end).join('');
  const byteStart = new TextEncoder().encode(before).length;
  return {
    byte_start: byteStart,
    byte_end: byteStart + new TextEncoder().encode(selected).length,
    scalar_start: start,
    scalar_end: end,
  };
}

function annotation(
  overrides: Partial<ResearchSemanticAnnotation> = {}
): ResearchSemanticAnnotation {
  const sourceRange = span(sourceText, 0, Array.from(sourceText).length);
  return {
    id: 'mw:semantic-annotation:fixture-001',
    kind: 'ResearchSemanticAnnotation',
    schema_version: 1,
    subject_assertion_id: evidence.assertion_id,
    evidence_id: evidence.id,
    source_content_sha256: passage.content_sha256,
    offset_basis: 'resolved_evidence_excerpt',
    source_range: sourceRange,
    polarity: 'positive',
    polarity_basis: 'human_scope_judgment',
    context: { mode: 'narration' },
    review_status: 'candidate',
    ...overrides,
  };
}

describe('source-bound semantic annotation', () => {
  it('preserves accepted negative polarity without promoting it to positive', async () => {
    const resolved = await resolvedEvidence();
    expect(resolved.excerpt).toBe(sourceText);
    const negative = annotation({
      polarity: 'negative',
      polarity_basis: 'explicit_negation',
      polarity_cue: {
        kind: 'negation',
        span: span(sourceText, sourceText.indexOf('not'), sourceText.indexOf('not') + 3),
        text: 'not',
      },
      review_status: 'accepted',
      reviewer_id: 'mw:user:reviewer-1',
      reviewed_at: '2026-10-16T00:00:00Z',
    });
    expect(validateResearchSemanticAnnotation(negative, resolved).valid).toBe(true);
    expect(projectResearchSemanticAnnotation(negative, resolved)).toMatchObject({
      status: 'projected',
      polarity: 'negative',
      context: { mode: 'narration' },
    });
  });

  it('requires an explicit speaker and source cue for quoted claims', async () => {
    const resolved = await resolvedEvidence();
    const quoted = annotation({
      context: { mode: 'direct_quote', speaker_id: 'mw:agent:quoted-speaker' },
    });
    expect(validateResearchSemanticAnnotation(quoted, resolved).valid).toBe(false);
    quoted.context.cue = {
      kind: 'quotation',
      span: span(sourceText, 10, 11),
      text: '“',
    };
    expect(validateResearchSemanticAnnotation(quoted, resolved).valid).toBe(true);
    quoted.review_status = 'accepted';
    quoted.reviewer_id = 'mw:user:reviewer-1';
    quoted.reviewed_at = '2026-10-16T00:00:00Z';
    expect(projectResearchSemanticAnnotation(quoted, resolved)).toMatchObject({
      status: 'scoped',
      polarity: 'positive',
      context: { mode: 'direct_quote', speaker_id: 'mw:agent:quoted-speaker' },
    });
    delete quoted.context.speaker_id;
    expect(validateResearchSemanticAnnotation(quoted, resolved).valid).toBe(false);
  });

  it('keeps uncertain polarity in review and rejects inaccurate or misbound spans', async () => {
    const resolved = await resolvedEvidence();
    const uncertain = annotation({
      polarity: 'ambiguous',
      polarity_basis: 'insufficient_context',
      review_status: 'accepted',
      reviewer_id: 'mw:user:reviewer-1',
      reviewed_at: '2026-10-16T00:00:00Z',
    });
    expect(projectResearchSemanticAnnotation(uncertain, resolved)).toEqual({
      status: 'review_required',
      reason: 'polarity_uncertain',
    });

    const invented = annotation({
      polarity_cue: {
        kind: 'negation',
        span: span(sourceText, sourceText.indexOf('not'), sourceText.indexOf('not') + 3),
        text: 'no',
      },
    });
    expect(validateResearchSemanticAnnotation(invented, resolved).valid).toBe(false);
    const wrongEvidence = { ...resolved, content_sha256: '0'.repeat(64) };
    expect(validateResearchSemanticAnnotation(annotation(), wrongEvidence).valid).toBe(false);
    const wrongRange = {
      ...resolved,
      range: { unit: 'unicode_scalar' as const, start: 0, end: 1 },
    };
    expect(validateResearchSemanticAnnotation(annotation(), wrongRange).valid).toBe(false);
  });

  it('requires polarity cues to agree with explicit negation or affirmation', async () => {
    const resolved = await resolvedEvidence();
    const explicitNegative = annotation({
      polarity: 'negative',
      polarity_basis: 'explicit_negation',
      polarity_cue: {
        kind: 'affirmation',
        span: span(sourceText, sourceText.indexOf('not'), sourceText.indexOf('not') + 3),
        text: 'not',
      },
    });
    expect(validateResearchSemanticAnnotation(explicitNegative, resolved).valid).toBe(false);
  });
});
