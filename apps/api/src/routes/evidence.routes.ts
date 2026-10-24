import type { ResolvablePassage, ResearchEvidenceReference } from '@moonwitness/research';
import {
  EvidenceResolutionError,
  researchEvidenceSelectorSchema,
  resolveResearchEvidenceReference,
} from '@moonwitness/research';
import type { FastifyPluginAsync } from 'fastify';
import { readQuranPassage, readTextualWitnessPassage } from '@moonwitness/corpus';
import { resolveCorpusDataRoot } from './corpus.routes.js';

const quranSourceId = 'mw:source:tanzil-quran-text';
const quranEditionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
const quranLocator = 'Q7:46';
const webpSourceId = 'mw:source:ebible-webp-protestant';
const webpExpressionId = 'mw:expression:webp-protestant';
const webpEditionId = 'mw:edition:webp-protestant-2020-stable';
const webpLocator = 'Genesis 1:1';

// Fastify's default request validator uses draft-07. The local research package
// validates the complete 2020-12 contract; omit the dialect marker here so
// Fastify can still apply its compatible structural validation before handler.
const requestSchema = { ...researchEvidenceSelectorSchema } as Record<string, unknown>;
delete requestSchema.$schema;

function inlineEvidenceSchemaReferences(
  value: unknown,
  definitions: Record<string, unknown>
): unknown {
  if (Array.isArray(value))
    return value.map((item) => inlineEvidenceSchemaReferences(item, definitions));
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (typeof object.$ref === 'string' && object.$ref.startsWith('#/$defs/')) {
    const name = object.$ref.slice('#/$defs/'.length);
    return inlineEvidenceSchemaReferences(definitions[name], definitions);
  }
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => key !== '$schema' && key !== '$id' && key !== '$defs')
      .map(([key, item]) => [key, inlineEvidenceSchemaReferences(item, definitions)])
  );
}

const evidenceResponseSchema = inlineEvidenceSchemaReferences(
  researchEvidenceSelectorSchema,
  researchEvidenceSelectorSchema.$defs as Record<string, unknown>
);

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'error'],
  properties: { success: { const: false }, error: { type: 'string' } },
} as const;

const resolvedResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'data'],
  properties: {
    success: { const: true },
    data: {
      type: 'object',
      additionalProperties: false,
      required: [
        'evidence',
        'direction',
        'source_id',
        'edition_id',
        'locator',
        'content_sha256',
        'citation',
        'excerpt',
      ],
      properties: {
        evidence: evidenceResponseSchema,
        direction: { enum: ['supporting', 'counterevidence'] },
        source_id: { type: 'string' },
        expression_id: { type: 'string' },
        edition_id: { type: 'string' },
        locator: { type: 'string' },
        content_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        citation: { type: 'string', minLength: 1 },
        excerpt: { type: 'string', minLength: 1 },
        range: {
          type: 'object',
          additionalProperties: false,
          required: ['unit', 'start', 'end'],
          properties: {
            unit: { const: 'unicode_scalar' },
            start: { type: 'integer', minimum: 0 },
            end: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
  },
} as const;

async function lookupPassage(
  editionId: string,
  locator: string
): Promise<ResolvablePassage | null> {
  const rootDirectory = resolveCorpusDataRoot();
  if (editionId === quranEditionId && locator === quranLocator) {
    const passage = await readQuranPassage({
      rootDirectory,
      editionId,
      locator,
      use: 'quote_excerpt',
    });
    return {
      source_id: quranSourceId,
      edition_id: passage.editionId,
      locator: passage.locator,
      text: passage.text,
      content_sha256: passage.sha256,
      citation: passage.attribution,
    };
  }
  if (editionId === webpEditionId && locator === webpLocator) {
    const passage = await readTextualWitnessPassage({
      rootDirectory,
      expressionId: webpExpressionId,
      editionId,
      locator,
    });
    return {
      source_id: webpSourceId,
      expression_id: passage.expressionId,
      edition_id: passage.editionId,
      locator: passage.locator,
      text: passage.text,
      content_sha256: passage.sha256,
      citation: passage.attribution,
    };
  }
  return null;
}

function httpError(error: EvidenceResolutionError): { status: number; message: string } {
  switch (error.code) {
    case 'invalid_selector':
    case 'range_invalid':
      return { status: 400, message: error.message };
    case 'passage_not_found':
      return { status: 404, message: error.message };
    case 'identity_mismatch':
    case 'content_hash_mismatch':
    case 'quote_mismatch':
      return { status: 409, message: error.message };
  }
}

export const evidenceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: ResearchEvidenceReference }>(
    '/api/research/evidence/resolve',
    {
      onRequest: async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store');
        if (!request.auth) {
          return reply.code(401).send({ success: false, error: 'Authentication required' });
        }
        const hasActiveCompanyContext =
          Number.isInteger(request.auth.companyId) && (request.auth.companyId ?? 0) > 0;
        if (
          (request.auth.role !== 'user' && request.auth.role !== 'superadmin') ||
          !hasActiveCompanyContext
        ) {
          return reply.code(403).send({ success: false, error: 'Research access denied' });
        }
      },
      schema: {
        tags: ['Research'],
        summary: 'Resolve an exact evidence selector against the local corpus',
        description:
          'Requires an authenticated user or superadmin with an active company context. Validates canonical source, expression, edition, passage, content hash, optional Unicode-scalar range, and supporting/counterevidence direction. No source is fetched over the network.',
        security: [{ bearerAuth: [] }],
        body: requestSchema,
        response: {
          200: {
            description: 'Resolved canonical evidence selector and exact cited excerpt.',
            ...resolvedResponseSchema,
          },
          400: {
            description: 'Malformed evidence selector or out-of-range character selection.',
            ...errorSchema,
          },
          401: {
            description: 'Bearer authentication is required.',
            ...errorSchema,
          },
          404: {
            description: 'The selected local source passage does not exist.',
            ...errorSchema,
          },
          409: {
            description: 'The selector identity, hash, or quoted text does not match the source.',
            ...errorSchema,
          },
          503: {
            description: 'The local source or rights manifest could not be verified.',
            ...errorSchema,
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const resolved = await resolveResearchEvidenceReference(request.body, lookupPassage);
        return reply
          .header('Cache-Control', 'private, no-store')
          .send({ success: true, data: resolved });
      } catch (error) {
        if (error instanceof EvidenceResolutionError) {
          const result = httpError(error);
          return reply.code(result.status).send({ success: false, error: result.message });
        }
        request.log.error({ err: error }, 'Local evidence selector resolution failed');
        return reply
          .code(503)
          .send({ success: false, error: 'Local evidence source is unavailable' });
      }
    }
  );
};
