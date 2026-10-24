import { validateResearchAssertion, type ResearchAssertion } from './assertion.js';
import { validateResearchEvidenceReference, type ResearchEvidenceReference } from './evidence.js';

export type DuplicateCandidateKind = 'duplicate' | 'overlap' | 'different';
export type DuplicateVisibility =
  'PUBLIC_APPROVED' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED' | 'CHILD_SENSITIVE';

export interface DuplicateCandidateInput {
  assertions: readonly ResearchAssertion[];
  evidence: readonly (ResearchEvidenceReference & { visibility: DuplicateVisibility })[];
  canRead?: (
    record: ResearchAssertion | (ResearchEvidenceReference & { visibility: DuplicateVisibility })
  ) => boolean;
  maxPairs?: number;
}

export interface DuplicateCandidate {
  left_id: string;
  right_id: string;
  status: 'unresolved';
  kind: DuplicateCandidateKind;
  rationale: string[];
  shared_supporting_evidence_ids: string[];
  shared_counterevidence_ids: string[];
  cross_direction_evidence_ids: string[];
  shared_scope: boolean;
  shared_claim_terms: number;
  compared_claim_terms: number;
}

export interface DuplicateCandidateResult {
  candidates: DuplicateCandidate[];
  truncated: boolean;
}

const VISIBILITIES = new Set<DuplicateVisibility>([
  'PUBLIC_APPROVED',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
  'CHILD_SENSITIVE',
]);
const MAX_ASSERTIONS = 500;
const MAX_EVIDENCE = 10_000;
const MAX_CLAIM_CODEPOINTS = 10_000;
const MAX_CLAIM_BYTES = 40_000;
const MAX_TERMS_PER_CLAIM = 256;
const EMPTY_DIRECTIONS = (): { support: Set<string>; counter: Set<string> } => ({
  support: new Set(),
  counter: new Set(),
});

function failClosed(): never {
  throw new TypeError('Duplicate candidate input is invalid or exceeds supported limits');
}

function knownVisibility(value: unknown): value is DuplicateVisibility {
  return typeof value === 'string' && VISIBILITIES.has(value as DuplicateVisibility);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalJson(nested)])
    );
  }
  return value;
}

function canonicalSelectorKey(selector: ResearchEvidenceReference['selector']): string {
  return JSON.stringify(canonicalJson(selector));
}

function claimFeatures(claim: string): { normalized: string; terms: Set<string> } {
  if (
    [...claim].length > MAX_CLAIM_CODEPOINTS ||
    new TextEncoder().encode(claim).length > MAX_CLAIM_BYTES
  ) {
    failClosed();
  }
  const normalized = claim.normalize('NFKC').trim().toLowerCase();
  const terms = new Set<string>();
  let token = '';
  let scanned = 0;
  const flush = () => {
    if (token && terms.size < MAX_TERMS_PER_CLAIM) terms.add(token);
    token = '';
  };
  // Iterate codepoints and stop collecting after the fixed feature budget.
  for (const char of normalized) {
    scanned += 1;
    if (scanned > MAX_CLAIM_CODEPOINTS) failClosed();
    if (/[\p{L}\p{N}]/u.test(char)) token += char;
    else flush();
  }
  flush();
  return { normalized, terms };
}

function contextMatches(left: ResearchAssertion, right: ResearchAssertion): boolean {
  return (
    left.context.mode === right.context.mode &&
    left.context.reference_id === right.context.reference_id &&
    left.context.speaker_id === right.context.speaker_id
  );
}

/**
 * Return bounded deterministic review candidates. This never mutates/merges records.
 * Callers must bound source retrieval before materializing input; internal caps
 * apply only to records visible under the supplied access policy.
 */
export function findDuplicateCandidates(input: DuplicateCandidateInput): DuplicateCandidateResult {
  try {
    if (
      !input ||
      typeof input !== 'object' ||
      !Array.isArray(input.assertions) ||
      !Array.isArray(input.evidence) ||
      (input.canRead !== undefined && typeof input.canRead !== 'function')
    )
      failClosed();
    const maxPairs = input.maxPairs ?? 2000;
    if (!Number.isInteger(maxPairs) || maxPairs < 1 || maxPairs > 5000) failClosed();
    const canRead = input.canRead ?? ((record) => record.visibility === 'PUBLIC_APPROVED');

    // Validate visibility as a strict enum before access decisions; unknown values fail closed.
    for (const item of input.assertions) if (!knownVisibility(item.visibility)) failClosed();
    for (const item of input.evidence) if (!knownVisibility(item.visibility)) failClosed();

    for (const item of input.assertions) {
      if (!item || typeof item !== 'object' || !knownVisibility(item.visibility)) failClosed();
    }
    const visibleAssertions = input.assertions.filter((item) => canRead(item));
    if (visibleAssertions.length > MAX_ASSERTIONS) failClosed();
    const assertionIds = new Set<string>();
    for (const item of visibleAssertions) {
      if (assertionIds.has(item.id)) failClosed();
      assertionIds.add(item.id);
    }
    for (const item of visibleAssertions) if (!validateResearchAssertion(item).valid) failClosed();
    const assertions = visibleAssertions
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const readableAssertionIds = new Set(assertions.map((item) => item.id));
    const readableEvidence = input.evidence.filter((item) => {
      if (!item || typeof item !== 'object' || !knownVisibility(item.visibility)) failClosed();
      return canRead(item);
    });
    if (readableEvidence.length > MAX_EVIDENCE) failClosed();
    const evidenceIds = new Set<string>();
    const evidenceByAssertion = new Map<
      string,
      Map<string, { support: Set<string>; counter: Set<string> }>
    >();
    for (const item of readableEvidence) {
      if (evidenceIds.has(item.id)) failClosed();
      evidenceIds.add(item.id);
      const { visibility: _visibility, ...contract } = item;
      if (!validateResearchEvidenceReference(contract).valid) failClosed();
      // Omit evidence with missing or unreadable assertion attachments alike.
      // This keeps the result independent of private-record existence.
      if (!readableAssertionIds.has(item.assertion_id)) continue;
      const key = canonicalSelectorKey(item.selector);
      const refsBySelector = evidenceByAssertion.get(item.assertion_id) ?? new Map();
      const refs = refsBySelector.get(key) ?? EMPTY_DIRECTIONS();
      (item.direction === 'supporting' ? refs.support : refs.counter).add(item.id);
      refsBySelector.set(key, refs);
      evidenceByAssertion.set(item.assertion_id, refsBySelector);
    }

    const features = new Map(assertions.map((item) => [item.id, claimFeatures(item.claim)]));
    const candidates: DuplicateCandidate[] = [];
    let truncated = false;
    outer: for (let i = 0; i < assertions.length; i += 1) {
      for (let j = i + 1; j < assertions.length; j += 1) {
        const left = assertions[i]!;
        const right = assertions[j]!;
        const leftFeatures = features.get(left.id)!;
        const rightFeatures = features.get(right.id)!;
        let sharedTerms = 0;
        const smaller =
          leftFeatures.terms.size <= rightFeatures.terms.size
            ? leftFeatures.terms
            : rightFeatures.terms;
        const larger = smaller === leftFeatures.terms ? rightFeatures.terms : leftFeatures.terms;
        for (const term of smaller) if (larger.has(term)) sharedTerms += 1;
        const exactClaim = leftFeatures.normalized === rightFeatures.normalized;
        const sharedScope =
          left.scope.kind === right.scope.kind &&
          left.scope.reference_id === right.scope.reference_id;
        const lEvidence = evidenceByAssertion.get(left.id) ?? new Map();
        const rEvidence = evidenceByAssertion.get(right.id) ?? new Map();
        const sharedSupport: string[] = [];
        const sharedCounter: string[] = [];
        const crossDirection: string[] = [];
        for (const [selectorKey, lDirections] of lEvidence) {
          const rDirections = rEvidence.get(selectorKey);
          if (!rDirections) continue;
          if (lDirections.support.size && rDirections.support.size)
            sharedSupport.push(...lDirections.support, ...rDirections.support);
          if (lDirections.counter.size && rDirections.counter.size)
            sharedCounter.push(...lDirections.counter, ...rDirections.counter);
          if (lDirections.support.size && rDirections.counter.size)
            crossDirection.push(...lDirections.support, ...rDirections.counter);
          if (lDirections.counter.size && rDirections.support.size)
            crossDirection.push(...lDirections.counter, ...rDirections.support);
        }
        sharedSupport.splice(0, sharedSupport.length, ...sorted(new Set(sharedSupport)));
        sharedCounter.splice(0, sharedCounter.length, ...sorted(new Set(sharedCounter)));
        crossDirection.splice(0, crossDirection.length, ...sorted(new Set(crossDirection)));
        const sharedEvidence =
          sharedSupport.length + sharedCounter.length + crossDirection.length > 0;
        const samePolarity = left.polarity === right.polarity;
        const sameContext = contextMatches(left, right);
        const eligibleLifecycle =
          ['candidate', 'active'].includes(left.lifecycle) &&
          ['candidate', 'active'].includes(right.lifecycle);
        const eligibleReview =
          !['rejected', 'withdrawn'].includes(left.review_status) &&
          !['rejected', 'withdrawn'].includes(right.review_status);
        const sameEpistemicStatus = left.epistemic_status === right.epistemic_status;
        const sameReviewStatus = left.review_status === right.review_status;
        const sameLifecycle = left.lifecycle === right.lifecycle;
        let kind: DuplicateCandidateKind = 'different';
        if (
          exactClaim &&
          samePolarity &&
          sharedScope &&
          sameContext &&
          eligibleLifecycle &&
          eligibleReview &&
          sameEpistemicStatus &&
          sameReviewStatus &&
          sameLifecycle
        ) {
          kind = 'duplicate';
        } else if (sharedTerms > 0 || sharedEvidence || sharedScope) kind = 'overlap';
        const rationale = [
          kind === 'duplicate'
            ? 'Normalized claim, polarity, scope, context attribution, and eligible lifecycle/review state match.'
            : kind === 'overlap'
              ? 'At least one bounded lexical, scope, evidence, context, or status feature overlaps; human review is required.'
              : 'No lexical, scope or evidence overlap was found in the available readable records.',
          samePolarity
            ? 'Polarity matches.'
            : 'Polarity differs; this is not treated as a duplicate.',
          sharedScope ? 'Scope reference matches.' : 'Scope reference differs.',
          sameContext
            ? 'Context mode, reference and speaker match.'
            : 'Context attribution differs.',
          `Lifecycle/review eligibility: ${eligibleLifecycle && eligibleReview ? 'eligible' : 'conservative overlap only'}.`,
          `Epistemic status ${sameEpistemicStatus ? 'matches' : 'differs'}; review status ${sameReviewStatus ? 'matches' : 'differs'}; lifecycle ${sameLifecycle ? 'matches' : 'differs'}.`,
          `Shared normalized claim terms: ${sharedTerms}.`,
          `Shared supporting evidence: ${sharedSupport.length}; shared counterevidence: ${sharedCounter.length}; cross-direction evidence: ${crossDirection.length}.`,
          'Feature counts are not probabilities or certainty; no merge or record mutation is performed.',
        ];
        if (candidates.length >= maxPairs) {
          truncated = true;
          break outer;
        }
        candidates.push({
          left_id: left.id,
          right_id: right.id,
          status: 'unresolved',
          kind,
          rationale,
          shared_supporting_evidence_ids: sharedSupport,
          shared_counterevidence_ids: sharedCounter,
          cross_direction_evidence_ids: crossDirection,
          shared_scope: sharedScope,
          shared_claim_terms: sharedTerms,
          compared_claim_terms: Math.max(leftFeatures.terms.size, rightFeatures.terms.size),
        });
      }
    }
    return { candidates, truncated };
  } catch {
    // Do not reveal details from unreadable/malformed records or user policies.
    return failClosed();
  }
}
