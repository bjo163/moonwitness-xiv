import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  projectTextualAlignmentCandidate,
  type TextualAlignmentPassage,
  type TextualAlignmentSelector,
} from '../src/index.js';

const syntheticPassages = [
  { tradition: 'alpha', evidence: 'a', quote: 'synthetic shared phrase' },
  { tradition: 'beta', evidence: 'b', quote: 'synthetic shared phrase' },
  { tradition: 'gamma', evidence: 'c', quote: 'synthetic contrasting phrase' },
  { tradition: 'delta', evidence: 'd', quote: 'synthetic contrasting phrase' },
].map((item) => {
  const text = `Fixture only: ${item.quote}.`;
  const start = Array.from('Fixture only: ').length;
  const end = start + Array.from(item.quote).length;
  const selector: TextualAlignmentSelector = {
    source_id: `mw:source:synthetic-${item.tradition}`,
    expression_id: `mw:expression:synthetic-${item.tradition}`,
    edition_id: `mw:edition:synthetic-${item.tradition}-v1`,
    locator: `synthetic:${item.tradition}:1`,
    content_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    range: { unit: 'unicode_scalar', start, end },
    quote: item.quote,
  };
  const passage: TextualAlignmentPassage = {
    evidence_id: `mw:evidence:synthetic-${item.evidence}`,
    tradition_context_id: `mw:tradition:synthetic-${item.tradition}`,
    ...selector,
    text,
  };
  return { item, selector, passage };
});

function candidate(leftIndex = 0, rightIndex = 1) {
  const left = syntheticPassages[leftIndex]!;
  const right = syntheticPassages[rightIndex]!;
  return {
    id: `mw:textual-alignment-candidate:${left.item.tradition}-${right.item.tradition}`,
    left: {
      evidence_id: left.passage.evidence_id,
      selector: left.selector,
    },
    right: {
      evidence_id: right.passage.evidence_id,
      selector: right.selector,
    },
    similarity_score: 0.73,
    method: { id: 'mw:alignment-method:synthetic-token-overlap', version: '1.0.0' },
    uncertainty: { level: 'high', note: 'Synthetic fixture; not a textual or doctrinal claim.' },
  };
}

function resolverFor(indices: number[]) {
  return async (evidenceId: string) => {
    const found = indices
      .map((index) => syntheticPassages[index]!)
      .find(({ passage }) => passage.evidence_id === evidenceId);
    return found?.passage ?? null;
  };
}

describe('synthetic textual alignment candidates', () => {
  it('preserves exact provenance across four synthetic tradition contexts and asserts no doctrine', async () => {
    const pairs = [
      await projectTextualAlignmentCandidate(candidate(0, 1), resolverFor([0, 1, 2, 3])),
      await projectTextualAlignmentCandidate(candidate(2, 3), resolverFor([0, 1, 2, 3])),
    ];
    expect(
      pairs.map(({ left, right }) => [left.tradition_context_id, right.tradition_context_id])
    ).toEqual([
      ['mw:tradition:synthetic-alpha', 'mw:tradition:synthetic-beta'],
      ['mw:tradition:synthetic-gamma', 'mw:tradition:synthetic-delta'],
    ]);
    for (const result of pairs) {
      expect(result.left).not.toHaveProperty('text');
      expect(result.right).not.toHaveProperty('text');
      expect(result).toMatchObject({
        kind: 'TextualParallelCandidate',
        status: 'candidate',
        interpretation_boundary: {
          basis: 'similarity_only',
          asserts_identity: false,
          asserts_quotation: false,
          asserts_fulfillment: false,
          asserts_doctrine: false,
        },
      });
      expect(result.left).toMatchObject({
        evidence_id: expect.stringMatching(/^mw:evidence:synthetic-/u),
        source_id: expect.stringMatching(/^mw:source:synthetic-/u),
        edition_id: expect.stringMatching(/^mw:edition:synthetic-/u),
        locator: expect.stringMatching(/^synthetic:/u),
        content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        quote: expect.stringMatching(/^synthetic/u),
      });
    }
  });

  it('rejects malformed, incomplete, and duplicate provenance', async () => {
    const valid = candidate();
    await expect(projectTextualAlignmentCandidate(null, resolverFor([0, 1]))).rejects.toThrow();
    await expect(
      projectTextualAlignmentCandidate(
        {
          ...valid,
          right: { ...valid.right, selector: { ...valid.right.selector, content_sha256: '' } },
        },
        resolverFor([0, 1])
      )
    ).rejects.toThrow();
    await expect(
      projectTextualAlignmentCandidate({ ...valid, right: { ...valid.left } }, resolverFor([0, 1]))
    ).rejects.toThrow();
    await expect(
      projectTextualAlignmentCandidate({ ...valid, similarity_score: 1.01 }, resolverFor([0, 1]))
    ).rejects.toThrow();
    await expect(
      projectTextualAlignmentCandidate(
        { ...valid, relation: 'identity_equivalent' },
        resolverFor([0, 1])
      )
    ).rejects.toThrow();
  });

  it('rejects resolver identity, hash, and exact quote/range mismatches', async () => {
    const valid = candidate();
    const altered = { ...syntheticPassages[1]!.passage, text: 'different synthetic text' };
    await expect(
      projectTextualAlignmentCandidate(valid, async (id) =>
        id === syntheticPassages[0]!.passage.evidence_id ? syntheticPassages[0]!.passage : altered
      )
    ).rejects.toThrow();
    await expect(
      projectTextualAlignmentCandidate(valid, async (id) => {
        const found = syntheticPassages.find(({ passage }) => passage.evidence_id === id)!;
        return { ...found.passage, locator: 'synthetic:wrong:locator' };
      })
    ).rejects.toThrow();
    await expect(
      projectTextualAlignmentCandidate(valid, async (id) => {
        const found = syntheticPassages.find(({ passage }) => passage.evidence_id === id)!.passage;
        return id === valid.right.evidence_id
          ? { ...found, tradition_context_id: syntheticPassages[0]!.passage.tradition_context_id }
          : found;
      })
    ).rejects.toThrow();
  });

  it('rejects unpaired UTF-16 surrogates and preserves supplementary-plane scalar offsets', async () => {
    const invalidQuote = candidate();
    invalidQuote.left.selector = { ...invalidQuote.left.selector, quote: '\ud800' };
    await expect(
      projectTextualAlignmentCandidate(invalidQuote, resolverFor([0, 1]))
    ).rejects.toThrow();

    const valid = candidate();
    const validLeft = syntheticPassages[0]!.passage;
    const malformedText = 'ok\ud800tail';
    const malformedSelector: TextualAlignmentSelector = {
      ...syntheticPassages[0]!.selector,
      content_sha256: createHash('sha256').update(malformedText, 'utf8').digest('hex'),
      range: { unit: 'unicode_scalar', start: 0, end: 2 },
      quote: 'ok',
    };
    const invalidText = { ...validLeft, ...malformedSelector, text: malformedText };
    valid.left.selector = malformedSelector;
    await expect(
      projectTextualAlignmentCandidate(valid, async (id) =>
        id === validLeft.evidence_id ? invalidText : syntheticPassages[1]!.passage
      )
    ).rejects.toThrow();

    const text = 'prefix 🧪 suffix';
    const selector: TextualAlignmentSelector = {
      source_id: 'mw:source:synthetic-supplementary',
      expression_id: 'mw:expression:synthetic-supplementary',
      edition_id: 'mw:edition:synthetic-supplementary-v1',
      locator: 'synthetic:supplementary:1',
      content_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      range: { unit: 'unicode_scalar', start: 7, end: 8 },
      quote: '🧪',
    };
    const supplementaryPassage: TextualAlignmentPassage = {
      evidence_id: 'mw:evidence:synthetic-supplementary',
      tradition_context_id: 'mw:tradition:synthetic-supplementary',
      ...selector,
      text,
    };
    const supplementaryCandidate = candidate();
    supplementaryCandidate.left.evidence_id = supplementaryPassage.evidence_id;
    supplementaryCandidate.left.selector = selector;
    const result = await projectTextualAlignmentCandidate(supplementaryCandidate, async (id) =>
      id === supplementaryPassage.evidence_id ? supplementaryPassage : syntheticPassages[1]!.passage
    );
    expect(result.left).toMatchObject({ quote: '🧪', range: { start: 7, end: 8 } });
  });

  it('derives tradition context from the trusted resolver, never a caller label', async () => {
    const value = candidate();
    const left = value.left as typeof value.left & { tradition_context_id?: string };
    left.tradition_context_id = 'mw:tradition:caller-claimed';
    await expect(projectTextualAlignmentCandidate(value, resolverFor([0, 1]))).rejects.toThrow();

    const result = await projectTextualAlignmentCandidate(candidate(), resolverFor([0, 1]));
    expect(result.left.tradition_context_id).toBe('mw:tradition:synthetic-alpha');
  });

  it('snapshots caller data before asynchronous resolution', async () => {
    const value = candidate();
    const pending = projectTextualAlignmentCandidate(value, async (evidenceId, selector) => {
      await Promise.resolve();
      const found = syntheticPassages.find(({ passage }) => passage.evidence_id === evidenceId)!;
      expect(Reflect.set(selector.range, 'start', 0)).toBe(false);
      return found.passage;
    });
    value.left.evidence_id = 'mw:evidence:synthetic-mutated';
    value.left.selector.locator = 'synthetic:mutated:locator';
    await expect(pending).resolves.toMatchObject({
      left: {
        evidence_id: 'mw:evidence:synthetic-a',
        locator: 'synthetic:alpha:1',
      },
    });
  });
});
