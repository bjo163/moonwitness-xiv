import { describe, expect, it } from 'vitest';
import {
  findResearchAssertion,
  validateResearchAssertion,
  type ResearchAssertion,
} from '../src/index.js';

const quotedClaim = (): ResearchAssertion => ({
  id: 'mw:assertion:reported-claim-001',
  kind: 'Assertion',
  schema_version: 1,
  lifecycle: 'candidate',
  created_at: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T00:00:00Z',
  origin_ref: 'synthetic:test:quoted-claim',
  visibility: 'INTERNAL',
  content_revision: 1,
  claim: 'The speaker reports that the event occurred.',
  polarity: 'positive',
  scope: { kind: 'passage', reference_id: 'mw:passage:sample-verse' },
  context: {
    mode: 'direct_quote',
    reference_id: 'mw:passage:sample-verse',
    speaker_id: 'mw:agent:sample-speaker',
  },
  epistemic_status: 'reported',
  review_status: 'pending',
});

describe('scoped research assertions', () => {
  it('keeps a quotation explicitly scoped, attributed, and unreviewed as global truth', () => {
    const assertion = quotedClaim();
    expect(validateResearchAssertion(assertion)).toEqual({ valid: true, issues: [] });
    expect(assertion.scope).toEqual({ kind: 'passage', reference_id: 'mw:passage:sample-verse' });
    expect(assertion.context).toMatchObject({
      mode: 'direct_quote',
      speaker_id: 'mw:agent:sample-speaker',
    });
    expect(assertion.epistemic_status).toBe('reported');
    expect(assertion.review_status).toBe('pending');
  });

  it('represents negation as explicit negative polarity and rejects a global scope', () => {
    const negative = {
      ...quotedClaim(),
      id: 'mw:assertion:explicit-negation',
      polarity: 'negative' as const,
    };
    expect(validateResearchAssertion(negative)).toEqual({ valid: true, issues: [] });
    expect(
      validateResearchAssertion({ ...negative, scope: { kind: 'global', reference_id: '*' } })
    ).toMatchObject({
      valid: false,
    });
  });

  it('requires a speaker for quoted context and does not infer missing claims as false', () => {
    const quoteWithoutSpeaker = {
      ...quotedClaim(),
      context: { mode: 'direct_quote', reference_id: 'mw:passage:sample-verse' },
    };
    expect(validateResearchAssertion(quoteWithoutSpeaker)).toMatchObject({ valid: false });

    const assertion = quotedClaim();
    expect(findResearchAssertion([assertion], 'mw:assertion:reported-claim-001')).toEqual({
      status: 'found',
      assertion,
    });
    expect(findResearchAssertion([assertion], 'mw:assertion:not-recorded')).toEqual({
      status: 'missing',
    });
  });
});
