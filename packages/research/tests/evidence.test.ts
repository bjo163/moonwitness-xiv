import { describe, expect, it } from 'vitest';
import {
  EvidenceResolutionError,
  resolveResearchEvidenceReference,
  validateResearchEvidenceReference,
  type ResearchEvidenceReference,
  type ResolvablePassage,
} from '../src/index.js';

const webpPassage: ResolvablePassage = {
  source_id: 'mw:source:ebible-webp-protestant',
  expression_id: 'mw:expression:webp-protestant',
  edition_id: 'mw:edition:webp-protestant-2020-stable',
  locator: 'Genesis 1:1',
  text: 'In the beginning, God created the heavens and the earth.',
  content_sha256: 'ae5c2799fad97b0e65334aa39be6193d487419f0d31713caaac58a47f6b4d8b1',
  citation: 'WEBP Genesis 1:1; eBible.org, public domain.',
};

function evidence(
  direction: 'supporting' | 'counterevidence' = 'supporting'
): ResearchEvidenceReference {
  return {
    id: `mw:evidence:genesis-${direction}`,
    assertion_id: 'mw:assertion:creation-claim',
    direction,
    selector: {
      source_id: 'mw:source:ebible-webp-protestant',
      expression_id: 'mw:expression:webp-protestant',
      edition_id: 'mw:edition:webp-protestant-2020-stable',
      locator: 'Genesis 1:1',
      content_sha256: webpPassage.content_sha256,
      range: { unit: 'unicode_scalar', start: 0, end: 16 },
      quote: 'In the beginning',
    },
  };
}

describe('exact research evidence selectors', () => {
  it('resolves canonical passage identity, exact hash and Unicode-scalar excerpt', async () => {
    const result = await resolveResearchEvidenceReference(evidence(), async (edition, locator) =>
      edition === webpPassage.edition_id && locator === webpPassage.locator ? webpPassage : null
    );
    expect(result).toMatchObject({
      direction: 'supporting',
      source_id: webpPassage.source_id,
      expression_id: webpPassage.expression_id,
      edition_id: webpPassage.edition_id,
      locator: webpPassage.locator,
      content_sha256: webpPassage.content_sha256,
      excerpt: 'In the beginning',
    });
  });

  it('allows explicit counterevidence without changing the source selector', async () => {
    const counterevidence = evidence('counterevidence');
    expect(validateResearchEvidenceReference(counterevidence)).toEqual({ valid: true, issues: [] });
    await expect(
      resolveResearchEvidenceReference(counterevidence, async () => webpPassage)
    ).resolves.toMatchObject({ direction: 'counterevidence' });
  });

  it('rejects dangling selectors, mismatched hashes, and mismatched identities', async () => {
    await expect(
      resolveResearchEvidenceReference(evidence(), async () => null)
    ).rejects.toMatchObject({ code: 'passage_not_found' });

    const wrongHash = evidence();
    wrongHash.selector.content_sha256 = '0'.repeat(64);
    await expect(
      resolveResearchEvidenceReference(wrongHash, async () => webpPassage)
    ).rejects.toMatchObject({ code: 'content_hash_mismatch' });

    await expect(
      resolveResearchEvidenceReference(evidence(), async () => ({
        ...webpPassage,
        expression_id: 'mw:expression:other',
      }))
    ).rejects.toMatchObject({ code: 'identity_mismatch' });
  });

  it('rejects out-of-range or invented quote text', async () => {
    const outside = evidence();
    outside.selector.range = { unit: 'unicode_scalar', start: 0, end: 500 };
    await expect(
      resolveResearchEvidenceReference(outside, async () => webpPassage)
    ).rejects.toBeInstanceOf(EvidenceResolutionError);

    const inventedQuote = evidence();
    inventedQuote.selector.quote = 'In the beginning, an invented phrase';
    await expect(
      resolveResearchEvidenceReference(inventedQuote, async () => webpPassage)
    ).rejects.toMatchObject({ code: 'quote_mismatch' });
  });
});
