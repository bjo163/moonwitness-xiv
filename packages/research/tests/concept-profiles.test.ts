import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  mintConceptProfileReviewDecision,
  validateConceptProfileWithEvidence,
  validateConceptProfileTextualObservations,
  type CanonicalConceptPassage,
  type ConceptProfileReviewDecision,
  type MintConceptProfileReviewInput,
  type TrustedConceptEvidenceResolution,
  type TrustedConceptProfileReviewContext,
} from '../src/index.js';

const requireKnowledgeDependency = createRequire(
  new URL('../../../knowledge/package.json', import.meta.url)
);
const Ajv2020 = requireKnowledgeDependency('ajv/dist/2020.js').default;
const schema = JSON.parse(
  await readFile(
    new URL('../../../ontology/domains/concept-profile.schema.json', import.meta.url),
    'utf8'
  )
);
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const evidenceId = 'mw:evidence:synthetic-reference';
const canonicalEvidence = {
  id: evidenceId,
  assertion_id: 'mw:assertion:synthetic-claim',
  direction: 'supporting' as const,
  selector: {
    source_id: 'mw:source:ebible-webp-protestant' as const,
    expression_id: 'mw:expression:webp-protestant',
    edition_id: 'mw:edition:webp-protestant-2020-stable' as const,
    locator: 'Genesis 1:1' as const,
    content_sha256: 'a'.repeat(64),
  },
};
const acceptedProfileDocument = () => {
  const accepted = profile('mercy-context-a', 'Synthetic tradition A', 'A bounded interpretation.');
  accepted.interpretations[0]!.status = 'accepted';
  accepted.interpretations[0]!.evidence_ids = [evidenceId];
  return { format: 'moonwitness-concept-profiles/v1', profiles: [accepted] };
};
const resolution = (
  overrides: Partial<TrustedConceptEvidenceResolution> = {}
): TrustedConceptEvidenceResolution => ({
  canonicalEvidence,
  reviewStatus: 'accepted',
  access: 'readable',
  ...overrides,
});

const reviewedProfileId = 'mw:concept-profile:mercy-context-a';

const acceptedReview = (
  overrides: Partial<MintConceptProfileReviewInput> = {}
): ConceptProfileReviewDecision =>
  mintConceptProfileReviewDecision({
    id: 'mw:concept-profile-review:review-1',
    company_id: '4',
    reviewer_id: '9',
    profile_id: reviewedProfileId,
    profile_digest: 'a'.repeat(64),
    reviewed_version: 1,
    reviewed_digest: 'b'.repeat(64),
    outcome: 'accepted',
    decided_at: '2026-10-25T00:00:00Z',
    rationale: 'Synthetic reviewed decision for the fixture profile.',
    ...overrides,
  });

const reviewContext = (
  resolve: TrustedConceptProfileReviewContext['resolve']
): TrustedConceptProfileReviewContext => ({ company_id: '4', resolve });

const onlyIssue = async (
  document: unknown,
  context: TrustedConceptProfileReviewContext
): Promise<string | undefined> => {
  const result = await validateConceptProfileWithEvidence(
    document,
    async () => resolution(),
    context
  );
  if (result.valid) throw new Error('expected the profile document to be rejected');
  return result.issues[0]?.code;
};

const profile = (id: string, tradition: string, text: string) => ({
  id: `mw:concept-profile:${id}`,
  concept_id: 'mw:concept:mercy',
  tradition,
  community_or_school: 'Synthetic study group',
  language: 'en',
  interpretive_scope: 'A bounded illustrative reading, not a universal definition.',
  epistemic_status: 'contested',
  uncertainty: { level: 'moderate', note: 'Synthetic example; not source-backed.' },
  interpretations: [
    {
      claim_type: 'human_interpretation',
      text,
      status: 'candidate',
      evidence_ids: [],
    },
  ],
});

const syntheticPassage: CanonicalConceptPassage = {
  source_id: 'mw:source:synthetic-text',
  edition_id: 'mw:edition:synthetic-v1',
  locator: 'sample-1',
  content_sha256: 'b'.repeat(64),
  text: 'A 🧭 bounded source span.',
  access: 'readable',
};

function textualObservationDocument() {
  const text = Array.from(syntheticPassage.text);
  const selected = text.slice(2, 3).join('');
  return {
    format: 'moonwitness-concept-profiles/v1',
    profiles: [
      {
        ...profile(
          'source-observation',
          'Synthetic source scope',
          'No semantic interpretation is asserted.'
        ),
        textual_observations: [
          {
            id: 'mw:text-observation:synthetic-span',
            source_id: syntheticPassage.source_id,
            edition_id: syntheticPassage.edition_id,
            locator: syntheticPassage.locator,
            content_sha256: syntheticPassage.content_sha256,
            range: { unit: 'unicode_scalar', start: 2, end: 3 },
            selected_text_sha256: createHash('sha256').update(selected, 'utf8').digest('hex'),
            review_status: 'unreviewed',
          },
        ],
      },
    ],
  };
}

describe('scoped concept profiles', () => {
  it('preserves divergent interpretations of one concept as separate situated profiles', () => {
    const document = {
      format: 'moonwitness-concept-profiles/v1',
      profiles: [
        profile('mercy-context-a', 'Synthetic tradition A', 'Emphasizes restorative care.'),
        profile('mercy-context-b', 'Synthetic tradition B', 'Emphasizes covenantal obligation.'),
      ],
    };
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    expect(document.profiles.map((item) => item.concept_id)).toEqual([
      'mw:concept:mercy',
      'mw:concept:mercy',
    ]);
    expect(document.profiles[0]?.interpretations[0]?.text).not.toBe(
      document.profiles[1]?.interpretations[0]?.text
    );
  });

  it('rejects profiles that blur interpretation into revelation or omit uncertainty', () => {
    const base = profile('mercy-context-a', 'Synthetic tradition A', 'A bounded interpretation.');
    const wrongClaimType = structuredClone(base);
    wrongClaimType.interpretations[0]!.claim_type = 'revelation' as 'human_interpretation';
    expect(
      validate({ format: 'moonwitness-concept-profiles/v1', profiles: [wrongClaimType] })
    ).toBe(false);

    const noUncertainty = structuredClone(base) as Record<string, unknown>;
    delete noUncertainty.uncertainty;
    expect(validate({ format: 'moonwitness-concept-profiles/v1', profiles: [noUncertainty] })).toBe(
      false
    );
  });

  it('requires evidence for an accepted human interpretation', () => {
    const accepted = profile(
      'mercy-context-a',
      'Synthetic tradition A',
      'A bounded interpretation.'
    );
    accepted.interpretations[0]!.status = 'accepted';
    expect(validate({ format: 'moonwitness-concept-profiles/v1', profiles: [accepted] })).toBe(
      false
    );
    accepted.interpretations[0]!.evidence_ids = ['mw:evidence:synthetic-reference'];
    expect(validate({ format: 'moonwitness-concept-profiles/v1', profiles: [accepted] })).toBe(
      true
    );
  });

  it('keeps accepted interpretations pending even when K3 Assertion evidence is accepted', async () => {
    await expect(
      validateConceptProfileWithEvidence(acceptedProfileDocument(), async () => resolution())
    ).resolves.toEqual({
      valid: false,
      issues: [
        {
          path: '/profiles/0/interpretations/0/status',
          code: 'profile_review_pending',
          message:
            'accepted profile interpretations require a separate decision bound to the exact profile digest',
        },
      ],
    });
  });

  it('accepts an interpretation once a minted accepted decision for its profile is supplied', async () => {
    await expect(
      validateConceptProfileWithEvidence(
        acceptedProfileDocument(),
        async () => resolution(),
        reviewContext(async () => acceptedReview())
      )
    ).resolves.toEqual({ valid: true, issues: [] });
  });

  it('refuses a review decision that was not minted by the trusted store', async () => {
    const forged = JSON.parse(JSON.stringify(acceptedReview())) as ConceptProfileReviewDecision;
    expect(
      await onlyIssue(
        acceptedProfileDocument(),
        reviewContext(async () => forged)
      )
    ).toBe('profile_review_unattested');
    expect(
      await onlyIssue(
        acceptedProfileDocument(),
        reviewContext(async () => acceptedReview({ company_id: '7' }))
      )
    ).toBe('profile_review_unattested');
  });

  it('refuses a decision belonging to another profile or a rejecting outcome', async () => {
    expect(
      await onlyIssue(
        acceptedProfileDocument(),
        reviewContext(async () =>
          acceptedReview({
            profile_id: 'mw:concept-profile:mercy-context-b',
            id: 'mw:concept-profile-review:review-2',
          })
        )
      )
    ).toBe('profile_review_identity_mismatch');
    expect(
      await onlyIssue(
        acceptedProfileDocument(),
        reviewContext(async () => acceptedReview({ outcome: 'rejected' }))
      )
    ).toBe('profile_review_rejected');
  });

  it('stays pending without a decision and fails closed when the resolver breaks', async () => {
    const pending = await validateConceptProfileWithEvidence(
      acceptedProfileDocument(),
      async () => resolution(),
      reviewContext(async () => null)
    );
    expect(pending.valid).toBe(false);
    if (!pending.valid) {
      expect(pending.issues[0]?.code).toBe('profile_review_pending');
      expect(pending.issues[0]?.message).toBe('no review decision exists for this concept profile');
    }

    expect(
      await onlyIssue(
        acceptedProfileDocument(),
        reviewContext(async () => {
          throw new Error('synthetic review store failure');
        })
      )
    ).toBe('profile_review_resolver_failure');
  });

  it('fails closed for missing and mismatched canonical evidence', async () => {
    const missing = await validateConceptProfileWithEvidence(
      acceptedProfileDocument(),
      async () => null
    );
    expect(missing.valid).toBe(false);
    if (!missing.valid) expect(missing.issues[0]?.code).toBe('evidence_missing');

    const mismatch = await validateConceptProfileWithEvidence(acceptedProfileDocument(), async () =>
      resolution({
        canonicalEvidence: { ...canonicalEvidence, id: 'mw:evidence:other' },
      })
    );
    expect(mismatch.valid).toBe(false);
    if (!mismatch.valid) expect(mismatch.issues[0]?.code).toBe('evidence_mismatch');
  });

  it('fails closed for unreviewed, rejected, or contradictory review status', async () => {
    for (const reviewStatus of ['unreviewed', 'rejected', 'conflicting'] as const) {
      const result = await validateConceptProfileWithEvidence(acceptedProfileDocument(), async () =>
        resolution({ reviewStatus })
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.issues[0]?.code).toBe(
          reviewStatus === 'conflicting' ? 'review_conflicting' : 'review_not_accepted'
        );
      }
    }
  });

  it('fails closed for denied access and resolver exceptions', async () => {
    const denied = await validateConceptProfileWithEvidence(acceptedProfileDocument(), async () =>
      resolution({ access: 'denied' })
    );
    expect(denied.valid).toBe(false);
    if (!denied.valid) expect(denied.issues[0]?.code).toBe('access_denied');

    const failure = await validateConceptProfileWithEvidence(
      acceptedProfileDocument(),
      async () => {
        throw new Error('synthetic resolver failure');
      }
    );
    expect(failure.valid).toBe(false);
    if (!failure.valid) expect(failure.issues[0]?.code).toBe('resolver_failure');
  });

  it('rejects caller mutation while never querying evidence IDs injected during await', async () => {
    const document = acceptedProfileDocument();
    const ids = document.profiles[0]!.interpretations[0]!.evidence_ids;
    const requested: string[] = [];
    const result = await validateConceptProfileWithEvidence(document, async (id) => {
      requested.push(id);
      ids.push('mw:evidence:injected-after-validation');
      await Promise.resolve();
      return resolution();
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues[0]?.code).toBe('input_changed');
    expect(requested).toEqual([evidenceId]);
  });

  it('rejects a candidate interpretation changed to accepted during resolver await', async () => {
    const candidate = profile(
      'second-candidate',
      'Synthetic tradition B',
      'Another bounded interpretation.'
    );
    const accepted = acceptedProfileDocument();
    const document = {
      ...accepted,
      profiles: [...accepted.profiles, candidate],
    };
    const result = await validateConceptProfileWithEvidence(document, async () => {
      candidate.interpretations[0]!.status = 'accepted';
      candidate.interpretations[0]!.evidence_ids = ['mw:evidence:added-during-await'];
      await Promise.resolve();
      return resolution();
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues[0]?.code).toBe('input_changed');
  });

  it('reports malformed resolver output and nested canonical evidence as issues', async () => {
    for (const malformed of [
      undefined,
      {},
      { reviewStatus: 'accepted', access: 'readable' },
      { canonicalEvidence: null, reviewStatus: 'accepted', access: 'readable' },
      { canonicalEvidence: {}, reviewStatus: 'accepted', access: 'readable' },
      { canonicalEvidence, reviewStatus: 'unknown', access: 'readable' },
      { canonicalEvidence, reviewStatus: 'accepted', access: 'sometimes' },
    ]) {
      const result = await validateConceptProfileWithEvidence(
        acceptedProfileDocument(),
        async () => malformed
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.issues[0]?.code).toMatch(/resolver_output_invalid|evidence_mismatch/u);
      }
    }
  });

  it('validates an exact source span without storing its text or making an interpretation', async () => {
    const document = textualObservationDocument();
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    await expect(
      validateConceptProfileTextualObservations(document, async () => syntheticPassage)
    ).resolves.toEqual({ valid: true, issues: [] });
    expect(JSON.stringify(document)).not.toContain('🧭');
    expect(JSON.stringify(document)).toContain('No semantic interpretation is asserted.');
  });

  it('fails closed when source identity, rights access, artifact digest, or selected span differ', async () => {
    const document = textualObservationDocument();
    const invalidCases: Array<{
      passage: unknown;
      code: string;
    }> = [
      { passage: null, code: 'passage_missing' },
      {
        passage: { ...syntheticPassage, edition_id: 'mw:edition:other' },
        code: 'passage_mismatch',
      },
      { passage: { ...syntheticPassage, access: 'denied' }, code: 'access_denied' },
      {
        passage: { ...syntheticPassage, content_sha256: 'c'.repeat(64) },
        code: 'content_hash_mismatch',
      },
    ];
    for (const { passage, code } of invalidCases) {
      const result = await validateConceptProfileTextualObservations(document, async () => passage);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.issues[0]?.code).toBe(code);
    }

    const wrongSpan = structuredClone(document);
    wrongSpan.profiles[0]!.textual_observations![0]!.selected_text_sha256 = 'd'.repeat(64);
    const result = await validateConceptProfileTextualObservations(
      wrongSpan,
      async () => syntheticPassage
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues[0]?.code).toBe('selected_text_hash_mismatch');
  });

  it('rejects invalid offsets and caller mutation while resolving a source span', async () => {
    const invalidRange = textualObservationDocument();
    invalidRange.profiles[0]!.textual_observations![0]!.range.end = 999;
    const rangeResult = await validateConceptProfileTextualObservations(
      invalidRange,
      async () => syntheticPassage
    );
    expect(rangeResult.valid).toBe(false);
    if (!rangeResult.valid) expect(rangeResult.issues[0]?.code).toBe('range_invalid');

    const changing = textualObservationDocument();
    const selected = changing.profiles[0]!.textual_observations![0]!;
    const mutationResult = await validateConceptProfileTextualObservations(changing, async () => {
      selected.range.end += 1;
      await Promise.resolve();
      return syntheticPassage;
    });
    expect(mutationResult.valid).toBe(false);
    if (!mutationResult.valid) expect(mutationResult.issues[0]?.code).toBe('input_changed');
  });

  it('rejects duplicate observation identities and malformed or failed resolvers', async () => {
    const duplicate = textualObservationDocument();
    duplicate.profiles[0]!.textual_observations!.push(
      structuredClone(duplicate.profiles[0]!.textual_observations![0]!)
    );
    const duplicateResult = await validateConceptProfileTextualObservations(
      duplicate,
      async () => syntheticPassage
    );
    expect(duplicateResult.valid).toBe(false);
    if (!duplicateResult.valid) {
      expect(
        duplicateResult.issues.some((issue) => issue.code === 'duplicate_observation_id')
      ).toBe(true);
    }

    const document = textualObservationDocument();
    for (const resolver of [
      async () => undefined,
      async () => {
        throw new Error('synthetic resolver failure');
      },
    ]) {
      const result = await validateConceptProfileTextualObservations(document, resolver);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.issues[0]?.code).toMatch(/resolver_output_invalid|resolver_failure/u);
      }
    }

    const invalidText = textualObservationDocument();
    const invalidPassage = { ...syntheticPassage, text: '\ud800' };
    const invalidTextResult = await validateConceptProfileTextualObservations(
      invalidText,
      async () => invalidPassage
    );
    expect(invalidTextResult.valid).toBe(false);
    if (!invalidTextResult.valid) {
      expect(invalidTextResult.issues[0]?.code).toBe('passage_text_invalid');
    }
  });
});
