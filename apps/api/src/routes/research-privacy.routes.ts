import type { FastifyPluginAsync } from 'fastify';
import { isRecord } from '@moonwitness/types';
import {
  applyPrivacyRevocation,
  PrivacyRevocationError,
  readActivePrivacyProjections,
} from '@moonwitness/orm-knowledge';

const digestPattern = '^[a-f0-9]{64}$';
const idempotencyPattern = '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$';

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'error'],
  properties: { success: { const: false }, error: { type: 'string' } },
} as const;

function validRevocationBody(value: unknown): value is {
  subject_ref_sha256: string;
  consent_decision_ref_sha256: string;
  idempotency_key: string;
} {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    typeof value.subject_ref_sha256 === 'string' &&
    new RegExp(digestPattern, 'u').test(value.subject_ref_sha256) &&
    typeof value.consent_decision_ref_sha256 === 'string' &&
    new RegExp(digestPattern, 'u').test(value.consent_decision_ref_sha256) &&
    typeof value.idempotency_key === 'string' &&
    new RegExp(idempotencyPattern, 'u').test(value.idempotency_key)
  );
}

function mapError(error: unknown): { status: number; message: string } | null {
  if (!(error instanceof PrivacyRevocationError)) return null;
  const status =
    error.code === 'FORBIDDEN'
      ? 403
      : error.code === 'SUBJECT_NOT_FOUND'
        ? 404
        : error.code === 'IDEMPOTENCY_CONFLICT'
          ? 409
          : error.code === 'INVALID_STORED_PROJECTION'
            ? 503
            : 400;
  return {
    status,
    message:
      error.code === 'FORBIDDEN'
        ? 'Privacy operation is unavailable'
        : error.code === 'SUBJECT_NOT_FOUND'
          ? 'Synthetic privacy subject is unavailable'
          : error.code === 'IDEMPOTENCY_CONFLICT'
            ? 'Idempotency key conflicts with an earlier decision'
            : error.code === 'INVALID_STORED_PROJECTION'
              ? 'Privacy projection is unavailable'
              : 'Invalid privacy request',
  };
}

export const researchPrivacyRoutes: FastifyPluginAsync = async (fastify) => {
  const bodyWithAdditionalFields = new WeakSet<object>();
  fastify.get(
    '/api/research/privacy/projections',
    {
      schema: {
        tags: ['Research'],
        summary: 'Read active tenant-scoped synthetic privacy projections',
        description:
          'Superadmin privacy stewards only. Returns active derived projections that are not revoked and whose stored JSON bytes match their SHA-256 digest. This endpoint is not a general witness-search or export API.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['success', 'data'],
            properties: {
              success: { const: true },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['projection_key', 'content', 'digest'],
                  properties: {
                    projection_key: { type: 'string' },
                    content: { type: 'object', additionalProperties: true },
                    digest: { type: 'string', pattern: digestPattern },
                  },
                },
              },
            },
          },
          401: errorSchema,
          403: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const auth = request.auth;
      if (!auth) return reply.code(401).send({ success: false, error: 'Authentication required' });
      if (auth.role !== 'superadmin' || !auth.companyId) {
        return reply.code(403).send({ success: false, error: 'Privacy operation is unavailable' });
      }
      try {
        const projections = await readActivePrivacyProjections(fastify.db, {
          userId: auth.userId,
          companyId: auth.companyId,
          role: auth.role,
        });
        return reply.send({
          success: true,
          data: projections.map((projection) => ({
            projection_key: projection.projectionKey,
            content: projection.content,
            digest: projection.digest,
          })),
        });
      } catch (error) {
        if (error instanceof PrivacyRevocationError) {
          const forbidden = error.code === 'FORBIDDEN';
          return reply.code(forbidden ? 403 : 503).send({
            success: false,
            error: forbidden
              ? 'Privacy operation is unavailable'
              : 'Privacy projection is unavailable',
          });
        }
        throw error;
      }
    }
  );

  fastify.post<{ Body: unknown }>(
    '/api/research/privacy/revocations',
    {
      attachValidation: true,
      preValidation: async (request) => {
        if (
          isRecord(request.body) &&
          Object.keys(request.body).some(
            (key) =>
              !['subject_ref_sha256', 'consent_decision_ref_sha256', 'idempotency_key'].includes(
                key
              )
          )
        ) {
          bodyWithAdditionalFields.add(request);
        }
      },
      schema: {
        tags: ['Research'],
        summary: 'Record a privacy withdrawal and invalidate tenant search projections',
        description:
          'Superadmin privacy stewards only. Accepts opaque SHA-256 references, never raw subject or consent identifiers. The event and local search-projection invalidation commit atomically; other derivative stores are not covered.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['subject_ref_sha256', 'consent_decision_ref_sha256', 'idempotency_key'],
          properties: {
            subject_ref_sha256: { type: 'string', pattern: digestPattern },
            consent_decision_ref_sha256: { type: 'string', pattern: digestPattern },
            idempotency_key: { type: 'string', pattern: idempotencyPattern },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['success', 'data'],
            properties: {
              success: { const: true },
              data: {
                type: 'object',
                additionalProperties: false,
                required: ['revocation_id', 'replayed', 'invalidated_projection_count'],
                properties: {
                  revocation_id: { type: 'integer', minimum: 1 },
                  replayed: { type: 'boolean' },
                  invalidated_projection_count: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['success', 'data'],
            properties: {
              success: { const: true },
              data: {
                type: 'object',
                additionalProperties: false,
                required: ['revocation_id', 'replayed', 'invalidated_projection_count'],
                properties: {
                  revocation_id: { type: 'integer', minimum: 1 },
                  replayed: { type: 'boolean' },
                  invalidated_projection_count: { type: 'integer', minimum: 0 },
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
      if (auth.role !== 'superadmin' || !auth.companyId) {
        return reply.code(403).send({ success: false, error: 'Privacy operation is unavailable' });
      }
      if (
        request.validationError ||
        bodyWithAdditionalFields.has(request) ||
        !validRevocationBody(request.body)
      ) {
        return reply.code(400).send({ success: false, error: 'Invalid privacy request' });
      }
      const body = request.body;
      try {
        const result = await applyPrivacyRevocation(fastify.db, {
          steward: { userId: auth.userId, companyId: auth.companyId, role: auth.role },
          subjectRefSha256: body.subject_ref_sha256,
          consentDecisionRefSha256: body.consent_decision_ref_sha256,
          idempotencyKey: body.idempotency_key,
        });
        return reply.code(result.replayed ? 200 : 201).send({
          success: true,
          data: {
            revocation_id: result.revocationId,
            replayed: result.replayed,
            invalidated_projection_count: result.invalidatedProjectionCount,
          },
        });
      } catch (error) {
        const failure = mapError(error);
        if (failure)
          return reply.code(failure.status).send({ success: false, error: failure.message });
        throw error;
      }
    }
  );
};
