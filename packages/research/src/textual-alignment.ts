import { createHash } from 'node:crypto';

const identifier = /^[a-z][a-z0-9+.-]*(?::[a-z0-9][a-z0-9._-]{0,179})+$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const methodIdentifier = /^mw:alignment-method:[a-z0-9][a-z0-9._-]{0,159}$/u;
const candidateIdentifier = /^mw:textual-alignment-candidate:[a-z0-9][a-z0-9._-]{0,159}$/u;

export interface TextualAlignmentSelector {
  readonly source_id: string;
  readonly expression_id: string;
  readonly edition_id: string;
  readonly locator: string;
  readonly content_sha256: string;
  readonly range: {
    readonly unit: 'unicode_scalar';
    readonly start: number;
    readonly end: number;
  };
  readonly quote: string;
}

export interface TextualAlignmentPassage extends TextualAlignmentSelector {
  readonly evidence_id: string;
  readonly tradition_context_id: string;
  readonly text: string;
}

export interface TextualAlignmentMethod {
  readonly id: string;
  readonly version: string;
}

export interface TextualAlignmentCandidate {
  readonly id: string;
  readonly kind: 'TextualParallelCandidate';
  readonly status: 'candidate';
  readonly left: Omit<TextualAlignmentPassage, 'text'> & { readonly tradition_context_id: string };
  readonly right: Omit<TextualAlignmentPassage, 'text'> & { readonly tradition_context_id: string };
  readonly similarity_score: number;
  readonly method: TextualAlignmentMethod;
  readonly uncertainty: {
    readonly level: 'low' | 'moderate' | 'high' | 'unassessed';
    readonly note: string;
  };
  readonly interpretation_boundary: {
    readonly basis: 'similarity_only';
    readonly asserts_identity: false;
    readonly asserts_quotation: false;
    readonly asserts_fulfillment: false;
    readonly asserts_doctrine: false;
  };
}

/**
 * The caller must bind this resolver to authenticated tenant context and verify
 * canonical evidence, source rights, edition, locator, and tradition metadata.
 * Never construct resolver results from the candidate input itself.
 */
export type TextualAlignmentPassageResolver = (
  evidenceId: string,
  selector: TextualAlignmentSelector
) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function fail(): never {
  throw new TypeError('Textual alignment input or canonical passage is invalid');
}

function snapshotJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') return fail();
  return json;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifier.test(value);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isSelector(value: unknown): value is TextualAlignmentSelector {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'source_id',
      'expression_id',
      'edition_id',
      'locator',
      'content_sha256',
      'range',
      'quote',
    ]) ||
    !isRecord(value.range) ||
    !hasOnlyKeys(value.range, ['unit', 'start', 'end'])
  )
    return false;
  return (
    isIdentifier(value.source_id) &&
    value.source_id.startsWith('mw:source:') &&
    isIdentifier(value.expression_id) &&
    value.expression_id.startsWith('mw:expression:') &&
    isIdentifier(value.edition_id) &&
    value.edition_id.startsWith('mw:edition:') &&
    typeof value.locator === 'string' &&
    value.locator.trim().length > 0 &&
    value.locator.length <= 240 &&
    typeof value.content_sha256 === 'string' &&
    digestPattern.test(value.content_sha256) &&
    value.range.unit === 'unicode_scalar' &&
    Number.isSafeInteger(value.range.start) &&
    Number(value.range.start) >= 0 &&
    Number.isSafeInteger(value.range.end) &&
    Number(value.range.end) > Number(value.range.start) &&
    typeof value.quote === 'string' &&
    isWellFormedUnicode(value.quote) &&
    value.quote.length > 0 &&
    value.quote.length <= 4000
  );
}

function isSide(value: unknown): value is Record<string, unknown> & {
  evidence_id: string;
  selector: TextualAlignmentSelector;
} {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['evidence_id', 'selector']) &&
    typeof value.evidence_id === 'string' &&
    value.evidence_id.startsWith('mw:evidence:') &&
    isIdentifier(value.evidence_id) &&
    isSelector(value.selector)
  );
}

function resolveSide(value: Record<string, unknown>, resolved: unknown): TextualAlignmentPassage {
  if (!isRecord(resolved) || typeof resolved.text !== 'string') return fail();
  const passageJson = snapshotJson(resolved);
  const passage = JSON.parse(passageJson) as Record<string, unknown>;
  const selector = value.selector as TextualAlignmentSelector;
  if (
    passage.evidence_id !== value.evidence_id ||
    !isIdentifier(passage.tradition_context_id) ||
    !String(passage.tradition_context_id).startsWith('mw:tradition:') ||
    passage.source_id !== selector.source_id ||
    passage.expression_id !== selector.expression_id ||
    passage.edition_id !== selector.edition_id ||
    passage.locator !== selector.locator ||
    passage.content_sha256 !== selector.content_sha256 ||
    typeof passage.text !== 'string' ||
    !isWellFormedUnicode(passage.text) ||
    createHash('sha256').update(passage.text, 'utf8').digest('hex') !== selector.content_sha256
  ) {
    return fail();
  }
  const scalars = Array.from(passage.text as string);
  const { start, end } = selector.range;
  if (end > scalars.length || scalars.slice(start, end).join('') !== selector.quote) return fail();
  return {
    evidence_id: value.evidence_id as string,
    tradition_context_id: passage.tradition_context_id as string,
    source_id: selector.source_id,
    expression_id: selector.expression_id,
    edition_id: selector.edition_id,
    locator: selector.locator,
    content_sha256: selector.content_sha256,
    range: { unit: 'unicode_scalar', start, end },
    quote: selector.quote,
    text: passage.text as string,
  };
}

function citationOnly(passage: TextualAlignmentPassage): Omit<TextualAlignmentPassage, 'text'> {
  return {
    evidence_id: passage.evidence_id,
    tradition_context_id: passage.tradition_context_id,
    source_id: passage.source_id,
    expression_id: passage.expression_id,
    edition_id: passage.edition_id,
    locator: passage.locator,
    content_sha256: passage.content_sha256,
    range: passage.range,
    quote: passage.quote,
  };
}

/**
 * Verify two exact source passages and project a noncanonical similarity candidate.
 * Score and method are validated caller-supplied metadata; this function does not
 * calculate similarity. A candidate never asserts identity, quotation,
 * fulfillment, or doctrine.
 */
export async function projectTextualAlignmentCandidate(
  value: unknown,
  resolvePassage: TextualAlignmentPassageResolver
): Promise<TextualAlignmentCandidate> {
  let input: unknown;
  try {
    input = JSON.parse(snapshotJson(value)) as unknown;
  } catch {
    return fail();
  }
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ['id', 'left', 'right', 'similarity_score', 'method', 'uncertainty']) ||
    !candidateIdentifier.test(String(input.id)) ||
    !isSide(input.left) ||
    !isSide(input.right) ||
    input.left.evidence_id === input.right.evidence_id ||
    (input.left.selector.edition_id === input.right.selector.edition_id &&
      input.left.selector.locator === input.right.selector.locator &&
      input.left.selector.range.start === input.right.selector.range.start &&
      input.left.selector.range.end === input.right.selector.range.end) ||
    !isRecord(input.method) ||
    !hasOnlyKeys(input.method, ['id', 'version']) ||
    typeof input.method.id !== 'string' ||
    !methodIdentifier.test(input.method.id) ||
    typeof input.method.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(input.method.version) ||
    typeof input.similarity_score !== 'number' ||
    !Number.isFinite(input.similarity_score) ||
    input.similarity_score < 0 ||
    input.similarity_score > 1 ||
    !isRecord(input.uncertainty) ||
    !hasOnlyKeys(input.uncertainty, ['level', 'note']) ||
    !['low', 'moderate', 'high', 'unassessed'].includes(String(input.uncertainty.level)) ||
    typeof input.uncertainty.note !== 'string' ||
    input.uncertainty.note.trim().length === 0 ||
    input.uncertainty.note.length > 2000
  ) {
    return fail();
  }

  // Callbacks receive detached selectors. Caller mutation while awaiting cannot
  // replace the evidence identity or citation that is validated and returned.
  const freezeSelector = (selector: TextualAlignmentSelector): TextualAlignmentSelector =>
    Object.freeze({
      ...selector,
      range: Object.freeze({ ...selector.range }),
    });
  const leftSelector = freezeSelector(input.left.selector as TextualAlignmentSelector);
  const rightSelector = freezeSelector(input.right.selector as TextualAlignmentSelector);
  const [leftRaw, rightRaw] = await Promise.all([
    resolvePassage(input.left.evidence_id, leftSelector),
    resolvePassage(input.right.evidence_id, rightSelector),
  ]);
  const left = resolveSide(input.left, leftRaw);
  const right = resolveSide(input.right, rightRaw);
  if (left.tradition_context_id === right.tradition_context_id) return fail();
  const leftCitation = citationOnly(left);
  const rightCitation = citationOnly(right);

  return {
    id: input.id as string,
    kind: 'TextualParallelCandidate',
    status: 'candidate',
    left: leftCitation,
    right: rightCitation,
    similarity_score: input.similarity_score,
    method: {
      id: input.method.id,
      version: input.method.version,
    },
    uncertainty: {
      level: input.uncertainty.level as TextualAlignmentCandidate['uncertainty']['level'],
      note: input.uncertainty.note,
    },
    interpretation_boundary: {
      basis: 'similarity_only',
      asserts_identity: false,
      asserts_quotation: false,
      asserts_fulfillment: false,
      asserts_doctrine: false,
    },
  };
}
