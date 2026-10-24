import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { Role } from '@moonwitness/auth';
import {
  AccessGroup,
  Company,
  CompanyMembership,
  GroupMembership,
  ModelAccess,
} from '@moonwitness/orm-base';
import type { GroupModelGrant } from '../auth/policy.js';

export interface AuthContext {
  userId: number;
  role: Role;
  partnerId?: number;
  companyId?: number;
  groupPermissions: readonly GroupModelGrant[];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every non-public route; null on public ones. */
    auth: AuthContext | null;
  }
}

export interface AuthPluginOptions {
  jwtSecret?: string;
  accessTtlSeconds: number;
}

const ROLES: readonly string[] = ['system', 'superadmin', 'user'];
const ISSUER = 'moonwitness';

/** Routes reachable without a token. Logout is public: the refresh token is its credential. */
function isPublic(url: string): boolean {
  return (
    url === '/' ||
    url === '/health' ||
    url === '/livez' ||
    url === '/readyz' ||
    url === '/whatsapp/readyz' ||
    url === '/whatsapp/gowa/webhook/:deviceId' ||
    url === '/metrics' ||
    url.startsWith('/docs') ||
    url === '/auth/register' ||
    url === '/auth/login' ||
    url === '/auth/refresh' ||
    url === '/auth/logout'
  );
}

export function validateJwtSecret(secret: string | undefined): string {
  if (!secret) {
    throw new Error(
      'JWT_SECRET is required. Generate a persistent value with node:crypto and set it in the repository .env.'
    );
  }
  if (secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  return secret;
}

/**
 * Registers JWT support and a global guard that authenticates every request except the
 * public routes. Must be registered after the ORM plugin: it enriches `request.env`.
 */
const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, options) => {
  await fastify.register(jwt, {
    secret: validateJwtSecret(options.jwtSecret),
    // fast-jwt interprets numeric durations as milliseconds.
    sign: { algorithm: 'HS256', iss: ISSUER, expiresIn: options.accessTtlSeconds * 1000 },
    verify: { algorithms: ['HS256'], allowedIss: ISSUER },
  });

  fastify.decorateRequest('auth', null as unknown as AuthContext | null);

  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.routeOptions.url;
    // Unmatched URLs fall through so they get a normal 404; CORS preflights carry no token.
    if (request.method === 'OPTIONS' || url === undefined || isPublic(url)) return;
    let userId: number;
    try {
      const payload = await request.jwtVerify<{ sub: string; role: string }>();
      userId = Number(payload.sub);
      if (!Number.isInteger(userId) || userId < 1 || !ROLES.includes(payload.role)) {
        throw new Error('Malformed token claims');
      }
    } catch {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ success: false, error: 'Authentication required' });
    }
    const UserModel = request.env.get('base.user');
    const user = (await UserModel.query()
      .findById(userId)
      .withGraphFetched('partner')) as unknown as
      | (InstanceType<typeof UserModel> & {
          role: Role;
          partner_id?: number;
          partner?: { id?: number; active?: boolean; company_id?: number };
        })
      | undefined;
    const partner = user?.partner;
    if (!user || user.active === false || !partner || partner.active === false) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ success: false, error: 'Authentication required' });
    }
    const role = String(user.role) as Role;
    if (!ROLES.includes(role)) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ success: false, error: 'Authentication required' });
    }

    const partnerId = user.partner_id ?? partner.id;
    const requestedCompanyHeader = request.headers['x-company-id'];
    const parsedCompanyHeader =
      typeof requestedCompanyHeader === 'string' && /^\d+$/.test(requestedCompanyHeader)
        ? Number(requestedCompanyHeader)
        : undefined;
    if (requestedCompanyHeader !== undefined && parsedCompanyHeader === undefined) {
      return reply.code(403).send({ success: false, error: 'Company access denied' });
    }
    const companyMemberships = await CompanyMembership.query()
      .where({ user_id: userId, active: true })
      .orderBy('is_default', 'desc')
      .orderBy('company_id', 'asc')
      .select('company_id', 'is_default');
    if (companyMemberships.length === 0) {
      return reply.code(403).send({ success: false, error: 'No active company membership' });
    }
    const selectedMembership =
      parsedCompanyHeader !== undefined
        ? companyMemberships.find(({ company_id }) => company_id === parsedCompanyHeader)
        : (companyMemberships.find(({ is_default }) => is_default) ??
          companyMemberships.find(({ company_id }) => company_id === partner.company_id) ??
          companyMemberships[0]);
    if (parsedCompanyHeader !== undefined && !selectedMembership) {
      return reply.code(403).send({ success: false, error: 'Company access denied' });
    }
    const companyId = selectedMembership?.company_id;
    if (
      companyId !== undefined &&
      !(await Company.query().where({ id: companyId, active: true }).first())
    ) {
      return reply.code(403).send({ success: false, error: 'Company access denied' });
    }

    let groupPermissions: GroupModelGrant[] = [];
    if (role === 'user') {
      const memberships = await GroupMembership.query()
        .where({ user_id: userId, active: true })
        .select('group_id');
      const groupIds = memberships.map(({ group_id }) => group_id);
      if (groupIds.length > 0) {
        const activeGroups = await AccessGroup.query()
          .whereIn('id', groupIds)
          .where({ active: true })
          .select('id');
        const activeGroupIds = activeGroups.map(({ id }) => id);
        if (activeGroupIds.length > 0) {
          const grants = await ModelAccess.query()
            .whereIn('group_id', activeGroupIds)
            .where({ active: true })
            .select('model_name', 'read', 'create', 'write', 'unlink');
          groupPermissions = grants.map((grant) => ({
            model_name: grant.model_name,
            read: grant.read,
            create: grant.create,
            write: grant.write,
            unlink: grant.unlink,
          }));
        }
      }
    }

    request.auth = { userId, role, partnerId, companyId, groupPermissions };
    request.env = request.env.withContext({ userId, role, companyId });
  });
};

export default fp(authPlugin, { name: 'moonwitness-auth' });
