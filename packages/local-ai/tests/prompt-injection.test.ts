import { describe, expect, it, vi } from 'vitest';
import { generateLocalAiSuggestion, type LocalAiSuggestionPassage } from '../src/index.js';
import {
  adversarialFixtures,
  ALLOWLISTED_PASSAGE_KEYS,
  PROMPT_DATA_MARKER,
  PROMPT_POLICY_MARKERS,
  type AdversarialFixture,
} from './prompt-injection-fixtures.js';

const SECRET_MARKERS = ['MUST-NEVER-ENTER-PROMPT', 'must-never-enter-prompt'];

function makeRuntime(fixture: AdversarialFixture) {
  const prompts: string[] = [];
  return {
    prompts,
    async generate(request: { prompt: string }) {
      prompts.push(request.prompt);
      if (fixture.providerThrows) throw new Error('provider exploded');
      if (fixture.providerOversize)
        return { status: 'generated' as const, text: 'x'.repeat(100_001) };
      return { status: 'generated' as const, text: fixture.providerText ?? '{}' };
    },
  };
}

/**
 * Stand-in for the trusted caller validator wired by the restricted API route. It enforces the two
 * rules that carry the isolation guarantee: the envelope is closed, and every citation must resolve
 * to a passage the caller actually supplied.
 */
function makeTrustedValidator(suppliedSourceIds: readonly string[]) {
  return (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('candidate is not an object');
    }
    const envelope = value as Record<string, unknown>;
    const extraKeys = Object.keys(envelope).filter(
      (key) => key !== 'format' && key !== 'suggestions'
    );
    if (extraKeys.length > 0) {
      throw new Error(`properties outside the schema: ${extraKeys.join(',')}`);
    }
    if (envelope.format !== 'mw-local-ai-suggestion-envelope/v1') throw new Error('wrong format');
    if (!Array.isArray(envelope.suggestions)) throw new Error('suggestions must be an array');
    for (const raw of envelope.suggestions) {
      const item = raw as { citations?: { source_id?: string }[] };
      for (const citation of item.citations ?? []) {
        if (!suppliedSourceIds.includes(citation?.source_id ?? '')) {
          throw new Error('citation does not resolve to a supplied source');
        }
      }
    }
    return value;
  };
}

async function runFixture(fixture: AdversarialFixture) {
  const runtime = makeRuntime(fixture);
  const validate = vi.fn(
    makeTrustedValidator(fixture.passages.map((entry) => String(entry.source_id)))
  );
  const result = await generateLocalAiSuggestion({
    runtime,
    request: {
      kind: fixture.kind,
      passages: fixture.passages as unknown as LocalAiSuggestionPassage[],
    },
    validate,
  });
  return { runtime, validate, result };
}

describe('adversarial local-AI corpus', () => {
  it('names every technique the card asks for', () => {
    expect(adversarialFixtures.map((fixture) => fixture.id)).toEqual([
      'LMI-01',
      'LMI-02',
      'LMI-03',
      'LMI-04',
      'LMI-05',
      'LMI-06',
      'LMI-07',
      'LMI-08',
      'LMI-09',
      'LMI-10',
      'LMI-11',
      'LMI-12',
      'LMI-13',
    ]);
  });

  for (const fixture of adversarialFixtures) {
    describe(`${fixture.id} — ${fixture.technique}`, () => {
      it.runIf(Boolean(fixture.expects.promptIsolation))(
        'keeps retrieved text inside the data region and the policy ahead of it',
        async () => {
          const { runtime } = await runFixture(fixture);
          expect(runtime.prompts).toHaveLength(1);
          const prompt = runtime.prompts[0];
          if (prompt === undefined) throw new Error('the adapter must capture exactly one prompt');

          const markerIndex = prompt.indexOf(PROMPT_DATA_MARKER);
          expect(markerIndex).toBeGreaterThan(-1);
          const header = prompt.slice(0, markerIndex);
          for (const rule of PROMPT_POLICY_MARKERS) expect(header).toContain(rule);
          expect(header).toContain(`Requested suggestion kind: ${fixture.kind}`);
          for (const secret of SECRET_MARKERS) expect(prompt).not.toContain(secret);

          const parsed = JSON.parse(
            prompt.slice(markerIndex + PROMPT_DATA_MARKER.length)
          ) as Record<string, unknown>[];
          expect(Array.isArray(parsed)).toBe(true);
          expect(parsed).toHaveLength(fixture.passages.length);
          for (const [index, entry] of parsed.entries()) {
            expect(Object.keys(entry).sort()).toEqual([...ALLOWLISTED_PASSAGE_KEYS].sort());
            expect(entry.text).toBe(fixture.passages[index]?.text);
          }
        }
      );

      it.runIf(Boolean(fixture.expects.preModelRefusal))(
        'refuses the request before the model runs when the context breaks its ceilings',
        async () => {
          const generate = vi.fn(async () => ({ status: 'generated' as const, text: '{}' }));
          const validate = vi.fn((value: unknown) => value);
          await expect(
            generateLocalAiSuggestion({
              runtime: { generate },
              request: {
                kind: fixture.kind,
                passages: fixture.passages as unknown as LocalAiSuggestionPassage[],
              },
              validate,
            })
          ).rejects.toThrow(/request is invalid/u);
          expect(generate).not.toHaveBeenCalled();
          expect(validate).not.toHaveBeenCalled();
        }
      );

      it.runIf(fixture.expects.status !== undefined)(
        'does not let hostile text or hostile output become an accepted candidate',
        async () => {
          const { validate, result } = await runFixture(fixture);
          expect(result.status).toBe(fixture.expects.status);
          if (fixture.expects.reason !== undefined) {
            expect(result).toHaveProperty('reason', fixture.expects.reason);
          }
          expect(validate).toHaveBeenCalledTimes(fixture.expects.validatorCalled ? 1 : 0);
          if (fixture.expects.status !== 'candidate') {
            expect(result).not.toHaveProperty('value');
            for (const secret of SECRET_MARKERS) {
              expect(JSON.stringify(result)).not.toContain(secret);
            }
          }
        }
      );
    });
  }
});
