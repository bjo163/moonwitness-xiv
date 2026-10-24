import { describe, expect, it } from 'vitest';
import {
  createPrivacyRevocationPlan,
  decidePrivacyRetention,
  decideSensitiveRecordAccess,
  excludeRevokedDerivedRecords,
  type SensitiveRecordAccessRequest,
} from '../src/privacy-lifecycle.js';

const baseAccess = {
  authenticated: true,
  actorTenantRef: 'synthetic-tenant-a',
  recordTenantRef: 'synthetic-tenant-a',
  classification: 'RESTRICTED',
  consentState: 'granted',
  approvedPurposes: ['synthetic-review'],
  requestedPurpose: 'synthetic-review',
  use: 'read',
  explicitlyAuthorized: true,
} satisfies SensitiveRecordAccessRequest;

describe('privacy lifecycle controls', () => {
  it('fails closed for absent classifications, consent, tenant scope, and explicit grants', () => {
    expect(decideSensitiveRecordAccess({ ...baseAccess, classification: null })).toMatchObject({
      allowed: false,
      reason: 'missing_classification',
    });
    expect(
      decideSensitiveRecordAccess({
        ...baseAccess,
        classification: 'UNKNOWN' as SensitiveRecordAccessRequest['classification'],
      })
    ).toMatchObject({ allowed: false, reason: 'invalid_classification' });
    expect(
      decideSensitiveRecordAccess({
        ...baseAccess,
        use: 'unspecified' as SensitiveRecordAccessRequest['use'],
      })
    ).toMatchObject({ allowed: false, reason: 'invalid_use' });
    for (const consentState of [null, 'denied', 'withdrawn'] as const) {
      expect(decideSensitiveRecordAccess({ ...baseAccess, consentState })).toMatchObject({
        allowed: false,
        reason: 'consent_not_granted',
      });
    }
    expect(
      decideSensitiveRecordAccess({ ...baseAccess, actorTenantRef: 'synthetic-tenant-b' })
    ).toMatchObject({ allowed: false, reason: 'tenant_scope_mismatch' });
    expect(
      decideSensitiveRecordAccess({ ...baseAccess, explicitlyAuthorized: false })
    ).toMatchObject({ allowed: false, reason: 'explicit_grant_required' });
  });

  it('denies child-sensitive search, model, analytics, export, and publication uses', () => {
    for (const use of [
      'general_search',
      'model_input',
      'analytics',
      'export',
      'public_projection',
    ] as const) {
      expect(
        decideSensitiveRecordAccess({ ...baseAccess, classification: 'CHILD_SENSITIVE', use })
      ).toMatchObject({ allowed: false, reason: 'child_sensitive_use_denied' });
    }
    expect(
      decideSensitiveRecordAccess({ ...baseAccess, classification: 'CHILD_SENSITIVE' })
    ).toEqual({ allowed: true });
  });

  it('requires a minimized, revision-bound publication approval from another reviewer', () => {
    const publication = {
      reviewerRef: 'synthetic-reviewer',
      requesterRef: 'synthetic-author',
      sourceRevisionSha256: 'a'.repeat(64),
      projectionRevisionSha256: 'b'.repeat(64),
      minimized: true,
    };
    const request = {
      ...baseAccess,
      use: 'public_projection',
      sourceRevisionSha256: publication.sourceRevisionSha256,
      projectionRevisionSha256: publication.projectionRevisionSha256,
      publicationApproval: publication,
    } satisfies SensitiveRecordAccessRequest;

    expect(decideSensitiveRecordAccess(request)).toEqual({ allowed: true });
    expect(
      decideSensitiveRecordAccess({
        ...request,
        publicationApproval: { ...publication, reviewerRef: publication.requesterRef },
      })
    ).toMatchObject({ allowed: false, reason: 'publication_review_required' });
    expect(
      decideSensitiveRecordAccess({
        ...request,
        publicationApproval: { ...publication, minimized: false },
      })
    ).toMatchObject({ allowed: false, reason: 'publication_review_required' });
    expect(
      decideSensitiveRecordAccess({ ...request, sourceRevisionSha256: 'c'.repeat(64) })
    ).toMatchObject({ allowed: false, reason: 'publication_review_required' });
  });

  it('requires an explicit owner-approved retention expiry and fails closed when expired', () => {
    expect(decidePrivacyRetention(null)).toEqual({ status: 'denied', reason: 'missing_policy' });
    const policy = {
      expiresAt: '2026-10-17T00:00:00.000Z',
      approvedByRef: 'synthetic-data-owner',
      decisionRef: 'synthetic-retention-decision',
    };
    expect(decidePrivacyRetention(policy, new Date('2026-10-16T00:00:00.000Z'))).toEqual({
      status: 'active',
      expiresAt: policy.expiresAt,
    });
    expect(decidePrivacyRetention(policy, new Date('2026-10-18T00:00:00.000Z'))).toEqual({
      status: 'expired',
      expiresAt: policy.expiresAt,
    });
    expect(decidePrivacyRetention({ ...policy, expiresAt: 'not-a-date' }, new Date())).toEqual({
      status: 'denied',
      reason: 'invalid_policy',
    });
  });

  it('filters revoked subjects from derived records and emits only sanitized audit references', () => {
    const canary = 'MW-SYNTHETIC-PRIVATE-DO-NOT-EXPOSE';
    const records = [
      { subjectRef: 'synthetic-subject-a', text: canary, surface: 'search' },
      { subjectRef: 'synthetic-subject-b', text: 'public synthetic text', surface: 'search' },
    ];
    const remaining = excludeRevokedDerivedRecords(records, new Set(['synthetic-subject-a']));
    const plan = createPrivacyRevocationPlan({
      subjectRef: 'synthetic-subject-a',
      consentDecisionRef: 'synthetic-consent-decision',
      decidedAt: '2026-10-16T10:00:00.000Z',
      derivedArtifacts: [
        { artifactRef: 'synthetic-search-index-entry', kind: 'search_index' },
        { artifactRef: 'synthetic-public-preview', kind: 'preview' },
      ],
    });

    expect(remaining).toEqual([records[1]]);
    expect(plan.derivedArtifacts).toHaveLength(2);
    expect(plan.audit.contentIncluded).toBe(false);
    expect(JSON.stringify({ remaining, plan })).not.toContain(canary);
    expect(JSON.stringify(plan)).not.toContain('synthetic-subject-a');
    expect(JSON.stringify(plan)).not.toContain('synthetic-consent-decision');
  });
});
