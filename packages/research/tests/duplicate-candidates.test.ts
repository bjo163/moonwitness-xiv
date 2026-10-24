import { describe, expect, it } from 'vitest';
import { findDuplicateCandidates } from '../src/duplicate-candidates.js';
import type { ResearchAssertion } from '../src/assertion.js';
import type { ResearchEvidenceReference } from '../src/evidence.js';

function assertion(
  id: string,
  claim: string,
  overrides: Partial<ResearchAssertion> = {}
): ResearchAssertion {
  return {
    id: `mw:assertion:${id}`,
    kind: 'Assertion',
    schema_version: 1,
    lifecycle: 'candidate',
    created_at: '2026-10-16T00:00:00Z',
    updated_at: '2026-10-16T00:00:00Z',
    origin_ref: 'mw:source:test',
    visibility: 'PUBLIC_APPROVED',
    content_revision: 1,
    claim,
    polarity: 'positive',
    scope: { kind: 'work', reference_id: 'mw:work:x' },
    context: { mode: 'analysis', reference_id: 'mw:work:x' },
    epistemic_status: 'hypothesized',
    review_status: 'unreviewed',
    ...overrides,
  };
}

function evidence(
  id: string,
  assertionId: string,
  direction: ResearchEvidenceReference['direction'],
  visibility = 'PUBLIC_APPROVED'
) {
  return {
    id: `mw:evidence:${id}`,
    assertion_id: `mw:assertion:${assertionId}`,
    direction,
    visibility,
    selector: {
      source_id: 'mw:source:tanzil-quran-text',
      edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
      locator: 'Q7:46',
      content_sha256: 'a'.repeat(64),
    },
  } as ResearchEvidenceReference & { visibility: string };
}

describe('bounded duplicate candidates', () => {
  it('distinguishes exact duplicates, partial overlap and unrelated assertions', () => {
    const result = findDuplicateCandidates({
      assertions: [
        assertion('a', 'A claim about the moon'),
        assertion('b', ' a claim ABOUT the moon '),
        assertion('c', 'A claim about lunar phases'),
        assertion('d', 'Unrelated historical detail', {
          scope: { kind: 'document', reference_id: 'mw:doc:y' },
        }),
      ],
      evidence: [],
    });
    expect(result.candidates).toHaveLength(6);
    expect(
      result.candidates.find((item) => item.left_id.endsWith(':a') && item.right_id.endsWith(':b'))
        ?.kind
    ).toBe('duplicate');
    expect(
      result.candidates.find((item) => item.left_id.endsWith(':a') && item.right_id.endsWith(':c'))
        ?.kind
    ).toBe('overlap');
    expect(
      result.candidates.find((item) => item.left_id.endsWith(':a') && item.right_id.endsWith(':d'))
        ?.kind
    ).toBe('different');
    expect(result.candidates.every((item) => item.status === 'unresolved')).toBe(true);
  });

  it('keeps shared evidence directions distinct and polarity conflicts unresolved', () => {
    const result = findDuplicateCandidates({
      assertions: [
        assertion('a', 'The passage reports rain'),
        assertion('b', 'The passage reports rain', { polarity: 'negative' }),
      ],
      evidence: [
        evidence('shared-a', 'a', 'supporting'),
        evidence('shared-b', 'b', 'counterevidence'),
      ],
    });
    expect(result.candidates[0]).toMatchObject({
      kind: 'overlap',
      shared_supporting_evidence_ids: [],
      shared_counterevidence_ids: [],
      cross_direction_evidence_ids: ['mw:evidence:shared-a', 'mw:evidence:shared-b'],
    });
    expect(result.candidates[0]?.rationale.join(' ')).toContain('Polarity differs');
  });

  it('filters private assertions/evidence before pairing, counting, and truncation', () => {
    const publicSet = [assertion('a', 'public claim'), assertion('b', 'other public claim')];
    const baseline = findDuplicateCandidates({ assertions: publicSet, evidence: [], maxPairs: 1 });
    const withPrivate = findDuplicateCandidates({
      assertions: [...publicSet, assertion('secret', 'public claim', { visibility: 'RESTRICTED' })],
      evidence: [evidence('secret', 'a', 'supporting', 'RESTRICTED')],
      maxPairs: 1,
    });
    expect(withPrivate).toEqual(baseline);
    expect(JSON.stringify(withPrivate)).not.toContain('secret');
  });

  it('ignores duplicate identifiers in unreadable records while rejecting unknown visibility', () => {
    const publicAssertion = assertion('public', 'visible claim');
    const baseline = findDuplicateCandidates({ assertions: [publicAssertion], evidence: [] });
    const privateDuplicate = assertion('public', 'private claim', { visibility: 'RESTRICTED' });
    const withPrivateDuplicates = findDuplicateCandidates({
      assertions: [publicAssertion, privateDuplicate],
      evidence: [
        evidence('private-evidence', 'public', 'supporting', 'RESTRICTED'),
        evidence('private-evidence', 'public', 'counterevidence', 'RESTRICTED'),
      ],
    });
    expect(withPrivateDuplicates).toEqual(baseline);
    expect(() =>
      findDuplicateCandidates({
        assertions: [
          assertion('unknown', 'claim', { visibility: 'OTHER' as ResearchAssertion['visibility'] }),
        ],
        evidence: [],
      })
    ).toThrow('Duplicate candidate input is invalid or exceeds supported limits');
  });

  it('applies volume caps after filtering private records and omits indistinguishable hidden/dangling attachments', () => {
    const baseline = findDuplicateCandidates({
      assertions: [assertion('visible', 'visible claim')],
      evidence: [],
    });
    const manyPrivateAssertions = Array.from({ length: 501 }, (_, i) =>
      assertion(`private-${i}`, 'secret claim', { visibility: 'RESTRICTED' })
    );
    const manyPrivateEvidence = Array.from({ length: 10_001 }, (_, i) =>
      evidence(`private-evidence-${i}`, 'visible', 'supporting', 'RESTRICTED')
    );
    expect(
      findDuplicateCandidates({
        assertions: [assertion('visible', 'visible claim'), ...manyPrivateAssertions],
        evidence: manyPrivateEvidence,
      })
    ).toEqual(baseline);

    const readableDangling = evidence('dangling', 'missing', 'supporting');
    const attachedToPrivate = evidence('hidden-attachment', 'private', 'supporting');
    const hiddenAssertion = assertion('private', 'hidden', { visibility: 'RESTRICTED' });
    expect(findDuplicateCandidates({ assertions: [], evidence: [readableDangling] })).toEqual(
      findDuplicateCandidates({ assertions: [hiddenAssertion], evidence: [attachedToPrivate] })
    );
  });

  it('uses a generic failure for malformed top-level inputs', () => {
    expect(() => findDuplicateCandidates(null as never)).toThrow(
      'Duplicate candidate input is invalid or exceeds supported limits'
    );
    expect(() => findDuplicateCandidates({ assertions: {} as never, evidence: [] })).toThrow(
      'Duplicate candidate input is invalid or exceeds supported limits'
    );
  });

  it('requires matching context attribution before calling exact text a duplicate', () => {
    const result = findDuplicateCandidates({
      assertions: [
        assertion('a', 'same exact claim'),
        assertion('b', 'same exact claim', {
          context: { mode: 'narration', reference_id: 'mw:work:other' },
        }),
      ],
      evidence: [],
    });
    expect(result.candidates[0]?.kind).toBe('overlap');
    expect(result.candidates[0]?.rationale.join(' ')).toContain('Context attribution differs');
  });

  it('keeps withdrawn/rejected records from qualifying as duplicates', () => {
    const result = findDuplicateCandidates({
      assertions: [
        assertion('a', 'same exact claim'),
        assertion('b', 'same exact claim', { lifecycle: 'withdrawn', review_status: 'withdrawn' }),
      ],
      evidence: [],
    });
    expect(result.candidates[0]?.kind).toBe('overlap');
    expect(result.candidates[0]?.rationale.join(' ')).toContain('conservative overlap only');
  });

  it('downgrades exact text when epistemic or review state differs', () => {
    const epistemic = findDuplicateCandidates({
      assertions: [
        assertion('a', 'same exact claim'),
        assertion('b', 'same exact claim', { epistemic_status: 'asserted' }),
      ],
      evidence: [],
    });
    const review = findDuplicateCandidates({
      assertions: [
        assertion('a', 'same exact claim'),
        assertion('b', 'same exact claim', { review_status: 'pending' }),
      ],
      evidence: [],
    });
    expect(epistemic.candidates[0]?.kind).toBe('overlap');
    expect(review.candidates[0]?.kind).toBe('overlap');
    expect(epistemic.candidates[0]?.rationale.join(' ')).toContain('Epistemic status differs');
    expect(review.candidates[0]?.rationale.join(' ')).toContain('review status differs');
  });

  it('matches canonical evidence selectors independent of property order', () => {
    const leftEvidence = evidence('selector-a', 'a', 'supporting');
    const rightEvidence = evidence('selector-b', 'b', 'supporting');
    const selector = leftEvidence.selector;
    leftEvidence.selector = {
      source_id: selector.source_id,
      edition_id: selector.edition_id,
      locator: selector.locator,
      content_sha256: selector.content_sha256,
      range: { unit: 'unicode_scalar', start: 1, end: 3 },
    } as typeof leftEvidence.selector;
    rightEvidence.selector = {
      content_sha256: selector.content_sha256,
      locator: selector.locator,
      edition_id: selector.edition_id,
      source_id: selector.source_id,
      range: { end: 3, start: 1, unit: 'unicode_scalar' },
    } as typeof rightEvidence.selector;
    const result = findDuplicateCandidates({
      assertions: [
        assertion('a', 'first unrelated words'),
        assertion('b', 'second separate words'),
      ],
      evidence: [leftEvidence, rightEvidence],
    });
    expect(result.candidates[0]).toMatchObject({
      kind: 'overlap',
      cross_direction_evidence_ids: [],
      shared_supporting_evidence_ids: ['mw:evidence:selector-a', 'mw:evidence:selector-b'],
    });
  });

  it('fails closed with a generic message on unknown visibility, invalid schemas, or duplicate IDs', () => {
    const invoke = (
      assertions: ResearchAssertion[],
      evidenceItems = [] as ReturnType<typeof evidence>[]
    ) => findDuplicateCandidates({ assertions, evidence: evidenceItems });
    expect(() =>
      invoke([
        assertion('x', 'claim', { visibility: 'UNKNOWN' as ResearchAssertion['visibility'] }),
      ])
    ).toThrow('Duplicate candidate input is invalid or exceeds supported limits');
    expect(() =>
      invoke([assertion('x', 'claim', { id: 'not-canonical' as ResearchAssertion['id'] })])
    ).toThrow('Duplicate candidate input is invalid or exceeds supported limits');
    expect(() => invoke([assertion('x', 'claim'), assertion('x', 'another')])).toThrow(
      'Duplicate candidate input is invalid or exceeds supported limits'
    );
    expect(() =>
      findDuplicateCandidates({
        assertions: [assertion('x', 'claim')],
        evidence: [evidence('dup', 'x', 'supporting'), evidence('dup', 'x', 'counterevidence')],
      })
    ).toThrow('Duplicate candidate input is invalid or exceeds supported limits');
  });

  it('omits dangling public evidence and bounds visible evidence volume and claim size', () => {
    expect(
      findDuplicateCandidates({
        assertions: [assertion('a', 'claim')],
        evidence: [evidence('dangling', 'missing', 'supporting')],
      }).candidates.every((candidate) => candidate.left_id !== 'mw:assertion:a')
    ).toBe(true);
    expect(() =>
      findDuplicateCandidates({
        assertions: [assertion('a', 'x'.repeat(10_001))],
        evidence: [],
      })
    ).toThrow('Duplicate candidate input is invalid or exceeds supported limits');
    expect(() =>
      findDuplicateCandidates({
        assertions: [],
        evidence: Array.from({ length: 10_001 }, (_, i) => evidence(`e${i}`, 'a', 'supporting')),
      })
    ).toThrow('Duplicate candidate input is invalid or exceeds supported limits');
  });

  it('applies deterministic pair bounds and validates the configured limit', () => {
    const assertions = ['a', 'b', 'c'].map((id) => assertion(id, id));
    expect(findDuplicateCandidates({ assertions, evidence: [], maxPairs: 2 })).toMatchObject({
      candidates: [
        { left_id: 'mw:assertion:a', right_id: 'mw:assertion:b' },
        { left_id: 'mw:assertion:a', right_id: 'mw:assertion:c' },
      ],
      truncated: true,
    });
    expect(() => findDuplicateCandidates({ assertions, evidence: [], maxPairs: 5001 })).toThrow(
      TypeError
    );
  });
});
