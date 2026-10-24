import { createHash } from 'node:crypto';
import {
  createJsonSchemaValidator,
  type JsonSchemaContract,
  type KnowledgeValidationResult,
} from '@moonwitness/knowledge';
import conceptProfileSchema from '../../../ontology/domains/concept-profile.schema.json' with { type: 'json' };
import { validateResearchEvidenceReference, type ResearchEvidenceReference } from './evidence.js';

export type ConceptProfileReviewStatus = 'accepted' | 'rejected' | 'unreviewed' | 'conflicting';
export type ConceptProfileEvidenceAccess = 'readable' | 'denied';

/**
 * Trusted server-side resolver boundary. Implementations must read the canonical
 * evidence record, its current review consensus, and authorization state from
 * authoritative local stores. Never construct this result from request fields.
 */
export interface TrustedConceptEvidenceResolution {
  canonicalEvidence: ResearchEvidenceReference;
  reviewStatus: ConceptProfileReviewStatus;
  access: ConceptProfileEvidenceAccess;
}

export type TrustedConceptEvidenceResolver = (evidenceId: string) => Promise<unknown>;

export interface CanonicalConceptPassage {
  source_id: string;
  edition_id: string;
  locator: string;
  content_sha256: string;
  text: string;
  access: ConceptProfileEvidenceAccess;
}

/** The resolver must load locally and validate the rights manifest/source artifact before returning. */
export type TrustedConceptPassageResolver = (
  sourceId: string,
  editionId: string,
  locator: string
) => Promise<unknown>;

export interface ConceptProfileValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type ConceptProfileValidationResult =
  { valid: true; issues: [] } | { valid: false; issues: ConceptProfileValidationIssue[] };

const validateSchema = createJsonSchemaValidator(
  conceptProfileSchema as unknown as JsonSchemaContract,
  'does not match the scoped concept profile schema'
);

/** Structural schema validation without evidence resolution or trust claims. */
export function validateConceptProfile(value: unknown): KnowledgeValidationResult {
  return validateSchema(value);
}

/**
 * Validate a profile document and verify evidence for every accepted
 * interpretation. This cannot approve the profile interpretation itself:
 * without a separate decision bound to the exact profile digest, accepted
 * interpretations remain pending even when their Assertion evidence is accepted.
 * Resolver exceptions and incomplete/contradictory review or access states fail closed.
 */
export async function validateConceptProfileWithEvidence(
  value: unknown,
  resolveTrustedEvidence: TrustedConceptEvidenceResolver
): Promise<ConceptProfileValidationResult> {
  const structural = validateSchema(value);
  if (!structural.valid) {
    return {
      valid: false,
      issues: structural.issues.map(({ path, keyword, message }) => ({
        path,
        code: keyword,
        message,
      })),
    };
  }

  // Clone and fingerprint the complete schema-valid JSON input before any
  // resolver can yield control and mutate caller-owned objects.
  let snapshotJson: string;
  let snapshot: unknown;
  try {
    snapshotJson = stableJson(value);
    snapshot = JSON.parse(snapshotJson) as unknown;
  } catch {
    return {
      valid: false,
      issues: [
        {
          path: '',
          code: 'input_snapshot_failed',
          message: 'profile input could not be safely snapshotted',
        },
      ],
    };
  }
  const document = snapshot as {
    profiles: Array<{
      interpretations: Array<{
        status: string;
        evidence_ids: string[];
      }>;
    }>;
  };
  // Snapshot all evidence targets before the first resolver await.
  const targets = document.profiles.flatMap((profile, profileIndex) =>
    profile.interpretations.flatMap((interpretation, interpretationIndex) =>
      interpretation.status === 'accepted'
        ? interpretation.evidence_ids.map((evidenceId, evidenceIndex) => ({
            evidenceId,
            path: `/profiles/${profileIndex}/interpretations/${interpretationIndex}/evidence_ids/${evidenceIndex}`,
          }))
        : []
    )
  );
  const pendingProfileReviews = document.profiles.flatMap((profile, profileIndex) =>
    profile.interpretations.flatMap((interpretation, interpretationIndex) =>
      interpretation.status === 'accepted'
        ? [
            {
              path: `/profiles/${profileIndex}/interpretations/${interpretationIndex}/status`,
            },
          ]
        : []
    )
  );
  const issues: ConceptProfileValidationIssue[] = [];
  for (const { evidenceId, path } of targets) {
    let rawResolution: unknown;
    try {
      rawResolution = await resolveTrustedEvidence(evidenceId);
    } catch {
      issues.push({
        path,
        code: 'resolver_failure',
        message: 'trusted evidence resolver failed',
      });
      continue;
    }
    if (rawResolution === null) {
      issues.push({
        path,
        code: 'evidence_missing',
        message: 'canonical evidence record did not resolve',
      });
      continue;
    }
    if (!isRecord(rawResolution) || !('canonicalEvidence' in rawResolution)) {
      issues.push({
        path,
        code: 'resolver_output_invalid',
        message: 'trusted evidence resolver returned a malformed result',
      });
      continue;
    }
    const rawEvidence = rawResolution.canonicalEvidence;
    if (
      !isRecord(rawEvidence) ||
      !validateResearchEvidenceReference(rawEvidence).valid ||
      rawEvidence.id !== evidenceId
    ) {
      issues.push({
        path,
        code: 'evidence_mismatch',
        message: 'resolved canonical evidence metadata is invalid or has a different identity',
      });
      continue;
    }
    if (
      rawResolution.reviewStatus !== 'accepted' &&
      rawResolution.reviewStatus !== 'rejected' &&
      rawResolution.reviewStatus !== 'unreviewed' &&
      rawResolution.reviewStatus !== 'conflicting'
    ) {
      issues.push({
        path,
        code: 'resolver_output_invalid',
        message: 'trusted evidence resolver returned an invalid review status',
      });
      continue;
    }
    if (rawResolution.access !== 'readable' && rawResolution.access !== 'denied') {
      issues.push({
        path,
        code: 'resolver_output_invalid',
        message: 'trusted evidence resolver returned an invalid access status',
      });
      continue;
    }
    const resolution = rawResolution as unknown as TrustedConceptEvidenceResolution;
    if (resolution.reviewStatus === 'conflicting') {
      issues.push({
        path,
        code: 'review_conflicting',
        message: 'canonical evidence has contradictory review decisions',
      });
      continue;
    }
    if (resolution.reviewStatus !== 'accepted') {
      issues.push({
        path,
        code: 'review_not_accepted',
        message: 'canonical evidence does not have accepted review status',
      });
      continue;
    }
    if (resolution.access !== 'readable') {
      issues.push({
        path,
        code: 'access_denied',
        message: 'canonical evidence is not readable in this authorization context',
      });
    }
  }
  try {
    if (stableJson(value) !== snapshotJson) {
      return {
        valid: false,
        issues: [
          {
            path: '',
            code: 'input_changed',
            message: 'profile input changed while evidence validation was in progress',
          },
        ],
      };
    }
  } catch {
    return {
      valid: false,
      issues: [
        {
          path: '',
          code: 'input_changed',
          message: 'profile input changed while evidence validation was in progress',
        },
      ],
    };
  }
  issues.push(
    ...pendingProfileReviews.map(({ path }) => ({
      path,
      code: 'profile_review_pending',
      message:
        'accepted profile interpretations require a separate decision bound to the exact profile digest',
    }))
  );
  return issues.length ? { valid: false, issues } : { valid: true, issues: [] };
}

/**
 * Verify source-span observations against a trusted, local canonical passage
 * resolver. This verifies only exact source identity, bytes, and offsets; it
 * does not interpret the selected text or make a theological claim.
 */
export async function validateConceptProfileTextualObservations(
  value: unknown,
  resolveCanonicalPassage: TrustedConceptPassageResolver
): Promise<ConceptProfileValidationResult> {
  const structural = validateSchema(value);
  if (!structural.valid) {
    return {
      valid: false,
      issues: structural.issues.map(({ path, keyword, message }) => ({
        path,
        code: keyword,
        message,
      })),
    };
  }

  let snapshotJson: string;
  let snapshot: unknown;
  try {
    snapshotJson = stableJson(value);
    snapshot = JSON.parse(snapshotJson) as unknown;
  } catch {
    return {
      valid: false,
      issues: [
        {
          path: '',
          code: 'input_snapshot_failed',
          message: 'profile input could not be safely snapshotted',
        },
      ],
    };
  }

  const document = snapshot as {
    profiles: Array<{
      textual_observations?: Array<{
        id: string;
        source_id: string;
        edition_id: string;
        locator: string;
        content_sha256: string;
        range: { unit: 'unicode_scalar'; start: number; end: number };
        selected_text_sha256: string;
      }>;
    }>;
  };
  const targets = document.profiles.flatMap((profile, profileIndex) =>
    (profile.textual_observations ?? []).map((observation, observationIndex) => ({
      observation,
      path: `/profiles/${profileIndex}/textual_observations/${observationIndex}`,
    }))
  );
  const issues: ConceptProfileValidationIssue[] = [];
  const seenObservationIds = new Set<string>();
  for (const { observation, path } of targets) {
    if (seenObservationIds.has(observation.id)) {
      issues.push({
        path,
        code: 'duplicate_observation_id',
        message: 'text observation identity is duplicated',
      });
      continue;
    }
    seenObservationIds.add(observation.id);
    let rawPassage: unknown;
    try {
      rawPassage = await resolveCanonicalPassage(
        observation.source_id,
        observation.edition_id,
        observation.locator
      );
    } catch {
      issues.push({ path, code: 'resolver_failure', message: 'trusted passage resolver failed' });
      continue;
    }
    if (rawPassage === null) {
      issues.push({
        path,
        code: 'passage_missing',
        message: 'canonical source passage did not resolve',
      });
      continue;
    }
    if (
      !isRecord(rawPassage) ||
      typeof rawPassage.source_id !== 'string' ||
      typeof rawPassage.edition_id !== 'string' ||
      typeof rawPassage.locator !== 'string' ||
      typeof rawPassage.content_sha256 !== 'string' ||
      typeof rawPassage.text !== 'string' ||
      (rawPassage.access !== 'readable' && rawPassage.access !== 'denied')
    ) {
      issues.push({
        path,
        code: 'resolver_output_invalid',
        message: 'trusted passage resolver returned malformed metadata',
      });
      continue;
    }
    if (
      rawPassage.source_id !== observation.source_id ||
      rawPassage.edition_id !== observation.edition_id ||
      rawPassage.locator !== observation.locator
    ) {
      issues.push({
        path,
        code: 'passage_mismatch',
        message: 'resolved canonical passage identity does not match',
      });
      continue;
    }
    if (rawPassage.access !== 'readable') {
      issues.push({
        path,
        code: 'access_denied',
        message: 'canonical source passage is not readable',
      });
      continue;
    }
    if (rawPassage.content_sha256 !== observation.content_sha256) {
      issues.push({
        path,
        code: 'content_hash_mismatch',
        message: 'canonical passage bytes do not match the observation',
      });
      continue;
    }
    const encodedPassage = Buffer.from(rawPassage.text, 'utf8');
    try {
      if (new TextDecoder('utf-8', { fatal: true }).decode(encodedPassage) !== rawPassage.text) {
        issues.push({
          path,
          code: 'passage_text_invalid',
          message: 'canonical passage text is not a valid UTF-8 round trip',
        });
        continue;
      }
    } catch {
      issues.push({
        path,
        code: 'passage_text_invalid',
        message: 'canonical passage text is not valid UTF-8',
      });
      continue;
    }
    const scalars = Array.from(rawPassage.text);
    const { start, end } = observation.range;
    if (start >= end || end > scalars.length) {
      issues.push({
        path,
        code: 'range_invalid',
        message: 'text observation range is outside the source passage',
      });
      continue;
    }
    const selectedHash = createHash('sha256')
      .update(scalars.slice(start, end).join(''), 'utf8')
      .digest('hex');
    if (selectedHash !== observation.selected_text_sha256) {
      issues.push({
        path,
        code: 'selected_text_hash_mismatch',
        message: 'selected source span does not match its digest',
      });
    }
  }

  try {
    if (stableJson(value) !== snapshotJson) {
      return {
        valid: false,
        issues: [
          {
            path: '',
            code: 'input_changed',
            message: 'profile input changed while passage validation was in progress',
          },
        ],
      };
    }
  } catch {
    return {
      valid: false,
      issues: [
        {
          path: '',
          code: 'input_changed',
          message: 'profile input changed while passage validation was in progress',
        },
      ],
    };
  }
  return issues.length ? { valid: false, issues } : { valid: true, issues: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('value is not JSON serializable');
  return serialized;
}
