import { createHash } from 'node:crypto';
import { readQuranPassageSnapshot, readTextualWitnessPassage } from '@moonwitness/corpus';
import {
  appendResearchReviewEvent,
  resolveResearchEvidenceReference,
  validateResearchReviewEvent,
  summarizeResearchReviewHistory,
  type ResearchEvidenceReference,
  type ResearchReviewEvent,
  type TrustedConceptEvidenceResolution,
  type ResearchReviewSubject,
  type ResearchVisibility,
  type ResolvablePassage,
} from '@moonwitness/research';
import {
  transitionWorkflow,
  WorkflowError,
  type TransitionWorkflowInput,
  type WorkflowEventPayload,
  type WorkflowRole,
} from '@moonwitness/orm-workflow';
import type { Knex } from 'knex';
import { canonicalResearchJson, readResearchGraphRelease } from './research-release.js';
import {
  assertObject,
  canonicalId,
  getVisibility,
  reviewVisibility,
  validateResearchRelease,
  visibilityOrder,
} from './research-release-validation.js';

export { validateResearchRelease } from './research-release-validation.js';

const corpusKey = 'research';
const graphRecordModel = 'knowledge.research_graph_record';
const userCanonicalIdPattern = /^mw:user:[a-z0-9][a-z0-9._-]{0,179}$/u;
export interface AuthenticatedResearchReviewer {
  /** Values populated by server authentication and authorization middleware. */
  readonly userId: number;
  readonly companyId: number;
  readonly role: 'user' | 'superadmin';
}

export interface TransitionResearchReviewInput {
  readonly instanceId: number;
  readonly authenticatedReviewer: AuthenticatedResearchReviewer;
  readonly action: 'approve' | 'reject';
  readonly expectedWorkflowRevision: number;
  readonly subjectId: string;
  readonly expectedSubjectRevision: number;
  readonly evidenceIds: readonly string[];
  readonly idempotencyKey: string;
  /** Trusted local root for pinned corpus bytes; no network access is performed. */
  readonly corpusRootDirectory: string;
  readonly now?: Date;
}

export interface ResolveConceptProfileEvidenceInput {
  /** Populated by server authentication/authorization middleware, never request fields. */
  readonly authenticatedReader: AuthenticatedResearchReviewer;
  /** Trusted local root for pinned corpus bytes; no network access is performed. */
  readonly corpusRootDirectory: string;
}

const reviewEnvelopeKeys = ['event', 'request', 'workflowPreparedPayload'] as const;

async function verifyWorkflowReviewReplay(
  trx: Knex.Transaction,
  instance: Readonly<{
    id: number;
    definition_id: number;
    company_id: number;
    resource_model: string;
    resource_id: number;
    started_by_id: number;
    current_state?: string;
    status?: string;
    revision?: number;
  }>,
  workflowEvent: Readonly<Record<string, unknown>>
): Promise<void> {
  const reject = () =>
    fail('INVALID_EVENT_PAYLOAD', 'Stored research review workflow failed integrity verification');
  let envelope: unknown;
  const payloadText = String(workflowEvent.payload ?? '');
  if (
    workflowEvent.action === 'timeout' &&
    workflowEvent.to_state === 'timed_out' &&
    workflowEvent.payload == null
  ) {
    const timeoutProjection = await trx('knowledge_research_review_events')
      .where({ workflow_instance_id: instance.id, workflow_event_sequence: workflowEvent.sequence })
      .first('event_id');
    const timeoutDefinition = await trx('workflow_definitions')
      .where({ id: instance.definition_id })
      .first('code');
    if (
      timeoutProjection ||
      timeoutDefinition?.code !== 'research.review' ||
      instance.resource_model !== graphRecordModel ||
      Number(workflowEvent.instance_id) !== instance.id ||
      workflowEvent.actor_id != null ||
      instance.status !== 'timed_out' ||
      instance.current_state !== 'timed_out' ||
      Number(instance.revision) !== Number(workflowEvent.revision) ||
      Number(workflowEvent.sequence) !== Number(workflowEvent.revision) ||
      workflowEvent.to_state !== 'timed_out'
    )
      return reject();
    return;
  }
  try {
    envelope = JSON.parse(payloadText) as unknown;
  } catch {
    return reject();
  }
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    canonicalResearchJson(envelope) !== payloadText
  )
    return reject();
  const value = envelope as Record<string, unknown>;
  if (
    Object.keys(value).sort().join('|') !== [...reviewEnvelopeKeys].sort().join('|') ||
    value.workflowPreparedPayload !== 1
  )
    return reject();

  const row = await trx('knowledge_research_review_events as review')
    .where({
      'review.workflow_instance_id': instance.id,
      'review.workflow_event_sequence': workflowEvent.sequence,
    })
    .first('review.*');
  const definition = await trx('workflow_definitions')
    .where({ id: instance.definition_id })
    .first('code');
  if (
    definition?.code !== 'research.review' ||
    instance.resource_model !== graphRecordModel ||
    Number(workflowEvent.instance_id) !== instance.id
  )
    return reject();
  const terminal =
    (workflowEvent.action === 'approve' && workflowEvent.to_state === 'approved') ||
    (workflowEvent.action === 'reject' && workflowEvent.to_state === 'rejected');
  if (!terminal) {
    if (
      value.event !== null ||
      row ||
      !['approve', 'reject'].includes(String(workflowEvent.action)) ||
      workflowEvent.to_state !== workflowEvent.from_state ||
      Number(workflowEvent.sequence) < 1 ||
      Number(workflowEvent.sequence) !== Number(workflowEvent.revision) ||
      !value.request ||
      typeof value.request !== 'object' ||
      Array.isArray(value.request)
    )
      return reject();
    const request = value.request as Record<string, unknown>;
    const evidenceIds = request.evidenceIds;
    if (
      Object.keys(request).sort().join('|') !== 'evidenceIds|expectedSubjectRevision|subjectId' ||
      !canonicalId(request.subjectId) ||
      !Number.isSafeInteger(request.expectedSubjectRevision) ||
      Number(request.expectedSubjectRevision) < 1 ||
      !Array.isArray(evidenceIds) ||
      evidenceIds.length === 0 ||
      evidenceIds.some(
        (id) => typeof id !== 'string' || !/^mw:evidence:[a-z0-9][a-z0-9._-]{0,179}$/u.test(id)
      ) ||
      new Set(evidenceIds).size !== evidenceIds.length ||
      evidenceIds.some((id, index) => id !== [...evidenceIds].sort()[index])
    )
      return reject();
    const config = JSON.parse(
      String(
        (await trx('workflow_instances').where({ id: instance.id }).first('definition_snapshot'))
          ?.definition_snapshot
      )
    ) as { transitions?: Array<Record<string, unknown>> };
    const transition = config.transitions?.find(
      (item) => item.action === workflowEvent.action && item.from === workflowEvent.from_state
    );
    if (
      !transition ||
      !Array.isArray(transition.roles) ||
      !Number.isSafeInteger(transition.requiredApprovals) ||
      Number(transition.requiredApprovals) < 2
    )
      return reject();
    const record = await trx('knowledge_research_graph_records')
      .where({ id: instance.resource_id, record_key: request.subjectId })
      .first('release_id');
    if (!record) return reject();
    const releaseDigest = await trx('knowledge_research_graph_releases')
      .where({ id: record.release_id })
      .first('release_digest');
    const release = releaseDigest
      ? await readResearchGraphRelease(trx, String(releaseDigest.release_digest))
      : null;
    if (
      !release ||
      release.corpusKey !== corpusKey ||
      release.schemaVersion !== 'research-graph/v1'
    )
      return reject();
    const graph = validateResearchRelease(release.records);
    const subject = graph.contentById.get(String(request.subjectId));
    if (!subject || Number(subject.content_revision) !== Number(request.expectedSubjectRevision))
      return reject();
    const reviewSubject = subject as unknown as ResearchReviewSubject;
    for (const evidenceId of evidenceIds as string[]) {
      const ref = graph.evidence.get(evidenceId);
      if (
        !ref ||
        (reviewSubject.kind === 'Assertion'
          ? ref.assertion_id !== reviewSubject.id
          : ![
              ...reviewSubject.supporting_evidence_ids,
              ...reviewSubject.counterevidence_ids,
            ].includes(evidenceId))
      )
        return reject();
    }
    const reviewer = await trx('users')
      .where({ id: workflowEvent.actor_id, active: true })
      .first('id', 'role');
    const membership = await trx('company_memberships')
      .where({ user_id: workflowEvent.actor_id, company_id: instance.company_id, active: true })
      .first('id');
    const company = await trx('companies')
      .where({ id: instance.company_id, active: true })
      .first('id');
    const identities = await trx('knowledge_research_actor_identities')
      .whereIn('user_id', [Number(workflowEvent.actor_id), instance.started_by_id])
      .select('user_id', 'canonical_user_id');
    const actorMap = new Map(
      identities.map((item) => [Number(item.user_id), String(item.canonical_user_id)])
    );
    if (
      !reviewer ||
      !membership ||
      !company ||
      !transition.roles.includes(reviewer.role) ||
      (transition.requireDifferentActor === true &&
        Number(workflowEvent.actor_id) === instance.started_by_id) ||
      !userCanonicalIdPattern.test(actorMap.get(Number(workflowEvent.actor_id)) ?? '') ||
      !userCanonicalIdPattern.test(actorMap.get(instance.started_by_id) ?? '')
    )
      return reject();
    return;
  }
  if (
    !row ||
    typeof value.request !== 'object' ||
    value.request === null ||
    Array.isArray(value.request) ||
    typeof value.event !== 'object' ||
    value.event === null ||
    Array.isArray(value.event)
  )
    return reject();
  const eventJson = String(row.event_json);
  const digest = createHash('sha256').update(eventJson, 'utf8').digest('hex');
  let projected: unknown;
  try {
    projected = JSON.parse(eventJson) as unknown;
  } catch {
    return reject();
  }
  if (
    digest !== row.event_digest ||
    canonicalResearchJson(projected) !== eventJson ||
    canonicalResearchJson(value.event) !== eventJson ||
    !validateResearchReviewEvent(projected).valid
  )
    return reject();
  const reviewEvent = projected as ResearchReviewEvent;
  const request = value.request as Record<string, unknown>;
  const expectedRequest = {
    subjectId: reviewEvent.subject_id,
    expectedSubjectRevision: reviewEvent.subject_revision,
    evidenceIds: [...reviewEvent.evidence_ids].sort(),
  };
  const reviewer = await trx('users').where({ id: workflowEvent.actor_id }).first('id', 'role');
  const identities = await trx('knowledge_research_actor_identities')
    .whereIn('user_id', [Number(workflowEvent.actor_id), instance.started_by_id])
    .select('user_id', 'canonical_user_id');
  const identityMap = new Map(
    identities.map((item) => [Number(item.user_id), String(item.canonical_user_id)])
  );
  const subjectRecord = await trx('knowledge_research_graph_releases as release')
    .join('knowledge_research_graph_records as record', 'record.release_id', 'release.id')
    .where({
      'release.release_digest': row.research_release_digest,
      'record.record_key': row.subject_id,
    })
    .first('record.id');
  const failedChecks = [
    canonicalResearchJson(request) !== canonicalResearchJson(expectedRequest),
    !reviewRowMatchesEvent(row, reviewEvent),
    Number(row.workflow_event_sequence) !== Number(workflowEvent.sequence),
    Number(reviewEvent.workflow_instance_id) !== Number(instance.id),
    Number(reviewEvent.workflow_revision) !== Number(workflowEvent.revision),
    reviewEvent.idempotency_key !== workflowEvent.idempotency_key,
    reviewEvent.outcome === 'accepted'
      ? workflowEvent.action !== 'approve' || workflowEvent.to_state !== 'approved'
      : workflowEvent.action !== 'reject' || workflowEvent.to_state !== 'rejected',
    !reviewer || reviewer.role !== reviewEvent.reviewer_role,
    identityMap.get(Number(workflowEvent.actor_id)) !== reviewEvent.reviewer_id,
    identityMap.get(instance.started_by_id) !== reviewEvent.requester_id,
    instance.resource_id !== Number(subjectRecord?.id),
    visibilityOrder[reviewEvent.visibility] > visibilityOrder.INTERNAL,
  ];
  if (failedChecks.some(Boolean)) return reject();
}

async function verifyCompanyReviewWorkflowLog(
  trx: Knex.Transaction,
  companyId: number,
  subjectId: string
): Promise<void> {
  const resourceRows = await trx('knowledge_research_graph_records')
    .where({ record_key: subjectId })
    .select('id');
  const resourceIds = resourceRows.map((row) => Number(row.id));
  if (resourceIds.length === 0) return;
  const rows = await trx('workflow_events as event')
    .join('workflow_instances as instance', 'instance.id', 'event.instance_id')
    .join('workflow_definitions as definition', 'definition.id', 'instance.definition_id')
    .where({
      'instance.company_id': companyId,
      'instance.resource_model': graphRecordModel,
      'definition.code': 'research.review',
    })
    .whereIn('instance.resource_id', resourceIds)
    .where('event.sequence', '>', 0)
    .select(
      'event.*',
      'instance.id as bound_instance_id',
      'instance.definition_id',
      'instance.company_id',
      'instance.resource_model',
      'instance.resource_id',
      'instance.started_by_id',
      'instance.current_state',
      'instance.status',
      'instance.revision as instance_revision'
    );
  for (const row of rows) {
    await verifyWorkflowReviewReplay(
      trx,
      {
        id: Number(row.bound_instance_id),
        definition_id: Number(row.definition_id),
        company_id: Number(row.company_id),
        resource_model: String(row.resource_model),
        resource_id: Number(row.resource_id),
        started_by_id: Number(row.started_by_id),
        current_state: String(row.current_state),
        status: String(row.status),
        revision: Number(row.instance_revision),
      },
      row as Record<string, unknown>
    );
  }
}

function fail(code: ConstructorParameters<typeof WorkflowError>[0], message: string): never {
  throw new WorkflowError(code, message);
}

async function resolveEvidence(reference: ResearchEvidenceReference, rootDirectory: string) {
  const selector = reference.selector;
  let passage: ResolvablePassage;
  if ('expression_id' in selector) {
    const local = await readTextualWitnessPassage({
      rootDirectory,
      expressionId: selector.expression_id,
      editionId: selector.edition_id,
      locator: selector.locator,
    });
    passage = {
      source_id: local.sourceId,
      expression_id: local.expressionId,
      edition_id: local.editionId,
      locator: local.locator,
      text: local.text,
      content_sha256: local.sha256,
      citation: `${local.expressionId} ${local.editionId} ${local.locator}`,
    };
  } else {
    const local = await readQuranPassageSnapshot({
      rootDirectory,
      editionId: selector.edition_id,
      locator: selector.locator,
      use: 'read_analyze',
    });
    const sourceId = local.sourceId;
    if (sourceId !== selector.source_id) {
      return fail(
        'INVALID_EVENT_PAYLOAD',
        'Quran evidence source identity does not match its local manifest'
      );
    }
    passage = {
      source_id: sourceId,
      edition_id: local.passage.editionId,
      locator: local.passage.locator,
      text: local.passage.text,
      content_sha256: local.passage.sha256,
      citation: `${local.passage.editionId} ${local.passage.locator}`,
    };
  }
  return passage;
}

async function verifiedActiveResearchRecords(trx: Knex.Transaction, resourceRecordId: number) {
  const active = await trx('knowledge_research_active_releases')
    .where({ corpus_key: corpusKey })
    .forUpdate()
    .first('release_id');
  if (!active) return fail('INVALID_EVENT_PAYLOAD', 'No active research release is selected');
  const releaseRow = await trx('knowledge_research_graph_releases')
    .where({ id: active.release_id })
    .first('release_digest');
  if (!releaseRow) return fail('INVALID_EVENT_PAYLOAD', 'Active research release is unavailable');
  const release = await readResearchGraphRelease(trx, String(releaseRow.release_digest));
  if (
    !release ||
    release.corpusKey !== corpusKey ||
    release.schemaVersion !== 'research-graph/v1'
  ) {
    return fail('INVALID_EVENT_PAYLOAD', 'Active research release is invalid or unsupported');
  }
  const resource = await trx('knowledge_research_graph_records')
    .where({ id: resourceRecordId, release_id: active.release_id })
    .first('record_key', 'record_kind', 'content_digest');
  if (!resource)
    return fail('INVALID_EVENT_PAYLOAD', 'Workflow resource is not in the active release');
  const record = release.records.find((candidate) => candidate.key === resource.record_key);
  if (
    !record ||
    record.kind !== resource.record_kind ||
    record.contentDigest !== resource.content_digest
  ) {
    return fail('INVALID_EVENT_PAYLOAD', 'Workflow resource does not match the verified release');
  }
  return { release, records: release.records, record };
}

async function verifiedActorIds(
  trx: Knex.Transaction,
  actorId: number,
  requesterId: number,
  companyId: number,
  role: AuthenticatedResearchReviewer['role']
) {
  const actor = await trx('users').where({ id: actorId }).first('id', 'role');
  if (!actor || actor.role !== role)
    fail('FORBIDDEN', 'Authenticated reviewer identity is invalid');
  const membership = await trx('company_memberships')
    .where({ user_id: actorId, company_id: companyId, active: true })
    .first('id');
  if (!membership) fail('FORBIDDEN', 'Reviewer is not authorized for this company');
  const company = await trx('companies').where({ id: companyId, active: true }).first('id');
  if (!company) fail('FORBIDDEN', 'Reviewer is not authorized for this company');
  const identities = await trx('knowledge_research_actor_identities')
    .whereIn('user_id', [...new Set([actorId, requesterId])])
    .select('user_id', 'canonical_user_id');
  const byUser = new Map<number, string>(
    identities.map((row) => [Number(row.user_id), String(row.canonical_user_id)])
  );
  const reviewer = byUser.get(actorId);
  const requester = byUser.get(requesterId);
  if (
    !reviewer ||
    !requester ||
    !userCanonicalIdPattern.test(reviewer) ||
    !userCanonicalIdPattern.test(requester)
  ) {
    fail(
      'INVALID_EVENT_PAYLOAD',
      'Reviewer or requester has no approved canonical identity mapping'
    );
  }
  return { reviewer, requester };
}

async function verifiedReviewHistory(trx: Knex.Transaction, subjectId: string, companyId: number) {
  await verifyCompanyReviewWorkflowLog(trx, companyId, subjectId);
  const rows = await trx('knowledge_research_review_events as review')
    .join('workflow_instances as instance', 'instance.id', 'review.workflow_instance_id')
    .where({ 'review.subject_id': subjectId, 'instance.company_id': companyId })
    .orderBy('workflow_instance_id', 'asc')
    .orderBy('workflow_event_sequence', 'asc')
    .select('review.*');
  return rows.map((row) => {
    const eventJson = String(row.event_json);
    const actualDigest = createHash('sha256').update(eventJson, 'utf8').digest('hex');
    if (actualDigest !== row.event_digest) {
      return fail(
        'INVALID_EVENT_PAYLOAD',
        'Stored research review history failed integrity verification'
      );
    }
    let event: unknown;
    try {
      event = JSON.parse(eventJson) as unknown;
    } catch {
      return fail('INVALID_EVENT_PAYLOAD', 'Stored research review history is malformed');
    }
    if (canonicalResearchJson(event) !== eventJson || !validateResearchReviewEvent(event).valid) {
      return fail(
        'INVALID_EVENT_PAYLOAD',
        'Stored research review history failed schema verification'
      );
    }
    const verified = event as ResearchReviewEvent;
    if (!reviewRowMatchesEvent(row, verified)) {
      fail('INVALID_EVENT_PAYLOAD', 'Stored research review history failed binding verification');
    }
    return verified;
  });
}

/**
 * Resolve one concept-profile evidence ID against the active canonical research
 * snapshot. Authentication, tenant scope, visibility, local corpus provenance,
 * and the active-company review consensus are rechecked in this transaction.
 * The returned status is accepted only for a decision on this exact subject
 * revision with no contradictory outcome in company history. This function
 * does not persist or publish concept profiles.
 */
export async function resolveConceptProfileEvidence(
  db: Knex | Knex.Transaction,
  evidenceId: string,
  input: ResolveConceptProfileEvidenceInput
): Promise<TrustedConceptEvidenceResolution | null> {
  const reader = input.authenticatedReader;
  if (
    !/^mw:evidence:[a-z0-9][a-z0-9._-]{0,179}$/u.test(evidenceId) ||
    !Number.isSafeInteger(reader.userId) ||
    reader.userId < 1 ||
    !Number.isSafeInteger(reader.companyId) ||
    reader.companyId < 1 ||
    (reader.role !== 'user' && reader.role !== 'superadmin') ||
    !input.corpusRootDirectory
  ) {
    fail('INVALID_EVENT_PAYLOAD', 'Concept evidence resolution context is invalid');
  }

  return db.transaction(async (trx) => {
    const user = await trx('users')
      .where({ id: reader.userId, role: reader.role, active: true })
      .forUpdate()
      .first('id');
    const company = await trx('companies')
      .where({ id: reader.companyId, active: true })
      .forUpdate()
      .first('id');
    const membership = await trx('company_memberships')
      .where({ user_id: reader.userId, company_id: reader.companyId, active: true })
      .forUpdate()
      .first('id');
    if (!user || !company || !membership) {
      fail('FORBIDDEN', 'Research evidence is unavailable in this company context');
    }

    const active = await trx('knowledge_research_active_releases')
      .where({ corpus_key: corpusKey })
      .forUpdate()
      .first('release_id');
    if (!active) return null;
    const evidenceRow = await trx('knowledge_research_graph_records')
      .where({ release_id: active.release_id, record_key: evidenceId })
      .first('id');
    if (!evidenceRow) return null;

    const { records } = await verifiedActiveResearchRecords(trx, Number(evidenceRow.id));
    const graph = validateResearchRelease(records);
    const recordById = new Map(records.map((record) => [record.key, record]));
    const evidenceRecord = recordById.get(evidenceId);
    const reference = graph.evidence.get(evidenceId);
    if (!evidenceRecord || !reference) return null;
    await verifyCompanyReviewWorkflowLog(trx, reader.companyId, reference.assertion_id);
    const subjectRecord = recordById.get(reference.assertion_id);
    const subject = graph.contentById.get(reference.assertion_id);
    if (
      !subjectRecord ||
      !subject ||
      subject.kind !== 'Assertion' ||
      subject.id !== reference.assertion_id
    ) {
      return null;
    }
    const evidenceContent = assertObject(
      evidenceRecord.content,
      'Research evidence record is invalid'
    );
    const subjectVisibility = reviewVisibility(
      subjectRecord,
      assertObject(subject, 'Research assertion is invalid')
    );
    const evidenceVisibility = reviewVisibility(evidenceRecord, evidenceContent);
    if (
      visibilityOrder[subjectVisibility] > visibilityOrder.INTERNAL ||
      visibilityOrder[evidenceVisibility] > visibilityOrder.INTERNAL
    ) {
      fail('FORBIDDEN', 'Research evidence is unavailable in this company context');
    }

    await resolveResearchEvidenceReference(reference, (editionId, locator) => {
      if (reference.selector.edition_id !== editionId || reference.selector.locator !== locator) {
        return Promise.resolve(null);
      }
      return resolveEvidence(reference, input.corpusRootDirectory);
    }).catch(() =>
      fail('INVALID_EVENT_PAYLOAD', 'Research evidence does not match its local source snapshot')
    );

    const rows = await trx('knowledge_research_review_events as review')
      .join('workflow_instances as instance', 'instance.id', 'review.workflow_instance_id')
      .leftJoin(
        'knowledge_research_graph_releases as reviewed_release',
        'reviewed_release.release_digest',
        'review.research_release_digest'
      )
      .leftJoin('knowledge_research_graph_records as reviewed_subject_record', function () {
        this.on('reviewed_subject_record.release_id', '=', 'reviewed_release.id').andOn(
          'reviewed_subject_record.record_key',
          '=',
          'review.subject_id'
        );
      })
      .leftJoin('workflow_events as workflow_event', function () {
        this.on('workflow_event.instance_id', '=', 'review.workflow_instance_id').andOn(
          'workflow_event.sequence',
          '=',
          'review.workflow_event_sequence'
        );
      })
      .leftJoin('workflow_definitions as definition', 'definition.id', 'instance.definition_id')
      .leftJoin('users as reviewer', 'reviewer.id', 'workflow_event.actor_id')
      .leftJoin(
        'knowledge_research_actor_identities as reviewer_identity',
        'reviewer_identity.user_id',
        'reviewer.id'
      )
      .leftJoin(
        'knowledge_research_actor_identities as requester_identity',
        'requester_identity.user_id',
        'instance.started_by_id'
      )
      .where({
        'review.subject_id': reference.assertion_id,
        'instance.company_id': reader.companyId,
      })
      .select(
        'review.workflow_instance_id',
        'review.workflow_event_sequence',
        'review.subject_id',
        'review.subject_revision',
        'review.research_release_digest',
        'review.idempotency_key',
        'review.event_json',
        'review.event_digest',
        'instance.resource_model as workflow_resource_model',
        'instance.resource_id as workflow_resource_id',
        'reviewed_subject_record.id as reviewed_subject_record_id',
        'definition.code as workflow_definition_code',
        'workflow_event.id as committed_workflow_event_id',
        'workflow_event.revision as committed_workflow_revision',
        'workflow_event.action as committed_workflow_action',
        'workflow_event.to_state as committed_workflow_state',
        'workflow_event.idempotency_key as committed_workflow_idempotency_key',
        'workflow_event.actor_id as committed_workflow_actor_id',
        'reviewer.id as committed_reviewer_user_id',
        'reviewer.role as committed_reviewer_role',
        'reviewer_identity.canonical_user_id as committed_reviewer_identity',
        'requester_identity.canonical_user_id as committed_requester_identity'
      );
    const history = rows.map((row) => {
      const eventJson = String(row.event_json);
      if (createHash('sha256').update(eventJson, 'utf8').digest('hex') !== row.event_digest) {
        fail(
          'INVALID_EVENT_PAYLOAD',
          'Stored research review history failed integrity verification'
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(eventJson) as unknown;
      } catch {
        fail('INVALID_EVENT_PAYLOAD', 'Stored research review history is malformed');
      }
      if (
        canonicalResearchJson(parsed) !== eventJson ||
        !validateResearchReviewEvent(parsed).valid
      ) {
        fail('INVALID_EVENT_PAYLOAD', 'Stored research review history failed schema verification');
      }
      const event = parsed as ResearchReviewEvent;
      if (
        !reviewRowMatchesEvent(row, event) ||
        String(row.workflow_resource_model) !== graphRecordModel ||
        row.reviewed_subject_record_id === null ||
        Number(row.workflow_resource_id) !== Number(row.reviewed_subject_record_id) ||
        row.workflow_definition_code !== 'research.review' ||
        row.committed_workflow_event_id === null ||
        event.workflow_revision !== Number(row.committed_workflow_revision) ||
        event.idempotency_key !== row.committed_workflow_idempotency_key ||
        String(row.committed_reviewer_identity ?? '') !== event.reviewer_id ||
        String(row.committed_requester_identity ?? '') !== event.requester_id ||
        String(row.committed_reviewer_role ?? '') !== event.reviewer_role ||
        Number(row.committed_workflow_actor_id) !== Number(row.committed_reviewer_user_id) ||
        (event.outcome === 'accepted'
          ? row.committed_workflow_action !== 'approve' ||
            row.committed_workflow_state !== 'approved'
          : row.committed_workflow_action !== 'reject' ||
            row.committed_workflow_state !== 'rejected')
      ) {
        fail('INVALID_EVENT_PAYLOAD', 'Stored review decision is not bound to its workflow event');
      }
      if (visibilityOrder[event.visibility] > visibilityOrder.INTERNAL) {
        fail('FORBIDDEN', 'Research evidence is unavailable in this company context');
      }
      return event;
    });
    const consensus = summarizeResearchReviewHistory(
      reference.assertion_id,
      Number(subject.content_revision),
      history
    );
    return {
      canonicalEvidence: reference,
      reviewStatus: consensus.status,
      access: 'readable',
    };
  });
}

function reviewRowMatchesEvent(row: Record<string, unknown>, event: ResearchReviewEvent): boolean {
  return (
    Number(row.workflow_instance_id) === event.workflow_instance_id &&
    Number(row.workflow_event_sequence) === event.workflow_event_sequence &&
    String(row.subject_id) === event.subject_id &&
    Number(row.subject_revision) === event.subject_revision &&
    String(row.research_release_digest) === event.research_release_digest &&
    String(row.idempotency_key) === event.idempotency_key
  );
}

async function persistResearchReview(
  trx: Knex.Transaction,
  event: ResearchReviewEvent
): Promise<void> {
  const eventJson = canonicalResearchJson(event);
  const eventDigest = createHash('sha256').update(eventJson, 'utf8').digest('hex');
  await trx('knowledge_research_review_events').insert({
    event_id: event.id,
    workflow_instance_id: event.workflow_instance_id,
    workflow_event_sequence: event.workflow_event_sequence,
    subject_id: event.subject_id,
    subject_revision: event.subject_revision,
    research_release_digest: event.research_release_digest,
    idempotency_key: event.idempotency_key,
    event_json: eventJson,
    event_digest: eventDigest,
  });
}

/**
 * Persist a validated decision in the same PostgreSQL transaction as its locked
 * workflow transition. This service accepts only server-authenticated identity;
 * it does not expose HTTP or generic ORM CRUD routes.
 */
export async function transitionResearchReview(db: Knex, input: TransitionResearchReviewInput) {
  if (
    !Number.isSafeInteger(input.authenticatedReviewer.userId) ||
    input.authenticatedReviewer.userId < 1 ||
    !Number.isSafeInteger(input.authenticatedReviewer.companyId) ||
    input.authenticatedReviewer.companyId < 1 ||
    !Number.isSafeInteger(input.instanceId) ||
    input.instanceId < 1 ||
    !Number.isSafeInteger(input.expectedWorkflowRevision) ||
    input.expectedWorkflowRevision < 0 ||
    !Number.isSafeInteger(input.expectedSubjectRevision) ||
    input.expectedSubjectRevision < 1 ||
    !canonicalId(input.subjectId) ||
    !Array.isArray(input.evidenceIds) ||
    input.evidenceIds.length === 0 ||
    new Set(input.evidenceIds).size !== input.evidenceIds.length ||
    input.evidenceIds.some((id) => !canonicalId(id)) ||
    input.evidenceIds.some((id) => !id.startsWith('mw:evidence:'))
  ) {
    throw new WorkflowError('INVALID_EVENT_PAYLOAD', 'Research review request is invalid');
  }
  const evidenceIds = [...input.evidenceIds].sort();
  const intent = {
    subjectId: input.subjectId,
    expectedSubjectRevision: input.expectedSubjectRevision,
    evidenceIds,
  };
  const reviewer = input.authenticatedReviewer;
  const role: WorkflowRole = reviewer.role;
  const transition: TransitionWorkflowInput = {
    instanceId: input.instanceId,
    companyId: reviewer.companyId,
    actorId: reviewer.userId,
    role,
    action: input.action,
    expectedRevision: input.expectedWorkflowRevision,
    idempotencyKey: input.idempotencyKey,
    payload: intent,
    ...(input.now ? { now: input.now } : {}),
    preparePayload: async (context) => {
      if (context.instance.resource_model !== graphRecordModel) {
        fail('INVALID_EVENT_PAYLOAD', 'Workflow is not bound to a canonical research graph record');
      }
      if (context.actorId !== reviewer.userId || context.role !== reviewer.role) {
        fail('FORBIDDEN', 'Authenticated reviewer context changed during transition');
      }
      const { reviewer: reviewerCanonicalId, requester: requesterCanonicalId } =
        await verifiedActorIds(
          context.trx,
          context.actorId,
          context.instance.started_by_id,
          context.instance.company_id,
          reviewer.role
        );
      const { release, records, record } = await verifiedActiveResearchRecords(
        context.trx,
        context.instance.resource_id
      );
      if (record.key !== input.subjectId || !['assertion', 'relation'].includes(record.kind)) {
        fail(
          'INVALID_EVENT_PAYLOAD',
          'Workflow resource does not match the requested review subject'
        );
      }
      const graph = validateResearchRelease(records);
      const subjectContent = graph.contentById.get(input.subjectId);
      if (!subjectContent) fail('INVALID_EVENT_PAYLOAD', 'Review subject is unavailable');
      const subject = subjectContent as unknown as ResearchReviewSubject;
      if (subject.content_revision !== input.expectedSubjectRevision) {
        fail('STALE_REVISION', 'Research subject changed; reload before retrying');
      }

      const recordById = new Map(records.map((item) => [item.key, item]));
      const evidenceVisibility = new Map<string, ResearchVisibility>();
      for (const evidenceId of evidenceIds) {
        const evidenceRecord = recordById.get(evidenceId);
        const reference = graph.evidence.get(evidenceId);
        if (!evidenceRecord || !reference) {
          fail('INVALID_EVENT_PAYLOAD', 'Review evidence does not resolve in the active release');
        }
        const content = assertObject(evidenceRecord.content, 'Research evidence record is invalid');
        if (
          subject.kind === 'Assertion'
            ? reference.assertion_id !== subject.id
            : ![...subject.supporting_evidence_ids, ...subject.counterevidence_ids].includes(
                evidenceId
              )
        ) {
          fail('INVALID_EVENT_PAYLOAD', 'Evidence is not bound to the requested research subject');
        }
        await resolveResearchEvidenceReference(reference, (editionId, locator) => {
          if (
            reference.selector.edition_id !== editionId ||
            reference.selector.locator !== locator
          ) {
            return Promise.resolve(null);
          }
          return resolveEvidence(reference, input.corpusRootDirectory);
        }).catch(() =>
          fail('INVALID_EVENT_PAYLOAD', 'Review evidence does not match an authorized local source')
        );
        evidenceVisibility.set(evidenceId, reviewVisibility(evidenceRecord, content));
      }
      const currentVisibility = reviewVisibility(
        record,
        assertObject(record.content, 'Review subject is invalid')
      );
      if (visibilityOrder[currentVisibility] > visibilityOrder.INTERNAL) {
        fail('FORBIDDEN', 'Research review is unavailable for this record');
      }
      if (
        [...evidenceVisibility.values()].some(
          (visibility) => visibilityOrder[visibility] > visibilityOrder.INTERNAL
        )
      ) {
        fail('FORBIDDEN', 'Research review is unavailable for this record');
      }
      const authorizedSubject = {
        ...subject,
        visibility: currentVisibility,
      } as ResearchReviewSubject;
      const history = await verifiedReviewHistory(
        context.trx,
        subject.id,
        context.instance.company_id
      );
      const result = appendResearchReviewEvent(authorizedSubject, history, {
        authenticatedActorId: reviewerCanonicalId,
        authenticatedRole: reviewer.role,
        requesterId: requesterCanonicalId,
        expectedSubjectRevision: input.expectedSubjectRevision,
        researchReleaseDigest: release.releaseDigest,
        workflowInstanceId: context.instance.id,
        workflowEventSequence: context.sequence,
        workflowRevision: context.revision,
        outcome: input.action === 'approve' ? 'accepted' : 'rejected',
        evidenceIds,
        evidenceVisibility,
        idempotencyKey: context.idempotencyKey,
        now: new Date(context.eventTime),
      });
      if (result.status === 'invalid') {
        fail('INVALID_EVENT_PAYLOAD', 'Research review decision failed its validation contract');
      }
      if (result.status === 'replayed') {
        fail('IDEMPOTENCY_CONFLICT', 'Review event exists without a matching workflow event');
      }
      if (
        (input.action === 'approve' && context.toState !== 'approved') ||
        (input.action === 'reject' && context.toState !== 'rejected')
      ) {
        // Multi-approval workflows record intermediate votes in the workflow log;
        // the decision projection is written only when the transition is terminal.
        return null;
      }
      await persistResearchReview(context.trx, result.event);
      return JSON.parse(canonicalResearchJson(result.event)) as WorkflowEventPayload;
    },
    verifyPreparedPayloadReplay: async ({ trx, instance, event }) => {
      await verifyWorkflowReviewReplay(trx, instance, event);
    },
  };
  return transitionWorkflow(db, transition);
}

/** Read a bounded, integrity-checked review history for an INTERNAL active subject. */
export async function readResearchReviewHistory(
  db: Knex,
  input: {
    readonly subjectId: string;
    readonly companyId: number;
    readonly limit?: number;
    readonly before?: {
      readonly workflowInstanceId: number;
      readonly workflowEventSequence: number;
    };
  }
) {
  const limit = input.limit ?? 50;
  if (
    !canonicalId(input.subjectId) ||
    !Number.isSafeInteger(input.companyId) ||
    input.companyId < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (input.before !== undefined &&
      (!Number.isSafeInteger(input.before.workflowInstanceId) ||
        input.before.workflowInstanceId < 1 ||
        !Number.isSafeInteger(input.before.workflowEventSequence) ||
        input.before.workflowEventSequence < 0))
  ) {
    throw new WorkflowError('INVALID_EVENT_PAYLOAD', 'Research review history request is invalid');
  }
  return db.transaction(async (trx) => {
    const release = await readResearchGraphRelease(
      trx,
      String(
        (
          await trx('knowledge_research_active_releases as active')
            .join('knowledge_research_graph_releases as release', 'release.id', 'active.release_id')
            .where('active.corpus_key', corpusKey)
            .first('release.release_digest')
        )?.release_digest ?? ''
      )
    );
    if (!release) fail('INVALID_EVENT_PAYLOAD', 'Research review history is unavailable');
    const graph = validateResearchRelease(release.records);
    const subject = graph.contentById.get(input.subjectId);
    if (
      !subject ||
      !['Assertion', 'ResearchRelation'].includes(String(subject.kind)) ||
      visibilityOrder[getVisibility(subject.visibility)] > visibilityOrder.INTERNAL
    ) {
      fail('FORBIDDEN', 'Research review history is unavailable');
    }
    await verifyCompanyReviewWorkflowLog(trx, input.companyId, input.subjectId);

    const historyQuery = trx('knowledge_research_review_events as review')
      .join('workflow_instances as instance', 'instance.id', 'review.workflow_instance_id')
      .where({ 'review.subject_id': input.subjectId, 'instance.company_id': input.companyId });
    const before = input.before;
    if (before) {
      historyQuery.andWhere(function () {
        this.where('review.workflow_instance_id', '<', before.workflowInstanceId).orWhere(
          function () {
            this.where('review.workflow_instance_id', before.workflowInstanceId).andWhere(
              'review.workflow_event_sequence',
              '<',
              before.workflowEventSequence
            );
          }
        );
      });
    }
    const rows = await historyQuery
      .orderBy('review.workflow_instance_id', 'desc')
      .orderBy('review.workflow_event_sequence', 'desc')
      .limit(limit + 1)
      .select(
        'review.workflow_instance_id',
        'review.workflow_event_sequence',
        'review.subject_id',
        'review.subject_revision',
        'review.research_release_digest',
        'review.idempotency_key',
        'review.event_json',
        'review.event_digest'
      );
    const truncated = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => {
      const eventJson = String(row.event_json);
      if (createHash('sha256').update(eventJson, 'utf8').digest('hex') !== row.event_digest) {
        fail(
          'INVALID_EVENT_PAYLOAD',
          'Stored research review history failed integrity verification'
        );
      }
      let event: unknown;
      try {
        event = JSON.parse(eventJson) as unknown;
      } catch {
        fail('INVALID_EVENT_PAYLOAD', 'Stored research review history is malformed');
      }
      if (canonicalResearchJson(event) !== eventJson || !validateResearchReviewEvent(event).valid) {
        fail('INVALID_EVENT_PAYLOAD', 'Stored research review history failed schema verification');
      }
      const verified = event as ResearchReviewEvent;
      if (!reviewRowMatchesEvent(row, verified)) {
        fail('INVALID_EVENT_PAYLOAD', 'Stored research review history failed binding verification');
      }
      if (
        verified.subject_id !== input.subjectId ||
        visibilityOrder[verified.visibility] > visibilityOrder.INTERNAL
      ) {
        fail('FORBIDDEN', 'Research review history is unavailable');
      }
      return verified;
    });
    const lastEvent = events.at(-1);
    return {
      events,
      truncated,
      nextCursor:
        truncated && lastEvent
          ? {
              workflowInstanceId: lastEvent.workflow_instance_id,
              workflowEventSequence: lastEvent.workflow_event_sequence,
            }
          : null,
    };
  });
}
