import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { LogController } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthError, ConflictError, type AuthService } from '@moonwitness/auth';
import { createLogger } from '@moonwitness/logger';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { manifest as knowledgeManifest } from '@moonwitness/orm-knowledge';
import knex from 'knex';
import { installPrivacySafeNotFoundHandler } from '../src/not-found.js';
import { authRoutes } from '../src/routes/auth.routes.js';
import { researchPrivacyRoutes } from '../src/routes/research-privacy.routes.js';

describe('request logging privacy', () => {
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  });

  it('keeps the route path but never writes query values to automatic request logs', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-api-logs-'));
    const logger = createLogger({
      name: 'api-log-privacy-test',
      level: 'info',
      logDir: temporaryDirectory,
      logFileName: 'api.log',
      enableConsole: false,
      enableFile: true,
      prettyPrint: false,
    });
    const app = Fastify({
      loggerInstance: logger,
      logController: new LogController({ disableRequestLogging: true }),
    });
    app.addHook('onResponse', async (request, reply) => {
      request.log.info(
        { req: request, res: { statusCode: reply.statusCode } },
        'request completed'
      );
    });
    installPrivacySafeNotFoundHandler(app);
    app.get('/api/privacy-search', async () => ({ ok: true }));
    app.get('/api/users/:userId', async () => ({ ok: true }));
    app.post('/api/privacy-submit', async () => ({ ok: true }));

    try {
      await app.inject({
        method: 'GET',
        url: '/api/privacy-search?term=private-search-canary&access_token=query-token-canary',
      });
      await app.inject({ method: 'GET', url: '/api/users/private-path-canary' });
      const unmatched = await app.inject({
        method: 'GET',
        url: '/api/missing/private-unmatched-canary',
      });
      await app.inject({
        method: 'POST',
        url: '/api/privacy-submit',
        headers: {
          host: 'private-host-canary',
          authorization: 'Bearer private-header-token-canary',
          cookie: 'session=private-cookie-canary',
        },
        payload: { text: 'private-body-canary' },
      });
      app.log.flush();
      const logContents = await readFile(path.join(temporaryDirectory, 'api.log'), 'utf8');

      expect(logContents).toContain('/api/privacy-search');
      expect(logContents).toContain('/api/users/:userId');
      expect(logContents).toContain('Route not found');
      expect(logContents).not.toContain('/api/missing/private-unmatched-canary');
      expect(unmatched.statusCode).toBe(404);
      expect(unmatched.body).not.toContain('private-unmatched-canary');
      expect(logContents).not.toContain('private-search-canary');
      expect(logContents).not.toContain('query-token-canary');
      expect(logContents).not.toContain('private-path-canary');
      expect(logContents).not.toContain('private-unmatched-canary');
      expect(logContents).not.toContain('private-header-token-canary');
      expect(logContents).not.toContain('private-cookie-canary');
      expect(logContents).not.toContain('private-body-canary');
      expect(logContents).not.toContain('private-host-canary');
    } finally {
      await app.close();
      app.log.flush();
    }
  });

  it('does not write authentication identifiers or credentials when registration and login fail', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-auth-log-privacy-'));
    const logger = createLogger({
      name: 'auth-log-privacy-test',
      level: 'info',
      logDir: temporaryDirectory,
      logFileName: 'api.log',
      enableConsole: false,
      enableFile: true,
      prettyPrint: false,
    });
    const app = Fastify({
      loggerInstance: logger,
      logController: new LogController({ disableRequestLogging: true }),
    });
    const authService: AuthService = {
      async register() {
        throw new ConflictError();
      },
      async login() {
        throw new AuthError();
      },
      fingerprintRefreshToken(token) {
        return token;
      },
      async refresh() {
        throw new AuthError();
      },
      async logout() {},
      async revokeAllForUser() {},
      async revokeAllSessions() {
        return 0;
      },
      async changePassword() {},
    };
    app.addHook('onResponse', async (request, reply) => {
      request.log.info(
        { req: request, res: { statusCode: reply.statusCode } },
        'request completed'
      );
    });
    await app.register(authRoutes, { authService, accessTtlSeconds: 900, loginRateMax: 5 });

    try {
      const registration = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          login: 'synthetic-registration-login-canary',
          password: 'synthetic-registration-password-canary',
          email: 'synthetic-registration-email-canary@example.test',
        },
      });
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          login: 'synthetic-login-identifier-canary',
          password: 'synthetic-login-password-canary',
        },
      });
      expect(registration.statusCode).toBe(409);
      expect(login.statusCode).toBe(401);

      app.log.flush();
      const logContents = await readFile(path.join(temporaryDirectory, 'api.log'), 'utf8');
      expect(logContents).toContain('registration conflict');
      expect(logContents).toContain('login failed');
      for (const canary of [
        'synthetic-registration-login-canary',
        'synthetic-registration-password-canary',
        'synthetic-registration-email-canary@example.test',
        'synthetic-login-identifier-canary',
        'synthetic-login-password-canary',
      ]) {
        expect(logContents).not.toContain(canary);
      }
    } finally {
      await app.close();
      app.log.flush();
    }
  });

  it('keeps the actual synthetic privacy revocation route hash-only in logs and responses', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-privacy-route-logs-'));
    const logger = createLogger({
      name: 'privacy-route-log-privacy-test',
      level: 'info',
      logDir: temporaryDirectory,
      logFileName: 'api.log',
      enableConsole: false,
      enableFile: true,
      prettyPrint: false,
    });
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    let app: ReturnType<typeof Fastify> | undefined;
    try {
      await installAddons(db, [baseManifest, knowledgeManifest]);
      const userId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
      const companyId = Number((await db('companies').first('id'))?.id);
      const rawSubject = 'synthetic-log-subject-private-canary';
      const rawConsent = 'synthetic-log-consent-private-canary';
      const excerpt = 'SYNTHETIC-PRIVACY-LOG-EXCERPT-CANARY';
      const subjectHash = createHash('sha256').update(rawSubject, 'utf8').digest('hex');
      const consentHash = createHash('sha256').update(rawConsent, 'utf8').digest('hex');
      const projectionKey = 'synthetic-privacy-log-projection-001';
      const projectionJson = JSON.stringify({ excerpt });
      await db('knowledge_privacy_projections').insert({
        company_id: companyId,
        projection_key: projectionKey,
        subject_ref_sha256: subjectHash,
        projection_json: projectionJson,
        projection_digest: createHash('sha256').update(projectionJson, 'utf8').digest('hex'),
        synthetic: true,
        visibility: 'RESTRICTED',
        state: 'active',
      });

      app = Fastify({
        loggerInstance: logger,
        logController: new LogController({ disableRequestLogging: true }),
      });
      app.decorateRequest('auth', null);
      app.decorate('db', db);
      app.addHook('onRequest', async (request) => {
        request.auth = { userId, companyId, role: 'superadmin', groupPermissions: [] };
      });
      app.addHook('onResponse', async (request, reply) => {
        request.log.info(
          { req: request, res: { statusCode: reply.statusCode } },
          'request completed'
        );
      });
      installPrivacySafeNotFoundHandler(app);
      await app.register(researchPrivacyRoutes);

      const revoked = await app.inject({
        method: 'POST',
        url: '/api/research/privacy/revocations?term=privacy-search-canary&access_token=query-token-canary',
        headers: {
          authorization: 'Bearer private-header-token-canary',
          cookie: 'session=private-cookie-canary',
          host: 'private-host-canary',
        },
        payload: {
          subject_ref_sha256: subjectHash,
          consent_decision_ref_sha256: consentHash,
          idempotency_key: 'synthetic-privacy-log-revoke-0001',
        },
      });
      expect(revoked.statusCode).toBe(201);
      expect(revoked.headers['cache-control']).toBe('private, no-store');
      expect(revoked.body).not.toContain(rawSubject);
      expect(revoked.body).not.toContain(rawConsent);
      expect(revoked.body).not.toContain(subjectHash);
      expect(revoked.body).not.toContain(consentHash);

      const rejected = await app.inject({
        method: 'POST',
        url: '/api/research/privacy/revocations?term=malformed-query-canary',
        headers: { authorization: 'Bearer private-header-token-canary' },
        payload: {
          subject_ref_sha256: subjectHash,
          consent_decision_ref_sha256: consentHash,
          idempotency_key: 'synthetic-privacy-log-revoke-0002',
          raw_subject: 'synthetic-malformed-body-canary',
        },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.headers['cache-control']).toBe('private, no-store');
      expect(rejected.body).not.toContain('synthetic-malformed-body-canary');
      expect(await db('knowledge_privacy_revocations')).toHaveLength(1);

      const projections = await app.inject({
        method: 'GET',
        url: '/api/research/privacy/projections?term=projection-query-canary',
        headers: { authorization: 'Bearer private-header-token-canary' },
      });
      expect(projections.statusCode).toBe(200);
      expect(projections.headers['cache-control']).toBe('private, no-store');
      expect(projections.body).not.toContain(excerpt);
      expect(projections.body).not.toContain(projectionKey);

      app.log.flush();
      const logContents = await readFile(path.join(temporaryDirectory, 'api.log'), 'utf8');
      expect(logContents).toContain('/api/research/privacy/revocations');
      expect(logContents).toContain('/api/research/privacy/projections');
      for (const canary of [
        rawSubject,
        rawConsent,
        excerpt,
        subjectHash,
        consentHash,
        projectionKey,
        'privacy-search-canary',
        'query-token-canary',
        'malformed-query-canary',
        'projection-query-canary',
        'private-header-token-canary',
        'private-cookie-canary',
        'private-host-canary',
        'synthetic-malformed-body-canary',
      ]) {
        expect(logContents).not.toContain(canary);
      }
    } finally {
      if (app) {
        await app.close();
        app.log.flush();
      }
      await db.destroy();
    }
  });
});
