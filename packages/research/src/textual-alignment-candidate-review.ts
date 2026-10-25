const digestPattern = /^[a-f0-9]{64}$/;
const candidateIdPattern = /^mw:textual-alignment-candidate:[a-z0-9][a-z0-9._-]{0,159}$/;

export type TextualAlignmentCandidateReviewOutcome = 'accepted' | 'rejected';

/**
 * One deliberate review of a stored textual alignment candidate version, bound to the exact canonical
 * digest of the candidate that was reviewed.
 *
 * An accepted outcome says a reviewer admits this pairing as a parallel worth carrying in this tenant.
 * It cannot widen what the candidate claims: the interpretation boundary is part of the reviewed bytes,
 * so a candidate that asserted identity, quotation, fulfilment or doctrine would carry a different
 * digest and no decision of this kind would describe it.
 */
export interface TextualAlignmentCandidateReviewDecision {
  readonly kind: 'TextualAlignmentCandidateReviewDecision';
  readonly id: string;
  readonly company_id: string;
  readonly candidate_id: string;
  readonly candidate_digest: string;
  readonly reviewed_version: number;
  readonly outcome: TextualAlignmentCandidateReviewOutcome;
  readonly reviewer_id: string;
  readonly decided_at: string;
  readonly rationale: string;
}

/** The reviewing context a decision must have been minted in to carry authority. */
export interface TextualAlignmentCandidateReviewAuthority {
  readonly company_id: string;
  readonly reviewer_id: string;
}

export interface MintTextualAlignmentCandidateReviewInput extends TextualAlignmentCandidateReviewAuthority {
  readonly id: string;
  readonly candidate_id: string;
  readonly candidate_digest: string;
  readonly reviewed_version: number;
  readonly outcome: TextualAlignmentCandidateReviewOutcome;
  readonly decided_at: string;
  readonly rationale: string;
}

const decisionAuthorities = new WeakMap<
  TextualAlignmentCandidateReviewDecision,
  TextualAlignmentCandidateReviewAuthority
>();

function invalid(message: string): never {
  throw new TypeError(message);
}

/**
 * Only decisions minted by `mintTextualAlignmentCandidateReviewDecision` carry authority, and only inside
 * the company and for the reviewer bound at mint time. A hand-built, cloned or serialized copy is
 * structurally valid and unauthorized.
 */
export function isAttestedTextualAlignmentCandidateReviewDecision(
  decision: TextualAlignmentCandidateReviewDecision,
  authority: TextualAlignmentCandidateReviewAuthority
): boolean {
  const bound = decisionAuthorities.get(decision);
  return (
    bound !== undefined &&
    bound.company_id === authority.company_id &&
    bound.reviewer_id === authority.reviewer_id
  );
}

/**
 * Company-only attestation, for a validator that knows the reviewing tenant but not which actor
 * inside it approved the candidate. Still unforgeable: anything not minted is absent from the brand.
 */
export function isTextualAlignmentCandidateReviewDecisionForCompany(
  decision: TextualAlignmentCandidateReviewDecision,
  companyId: string
): boolean {
  return decisionAuthorities.get(decision)?.company_id === companyId;
}

/**
 * A review describes an admitted candidate only when it is attested for that company, accepted, and
 * bound to the same candidate identity and canonical digest as the document being checked.
 */
export function authorizesTextualAlignmentCandidate(
  decision: TextualAlignmentCandidateReviewDecision | null,
  companyId: string,
  subject: { candidate_id: string; candidate_digest: string }
): boolean {
  if (!decision) return false;
  return (
    isTextualAlignmentCandidateReviewDecisionForCompany(decision, companyId) &&
    decision.outcome === 'accepted' &&
    decision.candidate_id === subject.candidate_id &&
    decision.candidate_digest === subject.candidate_digest
  );
}

/**
 * Mint one review decision after its bounds have been checked against authoritative storage. The
 * caller must supply the digest of the candidate version it actually read, not a caller's assertion.
 */
export function mintTextualAlignmentCandidateReviewDecision(
  input: MintTextualAlignmentCandidateReviewInput
): TextualAlignmentCandidateReviewDecision {
  if (!input.id.trim() || input.id.length > 255) invalid('Review decision id is invalid');
  if (!input.company_id.trim()) invalid('Review decision needs the reviewing company');
  if (!input.reviewer_id.trim()) invalid('Review decision needs the reviewing actor');
  if (!candidateIdPattern.test(input.candidate_id)) {
    invalid('Textual alignment candidate identity is invalid');
  }
  if (!digestPattern.test(input.candidate_digest)) {
    invalid('Review decision must bind a canonical candidate digest');
  }
  if (!Number.isSafeInteger(input.reviewed_version) || input.reviewed_version < 1) {
    invalid('Review decision must name the reviewed candidate version');
  }
  if (input.outcome !== 'accepted' && input.outcome !== 'rejected') {
    invalid('Review outcome must be accepted or rejected');
  }
  const decidedAt = Date.parse(input.decided_at);
  if (!Number.isFinite(decidedAt)) invalid('Review decision needs a valid decision timestamp');
  const rationale = input.rationale.trim();
  if (!rationale || rationale.length > 4000) invalid('Review decision needs a bounded rationale');

  const decision: TextualAlignmentCandidateReviewDecision = Object.freeze({
    kind: 'TextualAlignmentCandidateReviewDecision',
    id: input.id,
    company_id: input.company_id,
    candidate_id: input.candidate_id,
    candidate_digest: input.candidate_digest,
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
