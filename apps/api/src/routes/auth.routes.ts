import type { FastifyPluginAsync } from 'fastify';
import { AuthError, ConflictError, type AuthService, type AuthSession } from '@moonwitness/auth';
import type { Partner, User } from '@moonwitness/orm-base';

export interface AuthRoutesOptions {
  authService: AuthService;
  accessTtlSeconds: number;
  /** Max login attempts per IP per minute. */
  loginRateMax: number;
}

const refreshBody = {
  type: 'object',
  required: ['refresh_token'],
  additionalProperties: false,
  properties: { refresh_token: { type: 'string', minLength: 1, maxLength: 512 } },
} as const;

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (fastify, options) => {
  const { authService, accessTtlSeconds, loginRateMax } = options;

  const tokenResponse = (session: AuthSession) => ({
    success: true,
    data: {
      access_token: fastify.jwt.sign({ role: session.role }, { sub: String(session.userId) }),
      token_type: 'Bearer',
      expires_in: accessTtlSeconds,
      refresh_token: session.refreshToken,
      refresh_expires_at: session.refreshExpiresAt,
      user: {
        id: session.userId,
        login: session.login,
        role: session.role,
        partner_id: session.partnerId,
      },
    },
  });

  fastify.post<{ Body: { login: string; password: string; name?: string; email?: string } }>(
    '/auth/register',
    {
      config: { rateLimit: { max: loginRateMax, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Register a new user account',
        body: {
          type: 'object',
          required: ['login', 'password'],
          additionalProperties: false,
          properties: {
            login: { type: 'string', minLength: 3, maxLength: 255 },
            password: { type: 'string', minLength: 6, maxLength: 1024 },
            name: { type: 'string', minLength: 1, maxLength: 255 },
            email: { type: 'string', format: 'email', maxLength: 255 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const session = await authService.register(
          {
            login: req.body.login,
            password: req.body.password,
            name: req.body.name,
            email: req.body.email,
          },
          {
            userAgent: req.headers['user-agent'],
          }
        );
        req.log.info({ userId: session.userId, ip: req.ip }, 'registration succeeded');
        return reply.code(201).header('Cache-Control', 'no-store').send(tokenResponse(session));
      } catch (error) {
        if (error instanceof ConflictError) {
          req.log.warn({ ip: req.ip }, 'registration conflict');
          return reply.code(409).send({ success: false, error: error.message });
        }
        throw error;
      }
    }
  );

  fastify.post<{ Body: { login: string; password: string } }>(
    '/auth/login',
    {
      config: { rateLimit: { max: loginRateMax, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Exchange login and password for an access and refresh token',
        body: {
          type: 'object',
          required: ['login', 'password'],
          additionalProperties: false,
          properties: {
            login: { type: 'string', minLength: 1, maxLength: 255 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const session = await authService.login(req.body.login, req.body.password, {
          userAgent: req.headers['user-agent'],
        });
        req.log.info({ userId: session.userId, ip: req.ip }, 'login succeeded');
        return reply.header('Cache-Control', 'no-store').send(tokenResponse(session));
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        req.log.warn({ ip: req.ip }, 'login failed');
        return reply.code(401).send({ success: false, error: error.message });
      }
    }
  );

  const refreshInFlight = new Map<string, Promise<AuthSession>>();
  fastify.post<{ Body: { refresh_token: string } }>(
    '/auth/refresh',
    {
      config: { rateLimit: { max: loginRateMax * 3, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Rotate a refresh token for a new access and refresh token',
        body: refreshBody,
      },
    },
    async (req, reply) => {
      try {
        const tokenKey = authService.fingerprintRefreshToken(req.body.refresh_token);
        let entry = refreshInFlight.get(tokenKey);
        if (!entry) {
          const promise = authService.refresh(req.body.refresh_token, {
            userAgent: req.headers['user-agent'],
          });
          entry = promise;
          refreshInFlight.set(tokenKey, promise);
          void promise
            .finally(() => {
              if (refreshInFlight.get(tokenKey) === promise) refreshInFlight.delete(tokenKey);
            })
            .catch(() => undefined);
        }
        const session = await entry;
        return reply.header('Cache-Control', 'no-store').send(tokenResponse(session));
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        req.log.warn({ ip: req.ip }, 'refresh rejected');
        return reply.code(401).send({ success: false, error: error.message });
      }
    }
  );

  fastify.post<{ Body: { refresh_token: string } }>(
    '/auth/logout',
    { schema: { tags: ['Auth'], summary: 'Revoke a refresh token session', body: refreshBody } },
    async (req) => {
      await authService.logout(req.body.refresh_token);
      return { success: true };
    }
  );

  fastify.post<{ Body: { current_password: string; new_password: string } }>(
    '/auth/me/password',
    {
      config: { rateLimit: { max: loginRateMax, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Change the authenticated user password and revoke active sessions',
        body: {
          type: 'object',
          required: ['current_password', 'new_password'],
          additionalProperties: false,
          properties: {
            current_password: { type: 'string', minLength: 1, maxLength: 1024 },
            new_password: { type: 'string', minLength: 12, maxLength: 1024 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!req.auth)
        return reply.code(401).send({ success: false, error: 'Authentication required' });
      try {
        await authService.changePassword(
          req.auth.userId,
          req.body.current_password,
          req.body.new_password
        );
        return { success: true, data: { refresh_sessions_revoked: true } };
      } catch (error) {
        if (error instanceof AuthError)
          return reply.code(400).send({ success: false, error: error.message });
        if (error instanceof RangeError)
          return reply.code(400).send({ success: false, error: error.message });
        throw error;
      }
    }
  );

  fastify.get(
    '/auth/me',
    { schema: { tags: ['Auth'], summary: 'Return the authenticated user' } },
    async (req, reply) => {
      const UserModel = req.env.get<typeof User>('base.user');
      const user = req.auth ? await UserModel.query().findById(req.auth.userId) : undefined;
      if (!user || user.active === false) {
        return reply.code(401).send({ success: false, error: 'Authentication required' });
      }
      return {
        success: true,
        data: {
          id: user.id,
          login: user.login,
          role: user.role,
          partner_id: user.partner_id,
          company_id: req.auth?.companyId,
          language_id: user.language_id ?? null,
          timezone: user.timezone ?? 'UTC',
        },
      };
    }
  );

  fastify.patch<{ Body: { language_id: number | null; timezone: string } }>(
    '/auth/me/preferences',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Update preferences for the authenticated user',
        body: {
          type: 'object',
          required: ['language_id', 'timezone'],
          additionalProperties: false,
          properties: {
            language_id: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
            timezone: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!req.auth)
        return reply.code(401).send({ success: false, error: 'Authentication required' });
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: req.body.timezone });
      } catch {
        return reply.code(400).send({ success: false, error: 'Invalid timezone' });
      }

      const UserModel = req.env.get<typeof User>('base.user');
      if (req.body.language_id !== null) {
        const LanguageModel = req.env.get('base.language');
        const language = await LanguageModel.query().findById(req.body.language_id);
        if (!language) return reply.code(400).send({ success: false, error: 'Unknown language' });
      }
      const user = await UserModel.query().findById(req.auth.userId);
      if (!user || user.active === false) {
        return reply.code(401).send({ success: false, error: 'Authentication required' });
      }
      await UserModel.query().findById(req.auth.userId).patch({
        language_id: req.body.language_id,
        timezone: req.body.timezone,
      });
      return { success: true };
    }
  );

  fastify.patch<{
    Body: {
      name?: string;
      email?: string | null;
      phone?: string | null;
      mobile?: string | null;
      job_title?: string | null;
      website?: string | null;
    };
  }>(
    '/auth/me/profile',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Update contact details for the authenticated user',
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            email: {
              anyOf: [{ type: 'string', format: 'email', maxLength: 255 }, { type: 'null' }],
            },
            phone: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
            mobile: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
            job_title: { anyOf: [{ type: 'string', maxLength: 255 }, { type: 'null' }] },
            website: { anyOf: [{ type: 'string', maxLength: 2048 }, { type: 'null' }] },
          },
        },
      },
    },
    async (req, reply) => {
      if (!req.auth)
        return reply.code(401).send({ success: false, error: 'Authentication required' });
      const UserModel = req.env.get<typeof User>('base.user');
      const user = await UserModel.query().findById(req.auth.userId);
      if (!user || user.active === false || !user.partner_id) {
        return reply.code(401).send({ success: false, error: 'Profile is unavailable' });
      }
      const PartnerModel = req.env.get<typeof Partner>('base.partner');
      const partner = await PartnerModel.query().findById(user.partner_id);
      if (!partner)
        return reply.code(404).send({ success: false, error: 'Profile is unavailable' });
      await PartnerModel.query().findById(user.partner_id).patch(req.body);
      return { success: true };
    }
  );
};
