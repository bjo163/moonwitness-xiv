import type { FastifyPluginAsync } from 'fastify';
import { isRecord } from '@moonwitness/types';
import { readQuranPassageSnapshot, readTextualWitnessPassageSnapshot } from '@moonwitness/corpus';
import { generateLocalAiSuggestion } from '@moonwitness/local-ai';
import {
  resolveConceptProfileEvidence,
  listResearchSuggestionVersions,
  readResearchSuggestionVersion,
  researchSuggestionListMaxLimit,
  storeResearchSuggestions,
} from '@moonwitness/orm-knowledge';
import {
  validateResearchSuggestionEnvelopeWithResolver,
  type TrustedSuggestionResolver,
} from '@moonwitness/research';
import { resolveCorpusDataRoot } from './corpus.routes.js';
import type { Knex } from 'knex';

const sources = [
  {
    source_id: 'mw:source:tanzil-quran-text',
    edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
    locator: 'Q7:46',
  },
  {
    source_id: 'mw:source:ebible-webp-protestant',
    edition_id: 'mw:edition:webp-protestant-2020-stable',
    locator: 'Genesis 1:1',
  },
] as const;
const error = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'error'],
  properties: { success: { const: false }, error: { type: 'string' } },
} as const;

async function localPassage(selector: { source_id: string; edition_id: string; locator: string }) {
  if (
    selector.source_id === sources[0].source_id &&
    selector.edition_id === sources[0].edition_id &&
    selector.locator === sources[0].locator
  ) {
    const result = await readQuranPassageSnapshot({
      rootDirectory: resolveCorpusDataRoot(),
      editionId: selector.edition_id,
      locator: selector.locator,
      use: 'read_analyze',
    });
    return {
      source_id: result.sourceId,
      edition_id: result.passage.editionId,
      locator: result.passage.locator,
      content_sha256: result.passage.sha256,
      text: result.passage.text,
    };
  }
  if (
    selector.source_id === sources[1].source_id &&
    selector.edition_id === sources[1].edition_id &&
    selector.locator === sources[1].locator
  ) {
    const result = await readTextualWitnessPassageSnapshot({
      rootDirectory: resolveCorpusDataRoot(),
      expressionId: 'mw:expression:webp-protestant',
      editionId: selector.edition_id,
      locator: selector.locator,
      use: 'read_analyze',
    });
    return {
      source_id: result.passage.sourceId,
      edition_id: result.passage.editionId,
      locator: result.passage.locator,
      content_sha256: result.passage.sha256,
      text: result.passage.text,
    };
  }
  return null;
}

export const localAiSuggestionRoutes: FastifyPluginAsync = async (fastify) => {
  const bodyWithAdditionalFields = new WeakSet<object>();
  const queryWithAdditionalFields = new WeakSet<object>();
  fastify.get<{ Querystring: { limit?: string } }>(
    '/api/research/suggestions',
    {
      attachValidation: true,
      preValidation: async (request) => {
        // Fastify strips unknown query fields before the handler runs, so capture them first.
        if (isRecord(request.query) && Object.keys(request.query).some((key) => key !== 'limit'))
          queryWithAdditionalFields.add(request);
      },
      schema: {
        tags: ['Research'],
        summary: 'List one bounded page of tenant-scoped INTERNAL candidate identities',
        description:
          'Returns only the newest stored suggestion id, version and digest for the authenticated company. Candidate text and citations are never bulk-exported: every item must be revalidated through the single-candidate read route before it is reviewed.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
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
                required: ['visibility', 'status', 'items', 'truncated'],
                properties: {
                  visibility: { const: 'INTERNAL' },
                  status: { const: 'unreviewed' },
                  truncated: { type: 'boolean' },
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['suggestionId', 'version', 'digest', 'visibility', 'status'],
                      properties: {
                        suggestionId: { type: 'string' },
                        version: { type: 'integer' },
                        digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                        visibility: { const: 'INTERNAL' },
                        status: { const: 'unreviewed' },
                      },
                    },
                  },
                },
              },
            },
          },
          400: error,
          401: error,
          403: error,
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const auth = request.auth;
      if (!auth) return reply.code(401).send({ success: false, error: 'Authentication required' });
      if (
        !['user', 'superadmin'].includes(auth.role) ||
        !Number.isSafeInteger(auth.userId) ||
        auth.userId < 1 ||
        !Number.isSafeInteger(auth.companyId) ||
        !auth.companyId
      )
        return reply.code(403).send({ success: false, error: 'Suggestion list is unavailable' });
      const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
      if (
        request.validationError ||
        queryWithAdditionalFields.has(request) ||
        (request.query.limit !== undefined && String(limit) !== request.query.limit) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > researchSuggestionListMaxLimit
      )
        return reply.code(400).send({ success: false, error: 'Invalid suggestion list page size' });
      try {
        const page = await listResearchSuggestionVersions(fastify.db, {
          authenticatedReader: {
            userId: auth.userId,
            companyId: auth.companyId,
            role: auth.role as 'user' | 'superadmin',
          },
          limit,
        });
        return reply.send({
          success: true,
          data: {
            visibility: 'INTERNAL',
            status: 'unreviewed',
            truncated: page.truncated,
            items: page.items,
          },
        });
      } catch {
        return reply.code(403).send({ success: false, error: 'Suggestion list is unavailable' });
      }
    }
  );
  fastify.get<{ Params: { suggestionId: string }; Querystring: { version?: string } }>(
    '/api/research/suggestions/:suggestionId',
    {
      attachValidation: true,
      schema: {
        tags: ['Research'],
        summary: 'Read one tenant-scoped INTERNAL local research candidate',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['suggestionId'],
          properties: {
            suggestionId: { type: 'string', pattern: '^mw:suggestion:[a-z0-9][a-z0-9._-]{0,179}$' },
          },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { version: { type: 'string', pattern: '^[1-9][0-9]{0,8}$' } },
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
                required: [
                  'suggestionId',
                  'version',
                  'digest',
                  'visibility',
                  'status',
                  'suggestion',
                ],
                properties: {
                  suggestionId: { type: 'string' },
                  version: { type: 'integer' },
                  digest: { type: 'string' },
                  visibility: { const: 'INTERNAL' },
                  status: { const: 'unreviewed' },
                  suggestion: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
          400: error,
          401: error,
          403: error,
          404: error,
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const auth = request.auth;
      if (!auth) return reply.code(401).send({ success: false, error: 'Authentication required' });
      const userId = auth.userId;
      const companyId = auth.companyId;
      if (
        !['user', 'superadmin'].includes(auth.role) ||
        !Number.isSafeInteger(userId) ||
        !userId ||
        userId < 1 ||
        !Number.isSafeInteger(companyId) ||
        !companyId ||
        companyId < 1
      )
        return reply.code(403).send({ success: false, error: 'Suggestion is unavailable' });
      const version =
        request.query.version === undefined ? undefined : Number(request.query.version);
      if (
        request.validationError ||
        (version !== undefined &&
          (!Number.isSafeInteger(version) ||
            version < 1 ||
            String(version) !== request.query.version))
      )
        return reply.code(400).send({ success: false, error: 'Invalid suggestion version' });
      const actor = { userId, companyId, role: auth.role as 'user' | 'superadmin' };
      try {
        // The preliminary lookup only constrains the resolver to citations in this candidate.
        // The store then reloads and verifies the exact row in its transaction.
        const row = await fastify
          .db('knowledge_research_suggestion_versions')
          .where({ company_id: actor.companyId, suggestion_id: request.params.suggestionId })
          .modify((query) => {
            if (version !== undefined) query.andWhere({ version });
          })
          .orderBy('version', 'desc')
          .first('suggestion_json');
        if (!row)
          return reply.code(404).send({ success: false, error: 'Suggestion is unavailable' });
        const value: unknown = JSON.parse(String(row.suggestion_json));
        if (!isRecord(value) || !Array.isArray(value.citations))
          return reply.code(404).send({ success: false, error: 'Suggestion is unavailable' });
        const citations = value.citations.filter(isRecord);
        if (citations.length !== value.citations.length)
          return reply.code(404).send({ success: false, error: 'Suggestion is unavailable' });
        const expected = new Map<
          string,
          {
            assertionId: string;
            selector: {
              source_id: string;
              edition_id: string;
              locator: string;
              content_sha256: string;
            };
          }
        >();
        for (const citation of citations) {
          if (
            typeof citation.evidence_id !== 'string' ||
            typeof citation.assertion_id !== 'string' ||
            !isRecord(citation.selector)
          )
            return reply.code(404).send({ success: false, error: 'Suggestion is unavailable' });
          const selector = citation.selector;
          if (
            typeof selector.source_id !== 'string' ||
            typeof selector.edition_id !== 'string' ||
            typeof selector.locator !== 'string' ||
            typeof selector.content_sha256 !== 'string'
          )
            return reply.code(404).send({ success: false, error: 'Suggestion is unavailable' });
          expected.set(citation.evidence_id, {
            assertionId: citation.assertion_id,
            selector: selector as {
              source_id: string;
              edition_id: string;
              locator: string;
              content_sha256: string;
            },
          });
        }
        const resolverForTransaction = (
          database: Knex | Knex.Transaction
        ): TrustedSuggestionResolver => ({
          async resolvePassage(selector) {
            const item = [...expected.values()].find(
              (candidate) =>
                candidate.selector.source_id === selector.source_id &&
                candidate.selector.edition_id === selector.edition_id &&
                candidate.selector.locator === selector.locator &&
                candidate.selector.content_sha256 === selector.content_sha256
            );
            if (
              !item ||
              !sources.some(
                (source) =>
                  source.source_id === selector.source_id &&
                  source.edition_id === selector.edition_id &&
                  source.locator === selector.locator
              )
            )
              return null;
            const passage = await localPassage(selector);
            return passage && passage.content_sha256 === selector.content_sha256
              ? { ...passage, readable: true }
              : null;
          },
          async resolveAssertion(id) {
            for (const [evidenceId, item] of expected)
              if (item.assertionId === id) {
                const trusted = await resolveConceptProfileEvidence(database, evidenceId, {
                  authenticatedReader: actor,
                  corpusRootDirectory: resolveCorpusDataRoot(),
                });
                if (trusted?.access === 'readable' && trusted.canonicalEvidence.assertion_id === id)
                  return { active: true, readable: true };
              }
            return null;
          },
          async resolveEvidence(id) {
            const item = expected.get(id);
            if (!item) return null;
            const trusted = await resolveConceptProfileEvidence(database, id, {
              authenticatedReader: actor,
              corpusRootDirectory: resolveCorpusDataRoot(),
            });
            return trusted?.access === 'readable' &&
              trusted.canonicalEvidence.assertion_id === item.assertionId
              ? { assertion_id: item.assertionId, active: true, readable: true }
              : null;
          },
        });
        const stored = await readResearchSuggestionVersion(fastify.db, {
          authenticatedReader: actor,
          suggestionId: request.params.suggestionId,
          version,
          resolverForTransaction,
        });
        if (!stored)
          return reply.code(404).send({ success: false, error: 'Suggestion is unavailable' });
        return reply.send({
          success: true,
          data: {
            suggestionId: stored.suggestionId,
            version: stored.version,
            digest: stored.digest,
            visibility: stored.visibility,
            status: stored.status,
            suggestion: stored.suggestion,
          },
        });
      } catch {
        return reply.code(404).send({ success: false, error: 'Suggestion is unavailable' });
      }
    }
  );
  fastify.post<{ Body: unknown }>(
    '/api/research/suggestions/generate',
    {
      attachValidation: true,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preValidation: async (request) => {
        if (
          isRecord(request.body) &&
          Object.keys(request.body).some((key) => !['kind', 'evidence_ids'].includes(key))
        )
          bodyWithAdditionalFields.add(request);
      },
      schema: {
        tags: ['Research'],
        summary: 'Generate an INTERNAL local research candidate from approved sample evidence',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'evidence_ids'],
          properties: {
            kind: { enum: ['summary', 'term', 'duplicate'] },
            evidence_ids: {
              type: 'array',
              minItems: 1,
              maxItems: 2,
              uniqueItems: true,
              items: { type: 'string', pattern: '^mw:evidence:[a-z0-9][a-z0-9._-]{0,179}$' },
            },
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
                required: ['status', 'visibility', 'candidates'],
                properties: {
                  status: { const: 'unreviewed' },
                  visibility: { const: 'INTERNAL' },
                  candidates: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['suggestionId', 'version', 'digest', 'idempotent'],
                      properties: {
                        suggestionId: { type: 'string' },
                        version: { type: 'integer' },
                        digest: { type: 'string' },
                        idempotent: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
          400: error,
          401: error,
          403: error,
          404: error,
          429: {
            type: 'object',
            additionalProperties: false,
            required: ['statusCode', 'error', 'message'],
            properties: {
              statusCode: { const: 429 },
              error: { const: 'Too Many Requests' },
              message: { type: 'string' },
            },
          },
          503: error,
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const auth = request.auth;
      if (!auth) return reply.code(401).send({ success: false, error: 'Authentication required' });
      if (
        !['user', 'superadmin'].includes(auth.role) ||
        !Number.isSafeInteger(auth.userId) ||
        auth.userId < 1 ||
        !Number.isSafeInteger(auth.companyId) ||
        !auth.companyId
      )
        return reply.code(403).send({ success: false, error: 'Evidence is unavailable' });
      const body = request.body;
      if (
        request.validationError ||
        bodyWithAdditionalFields.has(request) ||
        !isRecord(body) ||
        Object.keys(body).some((key) => !['kind', 'evidence_ids'].includes(key)) ||
        !['summary', 'term', 'duplicate'].includes(String(body.kind)) ||
        !Array.isArray(body.evidence_ids) ||
        body.evidence_ids.length < 1 ||
        body.evidence_ids.length > 2 ||
        new Set(body.evidence_ids).size !== body.evidence_ids.length ||
        (body.kind === 'duplicate'
          ? body.evidence_ids.length !== 2
          : body.evidence_ids.length !== 1)
      )
        return reply.code(400).send({ success: false, error: 'Invalid suggestion request' });
      const actor = {
        userId: auth.userId,
        companyId: auth.companyId,
        role: auth.role as 'user' | 'superadmin',
      };
      try {
        const evidence = new Map<
          string,
          NonNullable<Awaited<ReturnType<typeof resolveConceptProfileEvidence>>>
        >();
        for (const id of body.evidence_ids) {
          if (typeof id !== 'string')
            return reply.code(400).send({ success: false, error: 'Invalid suggestion request' });
          const trusted = await resolveConceptProfileEvidence(fastify.db, id, {
            authenticatedReader: actor,
            corpusRootDirectory: resolveCorpusDataRoot(),
          });
          if (
            !trusted ||
            trusted.access !== 'readable' ||
            !sources.some(
              (source) =>
                source.source_id === trusted.canonicalEvidence.selector.source_id &&
                source.edition_id === trusted.canonicalEvidence.selector.edition_id &&
                source.locator === trusted.canonicalEvidence.selector.locator
            )
          )
            return reply.code(404).send({ success: false, error: 'Evidence is unavailable' });
          evidence.set(id, trusted);
        }
        const passages = [];
        for (const [evidenceId, trusted] of evidence) {
          const selector = trusted.canonicalEvidence.selector;
          const passage = await localPassage({
            source_id: selector.source_id,
            edition_id: selector.edition_id,
            locator: selector.locator,
          });
          if (!passage || passage.content_sha256 !== selector.content_sha256)
            return reply.code(404).send({ success: false, error: 'Evidence is unavailable' });
          passages.push({
            source_id: passage.source_id,
            edition_id: passage.edition_id,
            locator: passage.locator,
            content_sha256: passage.content_sha256,
            evidence_id: evidenceId,
            assertion_id: trusted.canonicalEvidence.assertion_id,
            text: passage.text,
          });
        }
        const createResolver = (database: Knex | Knex.Transaction): TrustedSuggestionResolver => ({
          async resolvePassage(selector) {
            const requested = [...evidence.entries()].find(([, item]) => {
              const source = item.canonicalEvidence.selector;
              return (
                item.access === 'readable' &&
                source.source_id === selector.source_id &&
                source.edition_id === selector.edition_id &&
                source.locator === selector.locator &&
                source.content_sha256 === selector.content_sha256
              );
            });
            if (!requested) return null;
            const [evidenceId, original] = requested;
            const trusted = await resolveConceptProfileEvidence(database, evidenceId, {
              authenticatedReader: actor,
              corpusRootDirectory: resolveCorpusDataRoot(),
            });
            if (!trusted) return null;
            const source = trusted.canonicalEvidence.selector;
            const originalSource = original.canonicalEvidence.selector;
            if (
              trusted.access !== 'readable' ||
              trusted.canonicalEvidence.assertion_id !== original.canonicalEvidence.assertion_id ||
              source.source_id !== originalSource.source_id ||
              source.edition_id !== originalSource.edition_id ||
              source.locator !== originalSource.locator ||
              source.content_sha256 !== originalSource.content_sha256
            )
              return null;
            const passage = await localPassage({
              source_id: source.source_id,
              edition_id: source.edition_id,
              locator: source.locator,
            });
            return passage && passage.content_sha256 === selector.content_sha256
              ? { ...passage, readable: true }
              : null;
          },
          async resolveAssertion(id) {
            for (const [evidenceId, original] of evidence) {
              if (original.canonicalEvidence.assertion_id !== id) continue;
              const trusted = await resolveConceptProfileEvidence(database, evidenceId, {
                authenticatedReader: actor,
                corpusRootDirectory: resolveCorpusDataRoot(),
              });
              if (trusted?.access === 'readable' && trusted.canonicalEvidence.assertion_id === id)
                return { active: true, readable: true };
            }
            return null;
          },
          async resolveEvidence(id) {
            const original = evidence.get(id);
            if (!original) return null;
            const trusted = await resolveConceptProfileEvidence(database, id, {
              authenticatedReader: actor,
              corpusRootDirectory: resolveCorpusDataRoot(),
            });
            return trusted?.access === 'readable' &&
              trusted.canonicalEvidence.assertion_id === original.canonicalEvidence.assertion_id
              ? {
                  assertion_id: trusted.canonicalEvidence.assertion_id,
                  active: true,
                  readable: true,
                }
              : null;
          },
        });
        const resolver = createResolver(fastify.db);
        const result = await generateLocalAiSuggestion({
          runtime: fastify.localAi,
          request: { kind: body.kind as 'summary' | 'term' | 'duplicate', passages },
          validate: (value) => validateResearchSuggestionEnvelopeWithResolver(value, resolver),
        });
        if (result.status === 'disabled' || result.status === 'unavailable')
          return reply
            .code(503)
            .send({ success: false, error: 'Local suggestion generation is unavailable' });
        if (result.status !== 'candidate')
          return reply.code(400).send({
            success: false,
            error: 'Generated suggestion did not pass trusted validation',
          });
        const stored = await storeResearchSuggestions(fastify.db, {
          authenticatedActor: actor,
          resolverForTransaction: (trx) => createResolver(trx),
          envelope: result.value,
        });
        return reply.send({
          success: true,
          data: {
            status: 'unreviewed',
            visibility: 'INTERNAL',
            candidates: stored.map(({ suggestionId, version, digest, idempotent }) => ({
              suggestionId,
              version,
              digest,
              idempotent,
            })),
          },
        });
      } catch {
        return reply.code(404).send({ success: false, error: 'Evidence is unavailable' });
      }
    }
  );
};
