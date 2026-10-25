const digestPattern = /^[a-f0-9]{64}$/;
const profileIdPattern = /^mw:concept-profile:[a-z0-9][a-z0-9._-]{0,179}$/;

export type ConceptProfileReviewOutcome = 'accepted' | 'rejected';

/**
 * One deliberate review of a stored concept profile version, bound to the exact canonical digest of
 * the document its outcome authorizes.
 */
export interface ConceptProfileReviewDecision {
  readonly kind: 'ConceptProfileReviewDecision';
  readonly id: string;
  readonly company_id: string;
  readonly profile_id: string;
  readonly profile_digest: string;
  readonly reviewed_version: number;
  readonly reviewed_digest: string;
  readonly outcome: ConceptProfileReviewOutcome;
  readonly reviewer_id: string;
  readonly decided_at: string;
  readonly rationale: string;
}

/** The reviewing context a decision must have been minted in to carry authority. */
export interface ConceptProfileReviewAuthority {
  readonly company_id: string;
  readonly reviewer_id: string;
}

export interface MintConceptProfileReviewInput extends ConceptProfileReviewAuthority {
  readonly id: string;
  readonly profile_id: string;
  readonly profile_digest: string;
  readonly reviewed_version: number;
  readonly reviewed_digest: string;
  readonly outcome: ConceptProfileReviewOutcome;
  readonly decided_at: string;
  readonly rationale: string;
}

const decisionAuthorities = new WeakMap<
  ConceptProfileReviewDecision,
  ConceptProfileReviewAuthority
>();

function invalid(message: string): never {
  throw new TypeError(message);
}

/**
 * Only decisions minted by `mintConceptProfileReviewDecision` carry authority, and only inside the
 * company and for the reviewer bound at mint time. A hand-built, cloned or serialized copy is
 * structurally valid and unauthorized.
 */
export function isAttestedConceptProfileReviewDecision(
  decision: ConceptProfileReviewDecision,
  authority: ConceptProfileReviewAuthority
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
 * inside it approved the version. Still unforgeable: anything not minted is absent from the brand.
 */
export function isConceptProfileReviewDecisionForCompany(
  decision: ConceptProfileReviewDecision,
  companyId: string
): boolean {
  return decisionAuthorities.get(decision)?.company_id === companyId;
}

/**
 * A review authorizes an interpretation only when it is attested for that company, accepted, and
 * bound to the same profile identity and canonical digest as the document being validated.
 */
export function authorizesConceptProfile(
  decision: ConceptProfileReviewDecision | null,
  companyId: string,
  subject: { profile_id: string; profile_digest: string }
): boolean {
  if (!decision) return false;
  return (
    isConceptProfileReviewDecisionForCompany(decision, companyId) &&
    decision.outcome === 'accepted' &&
    decision.profile_id === subject.profile_id &&
    decision.profile_digest === subject.profile_digest
  );
}

/**
 * Mint one review decision after its bounds have been checked against authoritative storage. The
 * caller must supply the digest of the document version it actually read, not a caller's assertion.
 */
export function mintConceptProfileReviewDecision(
  input: MintConceptProfileReviewInput
): ConceptProfileReviewDecision {
  if (!input.id.trim() || input.id.length > 255) invalid('Review decision id is invalid');
  if (!input.company_id.trim()) invalid('Review decision needs the reviewing company');
  if (!input.reviewer_id.trim()) invalid('Review decision needs the reviewing actor');
  if (!profileIdPattern.test(input.profile_id)) invalid('Concept profile identity is invalid');
  if (!digestPattern.test(input.profile_digest)) {
    invalid('Review decision must bind a canonical profile digest');
  }
  if (!digestPattern.test(input.reviewed_digest)) {
    invalid('Review decision must bind the reviewed version digest');
  }
  if (!Number.isSafeInteger(input.reviewed_version) || input.reviewed_version < 1) {
    invalid('Review decision must name the reviewed profile version');
  }
  if (input.outcome !== 'accepted' && input.outcome !== 'rejected') {
    invalid('Review outcome must be accepted or rejected');
  }
  const decidedAt = Date.parse(input.decided_at);
  if (!Number.isFinite(decidedAt)) invalid('Review decision needs a valid decision timestamp');
  const rationale = input.rationale.trim();
  if (!rationale || rationale.length > 4000) invalid('Review decision needs a bounded rationale');

  const decision: ConceptProfileReviewDecision = Object.freeze({
    kind: 'ConceptProfileReviewDecision',
    id: input.id,
    company_id: input.company_id,
    profile_id: input.profile_id,
    profile_digest: input.profile_digest,
    reviewed_version: input.reviewed_version,
    reviewed_digest: input.reviewed_digest,
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
