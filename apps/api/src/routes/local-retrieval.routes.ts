import type { FastifyPluginAsync } from 'fastify';
import { isRecord } from '@moonwitness/types';
import { readQuranPassageSnapshot } from '@moonwitness/corpus';
import {
  LocalRetrievalError,
  retrieveLocalPassageChunk,
  type CanonicalPassageReference,
  type LocalPassageResolver,
  type ResolvedCanonicalPassage,
} from '@moonwitness/local-ai';
import { resolveConceptProfileEvidence } from '@moonwitness/orm-knowledge';
import { resolveCorpusDataRoot } from './corpus.routes.js';

const quranReference = Object.freeze({
  sourceId: 'mw:source:tanzil-quran-text',
  editionId: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
  locator: 'Q7:46',
  sourceSha256: '6ff83b01099fb7992b5f7fa101cfab3d6556607ca6b1fe69d53cb76f97027760',
});
const quranManifestPath = 'corpus/manifests/tanzil-quran-text-v1.1-uthmani-q7-46.json';

function exactQuranReference(value: CanonicalPassageReference): boolean {
  return (
    value.sourceId === quranReference.sourceId &&
    value.editionId === quranReference.editionId &&
    value.locator === quranReference.locator &&
    value.sourceSha256 === quranReference.sourceSha256
  );
}

function parseBody(value: unknown): {
  evidence_id: string;
  byte_start?: number;
  byte_end?: number;
} | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['evidence_id', 'byte_start', 'byte_end'].includes(key)) ||
    typeof value.evidence_id !== 'string' ||
    !/^mw:evidence:[a-z0-9][a-z0-9._-]{0,179}$/u.test(value.evidence_id) ||
    (value.byte_start !== undefined &&
      (!Number.isSafeInteger(value.byte_start) || Number(value.byte_start) < 0)) ||
    (value.byte_end !== undefined &&
      (!Number.isSafeInteger(value.byte_end) || Number(value.byte_end) < 1))
  ) {
    return null;
  }
  return {
    evidence_id: value.evidence_id,
    ...(value.byte_start === undefined ? {} : { byte_start: Number(value.byte_start) }),
    ...(value.byte_end === undefined ? {} : { byte_end: Number(value.byte_end) }),
  };
}

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'error'],
  properties: { success: { const: false }, error: { type: 'string' } },
} as const;

export const localRetrievalRoutes: FastifyPluginAsync = async (fastify) => {
  const bodyWithAdditionalFields = new WeakSet<object>();
  fastify.post<{ Body: unknown }>(
    '/api/research/retrieval/chunk',
    {
      attachValidation: true,
      preValidation: async (request) => {
        if (
          isRecord(request.body) &&
          Object.keys(request.body).some(
            (key) => !['evidence_id', 'byte_start', 'byte_end'].includes(key)
          )
        ) {
          bodyWithAdditionalFields.add(request);
        }
      },
      schema: {
        tags: ['Research'],
        summary: 'Retrieve a permission-checked chunk from approved local Tanzil Q7:46 evidence',
        description:
          'Uses an active canonical evidence record and server-authenticated company context. Only the owner-approved Tanzil Q7:46 source is available; no runtime fetch or model call occurs.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['evidence_id'],
          properties: {
            evidence_id: { type: 'string', pattern: '^mw:evidence:[a-z0-9][a-z0-9._-]{0,179}$' },
            byte_start: { type: 'integer', minimum: 0 },
            byte_end: { type: 'integer', minimum: 1 },
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
                required: ['chunk', 'citation', 'span'],
                properties: {
                  chunk: { type: 'string', minLength: 1 },
                  citation: {
                    type: 'object',
                    additionalProperties: false,
                    required: [
                      'sourceId',
                      'editionId',
                      'locator',
                      'sourceSha256',
                      'sourceManifestPath',
                      'attribution',
                    ],
                    properties: {
                      sourceId: { type: 'string' },
                      editionId: { type: 'string' },
                      locator: { const: 'Q7:46' },
                      sourceSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                      sourceManifestPath: { type: 'string' },
                      attribution: { type: 'string', minLength: 1 },
                    },
                  },
                  span: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['basis', 'byteStart', 'byteEnd', 'scalarStart', 'scalarEnd'],
                    properties: {
                      basis: { const: 'resolved_passage_text' },
                      byteStart: { type: 'integer', minimum: 0 },
                      byteEnd: { type: 'integer', minimum: 1 },
                      scalarStart: { type: 'integer', minimum: 0 },
                      scalarEnd: { type: 'integer', minimum: 1 },
                    },
                  },
                },
              },
            },
          },
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const auth = request.auth;
      if (!auth) return reply.code(401).send({ success: false, error: 'Authentication required' });
      if (
        (auth.role !== 'user' && auth.role !== 'superadmin') ||
        !Number.isSafeInteger(auth.userId) ||
        auth.userId < 1 ||
        typeof auth.companyId !== 'number' ||
        !Number.isSafeInteger(auth.companyId) ||
        !auth.companyId
      ) {
        return reply.code(403).send({ success: false, error: 'Evidence is unavailable' });
      }
      const body = parseBody(request.body);
      if (request.validationError || bodyWithAdditionalFields.has(request) || !body) {
        return reply.code(400).send({ success: false, error: 'Invalid retrieval request' });
      }

      try {
        const trusted = await resolveConceptProfileEvidence(fastify.db, body.evidence_id, {
          authenticatedReader: {
            userId: auth.userId,
            companyId: auth.companyId,
            role: auth.role,
          },
          corpusRootDirectory: resolveCorpusDataRoot(),
        });
        if (
          !trusted ||
          trusted.access !== 'readable' ||
          trusted.canonicalEvidence.id !== body.evidence_id ||
          trusted.canonicalEvidence.selector.source_id !== quranReference.sourceId ||
          trusted.canonicalEvidence.selector.edition_id !== quranReference.editionId ||
          trusted.canonicalEvidence.selector.locator !== quranReference.locator ||
          trusted.canonicalEvidence.selector.content_sha256 !== quranReference.sourceSha256
        ) {
          return reply.code(404).send({ success: false, error: 'Evidence is unavailable' });
        }

        const snapshot = await readQuranPassageSnapshot({
          rootDirectory: resolveCorpusDataRoot(),
          editionId: quranReference.editionId,
          locator: quranReference.locator,
          use: 'read_analyze',
        });
        if (snapshot.sourceId !== quranReference.sourceId) {
          return reply.code(404).send({ success: false, error: 'Evidence is unavailable' });
        }

        const passage: ResolvedCanonicalPassage = {
          reference: quranReference,
          text: snapshot.passage.text,
          visibility: 'PUBLIC_APPROVED',
          sourceManifestPath: quranManifestPath,
          artifactBytes: snapshot.passage.originalBytes,
          sourceManifestBytes: snapshot.sourceManifestBytes,
        };
        const resolver: LocalPassageResolver = {
          resolve: async (reference) => (exactQuranReference(reference) ? passage : null),
          canRead: async (candidate) =>
            trusted.access === 'readable' &&
            trusted.canonicalEvidence.id === body.evidence_id &&
            exactQuranReference(candidate.reference),
        };
        const chunk = await retrieveLocalPassageChunk(
          {
            reference: quranReference,
            ...(body.byte_start === undefined ? {} : { byteStart: body.byte_start }),
            ...(body.byte_end === undefined ? {} : { byteEnd: body.byte_end }),
          },
          resolver
        );
        return reply.send({
          success: true,
          data: { chunk: chunk.text, citation: chunk.citation, span: chunk.sourceSpan },
        });
      } catch (error) {
        if (error instanceof LocalRetrievalError) {
          return reply.code(404).send({ success: false, error: 'Evidence is unavailable' });
        }
        // Resolver/auth failures share a generic denial so protected graph details do not leak.
        return reply.code(404).send({ success: false, error: 'Evidence is unavailable' });
      }
    }
  );
};
