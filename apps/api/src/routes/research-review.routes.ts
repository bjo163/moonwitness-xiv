import type { FastifyPluginAsync } from 'fastify';
import { isRecord } from '@moonwitness/types';
import {
  readActiveResearchGraphRelease,
  readResearchReviewHistory,
  ResearchGraphRecord,
  transitionResearchReview,
  validateResearchRelease,
} from '@moonwitness/orm-knowledge';
import { startWorkflow, WorkflowError, type WorkflowRole } from '@moonwitness/orm-workflow';
import { resolveCorpusDataRoot } from './corpus.routes.js';

const corpusKey = 'research';
const reviewCode = 'research.review';
const canonicalIdPattern =
  /^mw:[a-z]+(?:-[a-z]+)*:[a-z0-9][a-z0-9._-]{0,179}(?::[a-z0-9][a-z0-9._-]{0,179})*$/u;

function invalidBody(value: unknown, allowed: readonly string[]): boolean {
  return !isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key));
}

function workflowFailure(error: unknown): { status: number; message: string } | null {
  if (!(error instanceof WorkflowError)) return null;
  const status =
    error.code === 'FORBIDDEN'
      ? 403
      : error.code === 'INSTANCE_NOT_FOUND' || error.code === 'DEFINITION_NOT_FOUND'
        ? 404
        : error.code === 'STALE_REVISION' ||
            error.code === 'DUPLICATE_APPROVAL' ||
            error.code === 'INSTANCE_CLOSED' ||
            error.code === 'IDEMPOTENCY_CONFLICT'
          ? 409
          : 400;
  return { status, message: error.message };
}

function reviewerRole(role: string): role is 'user' | 'superadmin' {
  return role === 'user' || role === 'superadmin';
}

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'error'],
  properties: { success: { const: false }, error: { type: 'string' } },
} as const;

export const researchReviewRoutes: FastifyPluginAsync = async (fastify) => {
  const bodyWithAdditionalFields = new WeakSet<object>();
  fastify.post<{ Body: unknown }>(
    '/api/research/reviews',
    {
      attachValidation: true,
      preValidation: async (request) => {
        if (
          isRecord(request.body) &&
          Object.keys(request.body).some((key) => !['subject_id', 'idempotency_key'].includes(key))
        ) {
          bodyWithAdditionalFields.add(request);
        }
      },
      schema: {
        tags: ['Research'],
        summary: 'Start a human review for a canonical research subject',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['subject_id', 'idempotency_key'],
          properties: {
            subject_id: {
              type: 'string',
              pattern:
                '^mw:[a-z]+(?:-[a-z]+)*:[a-z0-9][a-z0-9._-]{0,179}(?::[a-z0-9][a-z0-9._-]{0,179})*$',
            },
            idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
          },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['success', 'data'],
            properties: {
              success: { const: true },
              data: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'subject_id', 'subject_revision', 'revision', 'state'],
                properties: {
                  id: { type: 'integer', minimum: 1 },
                  subject_id: { type: 'string' },
                  subject_revision: { type: 'integer', minimum: 1 },
                  revision: { type: 'integer', minimum: 0 },
                  state: { type: 'string' },
                },
              },
            },
          },
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const auth = request.auth;
      if (!auth) return reply.code(401).send({ success: false, error: 'Authentication required' });
      if (request.validationError || bodyWithAdditionalFields.has(request))
        return reply.code(400).send({ success: false, error: 'Invalid research review request' });
      if (!reviewerRole(auth.role) || !auth.companyId)
        return reply.code(403).send({ success: false, error: 'Research review is unavailable' });
      if (invalidBody(request.body, ['subject_id', 'idempotency_key']))
        return reply.code(400).send({ success: false, error: 'Invalid research review request' });
      const body = request.body as Record<string, unknown>;
      if (
        typeof body.subject_id !== 'string' ||
        !canonicalIdPattern.test(body.subject_id) ||
        typeof body.idempotency_key !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(body.idempotency_key)
      ) {
        return reply.code(400).send({ success: false, error: 'Invalid research review request' });
      }

      try {
        const started = await fastify.db.transaction(async (trx) => {
          const active = await trx('knowledge_research_active_releases')
            .where({ corpus_key: corpusKey })
            .forUpdate()
            .first('release_id');
          if (!active)
            throw new WorkflowError('INVALID_EVENT_PAYLOAD', 'Research subject is unavailable');
          const releaseRow = await trx('knowledge_research_graph_releases')
            .where({ id: active.release_id })
            .first('release_digest');
          const release = releaseRow ? await readActiveResearchGraphRelease(trx, corpusKey) : null;
          if (!release || release.releaseDigest !== releaseRow?.release_digest)
            throw new WorkflowError('INVALID_EVENT_PAYLOAD', 'Research subject is unavailable');
          const graph = validateResearchRelease(release.records);
          const subject = graph.contentById.get(body.subject_id as string);
          if (
            !subject ||
            !['Assertion', 'ResearchRelation'].includes(String(subject.kind)) ||
            subject.visibility !== 'INTERNAL'
          ) {
            throw new WorkflowError('FORBIDDEN', 'Research subject is unavailable');
          }
          const record = await trx('knowledge_research_graph_records')
            .where({ release_id: active.release_id, record_key: body.subject_id })
            .first('id', 'record_kind');
          if (!record || !['assertion', 'relation'].includes(String(record.record_kind)))
            throw new WorkflowError('INVALID_EVENT_PAYLOAD', 'Research subject is unavailable');
          const identity = await trx('knowledge_research_actor_identities')
            .where({ user_id: auth.userId })
            .first('user_id');
          if (!identity)
            throw new WorkflowError('FORBIDDEN', 'Research reviewer identity is not configured');
          const data = await startWorkflow(trx, {
            code: reviewCode,
            companyId: auth.companyId as number,
            actorId: auth.userId,
            role: auth.role as WorkflowRole,
            resourceModel: ResearchGraphRecord.modelName,
            resourceId: Number(record.id),
            idempotencyKey: body.idempotency_key as string,
          });
          return { data, subjectRevision: Number(subject.content_revision) };
        });
        return reply.code(201).send({
          success: true,
          data: {
            id: started.data.id,
            subject_id: body.subject_id,
            subject_revision: started.subjectRevision,
            revision: started.data.revision,
            state: started.data.currentState,
          },
        });
      } catch (error) {
        const failure = workflowFailure(error);
        if (failure)
          return reply.code(failure.status).send({
            success: false,
            error: failure.status === 403 ? 'Research review is unavailable' : failure.message,
          });
        throw error;
      }
    }
  );

  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/api/research/reviews/:id/decision',
    {
      attachValidation: true,
      preValidation: async (request) => {
        const allowed = [
          'action',
          'expected_workflow_revision',
          'subject_id',
          'expected_subject_revision',
          'evidence_ids',
          'idempotency_key',
        ];
        if (
          isRecord(request.body) &&
          Object.keys(request.body).some((key) => !allowed.includes(key))
        ) {
          bodyWithAdditionalFields.add(request);
        }
      },
      schema: {
        tags: ['Research'],
        summary: 'Record an immutable research review decision',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', pattern: '^[1-9][0-9]{0,14}$' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'action',
            'expected_workflow_revision',
            'subject_id',
            'expected_subject_revision',
            'evidence_ids',
            'idempotency_key',
          ],
          properties: {
            action: { enum: ['approve', 'reject'] },
            expected_workflow_revision: { type: 'integer', minimum: 0 },
            subject_id: {
              type: 'string',
              pattern:
                '^mw:[a-z]+(?:-[a-z]+)*:[a-z0-9][a-z0-9._-]{0,179}(?::[a-z0-9][a-z0-9._-]{0,179})*$',
            },
            expected_subject_revision: { type: 'integer', minimum: 1 },
            evidence_ids: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              uniqueItems: true,
              items: {
                type: 'string',
                pattern: '^mw:evidence:[a-z0-9][a-z0-9._-]{0,179}(?::[a-z0-9][a-z0-9._-]{0,179})*$',
              },
            },
            idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['success', 'data'],
            properties: {
              success: { const: true },
              data: { type: 'object', additionalProperties: true },
            },
          },
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const auth = request.auth;
      if (!auth) return reply.code(401).send({ success: false, error: 'Authentication required' });
      if (request.validationError || bodyWithAdditionalFields.has(request))
        return reply.code(400).send({ success: false, error: 'Invalid research review decision' });
      if (!reviewerRole(auth.role) || !auth.companyId)
        return reply.code(403).send({ success: false, error: 'Research review is unavailable' });
      if (
        !/^[1-9][0-9]{0,14}$/u.test(request.params.id) ||
        invalidBody(request.body, [
          'action',
          'expected_workflow_revision',
          'subject_id',
          'expected_subject_revision',
          'evidence_ids',
          'idempotency_key',
        ])
      )
        return reply.code(400).send({ success: false, error: 'Invalid research review decision' });
      const body = request.body as Record<string, unknown>;
      if (
        (body.action !== 'approve' && body.action !== 'reject') ||
        !Number.isSafeInteger(body.expected_workflow_revision) ||
        Number(body.expected_workflow_revision) < 0 ||
        typeof body.subject_id !== 'string' ||
        !canonicalIdPattern.test(body.subject_id) ||
        !Number.isSafeInteger(body.expected_subject_revision) ||
        Number(body.expected_subject_revision) < 1 ||
        !Array.isArray(body.evidence_ids) ||
        body.evidence_ids.length < 1 ||
        body.evidence_ids.length > 100 ||
        body.evidence_ids.some(
          (id) =>
            typeof id !== 'string' ||
            !/^mw:evidence:[a-z0-9][a-z0-9._-]{0,179}(?::[a-z0-9][a-z0-9._-]{0,179})*$/u.test(id)
        ) ||
        typeof body.idempotency_key !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(body.idempotency_key)
      )
        return reply.code(400).send({ success: false, error: 'Invalid research review decision' });
      try {
        const data = await transitionResearchReview(fastify.db, {
          instanceId: Number(request.params.id),
          authenticatedReviewer: {
            userId: auth.userId,
            companyId: auth.companyId as number,
            role: auth.role,
          },
          action: body.action,
          expectedWorkflowRevision: Number(body.expected_workflow_revision),
          subjectId: body.subject_id,
          expectedSubjectRevision: Number(body.expected_subject_revision),
          evidenceIds: body.evidence_ids as string[],
          idempotencyKey: body.idempotency_key as string,
          corpusRootDirectory: resolveCorpusDataRoot(),
        });
        return { success: true, data };
      } catch (error) {
        const failure = workflowFailure(error);
        if (failure)
          return reply.code(failure.status).send({
            success: false,
            error: failure.status === 403 ? 'Research review is unavailable' : failure.message,
          });
        throw error;
      }
    }
  );

  fastify.get<{
    Params: { subjectId: string };
    Querystring: {
      limit?: string;
      before_workflow_instance_id?: string;
      before_workflow_event_sequence?: string;
    };
  }>(
    '/api/research/reviews/:subjectId/history',
    {
      schema: {
        tags: ['Research'],
        summary: 'Read verified research review history',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['subjectId'],
          properties: {
            subjectId: {
              type: 'string',
              pattern:
                '^mw:[a-z]+(?:-[a-z]+)*:[a-z0-9][a-z0-9._-]{0,179}(?::[a-z0-9][a-z0-9._-]{0,179})*$',
            },
          },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'string', pattern: '^(?:[1-9][0-9]?|100)$' },
            before_workflow_instance_id: { type: 'string', pattern: '^[1-9][0-9]{0,14}$' },
            before_workflow_event_sequence: { type: 'string', pattern: '^[1-9][0-9]{0,14}$' },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const auth = request.auth;
      if (!auth) return reply.code(401).send({ success: false, error: 'Authentication required' });
      if (!reviewerRole(auth.role) || !auth.companyId)
        return reply
          .code(403)
          .send({ success: false, error: 'Research review history is unavailable' });
      const limit = Number(request.query.limit ?? 50);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return reply.code(400).send({ success: false, error: 'Invalid history limit' });
      const beforeInstance = request.query.before_workflow_instance_id;
      const beforeSequence = request.query.before_workflow_event_sequence;
      if ((beforeInstance === undefined) !== (beforeSequence === undefined))
        return reply.code(400).send({ success: false, error: 'Invalid history cursor' });
      const cursor =
        beforeInstance !== undefined && beforeSequence !== undefined
          ? {
              workflowInstanceId: Number(beforeInstance),
              workflowEventSequence: Number(beforeSequence),
            }
          : undefined;
      if (
        cursor &&
        (!Number.isSafeInteger(cursor.workflowInstanceId) ||
          cursor.workflowInstanceId < 1 ||
          !Number.isSafeInteger(cursor.workflowEventSequence) ||
          cursor.workflowEventSequence < 1)
      )
        return reply.code(400).send({ success: false, error: 'Invalid history cursor' });
      try {
        const data = await readResearchReviewHistory(fastify.db, {
          subjectId: request.params.subjectId,
          companyId: auth.companyId,
          limit,
          ...(cursor ? { before: cursor } : {}),
        });
        return { success: true, data };
      } catch (error) {
        const failure = workflowFailure(error);
        if (failure)
          return reply.code(failure.status).send({
            success: false,
            error:
              failure.status === 403 ? 'Research review history is unavailable' : failure.message,
          });
        throw error;
      }
    }
  );
};
