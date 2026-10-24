import Fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { createLocalAiRuntime, type LocalAiRuntime } from '@moonwitness/local-ai';
import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import ormPlugin from './plugins/orm.plugin.js';
import authPlugin, { validateJwtSecret } from './plugins/auth.plugin.js';
import { authRoutes } from './routes/auth.routes.js';
import { genericRoutes } from './routes/generic.routes.js';
import { healthRoutes } from './routes/health.routes.js';
import { jobsRoutes } from './routes/jobs.routes.js';
import { notificationRoutes } from './routes/notification.routes.js';
import { whatsappRoutes } from './routes/whatsapp.routes.js';
import { workflowRoutes } from './routes/workflow.routes.js';
import { corpusRoutes } from './routes/corpus.routes.js';
import { evidenceRoutes } from './routes/evidence.routes.js';
import { researchExplanationRoutes } from './routes/research-explanation.routes.js';
import { researchActorIdentityRoutes } from './routes/research-actor-identity.routes.js';
import { researchDuplicateCandidateRoutes } from './routes/research-duplicate-candidates.routes.js';
import { researchReviewRoutes } from './routes/research-review.routes.js';
import { researchPrivacyRoutes } from './routes/research-privacy.routes.js';
import { researchWitnessRoutes } from './routes/research-witness.routes.js';
import { conceptProfileRoutes } from './routes/concept-profile.routes.js';
import { storyWorkbenchRoutes } from './routes/story-workbench.routes.js';
import { localRetrievalRoutes } from './routes/local-retrieval.routes.js';
import { localAiSuggestionRoutes } from './routes/local-ai-suggestion.routes.js';
import { ensureResearchReviewWorkflow } from './research-review-workflow.js';
import { config, localAiConfig } from './config/env.js';
import { checkWhatsAppGatewayVersion } from './whatsapp/version-guard.js';
import { whatsappLogErrorContext } from './whatsapp/log-redaction.js';
import {
  LocalFileAttachmentStorage,
  S3AttachmentStorage,
  closeS3AttachmentStorage,
  type AttachmentStorage,
} from '@moonwitness/orm-storage';
import { createDatabase } from './database/knex.js';
import { databaseErrorCode, databaseErrorContext } from './database/errors.js';
import type { Knex } from 'knex';
import { manifest as baseAddon, initializeSuperadminPassword } from '@moonwitness/orm-base';
import { installAddons } from '@moonwitness/orm';
import { manifest as authAddon, createAuthService } from '@moonwitness/auth';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationAddon } from '@moonwitness/orm-notification';
import { manifest as workflowAddon } from '@moonwitness/orm-workflow';
import { manifest as organizationAddon } from '@moonwitness/orm-organization';
import { manifest as integrationAddon } from '@moonwitness/orm-integration';
import { whatsappManifest } from './whatsapp/manifest.js';
import { manifest as requestAddon } from '@moonwitness/orm-request';
import { manifest as knowledgeAddon } from '@moonwitness/orm-knowledge';

import { createLogger, type LogLevel } from '@moonwitness/logger';
import { installPrivacySafeNotFoundHandler } from './not-found.js';
import { isRecord } from '@moonwitness/types';
import observabilityPlugin from './plugins/observability.plugin.js';
import { createAttachmentStorage } from './storage/attachment-storage.js';
import { createAttachmentScanner, type AttachmentScanner } from './whatsapp/clamav-scanner.js';
import { createVideoPoster } from './whatsapp/media-thumbnail.js';

declare module 'fastify' {
  interface FastifyInstance {
    localAi: LocalAiRuntime;
  }
}

function errorProperty(error: unknown, key: string): unknown {
  return isRecord(error) && key in error ? error[key] : undefined;
}

export interface BuildAppOptions {
  db?: Knex;
  /** Overrides SUPERADMIN_PASSWORD (used by tests). */
  superadminPassword?: string;
  /** Overrides JWT_SECRET (used by tests). */
  jwtSecret?: string;
  /** Overrides AUTH_LOGIN_RATE_MAX (used by tests). */
  loginRateMax?: number;
  metricsToken?: string;
  /** Overrides the WhatsApp gateway probe for isolated tests. */
  checkWhatsAppGateway?: () => Promise<boolean>;
  /** Overrides attachment storage for isolated tests or custom providers. */
  attachmentStorage?: AttachmentStorage;
  /** Overrides the malware scanner for isolated tests. */
  attachmentScanner?: AttachmentScanner | null;
  /** Overrides video poster generation for isolated tests. */
  createVideoPoster?: typeof createVideoPoster;
  /** Overrides contact avatar CDN access for isolated tests. */
  fetchContactAvatar?: typeof fetch;
  /** @deprecated Use attachmentStorage; retained for existing test/app callers. */
  attachmentStorageDirectory?: string;
}

function requestIdFromHeader(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(candidate) ? candidate : null;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const authConfig = config.auth ?? {
    accessTtlSeconds: 15 * 60,
    refreshTtlSeconds: 14 * 24 * 60 * 60,
    loginRateMax: 10,
  };
  const jwtSecret = validateJwtSecret(options.jwtSecret ?? authConfig.jwtSecret);
  const superadminPassword = options.superadminPassword ?? config.superadminPassword;
  if (superadminPassword && (superadminPassword.length < 6 || superadminPassword.length > 1024)) {
    throw new Error('SUPERADMIN_PASSWORD must be between 6 and 1024 characters when configured');
  }

  const db = options.db ?? createDatabase();
  try {
    await installAddons(db, [
      baseAddon,
      authAddon,
      jobsManifest,
      integrationAddon,
      whatsappManifest,
      requestAddon,
      notificationAddon,
      organizationAddon,
      workflowAddon,
      knowledgeAddon,
    ]);
    await ensureResearchReviewWorkflow(db);
    await initializeSuperadminPassword(superadminPassword);
  } catch (error) {
    if (!options.db) await db.destroy();
    throw error;
  }
  const appLogger: FastifyBaseLogger = createLogger({
    name: 'api',
    level: (config.log?.level as LogLevel) ?? (config.env === 'test' ? 'silent' : 'info'),
    logDir: config.log?.dir,
    logFileName: config.log?.fileName,
    enableFile: config.log?.enableFile,
    prettyPrint: config.log?.prettyPrint,
  });

  const app = Fastify({
    bodyLimit: 1024 * 1024,
    requestIdHeader: false,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) => requestIdFromHeader(request.headers['x-request-id']) ?? randomUUID(),
    loggerInstance: appLogger,
    ajv: {
      customOptions: {
        coerceTypes: false,
      },
    },
  });
  app.decorate('localAi', createLocalAiRuntime(localAiConfig));

  app.addHook('onResponse', async (request, reply) => {
    request.log.info({ req: request, res: { statusCode: reply.statusCode } }, 'request completed');
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  await app.register(observabilityPlugin);

  // Collect routes (registered before any route) for a readable startup listing
  const routes: { method: string; url: string }[] = [];
  app.decorate('routeList', routes);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD' || route.url.startsWith('/docs/static')) continue;
      routes.push({ method, url: route.url });
    }
  });

  // Security & utility plugins
  await app.register(cors, { origin: true });
  await app.register(sensible);

  // Swagger Documentation
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Fastify Objection Knex - Enterprise ORM API',
        description:
          'High-performance Node.js REST and JSON-RPC API built with @moonwitness/orm and Fastify.',
        version: '1.0.0',
      },
      servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
      tags: [
        { name: 'Auth', description: 'Login, token refresh and current user' },
        { name: 'ORM', description: 'Generic CRUD and RPC endpoints' },
        { name: 'System', description: 'Health and status checks' },
      ],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
    staticCSP: true,
  });

  // Enterprise ORM Plugin (registers Knex, Objection, Environment, and models)
  await app.register(ormPlugin, { db });
  app.addHook('onClose', async () => db.destroy());

  // Authentication: after the ORM plugin (it enriches request.env), before any route.
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin, {
    jwtSecret,
    accessTtlSeconds: authConfig.accessTtlSeconds,
  });

  // Error handling
  app.setErrorHandler((error, request, reply) => {
    const isWhatsAppRoute = request.routeOptions.url?.startsWith('/whatsapp/') === true;
    const code = databaseErrorCode(error);
    if (code) {
      // Driver errors can contain SQL bindings, including password hashes.
      const name = errorProperty(error, 'name');
      request.log.error({ name, ...databaseErrorContext(error) }, 'Database request failed');
      const conflict =
        name === 'UniqueViolationError' ||
        code === '23505' ||
        code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        code === 'SQLITE_BUSY' ||
        code === 'SQLITE_BUSY_SNAPSHOT';
      return reply.status(conflict ? 409 : 500).send({
        success: false,
        error: conflict
          ? code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT'
            ? 'Database is busy; retry the request'
            : 'Unique constraint violation'
          : 'Database request failed',
      });
    }
    if (isWhatsAppRoute) {
      request.log.error({ error: whatsappLogErrorContext(error) }, 'WhatsApp request failed');
    } else {
      request.log.error(error);
    }

    // Objection.js ValidationError
    if (errorProperty(error, 'name') === 'ValidationError') {
      const message = error instanceof Error ? error.message : 'Validation failed';
      return reply.status(400).send({
        success: false,
        error: isWhatsAppRoute ? 'Invalid WhatsApp request' : message,
        type: 'ValidationError',
        ...(isWhatsAppRoute ? {} : { data: errorProperty(error, 'data') }),
      });
    }

    const statusCode = errorProperty(error, 'statusCode');
    return reply.status(typeof statusCode === 'number' ? statusCode : 500).send({
      success: false,
      error: isWhatsAppRoute
        ? 'WhatsApp request failed'
        : error instanceof Error
          ? error.message
          : 'Internal Server Error',
    });
  });

  installPrivacySafeNotFoundHandler(app);

  const attachmentStorage =
    options.attachmentStorage ??
    (options.attachmentStorageDirectory
      ? new LocalFileAttachmentStorage(options.attachmentStorageDirectory)
      : createAttachmentStorage());
  if (attachmentStorage instanceof S3AttachmentStorage) {
    app.addHook('onClose', async () => closeS3AttachmentStorage(attachmentStorage));
  }

  // Install the handler before route plugins inherit their error handling scope.
  await app.register(healthRoutes, {
    metricsToken: options.metricsToken ?? config.metricsToken,
    checkWhatsAppGateway: options.checkWhatsAppGateway ?? (() => checkWhatsAppGatewayVersion()),
    checkAttachmentStorage: async () => {
      if (attachmentStorage instanceof S3AttachmentStorage) {
        await attachmentStorage.checkReady();
      }
      return true;
    },
  });
  await app.register(authRoutes, {
    authService: createAuthService({
      refreshTtlSeconds: authConfig.refreshTtlSeconds,
      refreshTokenSecret: jwtSecret,
    }),
    accessTtlSeconds: authConfig.accessTtlSeconds,
    loginRateMax: options.loginRateMax ?? authConfig.loginRateMax,
  });
  await app.register(genericRoutes, {
    attachmentStorage,
  });
  await app.register(whatsappRoutes, {
    attachmentStorage,
    attachmentScanner:
      options.attachmentScanner === undefined
        ? createAttachmentScanner()
        : options.attachmentScanner,
    createVideoPoster: options.createVideoPoster,
    fetchContactAvatar: options.fetchContactAvatar,
  });
  await app.register(jobsRoutes);
  await app.register(notificationRoutes);
  await app.register(workflowRoutes);
  await app.register(corpusRoutes);
  await app.register(evidenceRoutes);
  await app.register(researchExplanationRoutes);
  await app.register(researchActorIdentityRoutes);
  await app.register(researchDuplicateCandidateRoutes);
  await app.register(researchReviewRoutes);
  await app.register(researchPrivacyRoutes);
  await app.register(researchWitnessRoutes);
  await app.register(conceptProfileRoutes);
  await app.register(storyWorkbenchRoutes);
  await app.register(localRetrievalRoutes);
  await app.register(localAiSuggestionRoutes);

  return app;
}
