import type { CorpusPassage, SourceCitation } from '@moonwitness/client';
import type { FastifyPluginAsync } from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readQuranPassage, readTextualWitnessPassage } from '@moonwitness/corpus';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const quranSourceId = 'mw:source:tanzil-quran-text';
const quranEditionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
const quranLocator = 'Q7:46';
const webpSourceId = 'mw:source:ebible-webp-protestant';
const webpExpressionId = 'mw:expression:webp-protestant';
const webpEditionId = 'mw:edition:webp-protestant-2020-stable';
const webpLocator = 'Genesis 1:1';

const errorResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'error'],
  properties: {
    success: { const: false },
    error: { type: 'string' },
  },
} as const;

const sourceCitationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'data'],
  properties: {
    success: { const: true },
    data: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'sourceId',
            'editionId',
            'locale',
            'publication',
            'citation',
            'references',
            'availablePassages',
          ],
          properties: {
            sourceId: { const: quranSourceId },
            editionId: { const: quranEditionId },
            locale: { const: 'ar' },
            publication: { const: 'source_bytes' },
            citation: { type: 'string', minLength: 1 },
            references: { type: 'array', items: { type: 'string', format: 'uri' } },
            availablePassages: { type: 'array', items: { const: quranLocator } },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'sourceId',
            'expressionId',
            'editionId',
            'locale',
            'publication',
            'citation',
            'references',
            'availablePassages',
          ],
          properties: {
            sourceId: { const: webpSourceId },
            expressionId: { const: webpExpressionId },
            editionId: { const: webpEditionId },
            locale: { const: 'en-US' },
            publication: { const: 'source_bytes' },
            citation: { type: 'string', minLength: 1 },
            references: { type: 'array', items: { type: 'string', format: 'uri' } },
            availablePassages: { type: 'array', items: { const: webpLocator } },
          },
        },
      ],
    },
  },
} as const;

const passageResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'data'],
  properties: {
    success: { const: true },
    data: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['sourceId', 'editionId', 'locator', 'text', 'sha256', 'citation'],
          properties: {
            sourceId: { const: quranSourceId },
            editionId: { const: quranEditionId },
            locator: { const: quranLocator },
            text: { type: 'string', minLength: 1 },
            sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            citation: { type: 'string', minLength: 1 },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'sourceId',
            'expressionId',
            'editionId',
            'locator',
            'text',
            'sha256',
            'citation',
          ],
          properties: {
            sourceId: { const: webpSourceId },
            expressionId: { const: webpExpressionId },
            editionId: { const: webpEditionId },
            locator: { const: webpLocator },
            text: { type: 'string', minLength: 1 },
            sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            citation: { type: 'string', minLength: 1 },
          },
        },
      ],
    },
  },
} as const;

const errorResponses = {
  401: {
    description: 'Bearer authentication is required.',
    headers: { 'WWW-Authenticate': { schema: { type: 'string' } } },
    ...errorResponseSchema,
  },
  404: {
    description: 'The source or exact edition/locator pair is not published.',
    ...errorResponseSchema,
  },
  503: {
    description: 'The local artifact, rights manifest, or checksum could not be verified.',
    ...errorResponseSchema,
  },
} as const;

/** Resolve the data root while supporting the container layout (`/app/corpus`). */
export function resolveCorpusDataRoot(): string {
  const corpusDirectory = process.env.MOONWITNESS_CORPUS_ROOT;
  return corpusDirectory ? path.dirname(path.resolve(corpusDirectory)) : repositoryRoot;
}

async function readPublishedPassage(
  editionId: string,
  locator: string
): Promise<CorpusPassage | null> {
  if (editionId === quranEditionId && locator === quranLocator) {
    const passage = await readQuranPassage({
      rootDirectory: resolveCorpusDataRoot(),
      editionId,
      locator,
      use: 'quote_excerpt',
    });
    return {
      sourceId: quranSourceId,
      editionId: passage.editionId as typeof quranEditionId,
      locator: passage.locator as typeof quranLocator,
      text: passage.text,
      sha256: passage.sha256,
      citation: passage.attribution,
    };
  }
  if (editionId === webpEditionId && locator === webpLocator) {
    const passage = await readTextualWitnessPassage({
      rootDirectory: resolveCorpusDataRoot(),
      expressionId: webpExpressionId,
      editionId,
      locator,
    });
    return {
      sourceId: webpSourceId,
      expressionId: passage.expressionId as typeof webpExpressionId,
      editionId: passage.editionId as typeof webpEditionId,
      locator: passage.locator as typeof webpLocator,
      text: passage.text,
      sha256: passage.sha256,
      citation: passage.attribution,
    };
  }
  return null;
}

async function readPublishedSource(sourceId: string): Promise<SourceCitation | null> {
  if (sourceId === quranSourceId) {
    const passage = await readPublishedPassage(quranEditionId, quranLocator);
    if (!passage) return null;
    return {
      sourceId: quranSourceId,
      editionId: quranEditionId,
      locale: 'ar',
      publication: 'source_bytes',
      citation: passage.citation,
      references: [
        'https://tanzil.net/',
        'https://tanzil.net/docs/Text_License',
        'https://creativecommons.org/licenses/by/3.0/',
      ],
      availablePassages: [quranLocator],
    };
  }
  if (sourceId === webpSourceId) {
    const passage = await readPublishedPassage(webpEditionId, webpLocator);
    if (!passage || !('expressionId' in passage)) return null;
    const references = [
      'https://ebible.org/engwebp/GEN01.htm',
      'https://ebible.org/find/show.php?id=engwebp',
      'https://ebible.org/engwebp/copyright.htm',
    ];
    return {
      sourceId: webpSourceId,
      expressionId: passage.expressionId,
      editionId: webpEditionId,
      locale: 'en-US',
      publication: 'source_bytes',
      citation: passage.citation,
      references,
      availablePassages: [webpLocator],
    };
  }
  return null;
}

export const corpusRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { sourceId: string } }>(
    '/api/corpus/sources/:sourceId',
    {
      schema: {
        tags: ['Corpus'],
        summary: 'Look up citation metadata for a published local source',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['sourceId'],
          properties: { sourceId: { type: 'string', minLength: 1, maxLength: 128 } },
        },
        response: {
          200: {
            description: 'Citation for a locally verified published source.',
            ...sourceCitationResponseSchema,
          },
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      if (![quranSourceId, webpSourceId].includes(request.params.sourceId)) {
        return reply.code(404).send({ success: false, error: 'Source not found' });
      }
      try {
        const source = await readPublishedSource(request.params.sourceId);
        if (!source) return reply.code(404).send({ success: false, error: 'Source not found' });
        return reply
          .header('Cache-Control', 'private, no-store')
          .send({ success: true, data: source });
      } catch (error) {
        request.log.error({ err: error }, 'Local source citation lookup failed');
        return reply.code(503).send({ success: false, error: 'Source is unavailable' });
      }
    }
  );

  fastify.get<{ Params: { editionId: string; locator: string } }>(
    '/api/corpus/passages/:editionId/:locator',
    {
      schema: {
        tags: ['Corpus'],
        summary: 'Read an exact locally published passage',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['editionId', 'locator'],
          properties: {
            editionId: { type: 'string', minLength: 1, maxLength: 128 },
            locator: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        response: {
          200: {
            description: 'Exact text and citation for a locally verified passage.',
            ...passageResponseSchema,
          },
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      if (!(
        (request.params.editionId === quranEditionId && request.params.locator === quranLocator) ||
        (request.params.editionId === webpEditionId && request.params.locator === webpLocator)
      )) {
        return reply.code(404).send({ success: false, error: 'Passage not found' });
      }
      try {
        const passage = await readPublishedPassage(
          request.params.editionId,
          request.params.locator
        );
        if (!passage) return reply.code(404).send({ success: false, error: 'Passage not found' });
        return reply
          .header('Cache-Control', 'private, no-store')
          .send({ success: true, data: passage });
      } catch (error) {
        request.log.error({ err: error }, 'Local passage lookup failed');
        return reply.code(503).send({ success: false, error: 'Passage is unavailable' });
      }
    }
  );
};
