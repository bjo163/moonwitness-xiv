import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  explainResearchRelation,
  validateResearchAssertion,
  validateResearchEvidenceReference,
  validateResearchRelation,
  type ResearchEvidenceReference,
  type ResearchAssertion,
  type ResearchGraphInput,
  type ResearchGraphNode,
  type ResearchRelation,
  type ResearchVisibility,
} from '@moonwitness/research';
import {
  readActiveResearchGraphRelease,
  validateResearchRelease,
  type StoredResearchGraphRecord,
  type StoredResearchGraphRelease,
} from '@moonwitness/orm-knowledge';
import { readQuranPassage, readTextualWitnessPassage } from '@moonwitness/corpus';
import type { Knex } from 'knex';
import type { AuthContext } from '../plugins/auth.plugin.js';
import { resolveCorpusDataRoot } from './corpus.routes.js';

const corpusKey = 'research';
const visibilities: readonly ResearchVisibility[] = [
  'PUBLIC_APPROVED',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
  'CHILD_SENSITIVE',
];
const visibilityRank: Record<ResearchVisibility, number> = {
  PUBLIC_APPROVED: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
  CHILD_SENSITIVE: 4,
};

export interface ResearchExplanationRouteOptions {
  readActiveRelease?: (
    trx: Knex.Transaction,
    key: string
  ) => Promise<StoredResearchGraphRelease | null>;
  lookupPassage?: (
    editionId: string,
    locator: string
  ) => Promise<{
    source_id: string;
    expression_id?: string;
    edition_id: string;
    locator: string;
    text: string;
    content_sha256: string;
    citation: string;
  } | null>;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function storedVisibility(record: StoredResearchGraphRecord, content: Record<string, unknown>) {
  if (!visibilities.includes(content.visibility as ResearchVisibility)) {
    throw new TypeError('Research record visibility is invalid');
  }
  const embedded = content.visibility as ResearchVisibility;
  // Storage PUBLIC is only an INTERNAL floor. It never means approved publication.
  const floor: ResearchVisibility = record.visibility === 'RESTRICTED' ? 'RESTRICTED' : 'INTERNAL';
  return visibilityRank[embedded] >= visibilityRank[floor] ? embedded : floor;
}

type AuthorizedReleaseResult =
  | { status: 'denied' }
  | { status: 'unavailable' }
  | { status: 'found'; release: StoredResearchGraphRelease };

async function readAuthorizedRelease(
  fastify: FastifyInstance,
  auth: AuthContext,
  readRelease: (trx: Knex.Transaction, key: string) => Promise<StoredResearchGraphRelease | null>
): Promise<AuthorizedReleaseResult> {
  const result = await fastify.knex.transaction(async (trx) => {
    if (auth.role !== 'system') {
      const company = await trx('companies')
        .where({ id: auth.companyId, active: true })
        .forUpdate()
        .first('id');
      const membership = await trx('company_memberships')
        .where({ user_id: auth.userId, company_id: auth.companyId, active: true })
        .forUpdate()
        .first('id');
      if (!company || !membership) return { denied: true as const };
    }
    return { denied: false as const, release: await readRelease(trx, corpusKey) };
  });
  if (result.denied) return { status: 'denied' };
  if (!result.release) return { status: 'unavailable' };
  return { status: 'found', release: result.release };
}

function isResearchReader(auth: AuthContext): boolean {
  return auth.role === 'system' || auth.role === 'superadmin' || auth.role === 'user';
}

type ResearchSearchResult =
  | { id: string; kind: 'assertion'; title: string; summary: string }
  | { id: string; kind: 'relation'; title: string; summary: string }
  | ({
      id: string;
      kind: 'evidence';
      title: string;
      summary: string;
      assertion_id: string;
    } & (
      | {
          source_id: 'mw:source:tanzil-quran-text';
          edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
          locator: 'Q7:46';
        }
      | {
          source_id: 'mw:source:ebible-webp-protestant';
          edition_id: 'mw:edition:webp-protestant-2020-stable';
          locator: 'Genesis 1:1';
        }
    ));

function searchResearchRelease(
  release: StoredResearchGraphRelease,
  query: string,
  limit: number
): { results: ResearchSearchResult[]; truncated: boolean } {
  const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
  const visibleAssertions = new Map<string, ResearchAssertion>();
  for (const record of release.records) {
    if (record.kind !== 'assertion') continue;
    const content = object(record.content);
    if (!content || content.kind !== 'Assertion' || content.id !== record.key) continue;
    if (
      storedVisibility(record, content) !== 'INTERNAL' ||
      !validateResearchAssertion(content).valid
    )
      continue;
    visibleAssertions.set(record.key, content as unknown as ResearchAssertion);
  }

  const visibleNodes = new Set<string>();
  const visibleSources = new Set<string>();
  const visibleEditions = new Set<string>();
  const visibleExpressions = new Set<string>();
  const visibleEvidence = new Set<string>();
  const evidenceRecords: Array<{ key: string; content: Record<string, unknown> }> = [];
  for (const record of release.records) {
    if (record.kind === 'relation') continue;
    const content = object(record.content);
    if (
      !content ||
      content.id !== record.key ||
      storedVisibility(record, content) !== 'INTERNAL' ||
      typeof content.kind !== 'string'
    ) {
      continue;
    }
    if (record.kind === 'source' && content.kind === 'Artifact') visibleSources.add(record.key);
    if (record.kind === 'expression' && content.kind === 'Edition') visibleEditions.add(record.key);
    if (record.kind === 'expression' && content.kind === 'Expression')
      visibleExpressions.add(record.key);
    if (record.kind === 'assertion') {
      if (visibleAssertions.has(record.key)) visibleNodes.add(record.key);
      continue;
    }
    if (record.kind === 'evidence') {
      if (content.kind === 'Evidence') evidenceRecords.push({ key: record.key, content });
      continue;
    }
    visibleNodes.add(record.key);
  }

  for (const { key, content } of evidenceRecords) {
    const reference = {
      id: content.id,
      assertion_id: content.assertion_id,
      direction: content.direction,
      selector: content.selector,
    };
    if (
      typeof content.assertion_id !== 'string' ||
      !visibleAssertions.has(content.assertion_id) ||
      !validateResearchEvidenceReference(reference).valid
    ) {
      continue;
    }
    const selector = object(content.selector);
    if (
      !selector ||
      typeof selector.source_id !== 'string' ||
      typeof selector.edition_id !== 'string' ||
      !visibleSources.has(selector.source_id) ||
      !visibleEditions.has(selector.edition_id) ||
      (typeof selector.expression_id === 'string' &&
        !visibleExpressions.has(selector.expression_id))
    ) {
      continue;
    }
    visibleNodes.add(key);
    visibleEvidence.add(key);
  }

  const results: ResearchSearchResult[] = [];
  for (const record of release.records) {
    if (record.kind === 'assertion') {
      const assertion = visibleAssertions.get(record.key);
      if (!assertion) continue;
      const id = record.key;
      if (
        !id.toLocaleLowerCase('en-US').includes(normalizedQuery) &&
        !assertion.claim.toLocaleLowerCase('en-US').includes(normalizedQuery)
      )
        continue;
      results.push({
        id,
        kind: 'assertion',
        title: assertion.claim.slice(0, 240),
        summary: `${assertion.polarity} · ${assertion.review_status}`,
      });
      continue;
    }
    if (record.kind === 'relation') {
      const content = object(record.content);
      if (
        !content ||
        content.kind !== 'ResearchRelation' ||
        content.id !== record.key ||
        storedVisibility(record, content) !== 'INTERNAL' ||
        !validateResearchRelation(content).valid
      ) {
        continue;
      }
      const relation = content as unknown as ResearchRelation;
      if (
        !visibleNodes.has(relation.subject_id) ||
        !visibleNodes.has(relation.object_id) ||
        !visibleNodes.has(relation.scope.reference_id) ||
        ![...relation.supporting_evidence_ids, ...relation.counterevidence_ids].every(
          (evidenceId) => visibleEvidence.has(evidenceId)
        )
      ) {
        continue;
      }
      const searchable = [record.key, relation.predicate, relation.subject_id, relation.object_id]
        .join(' ')
        .toLocaleLowerCase('en-US');
      if (!searchable.includes(normalizedQuery)) continue;
      results.push({
        id: relation.id,
        kind: 'relation',
        title: `${relation.predicate} · ${relation.subject_id} → ${relation.object_id}`,
        summary: `${relation.epistemic_status} · ${relation.review_status}`,
      });
      continue;
    }
    if (record.kind !== 'evidence') continue;
    const content = object(record.content);
    if (!content || content.kind !== 'Evidence' || content.id !== record.key) continue;
    if (!visibleEvidence.has(record.key)) continue;
    const candidate = {
      id: content.id,
      assertion_id: content.assertion_id,
      direction: content.direction,
      selector: content.selector,
    };
    if (!validateResearchEvidenceReference(candidate).valid) continue;
    const evidence = candidate as ResearchEvidenceReference;
    const selector = evidence.selector;
    const searchable = [
      record.key,
      evidence.assertion_id,
      selector.source_id,
      selector.edition_id,
      selector.locator,
    ]
      .join(' ')
      .toLocaleLowerCase('en-US');
    if (!searchable.includes(normalizedQuery)) continue;
    const result = {
      id: record.key,
      kind: 'evidence' as const,
      title: `${evidence.direction} · ${selector.locator}`,
      summary: selector.source_id,
      assertion_id: evidence.assertion_id,
    };
    if (selector.source_id === 'mw:source:tanzil-quran-text') {
      results.push({
        ...result,
        source_id: selector.source_id,
        edition_id: selector.edition_id,
        locator: selector.locator,
      });
    } else {
      results.push({
        ...result,
        source_id: selector.source_id,
        edition_id: selector.edition_id,
        locator: selector.locator,
      });
    }
  }
  return { results: results.slice(0, limit), truncated: results.length > limit };
}

function graphFromRelease(release: StoredResearchGraphRelease) {
  if (release.corpusKey !== corpusKey || release.schemaVersion !== 'research-graph/v1') {
    throw new TypeError('Research release has an unsupported identity');
  }
  // The default ORM reader verifies stored digests, but injected readers are also
  // supported by this route. Validate the complete release here so that seam
  // cannot bypass graph and evidence-reference semantics.
  validateResearchRelease(release.records);
  const nodes: ResearchGraphNode[] = [];
  const relations: ResearchRelation[] = [];
  const evidenceReferences: ResearchEvidenceReference[] = [];
  const evidenceVisibility = new Map<string, ResearchVisibility>();

  for (const record of release.records) {
    const content = object(record.content);
    if (!content || content.id !== record.key) throw new TypeError('Research record is malformed');
    const visibility = storedVisibility(record, content);
    if (record.kind === 'relation') {
      if (content.kind !== 'ResearchRelation')
        throw new TypeError('Research relation is malformed');
      relations.push({ ...content, visibility } as unknown as ResearchRelation);
      continue;
    }

    if (typeof content.kind !== 'string') throw new TypeError('Research node is malformed');
    nodes.push({
      id: record.key,
      kind: content.kind,
      visibility,
      ...(typeof content.identity_class === 'string'
        ? { identity_class: content.identity_class }
        : {}),
    } as ResearchGraphNode);

    if (record.kind === 'evidence') {
      if (
        content.kind !== 'Evidence' ||
        typeof content.assertion_id !== 'string' ||
        (content.direction !== 'supporting' && content.direction !== 'counterevidence') ||
        !object(content.selector)
      ) {
        throw new TypeError('Research evidence is malformed');
      }
      evidenceReferences.push({
        id: record.key as ResearchEvidenceReference['id'],
        assertion_id: content.assertion_id as ResearchEvidenceReference['assertion_id'],
        direction: content.direction,
        selector: content.selector as ResearchEvidenceReference['selector'],
      });
      evidenceVisibility.set(record.key, visibility);
    }
  }
  return {
    graph: { nodes, relations } satisfies ResearchGraphInput,
    evidenceReferences,
    evidenceVisibility,
  };
}

async function localPassage(editionId: string, locator: string) {
  const rootDirectory = resolveCorpusDataRoot();
  if (editionId === 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2' && locator === 'Q7:46') {
    const passage = await readQuranPassage({
      rootDirectory,
      editionId,
      locator,
      use: 'quote_excerpt',
    });
    return {
      source_id: 'mw:source:tanzil-quran-text',
      edition_id: passage.editionId,
      locator: passage.locator,
      text: passage.text,
      content_sha256: passage.sha256,
      citation: passage.attribution,
    };
  }
  if (editionId === 'mw:edition:webp-protestant-2020-stable' && locator === 'Genesis 1:1') {
    const passage = await readTextualWitnessPassage({
      rootDirectory,
      expressionId: 'mw:expression:webp-protestant',
      editionId,
      locator,
    });
    return {
      source_id: 'mw:source:ebible-webp-protestant',
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

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'error'],
  properties: { success: { const: false }, error: { type: 'string' } },
} as const;

const researchSearchSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'data'],
  properties: {
    success: { const: true },
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['release_digest', 'results', 'truncated'],
      properties: {
        release_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        results: {
          type: 'array',
          maxItems: 25,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'kind', 'title', 'summary'],
            properties: {
              id: { type: 'string' },
              kind: { enum: ['assertion', 'evidence', 'relation'] },
              title: { type: 'string', maxLength: 240 },
              summary: { type: 'string', maxLength: 255 },
              assertion_id: { type: 'string' },
              source_id: {
                enum: ['mw:source:tanzil-quran-text', 'mw:source:ebible-webp-protestant'],
              },
              edition_id: {
                enum: [
                  'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
                  'mw:edition:webp-protestant-2020-stable',
                ],
              },
              locator: { enum: ['Q7:46', 'Genesis 1:1'] },
            },
          },
        },
        truncated: { type: 'boolean' },
      },
    },
  },
} as const;

const relationSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'kind',
    'schema_version',
    'content_revision',
    'predicate',
    'subject_id',
    'object_id',
    'scope',
    'epistemic_status',
    'review_status',
    'interpretation_boundary',
  ],
  properties: {
    id: { type: 'string' },
    kind: { const: 'ResearchRelation' },
    schema_version: { const: 1 },
    content_revision: { type: 'integer', minimum: 1 },
    predicate: { type: 'string' },
    subject_id: { type: 'string' },
    object_id: { type: 'string' },
    scope: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'reference_id'],
      properties: { kind: { type: 'string' }, reference_id: { type: 'string' } },
    },
    epistemic_status: { type: 'string' },
    review_status: { type: 'string' },
    interpretation_boundary: { const: 'linked_evidence_only' },
  },
} as const;

const resolvedEvidenceSchema = {
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
    evidence: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'assertion_id', 'direction', 'selector'],
      properties: {
        id: { type: 'string' },
        assertion_id: { type: 'string' },
        direction: { enum: ['supporting', 'counterevidence'] },
        selector: { type: 'object', additionalProperties: true },
      },
    },
    direction: { enum: ['supporting', 'counterevidence'] },
    source_id: { type: 'string' },
    expression_id: { type: 'string' },
    edition_id: { type: 'string' },
    locator: { type: 'string' },
    content_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    citation: { type: 'string' },
    excerpt: { type: 'string' },
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
} as const;

const relationExplanationSchema = {
  ...relationSummarySchema,
  required: [
    ...(relationSummarySchema.required as readonly string[]),
    'supporting_evidence',
    'counterevidence',
    'alternatives',
  ],
  properties: {
    ...relationSummarySchema.properties,
    supporting_evidence: { type: 'array', items: resolvedEvidenceSchema },
    counterevidence: { type: 'array', items: resolvedEvidenceSchema },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['relation', 'supporting_evidence', 'counterevidence'],
        properties: {
          relation: relationSummarySchema,
          supporting_evidence: { type: 'array', items: resolvedEvidenceSchema },
          counterevidence: { type: 'array', items: resolvedEvidenceSchema },
        },
      },
    },
  },
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
      required: ['release_digest', 'explanation'],
      properties: {
        release_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        explanation: relationExplanationSchema,
      },
    },
  },
} as const;

export const researchExplanationRoutes: FastifyPluginAsync<
  ResearchExplanationRouteOptions
> = async (fastify, options) => {
  const readRelease = options.readActiveRelease ?? readActiveResearchGraphRelease;
  const passageLookup = options.lookupPassage ?? localPassage;

  fastify.get<{ Querystring: { q: string; limit?: string } }>(
    '/api/research/graph/search',
    {
      schema: {
        tags: ['Research'],
        summary:
          'Search readable assertions, evidence, and relations in the verified active release',
        description:
          'Searches only INTERNAL assertions, evidence whose parent and source identities are readable, and relations whose endpoints and linked evidence are readable. Human readers require active company membership; trusted system readers may read internally. Restricted and child-sensitive records are never returned.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 2, maxLength: 120 },
            limit: {
              type: 'string',
              description: 'Optional decimal integer from 1 to 25; defaults to 20.',
            },
          },
        },
        response: {
          200: {
            description: 'Matching readable graph records from the active release.',
            ...researchSearchSchema,
          },
          400: { description: 'Search query is too short.', ...errorSchema },
          401: { description: 'Bearer authentication is required.', ...errorSchema },
          403: {
            description: 'The authenticated reader is unsupported or lacks active membership.',
            ...errorSchema,
          },
          503: { description: 'The active release could not be verified.', ...errorSchema },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!request.auth)
        return reply.code(401).send({ success: false, error: 'Authentication required' });
      const auth = request.auth;
      if (!isResearchReader(auth)) {
        return reply.code(403).send({ success: false, error: 'Research search access denied' });
      }
      if (
        auth.role !== 'system' &&
        (!Number.isSafeInteger(auth.userId) ||
          auth.userId < 1 ||
          !Number.isSafeInteger(auth.companyId) ||
          !auth.companyId ||
          auth.companyId < 1)
      ) {
        return reply.code(403).send({ success: false, error: 'Research search access denied' });
      }
      if (request.query.q.trim().length < 2) {
        return reply.code(400).send({ success: false, error: 'Search query is too short' });
      }
      const rawLimit = request.query.limit;
      const limit = rawLimit === undefined ? 20 : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
        return reply
          .code(400)
          .send({ success: false, error: 'Search limit must be an integer from 1 to 25' });
      }
      try {
        const activeRelease = await readAuthorizedRelease(fastify, auth, readRelease);
        if (activeRelease.status === 'denied') {
          return reply.code(403).send({ success: false, error: 'Research search access denied' });
        }
        if (activeRelease.status === 'unavailable') {
          return reply.code(503).send({ success: false, error: 'Research graph is unavailable' });
        }
        validateResearchRelease(activeRelease.release.records);
        const result = searchResearchRelease(activeRelease.release, request.query.q, limit);
        return reply.send({
          success: true,
          data: { release_digest: activeRelease.release.releaseDigest, ...result },
        });
      } catch (error) {
        request.log.error({ err: error }, 'Verified research graph search failed');
        return reply.code(503).send({ success: false, error: 'Research graph is unavailable' });
      }
    }
  );

  fastify.get<{ Params: { relationId: string } }>(
    '/api/research/relations/:relationId/explanation',
    {
      schema: {
        tags: ['Research'],
        summary: 'Explain a relation from the verified active graph release',
        description:
          'Returns supporting evidence, counterevidence and alternatives bound to one immutable active PostgreSQL release. Evidence is resolved from pinned local corpus data with no network fetch. Human readers require an active company and membership; trusted system readers may read internally. Only INTERNAL visibility is permitted; restricted and child-sensitive records remain hidden.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['relationId'],
          properties: { relationId: { type: 'string', minLength: 1, maxLength: 255 } },
        },
        response: {
          200: { description: 'Explanation and exact source release digest.', ...successSchema },
          401: { description: 'Bearer authentication is required.', ...errorSchema },
          403: {
            description: 'The authenticated reader is unsupported or lacks active membership.',
            ...errorSchema,
          },
          404: {
            description: 'The relation is missing or hidden by access policy.',
            ...errorSchema,
          },
          503: {
            description: 'The active release or local evidence could not be verified.',
            ...errorSchema,
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!request.auth)
        return reply.code(401).send({ success: false, error: 'Authentication required' });
      const auth = request.auth;
      if (!isResearchReader(auth)) {
        return reply
          .code(403)
          .send({ success: false, error: 'Research explanation access denied' });
      }
      if (
        auth.role !== 'system' &&
        (!Number.isSafeInteger(auth.userId) ||
          auth.userId < 1 ||
          !Number.isSafeInteger(auth.companyId) ||
          !auth.companyId ||
          auth.companyId < 1)
      ) {
        return reply
          .code(403)
          .send({ success: false, error: 'Research explanation access denied' });
      }

      try {
        const activeRelease = await readAuthorizedRelease(fastify, auth, readRelease);
        if (activeRelease.status === 'denied') {
          return reply
            .code(403)
            .send({ success: false, error: 'Research explanation access denied' });
        }
        if (activeRelease.status === 'unavailable') {
          return reply
            .code(503)
            .send({ success: false, error: 'Research explanation is unavailable' });
        }
        const release = activeRelease.release;
        const snapshot = graphFromRelease(release);
        const result = await explainResearchRelation(snapshot.graph, request.params.relationId, {
          evidenceReferences: snapshot.evidenceReferences,
          evidenceVisibility: snapshot.evidenceVisibility,
          lookupPassage: passageLookup,
          canRead: (record) => record.visibility === 'INTERNAL',
        });
        if (result.status === 'evidence_unavailable') {
          return reply
            .code(503)
            .send({ success: false, error: 'Research explanation is unavailable' });
        }
        if (result.status === 'not_found') {
          return reply.code(404).send({ success: false, error: 'Research relation was not found' });
        }
        return reply.send({
          success: true,
          data: {
            release_digest: release.releaseDigest,
            explanation: result.explanation,
          },
        });
      } catch (error) {
        request.log.error({ err: error }, 'Verified research explanation could not be built');
        return reply
          .code(503)
          .send({ success: false, error: 'Research explanation is unavailable' });
      }
    }
  );
};
