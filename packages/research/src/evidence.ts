import { createJsonSchemaValidator, type JsonSchemaContract } from '@moonwitness/knowledge';
import evidenceSelectorSchema from './evidence-selector.schema.json' with { type: 'json' };

export type EvidenceDirection = 'supporting' | 'counterevidence';

interface EvidenceRange {
  unit: 'unicode_scalar';
  /** Zero-based inclusive Unicode scalar offset. */
  start: number;
  /** Zero-based exclusive Unicode scalar offset. */
  end: number;
}

interface EvidenceSelectorBase {
  content_sha256: string;
  range?: EvidenceRange;
  quote?: string;
}

export type CanonicalPassageSelector =
  | (EvidenceSelectorBase & {
      source_id: 'mw:source:tanzil-quran-text';
      edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
      locator: 'Q7:46';
    })
  | (EvidenceSelectorBase & {
      source_id: 'mw:source:ebible-webp-protestant';
      expression_id: 'mw:expression:webp-protestant';
      edition_id: 'mw:edition:webp-protestant-2020-stable';
      locator: 'Genesis 1:1';
    });

export interface ResearchEvidenceReference {
  id: `mw:evidence:${string}`;
  assertion_id: `mw:assertion:${string}`;
  direction: EvidenceDirection;
  selector: CanonicalPassageSelector;
}

export interface ResolvablePassage {
  source_id: string;
  expression_id?: string;
  edition_id: string;
  locator: string;
  text: string;
  content_sha256: string;
  citation: string;
}

export interface ResolvedEvidenceReference {
  evidence: ResearchEvidenceReference;
  direction: EvidenceDirection;
  source_id: string;
  expression_id?: string;
  edition_id: string;
  locator: string;
  content_sha256: string;
  citation: string;
  excerpt: string;
  range?: EvidenceRange;
}

export type EvidenceResolutionErrorCode =
  | 'invalid_selector'
  | 'passage_not_found'
  | 'identity_mismatch'
  | 'content_hash_mismatch'
  | 'range_invalid'
  | 'quote_mismatch';

export class EvidenceResolutionError extends Error {
  constructor(
    readonly code: EvidenceResolutionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'EvidenceResolutionError';
  }
}

export const researchEvidenceSelectorSchema = evidenceSelectorSchema;

const attestedResolutions = new WeakSet<ResolvedEvidenceReference>();

/**
 * Only objects minted by `resolveResearchEvidenceReference` are attested, so a caller cannot
 * present a hand-built reference as corpus-verified. Cloning or serializing loses attestation.
 */
export function isAttestedEvidenceResolution(value: ResolvedEvidenceReference): boolean {
  return attestedResolutions.has(value);
}

const validateSchema = createJsonSchemaValidator(
  evidenceSelectorSchema as unknown as JsonSchemaContract,
  'does not match the exact research evidence selector contract'
);

export function validateResearchEvidenceReference(value: unknown) {
  return validateSchema(value);
}

/**
 * Resolve a selector against an authoritative local passage lookup. The resolver
 * callback must return verified local source bytes and their actual content hash.
 */
export async function resolveResearchEvidenceReference(
  value: unknown,
  lookup: (editionId: string, locator: string) => Promise<ResolvablePassage | null>
): Promise<ResolvedEvidenceReference> {
  const validation = validateSchema(value);
  if (!validation.valid) {
    throw new EvidenceResolutionError('invalid_selector', 'Evidence selector is invalid');
  }
  const evidence = value as ResearchEvidenceReference;
  const selector = evidence.selector;
  const passage = await lookup(selector.edition_id, selector.locator);
  if (!passage) {
    throw new EvidenceResolutionError('passage_not_found', 'Evidence passage was not found');
  }
  if (
    passage.source_id !== selector.source_id ||
    passage.edition_id !== selector.edition_id ||
    passage.locator !== selector.locator ||
    ('expression_id' in selector && passage.expression_id !== selector.expression_id) ||
    (!('expression_id' in selector) && passage.expression_id !== undefined)
  ) {
    throw new EvidenceResolutionError(
      'identity_mismatch',
      'Evidence selector identity does not match the passage'
    );
  }
  if (passage.content_sha256 !== selector.content_sha256) {
    throw new EvidenceResolutionError(
      'content_hash_mismatch',
      'Evidence content hash does not match the passage'
    );
  }

  const characters = Array.from(passage.text);
  const start = selector.range?.start ?? 0;
  const end = selector.range?.end ?? characters.length;
  if (start >= end || end > characters.length) {
    throw new EvidenceResolutionError(
      'range_invalid',
      'Evidence range is outside the exact passage text'
    );
  }
  const excerpt = characters.slice(start, end).join('');
  if (selector.quote !== undefined && selector.quote !== excerpt) {
    throw new EvidenceResolutionError(
      'quote_mismatch',
      'Quoted evidence does not match its exact passage range'
    );
  }

  const resolution: ResolvedEvidenceReference = {
    evidence,
    direction: evidence.direction,
    source_id: passage.source_id,
    ...(passage.expression_id ? { expression_id: passage.expression_id } : {}),
    edition_id: passage.edition_id,
    locator: passage.locator,
    content_sha256: passage.content_sha256,
    citation: passage.citation,
    excerpt,
    ...(selector.range ? { range: selector.range } : {}),
  };
  attestedResolutions.add(resolution);
  return resolution;
}
