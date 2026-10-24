import type { FastifyPluginAsync } from 'fastify';
import { isRecord } from '@moonwitness/types';
import {
  provisionResearchActorIdentity,
  ResearchActorIdentityProvisioningError,
} from '@moonwitness/orm-knowledge';

interface ProvisionBody {
  target_user_id: number;
  canonical_user_id: string;
  reason: string;
}

function parseBody(value: unknown): ProvisionBody | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['target_user_id', 'canonical_user_id', 'reason'].includes(key)
    ) ||
    !Number.isSafeInteger(value.target_user_id) ||
    Number(value.target_user_id) < 1 ||
    typeof value.canonical_user_id !== 'string' ||
    !/^mw:user:[a-z0-9][a-z0-9._-]{0,179}$/u.test(value.canonical_user_id) ||
    typeof value.reason !== 'string' ||
    value.reason.trim().length === 0 ||
    value.reason.trim().length > 500
  ) {
    return null;
  }
  return {
    target_user_id: Number(value.target_user_id),
    canonical_user_id: value.canonical_user_id,
    reason: value.reason.trim(),
  };
}

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'error'],
  properties: { success: { const: false }, error: { type: 'string' } },
} as const;

const resultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'data'],
  properties: {
    success: { const: true },
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['target_user_id', 'canonical_user_id', 'request_id'],
      properties: {
        target_user_id: { type: 'integer', minimum: 1 },
        canonical_user_id: { type: 'string', pattern: '^mw:user:[a-z0-9][a-z0-9._-]{0,179}$' },
        request_id: { type: 'string', minLength: 1, maxLength: 96 },
      },
    },
  },
} as const;

export const researchActorIdentityRoutes: FastifyPluginAsync = async (fastify) => {
  const bodyWithAdditionalFields = new WeakSet<object>();
  fastify.post<{ Body: unknown }>(
    '/api/research/actor-identities',
    {
      attachValidation: true,
      preValidation: async (request) => {
        if (
          isRecord(request.body) &&
          Object.keys(request.body).some(
            (key) => !['target_user_id', 'canonical_user_id', 'reason'].includes(key)
          )
        ) {
          bodyWithAdditionalFields.add(request);
        }
      },
      schema: {
        tags: ['Research'],
        summary: 'Provision an explicit research actor identity mapping',
        description:
          'Superadmin-only operation. The target SQL user ID and canonical mw:user ID must be supplied explicitly. Mapping and append-only audit event are committed together in PostgreSQL. No identity is inferred from account names or SQL IDs.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['target_user_id', 'canonical_user_id', 'reason'],
          properties: {
            target_user_id: { type: 'integer', minimum: 1 },
            canonical_user_id: {
              type: 'string',
              pattern: '^mw:user:[a-z0-9][a-z0-9._-]{0,179}$',
            },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
        response: {
          200: {
            description: 'Identity mapping is provisioned or exactly replayed.',
            ...resultSchema,
          },
          400: { description: 'The explicit identity mapping request is invalid.', ...errorSchema },
          401: { description: 'Bearer authentication is required.', ...errorSchema },
          403: {
            description: 'Only an active superadmin may provision identity mappings.',
            ...errorSchema,
          },
          404: { description: 'The explicit target user is missing or inactive.', ...errorSchema },
          409: {
            description:
              'A user, canonical identity, or request ID conflicts with an existing mapping.',
            ...errorSchema,
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!request.auth) {
        return reply.code(401).send({ success: false, error: 'Authentication required' });
      }
      if (request.auth.role !== 'superadmin') {
        return reply
          .code(403)
          .send({ success: false, error: 'Identity provisioning is restricted' });
      }
      const provisionerUserId = request.auth.userId;
      const body = parseBody(request.body);
      if (!body || bodyWithAdditionalFields.has(request)) {
        return reply.code(400).send({ success: false, error: 'Invalid identity mapping request' });
      }

      try {
        await fastify.db.transaction((trx) =>
          provisionResearchActorIdentity(trx, {
            authenticatedProvisioner: {
              userId: provisionerUserId,
              role: 'superadmin',
            },
            targetUserId: body.target_user_id,
            canonicalUserId: body.canonical_user_id,
            reason: body.reason,
            requestId: request.id,
          })
        );
      } catch (error) {
        if (error instanceof ResearchActorIdentityProvisioningError) {
          const status =
            error.code === 'FORBIDDEN'
              ? 403
              : error.code === 'TARGET_NOT_FOUND'
                ? 404
                : error.code === 'CONFLICT'
                  ? 409
                  : 400;
          return reply.code(status).send({
            success: false,
            error:
              error.code === 'TARGET_NOT_FOUND'
                ? 'The explicit target user was not found'
                : error.code === 'CONFLICT'
                  ? 'Identity mapping conflicts with an existing mapping'
                  : error.code === 'FORBIDDEN'
                    ? 'Identity provisioning is restricted'
                    : 'Invalid identity mapping request',
          });
        }
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : undefined;
        if (code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return reply
            .code(409)
            .send({ success: false, error: 'Identity mapping conflicts with an existing mapping' });
        }
        throw error;
      }

      return reply.send({
        success: true,
        data: {
          target_user_id: body.target_user_id,
          canonical_user_id: body.canonical_user_id,
          request_id: request.id,
        },
      });
    }
  );
};
