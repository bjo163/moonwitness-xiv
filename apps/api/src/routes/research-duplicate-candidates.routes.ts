import type { FastifyPluginAsync } from 'fastify';
import {
  findDuplicateCandidates,
  type DuplicateCandidate,
  type DuplicateVisibility,
  type ResearchAssertion,
  type ResearchEvidenceReference,
} from '@moonwitness/research';
import {
  MAX_RESEARCH_RELEASE_CANONICAL_BYTES,
  MAX_RESEARCH_RELEASE_RECORDS,
  readActiveResearchGraphRelease,
  type StoredResearchGraphRecord,
  type StoredResearchGraphRelease,
} from '@moonwitness/orm-knowledge';
import type { Knex } from 'knex';

const corpusKey = 'research';
const visibilities: readonly DuplicateVisibility[] = [
  'PUBLIC_APPROVED',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
  'CHILD_SENSITIVE',
];
const visibilityRank: Record<DuplicateVisibility, number> = {
  PUBLIC_APPROVED: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
  CHILD_SENSITIVE: 4,
};
const MAX_CANDIDATES = 100;
const MAX_CANDIDATE_EVIDENCE_IDS = 500;

export interface ResearchDuplicateCandidateRouteOptions {
  readActiveRelease?: (
    trx: Knex.Transaction,
    key: string
  ) => Promise<StoredResearchGraphRelease | null>;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function effectiveVisibility(record: StoredResearchGraphRecord, content: Record<string, unknown>) {
  if (!visibilities.includes(content.visibility as DuplicateVisibility)) {
    throw new TypeError('Research record visibility is invalid');
  }
  const embedded = content.visibility as DuplicateVisibility;
  // Generic PUBLIC storage is only an INTERNAL floor, never publication approval.
  const floor: DuplicateVisibility = record.visibility === 'RESTRICTED' ? 'RESTRICTED' : 'INTERNAL';
  return visibilityRank[embedded] >= visibilityRank[floor] ? embedded : floor;
}

function candidateRecords(release: StoredResearchGraphRelease) {
  if (release.corpusKey !== corpusKey || release.schemaVersion !== 'research-graph/v1') {
    throw new TypeError('Research release has an unsupported identity');
  }
  const assertions: Array<ResearchAssertion & { visibility: DuplicateVisibility }> = [];
  const evidence: Array<ResearchEvidenceReference & { visibility: DuplicateVisibility }> = [];
  for (const record of release.records) {
    if (record.kind !== 'assertion' && record.kind !== 'evidence') continue;
    const content = object(record.content);
    if (!content || content.id !== record.key) throw new TypeError('Research record is malformed');
    const visibility = effectiveVisibility(record, content);
    if (record.kind === 'assertion') {
      if (content.kind !== 'Assertion') throw new TypeError('Research assertion is malformed');
      assertions.push({ ...content, visibility } as unknown as ResearchAssertion & {
        visibility: DuplicateVisibility;
      });
      continue;
    }
    if (
      content.kind !== 'Evidence' ||
      typeof content.assertion_id !== 'string' ||
      (content.direction !== 'supporting' && content.direction !== 'counterevidence') ||
      !object(content.selector)
    ) {
      throw new TypeError('Research evidence is malformed');
    }
    evidence.push({
      id: record.key as ResearchEvidenceReference['id'],
      assertion_id: content.assertion_id as ResearchEvidenceReference['assertion_id'],
      direction: content.direction,
      selector: content.selector as ResearchEvidenceReference['selector'],
      visibility,
    });
  }
  return { assertions, evidence };
}

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'error'],
  properties: { success: { const: false }, error: { type: 'string' } },
} as const;

const candidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'left_id',
    'right_id',
    'status',
    'kind',
    'rationale',
    'shared_supporting_evidence_ids',
    'shared_counterevidence_ids',
    'cross_direction_evidence_ids',
    'shared_scope',
    'shared_claim_terms',
    'compared_claim_terms',
  ],
  properties: {
    left_id: { type: 'string' },
    right_id: { type: 'string' },
    status: { const: 'unresolved' },
    kind: { enum: ['duplicate', 'overlap', 'different'] },
    rationale: { type: 'array', items: { type: 'string' } },
    shared_supporting_evidence_ids: { type: 'array', items: { type: 'string' } },
    shared_counterevidence_ids: { type: 'array', items: { type: 'string' } },
    cross_direction_evidence_ids: { type: 'array', items: { type: 'string' } },
    shared_scope: { type: 'boolean' },
    shared_claim_terms: { type: 'integer', minimum: 0 },
    compared_claim_terms: { type: 'integer', minimum: 0 },
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
      required: ['release_digest', 'candidates', 'truncated'],
      properties: {
        release_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        candidates: { type: 'array', items: candidateSchema },
        truncated: { type: 'boolean' },
      },
    },
  },
} as const;

export const researchDuplicateCandidateRoutes: FastifyPluginAsync<
  ResearchDuplicateCandidateRouteOptions
> = async (fastify, options) => {
  const readRelease = options.readActiveRelease ?? readActiveResearchGraphRelease;
  fastify.get(
    '/api/research/duplicate-candidates',
    {
      schema: {
        tags: ['Research'],
        summary: 'Generate bounded non-destructive duplicate review candidates',
        description:
          'Reads one verified active PostgreSQL research release and returns unresolved feature-overlap hints. Only INTERNAL records are considered; results never merge or mutate graph records. No network fetch is used.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            description: 'Unresolved candidates bound to one exact active release.',
            ...successSchema,
          },
          401: { description: 'Bearer authentication is required.', ...errorSchema },
          403: {
            description:
              'The authenticated actor lacks an eligible role or active company membership.',
            ...errorSchema,
          },
          503: {
            description: 'The active release is unavailable or cannot be verified.',
            ...errorSchema,
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!request.auth)
        return reply.code(401).send({ success: false, error: 'Authentication required' });
      const hasActiveCompanyContext =
        Number.isInteger(request.auth.companyId) && (request.auth.companyId ?? 0) > 0;
      const isTrustedSystem = request.auth.role === 'system';
      const isHumanReader = request.auth.role === 'user' || request.auth.role === 'superadmin';
      const canReadAsActor = isTrustedSystem || (isHumanReader && hasActiveCompanyContext);
      if (!canReadAsActor) {
        return reply.code(403).send({ success: false, error: 'Research access denied' });
      }

      try {
        // Revalidate human tenant membership in the same transaction as the shared release read.
        // Trusted system callers are service identities and do not use company membership.
        const releaseResult = await fastify.knex.transaction(async (trx) => {
          if (!isTrustedSystem) {
            const company = await trx('companies')
              .where({ id: request.auth!.companyId, active: true })
              .forUpdate()
              .first('id');
            const membership = await trx('company_memberships')
              .where({
                user_id: request.auth!.userId,
                company_id: request.auth!.companyId,
                active: true,
              })
              .forUpdate()
              .first('id');
            if (!company || !membership) return { denied: true as const };
          }
          return { denied: false as const, release: await readRelease(trx, corpusKey) };
        });
        if (releaseResult.denied) {
          return reply.code(403).send({ success: false, error: 'Research access denied' });
        }
        const release = releaseResult.release;
        if (!release) {
          return reply
            .code(503)
            .send({ success: false, error: 'Duplicate candidates are unavailable' });
        }
        const canonicalBytes =
          Buffer.byteLength(release.manifestJson, 'utf8') +
          release.records.reduce(
            (total, record) => total + Buffer.byteLength(JSON.stringify(record.content), 'utf8'),
            0
          );
        if (
          release.records.length > MAX_RESEARCH_RELEASE_RECORDS ||
          canonicalBytes > MAX_RESEARCH_RELEASE_CANONICAL_BYTES
        ) {
          return reply
            .code(503)
            .send({ success: false, error: 'Duplicate candidates are unavailable' });
        }
        const records = candidateRecords(release);
        const result = findDuplicateCandidates({
          assertions: records.assertions,
          evidence: records.evidence,
          canRead: (record) => record.visibility === 'INTERNAL',
          maxPairs: MAX_CANDIDATES,
        });
        const candidates: DuplicateCandidate[] = [];
        let evidenceIdCount = 0;
        let truncated = result.truncated;
        for (const candidate of result.candidates) {
          const candidateEvidenceIds =
            candidate.shared_supporting_evidence_ids.length +
            candidate.shared_counterevidence_ids.length +
            candidate.cross_direction_evidence_ids.length;
          if (
            candidates.length >= MAX_CANDIDATES ||
            evidenceIdCount + candidateEvidenceIds > MAX_CANDIDATE_EVIDENCE_IDS
          ) {
            truncated = true;
            break;
          }
          candidates.push(candidate);
          evidenceIdCount += candidateEvidenceIds;
        }
        return reply.send({
          success: true,
          data: {
            release_digest: release.releaseDigest,
            candidates,
            truncated,
          },
        });
      } catch (error) {
        request.log.error(
          { name: error instanceof Error ? error.name : 'UnknownError' },
          'Verified duplicate candidates could not be generated'
        );
        return reply
          .code(503)
          .send({ success: false, error: 'Duplicate candidates are unavailable' });
      }
    }
  );
};
