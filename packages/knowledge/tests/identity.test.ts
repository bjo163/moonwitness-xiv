import { describe, expect, it } from 'vitest';
import {
  knowledgeRecordKinds,
  resolveKnowledgeIdentity,
  validateCanonicalKnowledgeId,
} from '../src/index.js';
import type { KnowledgeAlias } from '../src/index.js';

const conceptId = 'mw:concept:synthetic-alpha';
const otherConceptId = 'mw:concept:synthetic-beta';

describe('canonical knowledge IDs', () => {
  it.each(knowledgeRecordKinds)('accepts lowercase kebab tokens for %s', (kind) => {
    const kindToken = kind.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase();
    const result = validateCanonicalKnowledgeId(`mw:${kindToken}:synthetic-alpha:edition-1.1:7:46`);

    expect(result).toMatchObject({ valid: true, kind });
  });

  it('accepts the plan’s illustrative edition and passage locator forms', () => {
    expect(validateCanonicalKnowledgeId('mw:edition:quran:tanzil-uthmani-1.1').valid).toBe(true);
    expect(validateCanonicalKnowledgeId('mw:passage:quran:tanzil-uthmani-1.1:7:46').valid).toBe(
      true
    );
  });

  it.each([
    ['not a string', 42],
    ['wrong namespace', 'other:concept:synthetic-alpha'],
    ['uppercase kind', 'mw:Concept:synthetic-alpha'],
    ['unknown kind', 'mw:unknown:synthetic-alpha'],
    ['missing token', 'mw:concept:'],
    ['uppercase token', 'mw:concept:Synthetic-Alpha'],
    ['whitespace', 'mw:concept:synthetic alpha'],
    ['empty token segment', 'mw:concept:synthetic::alpha'],
    ['bad token separator', 'mw:concept:-synthetic'],
    ['trailing separator', 'mw:concept:synthetic-'],
    ['trailing line feed', `${conceptId}\n`],
    ['trailing carriage return', `${conceptId}\r`],
    ['trailing Unicode line separator', `${conceptId}\u2028`],
    ['trailing Unicode paragraph separator', `${conceptId}\u2029`],
  ])('rejects %s', (_label, value) => {
    expect(validateCanonicalKnowledgeId(value).valid).toBe(false);
  });

  it('rejects IDs longer than 500 characters', () => {
    expect(validateCanonicalKnowledgeId(`mw:concept:${'a'.repeat(490)}`).valid).toBe(false);
  });
});

describe('explicit canonical identity resolution', () => {
  it('resolves an exact registered canonical ID', () => {
    expect(resolveKnowledgeIdentity({ canonicalId: conceptId }, [conceptId], [])).toMatchObject({
      status: 'resolved',
      canonicalId: conceptId,
      via: 'canonical',
    });
  });

  it('does not resolve by title or title similarity', () => {
    expect(
      resolveKnowledgeIdentity({ canonicalId: 'Synthetic Alpha' }, [conceptId], [])
    ).toMatchObject({
      status: 'invalid',
    });
    expect(
      resolveKnowledgeIdentity({ canonicalId: 'mw:concept:synthetic-alph' }, [conceptId], [])
    ).toEqual({
      status: 'not-found',
    });
  });

  it('resolves only exact namespace and alias value matches', () => {
    const aliases: KnowledgeAlias[] = [
      { namespace: 'legacy-catalog', value: 'CONCEPT-7', targetId: conceptId },
    ];

    expect(
      resolveKnowledgeIdentity(
        { alias: { namespace: 'legacy-catalog', value: 'CONCEPT-7' } },
        [conceptId],
        aliases
      )
    ).toMatchObject({ status: 'resolved', canonicalId: conceptId, via: 'alias' });
    expect(
      resolveKnowledgeIdentity(
        { alias: { namespace: 'legacy-catalog', value: 'concept-7' } },
        [conceptId],
        aliases
      )
    ).toEqual({ status: 'not-found' });
  });

  it('treats duplicate mappings to the same target as idempotent', () => {
    const alias = { namespace: 'legacy-catalog', value: 'concept-7', targetId: conceptId };

    expect(
      resolveKnowledgeIdentity({ alias: alias }, [conceptId], [alias, { ...alias }])
    ).toMatchObject({ status: 'resolved', canonicalId: conceptId, via: 'alias' });
  });

  it('reports alias collisions with stable sorted target IDs', () => {
    const aliases: KnowledgeAlias[] = [
      { namespace: 'legacy-catalog', value: 'duplicate-7', targetId: otherConceptId },
      { namespace: 'legacy-catalog', value: 'duplicate-7', targetId: conceptId },
    ];
    const result = resolveKnowledgeIdentity(
      { alias: { namespace: 'legacy-catalog', value: 'duplicate-7' } },
      [conceptId, otherConceptId],
      aliases
    );

    expect(result).toEqual({
      status: 'conflict',
      canonicalIds: [conceptId, otherConceptId],
    });
    expect(
      resolveKnowledgeIdentity(
        { alias: { namespace: 'legacy-catalog', value: 'duplicate-7' } },
        [conceptId, otherConceptId],
        [...aliases].reverse()
      )
    ).toEqual(result);
  });

  it('reports duplicate canonical registry IDs instead of collapsing them', () => {
    expect(
      resolveKnowledgeIdentity({ canonicalId: conceptId }, [conceptId, conceptId], [])
    ).toEqual({
      status: 'canonical-id-collision',
      canonicalId: conceptId,
    });
  });

  it('reports an alias whose target is not in the canonical registry', () => {
    expect(
      resolveKnowledgeIdentity(
        { alias: { namespace: 'legacy-catalog', value: 'missing-target' } },
        [conceptId],
        [{ namespace: 'legacy-catalog', value: 'missing-target', targetId: otherConceptId }]
      )
    ).toEqual({ status: 'dangling-alias', canonicalId: otherConceptId });
  });

  it('rejects malformed alias registry entries fail-closed', () => {
    expect(
      resolveKnowledgeIdentity(
        { alias: { namespace: 'legacy-catalog', value: 'reference' } },
        [conceptId],
        [{ namespace: 'legacy-catalog', value: 'reference', targetId: 'legacy:7' }]
      )
    ).toMatchObject({ status: 'invalid' });
    expect(
      resolveKnowledgeIdentity(
        { alias: { namespace: 'legacy-catalog', value: 'reference' } },
        [conceptId],
        [null as unknown as KnowledgeAlias]
      )
    ).toMatchObject({ status: 'invalid' });
    expect(
      resolveKnowledgeIdentity(null as unknown as { canonicalId: string }, [conceptId], [])
    ).toMatchObject({ status: 'invalid' });
  });
});
