const digestPattern = /^[a-f0-9]{64}$/;
const suggestionIdPattern = /^mw:suggestion:[a-z0-9][a-z0-9._-]{0,179}$/;

export type ResearchSuggestionReviewOutcome = 'accepted' | 'rejected';

/**
 * One deliberate review of a stored local-AI suggestion version, bound to the exact canonical digest of
 * the suggestion that was reviewed.
 *
 * An accepted outcome says a human admits this model output for the tenant's own follow-up work. It is a
 * verdict about a candidate only: the stored suggestion stays `INTERNAL` and `unreviewed`, and accepting
 * it writes no canonical record. Nothing in this shape can promote a suggestion, because promotion is a
 * separate action over separate authority, and the reviewer's own identity is confined to this company.
 */
export interface ResearchSuggestionReviewDecision {
  readonly kind: 'ResearchSuggestionReviewDecision';
  readonly id: string;
  readonly company_id: string;
  readonly suggestion_id: string;
  readonly suggestion_digest: string;
  readonly reviewed_version: number;
  readonly outcome: ResearchSuggestionReviewOutcome;
  readonly reviewer_id: string;
  readonly decided_at: string;
  readonly rationale: string;
}

/** The reviewing context a decision must have been minted in to carry authority. */
export interface ResearchSuggestionReviewAuthority {
  readonly company_id: string;
  readonly reviewer_id: string;
}

export interface MintResearchSuggestionReviewInput extends ResearchSuggestionReviewAuthority {
  readonly id: string;
  readonly suggestion_id: string;
  readonly suggestion_digest: string;
  readonly reviewed_version: number;
  readonly outcome: ResearchSuggestionReviewOutcome;
  readonly decided_at: string;
  readonly rationale: string;
}

const decisionAuthorities = new WeakMap<
  ResearchSuggestionReviewDecision,
  ResearchSuggestionReviewAuthority
>();

function invalid(message: string): never {
  throw new TypeError(message);
}

/**
 * Only decisions minted by `mintResearchSuggestionReviewDecision` carry authority, and only inside the
 * company and for the reviewer bound at mint time. A hand-built, cloned or serialized copy is
 * structurally valid and unauthorized.
 */
export function isAttestedResearchSuggestionReviewDecision(
  decision: ResearchSuggestionReviewDecision,
  authority: ResearchSuggestionReviewAuthority
): boolean {
  const bound = decisionAuthorities.get(decision);
  return (
    bound !== undefined &&
    bound.company_id === authority.company_id &&
    bound.reviewer_id === authority.reviewer_id
  );
}

/**
 * Company-only attestation, for a reader that knows the reviewing tenant but not which actor inside it
 * approved the suggestion. Still unforgeable: anything not minted is absent from the brand.
 */
export function isResearchSuggestionReviewDecisionForCompany(
  decision: ResearchSuggestionReviewDecision,
  companyId: string
): boolean {
  return decisionAuthorities.get(decision)?.company_id === companyId;
}

/**
 * A review describes an admitted suggestion only when it is attested for that company, accepted, and
 * bound to the same suggestion identity and canonical digest as the record being checked.
 */
export function authorizesResearchSuggestion(
  decision: ResearchSuggestionReviewDecision | null,
  companyId: string,
  subject: { suggestion_id: string; suggestion_digest: string }
): boolean {
  if (!decision) return false;
  return (
    isResearchSuggestionReviewDecisionForCompany(decision, companyId) &&
    decision.outcome === 'accepted' &&
    decision.suggestion_id === subject.suggestion_id &&
    decision.suggestion_digest === subject.suggestion_digest
  );
}

/**
 * Mint one review decision after its bounds have been checked against authoritative storage. The caller
 * must supply the digest of the suggestion version it actually read, not a caller's assertion.
 */
export function mintResearchSuggestionReviewDecision(
  input: MintResearchSuggestionReviewInput
): ResearchSuggestionReviewDecision {
  if (!input.id.trim() || input.id.length > 255) invalid('Review decision id is invalid');
  if (!input.company_id.trim()) invalid('Review decision needs the reviewing company');
  if (!input.reviewer_id.trim()) invalid('Review decision needs the reviewing actor');
  if (!suggestionIdPattern.test(input.suggestion_id)) {
    invalid('Research suggestion identity is invalid');
  }
  if (!digestPattern.test(input.suggestion_digest)) {
    invalid('Review decision must bind a canonical suggestion digest');
  }
  if (!Number.isSafeInteger(input.reviewed_version) || input.reviewed_version < 1) {
    invalid('Review decision must name the reviewed suggestion version');
  }
  if (input.outcome !== 'accepted' && input.outcome !== 'rejected') {
    invalid('Review outcome must be accepted or rejected');
  }
  const decidedAt = Date.parse(input.decided_at);
  if (!Number.isFinite(decidedAt)) invalid('Review decision needs a valid decision timestamp');
  const rationale = input.rationale.trim();
  if (!rationale || rationale.length > 4000) invalid('Review decision needs a bounded rationale');

  const decision: ResearchSuggestionReviewDecision = Object.freeze({
    kind: 'ResearchSuggestionReviewDecision',
    id: input.id,
    company_id: input.company_id,
    suggestion_id: input.suggestion_id,
    suggestion_digest: input.suggestion_digest,
    reviewed_version: input.reviewed_version,
    outcome: input.outcome,
    reviewer_id: input.reviewer_id,
    decided_at: input.decided_at,
    rationale,
  });
  decisionAuthorities.set(decision, {
    company_id: input.company_id,
    reviewer_id: input.reviewer_id,
  });
  return decision;
}
