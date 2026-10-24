import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { URL } from 'node:url';
import {
  isAttestedEvidenceResolution,
  projectAsmaAttributeCandidate,
  projectResearchSemanticAnnotation,
  resolveResearchEvidenceReference,
  validateResearchEvidenceReference,
  validateResearchSemanticAnnotation,
  type ResearchEvidenceReference,
  type ResolvablePassage,
  type ResearchSemanticAnnotation,
  type ResolvedEvidenceReference,
  type SemanticSpan,
} from '../src/index.js';
import { projectAsmaAttributeCandidateWithProfile } from '../src/asma.js';

const text = 'The source says: compassion is attributed to God.';
const sourceHash = createHash('sha256').update(text, 'utf8').digest('hex');
const passage: ResolvablePassage = {
  source_id: 'mw:source:ebible-webp-protestant',
  expression_id: 'mw:expression:webp-protestant',
  edition_id: 'mw:edition:webp-protestant-2020-stable',
  locator: 'Genesis 1:1',
  text,
  content_sha256: sourceHash,
  citation: 'synthetic:test:asma-fixture',
};
const evidence: ResearchEvidenceReference = {
  id: 'mw:evidence:asma-fixture',
  assertion_id: 'mw:assertion:asma-fixture',
  direction: 'supporting',
  selector: {
    source_id: passage.source_id as 'mw:source:ebible-webp-protestant',
    expression_id: passage.expression_id as 'mw:expression:webp-protestant',
    edition_id: passage.edition_id as 'mw:edition:webp-protestant-2020-stable',
    locator: passage.locator,
    content_sha256: sourceHash,
  },
};

function span(source: string, start: number, end: number): SemanticSpan {
  const scalars = Array.from(source);
  const prefix = scalars.slice(0, start).join('');
  const selected = scalars.slice(start, end).join('');
  const byteStart = new TextEncoder().encode(prefix).length;
  return {
    byte_start: byteStart,
    byte_end: byteStart + new TextEncoder().encode(selected).length,
    scalar_start: start,
    scalar_end: end,
  };
}

function scalarIndexOf(source: string, term: string): number {
  return Array.from(source.slice(0, source.indexOf(term))).length;
}

const annotation: ResearchSemanticAnnotation = {
  id: 'mw:semantic-annotation:asma-fixture',
  kind: 'ResearchSemanticAnnotation',
  schema_version: 1,
  subject_assertion_id: 'mw:assertion:asma-fixture',
  evidence_id: 'mw:evidence:asma-fixture',
  source_content_sha256: sourceHash,
  offset_basis: 'resolved_evidence_excerpt',
  source_range: span(text, 0, Array.from(text).length),
  polarity: 'positive',
  polarity_basis: 'human_scope_judgment',
  context: { mode: 'analysis' },
  review_status: 'accepted',
  reviewer_id: 'mw:user:fixture-reviewer',
  reviewed_at: '2026-10-16T00:00:00Z',
};

async function resolvedEvidence() {
  expect(validateResearchEvidenceReference(evidence)).toEqual({ valid: true, issues: [] });
  return resolveResearchEvidenceReference(evidence, async () => passage);
}

const syntheticProfile = {
  id: 'mw:research-profile:synthetic-test',
  authorized_passages: [
    {
      source_id: passage.source_id,
      edition_id: passage.edition_id,
      locator: passage.locator,
      content_sha256: sourceHash,
      allowed_use: 'read_analyze' as const,
      rights_evidence_ref: 'synthetic:test-only',
    },
  ],
};
const productionProfile = JSON.parse(
  await readFile(
    new URL('../../../research/profiles/quran-primary-v1.json', import.meta.url),
    'utf8'
  )
) as { id: string; authorized_passages: Array<Record<string, unknown>> };
const quranRightsManifest = JSON.parse(
  await readFile(
    new URL('../../../corpus/manifests/tanzil-quran-text-v1.1-uthmani-q7-46.json', import.meta.url),
    'utf8'
  )
) as {
  source_id: string;
  edition_id: string;
  artifact: { sha256: string };
  attribution: { text: string };
  rights: { state: string; allowed_uses: string[] };
};

describe('Asma candidate projection', () => {
  it('binds its production profile to the reviewed Q7:46 rights manifest', () => {
    expect(productionProfile.authorized_passages).toEqual([
      {
        source_id: quranRightsManifest.source_id,
        edition_id: quranRightsManifest.edition_id,
        locator: 'Q7:46',
        content_sha256: quranRightsManifest.artifact.sha256,
        allowed_use: 'read_analyze',
        rights_evidence_ref: 'docs/roadmap/evidence/K2-005.md#source-specific-rights-decision',
      },
    ]);
    expect(productionProfile).toMatchObject({
      lexical_inventory: 'none',
      historical_metrics: { state: 'unverified' },
      interpretation_scope: 'analysis_not_revelation',
    });
    expect(quranRightsManifest.rights.state).toBe('permitted');
    expect(quranRightsManifest.rights.allowed_uses).toContain('read_analyze');
  });

  it('produces only an exact, method-bound candidate and never a canonical fact', async () => {
    const resolved = await resolvedEvidence();
    expect(validateResearchSemanticAnnotation(annotation, resolved).valid).toBe(true);
    expect(projectResearchSemanticAnnotation(annotation, resolved)).toMatchObject({
      status: 'projected',
    });
    const start = scalarIndexOf(text, 'compassion');
    const result = projectAsmaAttributeCandidateWithProfile({
      annotation,
      evidence: resolved,
      term_span: span(text, start, start + 'compassion'.length),
      method: { id: 'mw:asma-method:attribute-review', version: '1.0.0' },
      profile: syntheticProfile,
    });
    expect(result.status).toBe('candidate');
    if (result.status !== 'candidate') return;
    expect(result.candidate.term.original_text).toBe('compassion');
    expect(result.candidate.source).toMatchObject({
      edition_id: passage.edition_id,
      locator: passage.locator,
      content_sha256: sourceHash,
      evidence_id: evidence.id,
    });
    expect(result.candidate.method).toEqual({
      id: 'mw:asma-method:attribute-review',
      version: '1.0.0',
    });
    expect(result.candidate).toMatchObject({
      status: 'candidate',
      interpretation_scope: 'analysis_not_revelation',
    });
  });

  it('rejects a term that is not an exact source span', async () => {
    const resolved = await resolvedEvidence();
    const start = scalarIndexOf(text, 'compassion');
    const badSpan = { ...span(text, start, start + 'compassion'.length), scalar_end: start + 1 };
    expect(
      projectAsmaAttributeCandidateWithProfile({
        annotation,
        evidence: resolved,
        term_span: badSpan,
        method: { id: 'mw:asma-method:attribute-review', version: '1.0.0' },
        profile: syntheticProfile,
      })
    ).toEqual({ status: 'rejected', reason: 'term_span' });
  });

  it('rejects quoted, reported, negative, uncertain, or unreviewed assertions', async () => {
    const resolved = await resolvedEvidence();
    const start = scalarIndexOf(text, 'compassion');
    const term_span = span(text, start, start + 'compassion'.length);
    for (const overrides of [
      {
        context: {
          mode: 'direct_quote' as const,
          speaker_id: 'mw:agent:fixture',
          cue: { kind: 'quotation' as const, span: span(text, 0, 3), text: 'The' },
        },
      },
      { polarity: 'negative' as const, polarity_basis: 'explicit_negation' as const },
      { polarity: 'ambiguous' as const, polarity_basis: 'insufficient_context' as const },
      { review_status: 'candidate' as const, reviewer_id: undefined, reviewed_at: undefined },
    ]) {
      const result = projectAsmaAttributeCandidateWithProfile({
        annotation: { ...annotation, ...overrides } as ResearchSemanticAnnotation,
        evidence: resolved,
        term_span,
        method: { id: 'mw:asma-method:attribute-review', version: '1.0.0' },
        profile: syntheticProfile,
      });
      expect(result).toEqual({ status: 'rejected', reason: 'semantic_annotation' });
    }
  });

  it('rejects a method without an identity and version', async () => {
    const resolved = await resolvedEvidence();
    const start = scalarIndexOf(text, 'compassion');
    expect(
      projectAsmaAttributeCandidateWithProfile({
        annotation,
        evidence: resolved,
        term_span: span(text, start, start + 'compassion'.length),
        method: { id: ' ', version: '1.0.0' },
        profile: syntheticProfile,
      })
    ).toEqual({ status: 'rejected', reason: 'method' });
  });

  it('does not turn counterevidence into an attribute candidate', async () => {
    const counterevidence = await resolveResearchEvidenceReference(
      { ...evidence, direction: 'counterevidence' },
      async () => passage
    );
    const start = scalarIndexOf(text, 'compassion');
    expect(
      projectAsmaAttributeCandidateWithProfile({
        annotation,
        evidence: counterevidence,
        term_span: span(text, start, start + 'compassion'.length),
        method: { id: 'mw:asma-method:attribute-review', version: '1.0.0' },
        profile: syntheticProfile,
      })
    ).toEqual({ status: 'rejected', reason: 'semantic_annotation' });
  });

  it('does not accept a non-Quran witness under the production Quran-primary profile', async () => {
    const resolved = await resolvedEvidence();
    const start = scalarIndexOf(text, 'compassion');
    expect(
      projectAsmaAttributeCandidate({
        annotation,
        evidence: resolved,
        term_span: span(text, start, start + 'compassion'.length),
        method: { id: 'mw:asma-method:attribute-review', version: '1.0.0' },
      })
    ).toEqual({ status: 'rejected', reason: 'profile_source' });
  });

  /**
   * Golden path over the real, rights-cleared Q7:46 bytes rather than a synthetic string. The term
   * is the token at a position in the verified line, so the fixture pins reproducibility of the
   * projection and source binding; which token is a divine attribute stays a human reading and the
   * profile keeps `lexical_inventory: none`.
   */
  it('projects verified Q7:46 source bytes through the production profile', async () => {
    const artifact = await readFile(
      new URL(
        '../../../corpus/reference/sha256/6f/6ff83b01099fb7992b5f7fa101cfab3d6556607ca6b1fe69d53cb76f97027760',
        import.meta.url
      )
    );
    expect(createHash('sha256').update(artifact).digest('hex')).toBe(
      '6ff83b01099fb7992b5f7fa101cfab3d6556607ca6b1fe69d53cb76f97027760'
    );
    expect(quranRightsManifest).toMatchObject({
      source_id: 'mw:source:tanzil-quran-text',
      edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
    });
    const line = artifact.toString('utf8');
    const term = line.split(' ')[2];
    if (typeof term !== 'string' || term.length === 0) throw new Error('Q7:46 token is missing');
    const quranPassage: ResolvablePassage = {
      source_id: 'mw:source:tanzil-quran-text',
      edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
      locator: 'Q7:46',
      text: line,
      content_sha256: quranRightsManifest.artifact.sha256,
      citation: quranRightsManifest.attribution.text,
    };
    const quranEvidence: ResearchEvidenceReference = {
      id: 'mw:evidence:asma-q7-46-golden',
      assertion_id: 'mw:assertion:asma-q7-46-golden',
      direction: 'supporting',
      selector: {
        source_id: quranPassage.source_id,
        edition_id: quranPassage.edition_id,
        locator: quranPassage.locator,
        content_sha256: quranPassage.content_sha256,
      },
    };
    const quranAnnotation: ResearchSemanticAnnotation = {
      ...annotation,
      id: 'mw:semantic-annotation:asma-q7-46-golden',
      subject_assertion_id: 'mw:assertion:asma-q7-46-golden',
      evidence_id: 'mw:evidence:asma-q7-46-golden',
      source_content_sha256: quranPassage.content_sha256,
      source_range: span(line, 0, Array.from(line).length),
    };
    const resolved = await resolveResearchEvidenceReference(
      quranEvidence,
      async () => quranPassage
    );
    expect(validateResearchSemanticAnnotation(quranAnnotation, resolved).valid).toBe(true);
    const start = scalarIndexOf(line, term);
    const termSpan = span(line, start, start + Array.from(term).length);
    const method = { id: 'mw:asma-method:source-span-binding', version: '1.0.0' };

    const first = projectAsmaAttributeCandidate({
      annotation: quranAnnotation,
      evidence: resolved,
      term_span: termSpan,
      method,
    });
    expect(first.status).toBe('candidate');
    if (first.status !== 'candidate') return;
    expect(first.candidate.term.original_text).toBe(term);
    expect(first.candidate.source).toEqual({
      source_id: 'mw:source:tanzil-quran-text',
      edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
      locator: 'Q7:46',
      content_sha256: quranRightsManifest.artifact.sha256,
      evidence_id: 'mw:evidence:asma-q7-46-golden',
      assertion_id: 'mw:assertion:asma-q7-46-golden',
      rights_evidence_ref: 'docs/roadmap/evidence/K2-005.md#source-specific-rights-decision',
    });
    expect(first.candidate.profile_id).toBe(productionProfile.id);
    // Reproducibility anchor: re-deriving this from the pinned bytes must give the same digest.
    expect(first.candidate.id).toBe(
      'mw:asma-candidate:520cc83e540d4325b46e884db03fdb70d6fcf5dddf524f08ab94386b2a4e5acd'
    );
    expect(first.candidate.interpretation_scope).toBe('analysis_not_revelation');
    expect(first.candidate.status).toBe('candidate');
    expect(
      projectAsmaAttributeCandidate({
        annotation: quranAnnotation,
        evidence: resolved,
        term_span: termSpan,
        method,
      })
    ).toEqual(first);
  });

  it('refuses a method that is not a named, versioned identity', async () => {
    const resolved = await resolvedEvidence();
    const start = scalarIndexOf(text, 'compassion');
    const termSpan = span(text, start, start + 'compassion'.length);
    for (const method of [
      { id: ' ', version: '1.0.0' },
      { id: 'synthetic:attribute-review', version: '1.0.0' },
      { id: 'attribute-review', version: '1.0.0' },
      { id: 'mw:asma-method:', version: '1.0.0' },
      { id: 'mw:asma-method:Attribute Review', version: '1.0.0' },
      { id: 'mw:asma-method:attribute-review', version: '1' },
      { id: 'mw:asma-method:attribute-review', version: 'v1.0' },
      { id: 'mw:asma-method:attribute-review', version: ' ' },
    ]) {
      expect(
        projectAsmaAttributeCandidateWithProfile({
          annotation,
          evidence: resolved,
          term_span: termSpan,
          method,
          profile: syntheticProfile,
        }),
        `method ${method.id}/${method.version}`
      ).toEqual({ status: 'rejected', reason: 'method' });
    }
  });

  it('refuses an evidence reference the corpus resolver never minted', async () => {
    const resolved = await resolvedEvidence();
    const start = scalarIndexOf(text, 'compassion');
    const termSpan = span(text, start, start + 'compassion'.length);
    const method = { id: 'mw:asma-method:attribute-review', version: '1.0.0' };
    const project = (evidenceReference: ResolvedEvidenceReference) =>
      projectAsmaAttributeCandidateWithProfile({
        annotation,
        evidence: evidenceReference,
        term_span: termSpan,
        method,
        profile: syntheticProfile,
      });

    expect(isAttestedEvidenceResolution(resolved)).toBe(true);
    expect(project(resolved).status).toBe('candidate');

    const handBuilt = { ...resolved };
    expect(isAttestedEvidenceResolution(handBuilt)).toBe(false);
    expect(project(handBuilt)).toEqual({ status: 'rejected', reason: 'evidence_attestation' });

    const roundTripped = JSON.parse(JSON.stringify(resolved)) as ResolvedEvidenceReference;
    expect(project(roundTripped)).toEqual({
      status: 'rejected',
      reason: 'evidence_attestation',
    });

    const forged = {
      ...resolved,
      content_sha256: createHash('sha256').update('substituted bytes', 'utf8').digest('hex'),
    } as ResolvedEvidenceReference;
    expect(project(forged)).toEqual({ status: 'rejected', reason: 'evidence_attestation' });
  });

  it('binds the candidate identity to every field the record persists', async () => {
    const resolved = await resolvedEvidence();
    const start = scalarIndexOf(text, 'compassion');
    const termSpan = span(text, start, start + 'compassion'.length);
    const method = { id: 'mw:asma-method:attribute-review', version: '1.0.0' };
    const project = (overrides: Partial<ResearchSemanticAnnotation>) =>
      projectAsmaAttributeCandidateWithProfile({
        annotation: { ...annotation, ...overrides } as ResearchSemanticAnnotation,
        evidence: resolved,
        term_span: termSpan,
        method,
        profile: syntheticProfile,
      });
    const analysis = project({});
    const narration = project({ context: { mode: 'narration' } });
    expect(analysis.status).toBe('candidate');
    expect(narration.status).toBe('candidate');
    if (analysis.status !== 'candidate' || narration.status !== 'candidate') return;
    expect(analysis.candidate.context_mode).toBe('analysis');
    expect(narration.candidate.context_mode).toBe('narration');
    expect(narration.candidate.id).not.toBe(analysis.candidate.id);
    const shifted = project({
      id: 'mw:semantic-annotation:asma-fixture-alt',
    } as Partial<ResearchSemanticAnnotation>);
    expect(shifted.status).toBe('candidate');
    if (shifted.status === 'candidate')
      expect(shifted.candidate.id).not.toBe(analysis.candidate.id);
  });
});
