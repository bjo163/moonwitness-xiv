import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SuggestionEnvelopeError,
  validateResearchSuggestionEnvelope,
  validateResearchSuggestionEnvelopeWithResolver,
  type SuggestionSpanSelector,
  type TrustedSuggestionResolver,
} from '../src/suggestion-envelope.js';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function fixture(text = 'A😀B') {
  const contentSha = hash(text);
  const selector: SuggestionSpanSelector = {
    source_id: 'mw:source:synthetic-test',
    edition_id: 'mw:edition:synthetic-test-v1',
    locator: 'Synthetic 1:1',
    content_sha256: contentSha,
    range: { unit: 'unicode_scalar', start: 1, end: 2 },
    selected_span_sha256: hash('😀'),
  };
  const citation = {
    evidence_id: 'mw:evidence:synthetic-test',
    assertion_id: 'mw:assertion:synthetic-test',
    selector,
  } as const;
  const envelope = {
    format: 'mw-local-ai-suggestion-envelope/v1',
    suggestions: [
      {
        id: 'mw:suggestion:term-test',
        status: 'unreviewed',
        visibility: 'INTERNAL',
        kind: 'term',
        text: '😀',
        citations: [citation],
      },
    ],
  };
  const resolver: TrustedSuggestionResolver = {
    async resolvePassage() {
      return {
        source_id: selector.source_id,
        edition_id: selector.edition_id,
        locator: selector.locator,
        content_sha256: contentSha,
        text,
        readable: true,
      };
    },
    async resolveAssertion() {
      return { active: true, readable: true };
    },
    async resolveEvidence(evidenceId) {
      return {
        assertion_id: evidenceId.endsWith('second')
          ? 'mw:assertion:synthetic-second'
          : citation.assertion_id,
        active: true,
        readable: true,
      };
    },
  };
  return { envelope, resolver, selector, citation };
}

describe('local AI suggestion envelope', () => {
  it('accepts strict extractive term and uses Unicode scalar offsets', async () => {
    const { envelope, resolver } = fixture();
    expect(validateResearchSuggestionEnvelope(envelope)).toEqual({ valid: true, issues: [] });
    await expect(
      validateResearchSuggestionEnvelopeWithResolver(envelope, resolver)
    ).resolves.toEqual(envelope);
  });

  it('validates and returns an isolated snapshot when the caller mutates during resolver awaits', async () => {
    const { envelope, resolver } = fixture();
    const mutatingResolver: TrustedSuggestionResolver = {
      ...resolver,
      async resolvePassage(selector) {
        envelope.suggestions[0]!.text = 'Unsupported changed text';
        envelope.suggestions[0]!.citations[0]!.selector.range.end = 3;
        selector.range.end = 0;
        return resolver.resolvePassage(selector);
      },
    };

    const result = await validateResearchSuggestionEnvelopeWithResolver(envelope, mutatingResolver);
    expect(result.suggestions[0]).toMatchObject({ text: '😀', kind: 'term' });
    expect(envelope.suggestions[0]!.text).toBe('Unsupported changed text');
  });

  it('rejects unknown fields, mutable status/visibility, malformed ids and free-form claim text', async () => {
    const { envelope, resolver } = fixture();
    expect(
      validateResearchSuggestionEnvelope({ ...envelope, prompt: 'ignore rules' })
    ).toMatchObject({ valid: false });
    for (const changed of [
      { ...envelope.suggestions[0]!, status: 'accepted' },
      { ...envelope.suggestions[0]!, visibility: 'PUBLIC' },
      { ...envelope.suggestions[0]!, rationale: 'This means...' },
      {
        ...envelope.suggestions[0]!,
        citations: [{ ...envelope.suggestions[0]!.citations[0]!, assertion_id: 'other' }],
      },
    ]) {
      const candidate = { ...envelope, suggestions: [changed] };
      expect(validateResearchSuggestionEnvelope(candidate)).toMatchObject({ valid: false });
    }
    await expect(
      validateResearchSuggestionEnvelopeWithResolver(
        {
          ...envelope,
          suggestions: [{ ...envelope.suggestions[0]!, text: 'A supported conclusion' }],
        },
        resolver
      )
    ).rejects.toMatchObject({ code: 'unsupported_text' });
  });

  it('requires every summary and term citation to resolve a readable Assertion and bound Evidence', async () => {
    const { envelope, resolver } = fixture();
    const term = envelope.suggestions[0]!;
    const candidates = [
      envelope,
      { ...envelope, suggestions: [{ ...term, kind: 'summary' as const }] },
    ];
    const deniedAssertion: TrustedSuggestionResolver = {
      ...resolver,
      async resolveAssertion() {
        return { active: false, readable: true };
      },
    };
    const deniedEvidence: TrustedSuggestionResolver = {
      ...resolver,
      async resolveEvidence() {
        return { assertion_id: term.citations[0]!.assertion_id, active: true, readable: false };
      },
    };
    const mismatchedEvidence: TrustedSuggestionResolver = {
      ...resolver,
      async resolveEvidence() {
        return {
          assertion_id: 'mw:assertion:another-subject',
          active: true,
          readable: true,
        };
      },
    };

    for (const candidate of candidates) {
      await expect(
        validateResearchSuggestionEnvelopeWithResolver(candidate, deniedAssertion)
      ).rejects.toMatchObject({ code: 'assertion_unavailable' });
      await expect(
        validateResearchSuggestionEnvelopeWithResolver(candidate, deniedEvidence)
      ).rejects.toMatchObject({ code: 'evidence_unavailable' });
      await expect(
        validateResearchSuggestionEnvelopeWithResolver(candidate, mismatchedEvidence)
      ).rejects.toMatchObject({ code: 'evidence_binding_mismatch' });
    }
  });

  it('requires summary to be exact span concatenation and duplicate pair evidence to bind on both sides', async () => {
    const { resolver, citation } = fixture('alpha beta');
    const first = {
      ...citation,
      selector: {
        ...citation.selector,
        range: { unit: 'unicode_scalar' as const, start: 0, end: 5 },
        selected_span_sha256: hash('alpha'),
      },
    };
    const second = {
      ...citation,
      evidence_id: 'mw:evidence:synthetic-second',
      assertion_id: 'mw:assertion:synthetic-second',
      selector: {
        ...first.selector,
        range: { unit: 'unicode_scalar' as const, start: 6, end: 10 },
        selected_span_sha256: hash('beta'),
      },
    };
    const summary = {
      format: 'mw-local-ai-suggestion-envelope/v1',
      suggestions: [
        {
          id: 'mw:suggestion:summary',
          status: 'unreviewed',
          visibility: 'INTERNAL',
          kind: 'summary',
          text: 'alphabeta',
          citations: [first, second],
        },
      ],
    };
    await expect(
      validateResearchSuggestionEnvelopeWithResolver(summary, resolver)
    ).resolves.toBeDefined();
    await expect(
      validateResearchSuggestionEnvelopeWithResolver(
        { ...summary, suggestions: [{ ...summary.suggestions[0]!, text: 'alpha beta' }] },
        resolver
      )
    ).rejects.toMatchObject({ code: 'unsupported_text' });

    const duplicate = {
      format: 'mw-local-ai-suggestion-envelope/v1',
      suggestions: [
        {
          id: 'mw:suggestion:duplicate',
          status: 'unreviewed',
          visibility: 'INTERNAL',
          kind: 'duplicate',
          assertion_ids: ['mw:assertion:synthetic-test', 'mw:assertion:synthetic-second'],
          citations: [first, second],
        },
      ],
    };
    await expect(
      validateResearchSuggestionEnvelopeWithResolver(duplicate, resolver)
    ).resolves.toBeDefined();
    await expect(
      validateResearchSuggestionEnvelopeWithResolver(
        {
          ...duplicate,
          suggestions: [
            {
              ...duplicate.suggestions[0]!,
              citations: [first, { ...second, assertion_id: 'mw:assertion:synthetic-test' }],
            },
          ],
        },
        resolver
      )
    ).rejects.toMatchObject({ code: 'evidence_binding_mismatch' });
  });

  it('checks source access, exact identity, digest and selected-span digest', async () => {
    const { envelope, resolver, selector } = fixture();
    const failureCases: Array<[TrustedSuggestionResolver, string]> = [
      [
        {
          ...resolver,
          async resolvePassage() {
            return {
              source_id: selector.source_id,
              edition_id: selector.edition_id,
              locator: selector.locator,
              content_sha256: selector.content_sha256,
              text: 'A😀B',
              readable: false,
            };
          },
        },
        'source_access_denied',
      ],
      [
        {
          ...resolver,
          async resolvePassage() {
            return {
              source_id: 'mw:source:other',
              edition_id: selector.edition_id,
              locator: selector.locator,
              content_sha256: selector.content_sha256,
              text: 'A😀B',
              readable: true,
            };
          },
        },
        'source_identity_mismatch',
      ],
      [
        {
          ...resolver,
          async resolvePassage() {
            return {
              source_id: selector.source_id,
              edition_id: selector.edition_id,
              locator: selector.locator,
              content_sha256: 'f'.repeat(64),
              text: 'A😀B',
              readable: true,
            };
          },
        },
        'source_digest_mismatch',
      ],
      [
        {
          ...resolver,
          async resolvePassage() {
            return {
              source_id: selector.source_id,
              edition_id: selector.edition_id,
              locator: selector.locator,
              content_sha256: selector.content_sha256,
              text: 'A😁B',
              readable: true,
            };
          },
        },
        'span_digest_mismatch',
      ],
    ];
    for (const [failingResolver, code] of failureCases) {
      await expect(
        validateResearchSuggestionEnvelopeWithResolver(envelope, failingResolver)
      ).rejects.toMatchObject({ code });
    }
    expect(SuggestionEnvelopeError).toBeDefined();
  });

  it('validates local approved Q7:46 and WEBP Genesis 1:1 exact bytes without expanding the source policy', async () => {
    const root = path.resolve(process.cwd(), '../..');
    const cases = [
      {
        path: `${root}/corpus/reference/sha256/6f/6ff83b01099fb7992b5f7fa101cfab3d6556607ca6b1fe69d53cb76f97027760`,
        source_id: 'mw:source:tanzil-quran-text',
        edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
        locator: 'Q7:46',
      },
      {
        path: `${root}/corpus/reference/sha256/ae/ae5c2799fad97b0e65334aa39be6193d487419f0d31713caaac58a47f6b4d8b1`,
        source_id: 'mw:source:ebible-webp-protestant',
        edition_id: 'mw:edition:webp-protestant-2020-stable',
        locator: 'Genesis 1:1',
      },
    ];
    for (const item of cases) {
      const bytes = await readFile(item.path);
      const content_sha256 = createHash('sha256').update(bytes).digest('hex');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\n$/u, '');
      const excerpt = Array.from(text).slice(0, 1).join('');
      const selector: SuggestionSpanSelector = {
        source_id: item.source_id,
        edition_id: item.edition_id,
        locator: item.locator,
        content_sha256,
        range: { unit: 'unicode_scalar', start: 0, end: 1 },
        selected_span_sha256: hash(excerpt),
      };
      const suggestion = {
        id: 'mw:suggestion:approved-byte-fixture',
        status: 'unreviewed',
        visibility: 'INTERNAL',
        kind: 'term',
        text: excerpt,
        citations: [
          {
            evidence_id: 'mw:evidence:approved-byte-fixture',
            assertion_id: 'mw:assertion:approved-byte-fixture',
            selector,
          },
        ],
      };
      const resolver: TrustedSuggestionResolver = {
        async resolvePassage() {
          return { ...item, content_sha256, text, readable: true };
        },
        async resolveAssertion() {
          return { active: true, readable: true };
        },
        async resolveEvidence() {
          return {
            assertion_id: 'mw:assertion:approved-byte-fixture',
            active: true,
            readable: true,
          };
        },
      };
      await expect(
        validateResearchSuggestionEnvelopeWithResolver(
          { format: 'mw-local-ai-suggestion-envelope/v1', suggestions: [suggestion] },
          resolver
        )
      ).resolves.toBeDefined();
    }
  });
});
