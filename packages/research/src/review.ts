import {
  createJsonSchemaValidator,
  type JsonSchemaContract,
  type KnowledgeValidationResult,
} from '@moonwitness/knowledge';
import reviewEventSchema from '../../../ontology/core/research-review-event.schema.json' with { type: 'json' };
import { validateResearchAssertion, type ResearchAssertion } from './assertion.js';
import { validateResearchRelation, type ResearchRelation } from './relation.js';

export type ResearchReviewOutcome = 'accepted' | 'rejected';
export type ResearchReviewActorRole = 'user' | 'superadmin';
export type ResearchReviewSubject = ResearchAssertion | ResearchRelation;
type ResearchReviewVisibility = ResearchAssertion['visibility'] | ResearchRelation['visibility'];

/** Append-only projection of a research review decision bound to one exact subject revision. */
export interface ResearchReviewEvent {
  id: `mw:review-event:${string}`;
  kind: 'ResearchReviewEvent';
  schema_version: 1;
  subject_id: string;
  subject_revision: number;
  research_release_digest: string;
  workflow_instance_id: number;
  workflow_event_sequence: number;
  workflow_revision: number;
  outcome: ResearchReviewOutcome;
  reviewer_id: string;
  requester_id: string;
  reviewer_role: ResearchReviewActorRole;
  evidence_ids: string[];
  visibility: ResearchReviewVisibility;
  idempotency_key: string;
  decided_at: string;
}

export interface AppendResearchReviewInput {
  /** Actor and role must come from authenticated server context, never request-body fields. */
  authenticatedActorId: string;
  authenticatedRole: ResearchReviewActorRole;
  requesterId: string;
  expectedSubjectRevision: number;
  researchReleaseDigest: string;
  workflowInstanceId: number;
  workflowEventSequence: number;
  workflowRevision: number;
  outcome: ResearchReviewOutcome;
  evidenceIds: readonly string[];
  evidenceVisibility: ReadonlyMap<string, ResearchReviewVisibility>;
  idempotencyKey: string;
  now?: Date;
}

export type AppendResearchReviewResult =
  | { status: 'appended'; event: ResearchReviewEvent; history: ResearchReviewEvent[] }
  | { status: 'replayed'; event: ResearchReviewEvent; history: ResearchReviewEvent[] }
  | { status: 'invalid'; issues: Array<{ path: string; code: string; message: string }> };

export type ResearchReviewHistorySummary =
  | { status: 'unreviewed'; events: ResearchReviewEvent[] }
  | { status: 'accepted' | 'rejected'; events: ResearchReviewEvent[] }
  | { status: 'conflicting'; events: ResearchReviewEvent[] };

const validateReviewEventSchema = createJsonSchemaValidator(
  reviewEventSchema as unknown as JsonSchemaContract,
  'does not match the immutable research review event contract'
);

export function validateResearchReviewEvent(value: unknown): KnowledgeValidationResult {
  const result = validateReviewEventSchema(value);
  if (!result.valid) return result;
  const event = value as ResearchReviewEvent;
  if (event.reviewer_id === event.requester_id) {
    return {
      valid: false,
      issues: [
        {
          path: '/reviewer_id',
          keyword: 'reviewer_separation',
          message: 'requester cannot review their own research record',
        },
      ],
    };
  }
  return result;
}

function subjectValid(subject: ResearchReviewSubject): boolean {
  return subject.kind === 'Assertion'
    ? validateResearchAssertion(subject).valid
    : validateResearchRelation(subject).valid;
}

function replayMatches(
  event: ResearchReviewEvent,
  subjectId: string,
  input: AppendResearchReviewInput
): boolean {
  return (
    event.subject_id === subjectId &&
    event.reviewer_id === input.authenticatedActorId &&
    event.requester_id === input.requesterId &&
    event.reviewer_role === input.authenticatedRole &&
    event.subject_revision === input.expectedSubjectRevision &&
    event.research_release_digest === input.researchReleaseDigest &&
    event.workflow_instance_id === input.workflowInstanceId &&
    event.workflow_event_sequence === input.workflowEventSequence &&
    event.workflow_revision === input.workflowRevision &&
    event.outcome === input.outcome &&
    event.evidence_ids.length === input.evidenceIds.length &&
    event.evidence_ids.every((id, index) => id === input.evidenceIds[index])
  );
}

const visibilityOrder: Record<ResearchReviewVisibility, number> = {
  PUBLIC_APPROVED: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
  CHILD_SENSITIVE: 4,
};

function mostRestrictiveVisibility(
  left: ResearchReviewVisibility,
  right: ResearchReviewVisibility
): ResearchReviewVisibility {
  return visibilityOrder[left] >= visibilityOrder[right] ? left : right;
}

/**
 * Validate a server-authorized workflow result and append its immutable research event.
 * The caller persists the returned history atomically with the ORM workflow transaction.
 */
export function appendResearchReviewEvent(
  subject: ResearchReviewSubject,
  history: readonly ResearchReviewEvent[],
  input: AppendResearchReviewInput
): AppendResearchReviewResult {
  const invalid = (path: string, code: string, message: string): AppendResearchReviewResult => ({
    status: 'invalid',
    issues: [{ path, code, message }],
  });
  if (!subject || (subject.kind !== 'Assertion' && subject.kind !== 'ResearchRelation')) {
    return invalid('/subject', 'subject_kind', 'review subject must be an assertion or relation');
  }
  if (!subjectValid(subject)) {
    return invalid('/subject', 'subject_invalid', 'review subject does not satisfy its schema');
  }
  if (!Number.isSafeInteger(input.expectedSubjectRevision) || input.expectedSubjectRevision < 1) {
    return invalid(
      '/expectedSubjectRevision',
      'subject_revision',
      'subject revision must be a positive integer'
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(input.researchReleaseDigest)) {
    return invalid(
      '/researchReleaseDigest',
      'release_digest',
      'review must reference an immutable research release'
    );
  }
  if (
    !Number.isSafeInteger(input.workflowInstanceId) ||
    input.workflowInstanceId < 1 ||
    !Number.isSafeInteger(input.workflowEventSequence) ||
    input.workflowEventSequence < 1 ||
    !Number.isSafeInteger(input.workflowRevision) ||
    input.workflowRevision < 1
  ) {
    return invalid(
      '/workflowInstanceId',
      'workflow_event',
      'review must reference a committed workflow event'
    );
  }
  if (
    !input.authenticatedActorId ||
    !input.requesterId ||
    input.authenticatedActorId === input.requesterId
  ) {
    return invalid(
      '/authenticatedActorId',
      'reviewer_separation',
      'requester cannot review their own research record'
    );
  }
  if (input.authenticatedRole !== 'user' && input.authenticatedRole !== 'superadmin') {
    return invalid(
      '/authenticatedRole',
      'review_role',
      'role is not authorized for research review'
    );
  }
  if (input.outcome !== 'accepted' && input.outcome !== 'rejected') {
    return invalid('/outcome', 'review_outcome', 'review outcome must be accepted or rejected');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(input.idempotencyKey)) {
    return invalid('/idempotencyKey', 'idempotency_key', 'valid idempotency key is required');
  }
  const subjectHistory = history.filter((event) => event.subject_id === subject.id);
  const keyedReplay = history.find((event) => event.idempotency_key === input.idempotencyKey);
  if (keyedReplay) {
    return replayMatches(keyedReplay, subject.id, input)
      ? { status: 'replayed', event: keyedReplay, history: [...history] }
      : invalid(
          '/idempotencyKey',
          'idempotency_conflict',
          'idempotency key is bound to another review event'
        );
  }
  if (input.expectedSubjectRevision !== subject.content_revision) {
    return invalid(
      '/expectedSubjectRevision',
      'stale_subject',
      'review targets a stale subject revision'
    );
  }
  if (subjectHistory.some((event) => event.workflow_instance_id === input.workflowInstanceId)) {
    return invalid(
      '/workflowInstanceId',
      'duplicate_workflow_event',
      'workflow instance already recorded a review event'
    );
  }
  if (
    history.some(
      (event) =>
        event.workflow_instance_id === input.workflowInstanceId &&
        event.workflow_event_sequence === input.workflowEventSequence
    )
  ) {
    return invalid(
      '/workflowEventSequence',
      'duplicate_workflow_event',
      'workflow event sequence is already recorded'
    );
  }
  if (!input.evidenceIds.length || new Set(input.evidenceIds).size !== input.evidenceIds.length) {
    return invalid('/evidenceIds', 'review_evidence', 'review requires unique evidence references');
  }
  let eventVisibility: ResearchReviewVisibility = subject.visibility;
  for (const id of input.evidenceIds) {
    const visibility = input.evidenceVisibility.get(id);
    if (visibility === undefined) {
      return invalid(
        '/evidenceIds',
        'evidence_unavailable',
        'review evidence must resolve to an authorized record'
      );
    }
    eventVisibility = mostRestrictiveVisibility(eventVisibility, visibility);
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime()))
    return invalid('/now', 'timestamp', 'review timestamp must be valid');
  const event: ResearchReviewEvent = {
    id: `mw:review-event:${input.workflowInstanceId}-${input.workflowEventSequence}`,
    kind: 'ResearchReviewEvent',
    schema_version: 1,
    subject_id: subject.id,
    subject_revision: subject.content_revision,
    research_release_digest: input.researchReleaseDigest,
    workflow_instance_id: input.workflowInstanceId,
    workflow_event_sequence: input.workflowEventSequence,
    workflow_revision: input.workflowRevision,
    outcome: input.outcome,
    reviewer_id: input.authenticatedActorId,
    requester_id: input.requesterId,
    reviewer_role: input.authenticatedRole,
    evidence_ids: [...input.evidenceIds],
    visibility: eventVisibility,
    idempotency_key: input.idempotencyKey,
    decided_at: now.toISOString(),
  };
  const eventValidation = validateResearchReviewEvent(event);
  if (!eventValidation.valid) {
    return {
      status: 'invalid',
      issues: eventValidation.issues.map(({ path, keyword, message }) => ({
        path,
        code: keyword,
        message,
      })),
    };
  }
  return { status: 'appended', event, history: [...history, event] };
}

/** Preserve all event history and make contradictory decisions explicit. */
export function summarizeResearchReviewHistory(
  subjectId: string,
  subjectRevision: number,
  history: readonly ResearchReviewEvent[]
): ResearchReviewHistorySummary {
  const events = history.filter(
    (event) => event.subject_id === subjectId && event.subject_revision === subjectRevision
  );
  const outcomes = new Set(events.map((event) => event.outcome));
  if (outcomes.size > 1) return { status: 'conflicting', events: [...events] };
  if (outcomes.has('accepted')) return { status: 'accepted', events: [...events] };
  if (outcomes.has('rejected')) return { status: 'rejected', events: [...events] };
  return { status: 'unreviewed', events: [] };
}
