import type { FastifyPluginAsync } from 'fastify';
import { readOwnedSyntheticWitness, WitnessAccessError } from '@moonwitness/orm-knowledge';

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'error'],
  properties: { success: { const: false }, error: { type: 'string' } },
} as const;

const successSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'data'],
  properties: {
    success: { const: true },
    data: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id',
        'external_key',
        'original_text',
        'source_label',
        'source_locator',
        'source_digest',
        'received_time_text',
        'received_time_precision',
        'uncertainty_note',
        'corrections',
        'interpretations',
      ],
      properties: {
        id: { type: 'integer', minimum: 1 },
        external_key: { type: 'string' },
        original_text: { type: 'string' },
        source_label: { type: 'string' },
        source_locator: { type: 'string' },
        source_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        received_time_text: { type: 'string' },
        received_time_precision: { enum: ['instant', 'day', 'month', 'year', 'unknown'] },
        uncertainty_note: { type: ['string', 'null'] },
        corrections: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'sequence',
              'correction_text',
              'reason',
              'source_label',
              'source_locator',
              'source_digest',
              'asserted_time_text',
              'asserted_time_precision',
              'uncertainty_note',
            ],
            properties: {
              sequence: { type: 'integer', minimum: 1 },
              correction_text: { type: 'string' },
              reason: { type: 'string' },
              source_label: { type: 'string' },
              source_locator: { type: 'string' },
              source_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              asserted_time_text: { type: 'string' },
              asserted_time_precision: {
                enum: ['instant', 'day', 'month', 'year', 'unknown'],
              },
              uncertainty_note: { type: ['string', 'null'] },
            },
          },
        },
        interpretations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'assertion_ref',
              'evidence_ref',
              'interpretation_text',
              'method_label',
              'method_version',
              'epistemic_status',
              'visibility',
            ],
            properties: {
              assertion_ref: { type: 'string' },
              evidence_ref: { type: 'string' },
              interpretation_text: { type: 'string' },
              method_label: { type: 'string' },
              method_version: { type: 'string' },
              epistemic_status: { enum: ['hypothesis', 'supported', 'contested', 'rejected'] },
              visibility: { enum: ['RESTRICTED', 'INTERNAL', 'PUBLIC'] },
            },
          },
        },
      },
    },
  },
} as const;

export const researchWitnessRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { witnessId: string } }>(
    '/api/research/witnesses/:witnessId',
    {
      attachValidation: true,
      schema: {
        tags: ['Research'],
        summary: 'Read one owner-scoped synthetic witness and its provenance chain',
        description:
          'Read-only synthetic example endpoint. Requires an active superadmin witness-steward membership and company membership; testimony must belong to the authenticated user and active company. There is no list, create, update, or delete route. Real testimony remains disabled pending privacy and safeguarding approval.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['witnessId'],
          properties: { witnessId: { type: 'string', pattern: '^[1-9][0-9]{0,14}$' } },
        },
        response: {
          400: { description: 'Witness identifier is malformed.', ...errorSchema },
          200: {
            description: 'Owner-scoped synthetic testimony and provenance.',
            ...successSchema,
          },
          401: { description: 'Bearer authentication is required.', ...errorSchema },
          403: { description: 'Active witness-steward authorization is required.', ...errorSchema },
          404: {
            description: 'Witness is missing or outside the caller scope.',
            ...errorSchema,
          },
          503: { description: 'Witness records are temporarily unavailable.', ...errorSchema },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (request.validationError) {
        return reply.code(400).send({ success: false, error: 'Invalid witness identifier' });
      }
      const auth = request.auth;
      if (!auth) return reply.code(401).send({ success: false, error: 'Authentication required' });
      if (!auth.companyId) {
        return reply.code(403).send({ success: false, error: 'Witness access denied' });
      }
      const testimonyId = Number(request.params.witnessId);
      if (!Number.isSafeInteger(testimonyId)) {
        return reply.code(404).send({ success: false, error: 'Witness record not found' });
      }

      try {
        const witness = await readOwnedSyntheticWitness(
          fastify.db,
          {
            userId: auth.userId,
            companyId: auth.companyId,
            role: auth.role,
          },
          testimonyId
        );
        return reply.send({
          success: true,
          data: {
            id: witness.id,
            external_key: witness.externalKey,
            original_text: witness.originalText,
            source_label: witness.sourceLabel,
            source_locator: witness.sourceLocator,
            source_digest: witness.sourceDigest,
            received_time_text: witness.receivedTimeText,
            received_time_precision: witness.receivedTimePrecision,
            uncertainty_note: witness.uncertaintyNote,
            corrections: witness.corrections.map((correction) => ({
              sequence: correction.sequence,
              correction_text: correction.correctionText,
              reason: correction.reason,
              source_label: correction.sourceLabel,
              source_locator: correction.sourceLocator,
              source_digest: correction.sourceDigest,
              asserted_time_text: correction.assertedTimeText,
              asserted_time_precision: correction.assertedTimePrecision,
              uncertainty_note: correction.uncertaintyNote,
            })),
            interpretations: witness.interpretations.map((interpretation) => ({
              assertion_ref: interpretation.assertionRef,
              evidence_ref: interpretation.evidenceRef,
              interpretation_text: interpretation.interpretationText,
              method_label: interpretation.methodLabel,
              method_version: interpretation.methodVersion,
              epistemic_status: interpretation.epistemicStatus,
              visibility: interpretation.visibility,
            })),
          },
        });
      } catch (error) {
        if (error instanceof WitnessAccessError) {
          const forbidden = error.code === 'FORBIDDEN';
          return reply.code(forbidden ? 403 : 404).send({
            success: false,
            error: forbidden ? 'Witness access denied' : 'Witness record not found',
          });
        }
        request.log.error({ err: error }, 'Synthetic witness could not be read');
        return reply.code(503).send({ success: false, error: 'Witness record is unavailable' });
      }
    }
  );
};
