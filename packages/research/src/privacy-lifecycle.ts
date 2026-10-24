import { createHash } from 'node:crypto';
import type { ResearchVisibility } from './relation.js';

export type PrivacyUse =
  'read' | 'general_search' | 'export' | 'public_projection' | 'model_input' | 'analytics';

export type PrivacyConsentState = 'granted' | 'denied' | 'withdrawn';

export interface PublicationApproval {
  reviewerRef: string;
  requesterRef: string;
  sourceRevisionSha256: string;
  projectionRevisionSha256: string;
  minimized: boolean;
}

export interface SensitiveRecordAccessRequest {
  authenticated: boolean;
  actorTenantRef: string | null;
  recordTenantRef: string | null;
  classification: ResearchVisibility | null;
  consentState: PrivacyConsentState | null;
  approvedPurposes: readonly string[];
  requestedPurpose: string;
  use: PrivacyUse;
  explicitlyAuthorized: boolean;
  sourceRevisionSha256?: string;
  projectionRevisionSha256?: string;
  publicationApproval?: PublicationApproval;
}

export type SensitiveRecordAccessDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'unauthenticated'
        | 'invalid_use'
        | 'missing_classification'
        | 'invalid_classification'
        | 'consent_not_granted'
        | 'tenant_scope_mismatch'
        | 'purpose_not_approved'
        | 'explicit_grant_required'
        | 'child_sensitive_use_denied'
        | 'publication_review_required';
    };

const visibilityValues: readonly ResearchVisibility[] = [
  'PUBLIC_APPROVED',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
  'CHILD_SENSITIVE',
];
const privacyUses: readonly PrivacyUse[] = [
  'read',
  'general_search',
  'export',
  'public_projection',
  'model_input',
  'analytics',
];

/** Decide access for sensitive records using trusted server-side auth context. */
export function decideSensitiveRecordAccess(
  request: SensitiveRecordAccessRequest
): SensitiveRecordAccessDecision {
  if (request.authenticated !== true) return { allowed: false, reason: 'unauthenticated' };
  if (!privacyUses.includes(request.use)) return { allowed: false, reason: 'invalid_use' };
  if (request.classification === null) {
    return { allowed: false, reason: 'missing_classification' };
  }
  if (!visibilityValues.includes(request.classification)) {
    return { allowed: false, reason: 'invalid_classification' };
  }
  if (request.consentState !== 'granted') {
    return { allowed: false, reason: 'consent_not_granted' };
  }

  if (
    request.classification !== 'PUBLIC_APPROVED' &&
    (!request.actorTenantRef ||
      !request.recordTenantRef ||
      request.actorTenantRef !== request.recordTenantRef)
  ) {
    return { allowed: false, reason: 'tenant_scope_mismatch' };
  }
  if (
    typeof request.requestedPurpose !== 'string' ||
    !request.requestedPurpose ||
    !Array.isArray(request.approvedPurposes) ||
    !request.approvedPurposes.includes(request.requestedPurpose)
  ) {
    return { allowed: false, reason: 'purpose_not_approved' };
  }
  if (request.classification === 'CHILD_SENSITIVE' && request.use !== 'read') {
    return { allowed: false, reason: 'child_sensitive_use_denied' };
  }
  if (request.classification !== 'PUBLIC_APPROVED' && request.explicitlyAuthorized !== true) {
    return { allowed: false, reason: 'explicit_grant_required' };
  }
  if (request.use === 'public_projection') {
    const approval = request.publicationApproval;
    if (
      request.classification === 'CHILD_SENSITIVE' ||
      !approval?.minimized ||
      typeof approval.reviewerRef !== 'string' ||
      !approval.reviewerRef ||
      typeof approval.requesterRef !== 'string' ||
      !approval.requesterRef ||
      approval.reviewerRef === approval.requesterRef ||
      typeof approval.sourceRevisionSha256 !== 'string' ||
      typeof approval.projectionRevisionSha256 !== 'string' ||
      approval.sourceRevisionSha256 !== request.sourceRevisionSha256 ||
      approval.projectionRevisionSha256 !== request.projectionRevisionSha256 ||
      !/^[a-f0-9]{64}$/u.test(approval.sourceRevisionSha256) ||
      !/^[a-f0-9]{64}$/u.test(approval.projectionRevisionSha256)
    ) {
      return { allowed: false, reason: 'publication_review_required' };
    }
  }
  return { allowed: true };
}

export interface PrivacyRetentionPolicy {
  expiresAt: string;
  approvedByRef: string;
  decisionRef: string;
}

export type PrivacyRetentionDecision =
  | { status: 'active'; expiresAt: string }
  | { status: 'expired'; expiresAt: string }
  | { status: 'denied'; reason: 'missing_policy' | 'invalid_policy' };

/** Retention is never inferred; an owner-approved absolute expiry is required. */
export function decidePrivacyRetention(
  policy: PrivacyRetentionPolicy | null,
  now: Date = new Date()
): PrivacyRetentionDecision {
  if (policy === null) return { status: 'denied', reason: 'missing_policy' };
  if (
    typeof policy.expiresAt !== 'string' ||
    typeof policy.approvedByRef !== 'string' ||
    typeof policy.decisionRef !== 'string' ||
    Number.isNaN(now.getTime())
  ) {
    return { status: 'denied', reason: 'invalid_policy' };
  }
  const expiresAt = new Date(policy.expiresAt);
  if (
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt.toISOString() !== policy.expiresAt ||
    !policy.approvedByRef.trim() ||
    !policy.decisionRef.trim()
  ) {
    return { status: 'denied', reason: 'invalid_policy' };
  }
  return expiresAt.getTime() <= now.getTime()
    ? { status: 'expired', expiresAt: policy.expiresAt }
    : { status: 'active', expiresAt: policy.expiresAt };
}

export type RevocableArtifactKind =
  | 'operational_view'
  | 'search_index'
  | 'embedding'
  | 'attachment'
  | 'replica'
  | 'cache'
  | 'preview'
  | 'export'
  | 'public_release'
  | 'publication_projection';

const revocableArtifactKinds: readonly RevocableArtifactKind[] = [
  'operational_view',
  'search_index',
  'embedding',
  'attachment',
  'replica',
  'cache',
  'preview',
  'export',
  'public_release',
  'publication_projection',
];

export interface RevocableArtifactReference {
  artifactRef: string;
  kind: RevocableArtifactKind;
}

export interface PrivacyRevocationPlan {
  format: 'moonwitness-privacy-revocation-plan/v1';
  decision: 'withdrawn';
  decidedAt: string;
  subjectRefSha256: string;
  consentDecisionRefSha256: string;
  derivedArtifacts: Array<{
    artifactRefSha256: string;
    kind: RevocableArtifactKind;
    action: 'invalidate_or_rebuild';
  }>;
  audit: {
    action: 'block_access_and_invalidate_derivatives';
    contentIncluded: false;
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Build a sanitized revocation plan; persistence adapters must apply every invalidation. */
export function createPrivacyRevocationPlan(input: {
  subjectRef: string;
  consentDecisionRef: string;
  decidedAt: string;
  derivedArtifacts: readonly RevocableArtifactReference[];
}): PrivacyRevocationPlan {
  if (typeof input.decidedAt !== 'string') {
    throw new TypeError(
      'A valid subject, consent decision, and canonical UTC timestamp are required'
    );
  }
  const date = new Date(input.decidedAt);
  if (
    typeof input.subjectRef !== 'string' ||
    !input.subjectRef.trim() ||
    typeof input.consentDecisionRef !== 'string' ||
    !input.consentDecisionRef.trim() ||
    Number.isNaN(date.getTime()) ||
    date.toISOString() !== input.decidedAt ||
    !Array.isArray(input.derivedArtifacts) ||
    input.derivedArtifacts.some(
      (artifact) =>
        !artifact ||
        typeof artifact !== 'object' ||
        typeof artifact.artifactRef !== 'string' ||
        !artifact.artifactRef.trim() ||
        !revocableArtifactKinds.includes(artifact.kind)
    )
  ) {
    throw new TypeError(
      'A valid subject, consent decision, and canonical UTC timestamp are required'
    );
  }
  return {
    format: 'moonwitness-privacy-revocation-plan/v1',
    decision: 'withdrawn',
    decidedAt: input.decidedAt,
    subjectRefSha256: sha256(input.subjectRef),
    consentDecisionRefSha256: sha256(input.consentDecisionRef),
    derivedArtifacts: input.derivedArtifacts.map((artifact) => ({
      artifactRefSha256: sha256(artifact.artifactRef),
      kind: artifact.kind,
      action: 'invalidate_or_rebuild',
    })),
    audit: {
      action: 'block_access_and_invalidate_derivatives',
      contentIncluded: false,
    },
  };
}

/** Remove withdrawn subjects from derived views, search results, and candidate projections. */
export function excludeRevokedDerivedRecords<T extends { subjectRef: string }>(
  records: readonly T[],
  revokedSubjectRefs: ReadonlySet<string>
): T[] {
  return records.filter((record) => !revokedSubjectRefs.has(record.subjectRef));
}
