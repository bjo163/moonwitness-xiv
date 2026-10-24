import type { FastifyPluginAsync } from 'fastify';
import {
  readStoryVersion,
  storeStoryVersion,
  validateStoryVersion,
  type StoryMediaReference,
  type StoryVersionDocument,
} from '@moonwitness/orm-knowledge';
import { readTextualWitnessPassageSnapshot } from '@moonwitness/corpus';
import {
  parseCanonicalJson,
  validateSourceArtifactManifest,
  type SourceBytesManifest,
} from '@moonwitness/knowledge';
import { resolveCorpusDataRoot } from './corpus.routes.js';

const storyIdPattern = '^mw:story:[a-z0-9][a-z0-9._-]{0,179}$';
const mediaReferenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['artifact_id', 'sha256', 'media_type', 'rights_ref'],
  properties: {
    artifact_id: { const: 'mw:artifact:webp-protestant-genesis-1-1' },
    sha256: { const: 'ae5c2799fad97b0e65334aa39be6193d487419f0d31713caaac58a47f6b4d8b1' },
    media_type: { const: 'text/plain; charset=utf-8' },
    rights_ref: { const: 'docs/roadmap/evidence/K2-006.md#source-and-rights' },
  },
} as const;

const storySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'story_id', 'version', 'title', 'visibility', 'pages'],
  properties: {
    schema_version: { const: 1 },
    story_id: { type: 'string', pattern: storyIdPattern },
    version: { type: 'integer', minimum: 1 },
    title: { type: 'string', minLength: 1, maxLength: 500 },
    visibility: { const: 'INTERNAL' },
    pages: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['page_id', 'page_order', 'original_text'],
        properties: {
          page_id: { type: 'string', pattern: '^mw:story-page:[a-z0-9][a-z0-9._-]{0,179}$' },
          page_order: { type: 'integer', minimum: 1 },
          original_text: { type: 'string', minLength: 1, maxLength: 1000000 },
          media: mediaReferenceSchema,
        },
      },
    },
  },
} as const;

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'error'],
  properties: { success: { const: false }, error: { type: 'string' } },
} as const;
function validateStoryPayload(value: unknown): ReturnType<typeof validateStoryVersion> {
  return validateStoryVersion(value);
}

async function resolveApprovedLocalMedia(reference: StoryMediaReference): Promise<{
  artifact_id: string;
  sha256: string;
  media_type: string;
  rights_ref: string;
  bytes_verified: true;
  rights_state: 'permitted';
  allowed_uses: readonly string[];
} | null> {
  if (
    reference.artifact_id !== 'mw:artifact:webp-protestant-genesis-1-1' ||
    reference.sha256 !== 'ae5c2799fad97b0e65334aa39be6193d487419f0d31713caaac58a47f6b4d8b1' ||
    reference.media_type !== 'text/plain; charset=utf-8' ||
    reference.rights_ref !== 'docs/roadmap/evidence/K2-006.md#source-and-rights'
  )
    return null;
  const snapshot = await readTextualWitnessPassageSnapshot({
    rootDirectory: resolveCorpusDataRoot(),
    expressionId: 'mw:expression:webp-protestant',
    editionId: 'mw:edition:webp-protestant-2020-stable',
    locator: 'Genesis 1:1',
    use: 'store',
  });
  if (snapshot.sourceArtifactId !== reference.artifact_id) return null;
  const raw = parseCanonicalJson(
    new TextDecoder('utf-8', { fatal: true }).decode(snapshot.sourceManifestBytes)
  );
  const validation = validateSourceArtifactManifest(raw);
  if (!validation.valid || typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return null;
  const manifest = raw as unknown as SourceBytesManifest;
  if (
    manifest.artifact.sha256 !== reference.sha256 ||
    manifest.artifact.media_type !== reference.media_type ||
    manifest.rights.evidence_ref !== reference.rights_ref ||
    manifest.rights.state !== 'permitted' ||
    !manifest.rights.allowed_uses.includes('store')
  )
    return null;
  return {
    artifact_id: reference.artifact_id,
    sha256: reference.sha256,
    media_type: reference.media_type,
    rights_ref: reference.rights_ref,
    bytes_verified: true,
    rights_state: 'permitted',
    allowed_uses: manifest.rights.allowed_uses,
  };
}

export const storyWorkbenchRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { storyId: string }; Querystring: { version?: string } }>(
    '/api/research/stories/:storyId',
    {
      attachValidation: true,
      schema: {
        tags: ['Research'],
        summary: 'Read a tenant-scoped INTERNAL story version',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['storyId'],
          properties: { storyId: { type: 'string', pattern: storyIdPattern } },
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
              data: { type: 'object', additionalProperties: true },
            },
          },
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
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
        !auth.companyId ||
        auth.companyId < 1
      )
        return reply.code(403).send({ success: false, error: 'Story is unavailable' });
      const version =
        request.query.version === undefined ? undefined : Number(request.query.version);
      if (
        request.validationError ||
        (version !== undefined && String(version) !== request.query.version)
      )
        return reply.code(400).send({ success: false, error: 'Invalid story version' });
      try {
        const result = await readStoryVersion(fastify.db, {
          authenticatedReader: {
            userId: auth.userId,
            companyId: auth.companyId,
            role: auth.role as 'user' | 'superadmin',
          },
          storyId: request.params.storyId,
          version,
          resolveMedia: resolveApprovedLocalMedia,
        });
        if (!result) return reply.code(404).send({ success: false, error: 'Story is unavailable' });
        return reply.send({ success: true, data: result });
      } catch {
        return reply.code(404).send({ success: false, error: 'Story is unavailable' });
      }
    }
  );

  fastify.post<{ Params: { storyId: string }; Body: StoryVersionDocument }>(
    '/api/research/stories/:storyId',
    {
      attachValidation: true,
      validatorCompiler: ({ schema }) => {
        return (data: unknown) => {
          if (schema !== storySchema) return true;
          const result = validateStoryPayload(data);
          return result.valid;
        };
      },
      schema: {
        tags: ['Research'],
        summary: 'Append a private immutable story version',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['storyId'],
          properties: { storyId: { type: 'string', pattern: storyIdPattern } },
        },
        body: storySchema,
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
          201: {
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
          409: errorSchema,
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
        !auth.companyId ||
        auth.companyId < 1
      )
        return reply.code(403).send({ success: false, error: 'Story is unavailable' });
      if (request.validationError || request.params.storyId !== request.body?.story_id)
        return reply.code(400).send({ success: false, error: 'Invalid story document' });
      try {
        const result = await storeStoryVersion(fastify.db, {
          authenticatedActor: {
            userId: auth.userId,
            companyId: auth.companyId,
            role: auth.role as 'user' | 'superadmin',
          },
          story: request.body,
          resolveMedia: resolveApprovedLocalMedia,
        });
        return reply.code(result.idempotent ? 200 : 201).send({ success: true, data: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const conflict =
          message.includes('already exists') || message.includes('append the next version');
        return reply.code(conflict ? 409 : 400).send({
          success: false,
          error: conflict
            ? 'Story version conflicts with the latest version'
            : 'Story version is invalid or unavailable',
        });
      }
    }
  );
};
