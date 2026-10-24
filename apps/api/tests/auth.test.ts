import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import type { FastifyInstance, InjectOptions } from 'fastify';
import {
  AccessGroup,
  Activity,
  AuditLog,
  Company,
  CompanyMembership,
  Country,
  GroupMembership,
  Language,
  ModelAccess,
  PartnerAddress,
  PartnerCategory,
  PartnerCategoryLink,
  Partner,
  Tag,
  TagLink,
  User,
} from '@moonwitness/orm-base';
import { buildApp } from '../src/app.js';
import { OutboxEvent } from '@moonwitness/jobs';
import { canAccess } from '../src/auth/policy.js';
import { OrganizationDepartment } from '@moonwitness/orm-organization';
import type { AttachmentStorage } from '@moonwitness/orm-storage';

const ADMIN_PASSWORD = 'admin-test-password';
const USER_PASSWORD = 'alice-test-password';
const TEST_JWT_SECRET = 'test-secret-test-secret-test-secret-123';

interface TokenBody {
  success: boolean;
  data: {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    user: { id: number; login: string; role: string };
  };
}

describe('authentication and authorization', () => {
  let db: Knex;
  let app: FastifyInstance;
  let admin: TokenBody['data'];
  let alice: TokenBody['data'];
  let system: TokenBody['data'];
  const attachmentObjects = new Map<string, Buffer>();
  let attachmentGetCalls = 0;
  const attachmentStorage: AttachmentStorage = {
    async put(key, content) {
      const copy = Buffer.from(content);
      attachmentObjects.set(key, copy);
      return { key, sizeBytes: copy.byteLength, checksum: '0'.repeat(64) };
    },
    async get(key) {
      attachmentGetCalls += 1;
      const content = attachmentObjects.get(key);
      return content ? Buffer.from(content) : null;
    },
    async delete(key) {
      attachmentObjects.delete(key);
    },
    async *list() {
      for (const [key, content] of attachmentObjects) {
        yield {
          key,
          sizeBytes: content.byteLength,
          checksum: '0'.repeat(64),
        };
      }
    },
  };

  const login = (loginName: string, password: string) =>
    app.inject({ method: 'POST', url: '/auth/login', payload: { login: loginName, password } });
  const as = (token: string, options: InjectOptions) =>
    app.inject({ ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
  const rpc = (token: string, args: unknown[]) =>
    as(token, {
      method: 'POST',
      url: '/jsonrpc',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'call',
        params: { service: 'object', method: 'execute_kw', args },
      },
    });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    app = await buildApp({
      db,
      superadminPassword: ADMIN_PASSWORD,
      jwtSecret: TEST_JWT_SECRET,
      loginRateMax: 1000,
      attachmentStorage,
    });
    await app.ready();

    const company = await Company.query().findOne({ name: 'MoonWitness' }).throwIfNotFound();
    const partner = await Partner.query().insert({ name: 'Alice Regular', company_id: company.id });
    const aliceUser = await User.query().insertAndFetch({
      login: 'alice',
      password: USER_PASSWORD,
      partner_id: partner.id,
      role: 'user',
    });
    await CompanyMembership.query().insert({
      user_id: aliceUser.id,
      company_id: company.id,
      is_default: true,
    });
    admin = (await login('superadmin', ADMIN_PASSWORD)).json<TokenBody>().data;
    alice = (await login('alice', USER_PASSWORD)).json<TokenBody>().data;
    const systemUser = await User.query().findOne({ login: 'system' }).throwIfNotFound();
    await User.query().findById(systemUser.id).patch({ password: 'system-test-password' });
    system = (await login('system', 'system-test-password')).json<TokenBody>().data;
  }, 30000);

  it('starts with AI disabled and makes no provider call', async () => {
    expect(await app.localAi.generate({ prompt: 'synthetic startup probe' })).toEqual({
      status: 'disabled',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('rechecks parent record access before reading attachment bytes', async () => {
    const userGroup = await AccessGroup.query().findOne({ code: 'user' }).throwIfNotFound();
    const membership = await GroupMembership.query().findOne({
      user_id: alice.user.id,
      group_id: userGroup.id,
    });
    const createdMembership =
      membership ??
      (await GroupMembership.query().insert({ user_id: alice.user.id, group_id: userGroup.id }));
    const existingGrant = await ModelAccess.query().findOne({
      group_id: userGroup.id,
      model_name: 'base.attachment',
    });
    const grant = existingGrant
      ? await ModelAccess.query()
          .findById(existingGrant.id)
          .patchAndFetch({ read: true, create: true })
      : await ModelAccess.query().insertAndFetch({
          group_id: userGroup.id,
          model_name: 'base.attachment',
          read: true,
          create: true,
        });
    const user = await User.query().findById(alice.user.id).throwIfNotFound();
    const partner = await Partner.query().findById(user.partner_id).throwIfNotFound();
    const originalCompanyId = partner.company_id;
    const foreignCompany = await Company.query().insertAndFetch({
      name: 'Attachment Scope Foreign Company',
    });
    let attachmentId: number | undefined;
    let archivedTagId: number | undefined;
    let archivedAttachmentId: number | undefined;

    try {
      const uploaded = await as(alice.access_token, {
        method: 'POST',
        url: `/api/base.attachment/upload?resource_model=base.partner&resource_id=${partner.id}&name=scope-check.txt`,
        headers: { 'content-type': 'application/octet-stream', 'x-file-mime': 'text/plain' },
        payload: Buffer.from('private parent content'),
      });
      expect(uploaded.statusCode, uploaded.payload).toBe(201);
      attachmentId = uploaded.json<{ data: { id: number } }>().data.id;

      await Partner.query().findById(partner.id).patch({ company_id: foreignCompany.id });
      const getCallsBeforeDeniedDownload = attachmentGetCalls;
      const denied = await as(alice.access_token, {
        method: 'GET',
        url: `/api/base.attachment/${attachmentId}/download`,
      });

      expect(denied.statusCode).toBe(404);
      expect(denied.payload).not.toContain('private parent content');
      expect(attachmentGetCalls).toBe(getCallsBeforeDeniedDownload);

      await Partner.query().findById(partner.id).patch({ company_id: originalCompanyId });
      const archivedTag = await Tag.query().insertAndFetch({ name: 'Archived Attachment Parent' });
      archivedTagId = archivedTag.id;
      const archivedUpload = await as(alice.access_token, {
        method: 'POST',
        url: `/api/base.attachment/upload?resource_model=base.tag&resource_id=${archivedTag.id}&name=archived-parent.txt`,
        headers: { 'content-type': 'application/octet-stream', 'x-file-mime': 'text/plain' },
        payload: Buffer.from('archived parent content'),
      });
      expect(archivedUpload.statusCode, archivedUpload.payload).toBe(201);
      archivedAttachmentId = archivedUpload.json<{ data: { id: number } }>().data.id;
      await Tag.query().findById(archivedTag.id).patch({ active: false });
      const storedObjectsBeforeArchivedUpload = attachmentObjects.size;
      const deniedArchivedUpload = await as(alice.access_token, {
        method: 'POST',
        url: `/api/base.attachment/upload?resource_model=base.tag&resource_id=${archivedTag.id}&name=second-archived-parent.txt`,
        headers: { 'content-type': 'application/octet-stream', 'x-file-mime': 'text/plain' },
        payload: Buffer.from('must not be stored'),
      });
      expect(deniedArchivedUpload.statusCode).toBe(404);
      expect(attachmentObjects.size).toBe(storedObjectsBeforeArchivedUpload);
      const getCallsBeforeArchivedParentDownload = attachmentGetCalls;
      const deniedArchivedParent = await as(alice.access_token, {
        method: 'GET',
        url: `/api/base.attachment/${archivedAttachmentId}/download`,
      });

      expect(deniedArchivedParent.statusCode).toBe(404);
      expect(deniedArchivedParent.payload).not.toContain('archived parent content');
      expect(attachmentGetCalls).toBe(getCallsBeforeArchivedParentDownload);
    } finally {
      await Partner.query().findById(partner.id).patch({ company_id: originalCompanyId });
      for (const id of [attachmentId, archivedAttachmentId]) {
        if (id === undefined) continue;
        const attachment = await db('attachments')
          .select('storage_key')
          .where({ id })
          .first<{ storage_key: string }>();
        await db('attachments').where({ id }).delete();
        if (attachment) await attachmentStorage.delete(attachment.storage_key);
      }
      if (archivedTagId !== undefined) await Tag.query().deleteById(archivedTagId);
      await Company.query().deleteById(foreignCompany.id);
      if (existingGrant) {
        await ModelAccess.query().findById(grant.id).patch({
          read: existingGrant.read,
          create: existingGrant.create,
        });
      } else {
        await ModelAccess.query().deleteById(grant.id);
      }
      if (!membership) await GroupMembership.query().deleteById(createdMembership.id);
    }
  });

  describe('register', () => {
    it('registers a new user and returns tokens without returning passwords', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          login: 'charlie',
          password: 'charlie-strong-password',
          name: 'Charlie Chaplin',
          email: 'charlie@example.com',
        },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json<TokenBody>();
      expect(body.success).toBe(true);
      expect(body.data.user).toMatchObject({
        login: 'charlie',
        role: 'user',
      });
      expect(body.data.access_token.split('.')).toHaveLength(3);
      const registered = await User.query().findOne({ login: 'charlie' }).throwIfNotFound();
      const defaultGroup = await AccessGroup.query().findOne({ code: 'user' }).throwIfNotFound();
      expect(
        await GroupMembership.query().findOne({ user_id: registered.id, group_id: defaultGroup.id })
      ).toBeDefined();
      expect(
        await CompanyMembership.query().findOne({ user_id: registered.id, is_default: true })
      ).toMatchObject({ company_id: 1, is_default: true });
      expect(JSON.stringify(body)).not.toContain('scrypt$');
      expect(JSON.stringify(body)).not.toContain('charlie-strong-password');
    });

    it('rejects duplicate registration with 409 Conflict', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          login: 'charlie',
          password: 'another-password',
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ success: false, error: 'User already exists' });
    });

    it('validates registration input requirements', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          login: 'ab', // minLength 3
          password: '123', // minLength 6
        },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('login', () => {
    it('issues bearer tokens and never returns credentials', async () => {
      expect(admin).toMatchObject({
        token_type: 'Bearer',
        expires_in: 900,
        user: { login: 'superadmin', role: 'superadmin' },
      });
      expect(admin.access_token.split('.')).toHaveLength(3);
      expect(JSON.stringify(admin)).not.toContain('scrypt$');
      const tokenBytes = Buffer.from(admin.refresh_token, 'base64url');
      expect(tokenBytes).toHaveLength(32);
      expect(tokenBytes.toString('base64url')).toBe(admin.refresh_token);
      const storedToken = await db<{ token_hash: string }>('auth_refresh_tokens')
        .select('token_hash')
        .where({ user_id: admin.user.id })
        .first();
      expect(storedToken?.token_hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(storedToken?.token_hash).not.toBe(admin.refresh_token);
    });

    it('answers wrong password and unknown login identically', async () => {
      const wrong = await login('superadmin', 'nope');
      const unknown = await login('ghost', 'nope');
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(wrong.json()).toEqual(unknown.json());
    });

    it('rejects malformed bodies and ignores unknown properties', async () => {
      for (const payload of [{}, { login: 'a' }, { login: 1, password: 'b' }]) {
        const response = await app.inject({ method: 'POST', url: '/auth/login', payload });
        expect(response.statusCode).toBe(400);
      }
      // Ajv strips unknown keys, so these cannot smuggle extra fields into the service.
      const extra = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { login: 'ghost', password: 'b', role: 'superadmin' },
      });
      expect(extra.statusCode).toBe(401);
    });
  });

  describe('request guard', () => {
    it('keeps health and docs public but protects the API', async () => {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/jsonrpc', payload: {} })).statusCode).toBe(
        401
      );
      expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(401);
    });

    it('ignores the legacy x-user-id header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/models',
        headers: { 'x-user-id': String(admin.user.id) },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects garbage and wrongly-claimed tokens', async () => {
      const garbage = await as('not.a.jwt', { method: 'GET', url: '/api/models' });
      expect(garbage.statusCode).toBe(401);
      expect(garbage.headers['www-authenticate']).toBe('Bearer');

      const badSubject = app.jwt.sign({ role: 'superadmin' }, { sub: 'abc' });
      expect((await as(badSubject, { method: 'GET', url: '/api/models' })).statusCode).toBe(401);
      const badRole = app.jwt.sign({ role: 'root' }, { sub: '1' });
      expect((await as(badRole, { method: 'GET', url: '/api/models' })).statusCode).toBe(401);
    });

    it('accepts a live access token and rejects tokens at or beyond their expiry boundary', async () => {
      const live = app.jwt.sign({ role: 'superadmin' }, { sub: '1', expiresIn: '1 minute' });
      expect((await as(live, { method: 'GET', url: '/api/models' })).statusCode).toBe(200);

      const atExpiry = app.jwt.sign({ role: 'superadmin' }, { sub: '1', expiresIn: '-1 ms' });
      const expiredAtBoundary = await as(atExpiry, { method: 'GET', url: '/api/models' });
      expect(expiredAtBoundary.statusCode).toBe(401);
      expect(expiredAtBoundary.headers['www-authenticate']).toBe('Bearer');

      const alreadyExpired = app.jwt.sign(
        { role: 'superadmin' },
        { sub: '1', expiresIn: '-1 second' }
      );
      expect((await as(alreadyExpired, { method: 'GET', url: '/api/models' })).statusCode).toBe(
        401
      );
    });

    it('returns the current user from /auth/me', async () => {
      const response = await as(alice.access_token, { method: 'GET', url: '/auth/me' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ data: { login: 'alice', role: 'user' } });
      expect(response.payload).not.toContain('password');
    });

    it('returns manifest menu metadata for models visible to the current user', async () => {
      const response = await as(alice.access_token, { method: 'GET', url: '/api/models' });
      expect(response.statusCode).toBe(200);
      const models = response.json<{
        models: Array<{
          model: string;
          menu: { group: string; sequence: number; developmentOnly: boolean };
        }>;
      }>().models;
      expect(models.find((item) => item.model === 'base.partner')?.menu).toMatchObject({
        group: 'Workspace',
        sequence: 10,
        developmentOnly: false,
      });
      expect(models.some((item) => item.model === 'base.model_access')).toBe(false);
      expect(models.find((item) => item.model === 'base.bank')?.menu.developmentOnly).toBe(true);
      expect(models.some((item) => item.model === 'base.partner_bank')).toBe(false);
    });

    it('updates only the authenticated user regional preferences', async () => {
      const unauthenticated = await app.inject({
        method: 'PATCH',
        url: '/auth/me/preferences',
        payload: { language_id: null, timezone: 'Asia/Jakarta' },
      });
      expect(unauthenticated.statusCode).toBe(401);

      const invalid = await as(alice.access_token, {
        method: 'PATCH',
        url: '/auth/me/preferences',
        payload: { language_id: null, timezone: 'Not/A_Real_Zone' },
      });
      expect(invalid.statusCode).toBe(400);

      const unknownLanguage = await as(alice.access_token, {
        method: 'PATCH',
        url: '/auth/me/preferences',
        payload: { language_id: Number.MAX_SAFE_INTEGER, timezone: 'Asia/Jakarta' },
      });
      expect(unknownLanguage.statusCode).toBe(400);
      expect(unknownLanguage.json()).toMatchObject({ error: 'Unknown language' });
      await expect(User.query().findById(alice.user.id)).resolves.toMatchObject({
        language_id: null,
        timezone: null,
      });

      const english = await Language.query().findOne({ code: 'en-US' }).throwIfNotFound();

      const updated = await as(alice.access_token, {
        method: 'PATCH',
        url: '/auth/me/preferences',
        payload: { language_id: english.id, timezone: 'Asia/Jakarta' },
      });
      expect(updated.statusCode).toBe(200);
      await expect(User.query().findById(alice.user.id)).resolves.toMatchObject({
        language_id: english.id,
        timezone: 'Asia/Jakarta',
      });
    });

    it('updates only the contact linked to the authenticated user profile', async () => {
      const adminBefore = await User.query().findById(admin.user.id).throwIfNotFound();
      const response = await as(alice.access_token, {
        method: 'PATCH',
        url: '/auth/me/profile',
        payload: {
          name: 'Alice Regular',
          email: 'alice.updated@example.com',
          phone: '+62-555-0199',
          id: admin.user.id,
          login: admin.user.login,
          role: 'superadmin',
          partner_id: admin.user.partner_id,
          active: false,
          company_id: 999999,
        },
      });
      expect(response.statusCode).toBe(200);
      const aliceRecord = await User.query().findById(alice.user.id).throwIfNotFound();
      const alicePartner = await Partner.query().findById(aliceRecord.partner_id).throwIfNotFound();
      expect(alicePartner).toMatchObject({
        name: 'Alice Regular',
        email: 'alice.updated@example.com',
        phone: '+62-555-0199',
      });
      expect(aliceRecord).toMatchObject({
        id: alice.user.id,
        login: 'alice',
        role: 'user',
        partner_id: alicePartner.id,
        active: true,
      });
      await expect(User.query().findById(admin.user.id)).resolves.toMatchObject({
        id: adminBefore.id,
        login: adminBefore.login,
        role: adminBefore.role,
        partner_id: adminBefore.partner_id,
        active: adminBefore.active,
      });
    });

    it('changes password only with the current password and revokes refresh sessions', async () => {
      const oldSession = (await login('alice', USER_PASSWORD)).json<TokenBody>().data;
      const anotherSession = (await login('alice', USER_PASSWORD)).json<TokenBody>().data;
      try {
        const wrongCurrentPassword = await as(alice.access_token, {
          method: 'POST',
          url: '/auth/me/password',
          payload: {
            current_password: 'incorrect-password',
            new_password: 'new-strong-password-123',
          },
        });
        expect(wrongCurrentPassword.statusCode).toBe(400);

        const belowMinimum = await as(alice.access_token, {
          method: 'POST',
          url: '/auth/me/password',
          payload: { current_password: USER_PASSWORD, new_password: 'a'.repeat(11) },
        });
        expect(belowMinimum.statusCode).toBe(400);

        const tooLong = await as(alice.access_token, {
          method: 'POST',
          url: '/auth/me/password',
          payload: {
            current_password: USER_PASSWORD,
            new_password: 'a'.repeat(1025),
          },
        });
        expect(tooLong.statusCode).toBe(400);

        const changed = await as(alice.access_token, {
          method: 'POST',
          url: '/auth/me/password',
          payload: {
            current_password: USER_PASSWORD,
            new_password: 'twelve-chars',
          },
        });
        expect(changed.statusCode).toBe(200);
        expect(changed.json()).toMatchObject({ data: { refresh_sessions_revoked: true } });

        const oldRefresh = await app.inject({
          method: 'POST',
          url: '/auth/refresh',
          payload: { refresh_token: oldSession.refresh_token },
        });
        expect(oldRefresh.statusCode).toBe(401);
        const otherRefresh = await app.inject({
          method: 'POST',
          url: '/auth/refresh',
          payload: { refresh_token: anotherSession.refresh_token },
        });
        expect(otherRefresh.statusCode).toBe(401);
        expect((await login('alice', USER_PASSWORD)).statusCode).toBe(401);
        expect((await login('alice', 'twelve-chars')).statusCode).toBe(200);

        const maximumLengthPassword = 'a'.repeat(1024);
        const changedToMaximumLength = await as(alice.access_token, {
          method: 'POST',
          url: '/auth/me/password',
          payload: { current_password: 'twelve-chars', new_password: maximumLengthPassword },
        });
        expect(changedToMaximumLength.statusCode).toBe(200);
        expect((await login('alice', maximumLengthPassword)).statusCode).toBe(200);
      } finally {
        await User.query().findById(alice.user.id).patch({ password: USER_PASSWORD });
      }
    }, 15000);
  });

  describe('refresh and logout', () => {
    it('rotates refresh tokens and invalidates the family on reuse', async () => {
      const first = (await login('alice', USER_PASSWORD)).json<TokenBody>().data;
      const refreshed = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refresh_token: first.refresh_token },
      });
      expect(refreshed.statusCode).toBe(200);
      const second = refreshed.json<TokenBody>().data;
      expect(second.refresh_token).not.toBe(first.refresh_token);

      await new Promise((resolve) => setTimeout(resolve, 5200));
      const replay = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refresh_token: first.refresh_token },
      });
      expect(replay.statusCode).toBe(401);
      const afterReplay = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refresh_token: second.refresh_token },
      });
      expect(afterReplay.statusCode).toBe(401);
    }, 10000);

    it('keeps the session alive when the same refresh token is used concurrently', async () => {
      const first = (await login('alice', USER_PASSWORD)).json<TokenBody>().data;
      const rotated = await Promise.all(
        Array.from({ length: 8 }, () =>
          app.inject({
            method: 'POST',
            url: '/auth/refresh',
            payload: { refresh_token: first.refresh_token },
          })
        )
      );
      expect(rotated.map((response) => response.statusCode)).toEqual(Array(8).fill(200));
      const branch = rotated[0].json<TokenBody>().data;
      const next = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refresh_token: branch.refresh_token },
      });
      expect(next.statusCode).toBe(200);
    });

    it('logs out without revealing whether the token existed', async () => {
      const session = (await login('alice', USER_PASSWORD)).json<TokenBody>().data;
      for (const token of [session.refresh_token, session.refresh_token, 'unknown']) {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/logout',
          payload: { refresh_token: token },
        });
        expect(response.statusCode).toBe(200);
      }
      const refresh = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refresh_token: session.refresh_token },
      });
      expect(refresh.statusCode).toBe(401);
    });
  });

  describe('authorization', () => {
    it('denies cross-company reads, writes, creation and company selection', async () => {
      const foreignCompany = await Company.query().insert({ name: 'Foreign Tenant' });
      const foreignPartner = await Partner.query().insert({
        name: 'Foreign Partner',
        company_id: foreignCompany.id,
      });
      expect(
        (
          await as(alice.access_token, {
            method: 'GET',
            url: `/api/base.partner/${foreignPartner.id}`,
          })
        ).statusCode
      ).toBe(404);
      const partnerGroup = await AccessGroup.query().insert({
        code: 'partner_maintainers',
        name: 'Partner Maintainers',
      });
      const partnerMembership = await GroupMembership.query().insert({
        user_id: alice.user.id,
        group_id: partnerGroup.id,
      });
      await ModelAccess.query().insert({
        group_id: partnerGroup.id,
        model_name: 'base.partner',
        read: true,
        create: true,
        write: true,
      });
      const ownCompany = await Company.query().findOne({ name: 'MoonWitness' }).throwIfNotFound();
      const ownCreateName = 'Alice created own-company contact';
      const allowedCreate = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.partner',
        payload: { name: ownCreateName, company_id: ownCompany.id },
      });
      expect(allowedCreate.statusCode, allowedCreate.payload).toBe(201);
      const createdPartnerId = allowedCreate.json<{ data: { id: number } }>().data.id;
      expect(await Partner.query().findById(createdPartnerId)).toMatchObject({
        name: ownCreateName,
        company_id: ownCompany.id,
      });
      expect(
        (
          await as(alice.access_token, {
            method: 'PATCH',
            url: `/api/base.partner/${foreignPartner.id}`,
            payload: { name: 'Stolen Partner' },
          })
        ).statusCode
      ).toBe(404);
      const deniedCreate = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.partner',
        payload: { name: 'Cross-company write', company_id: foreignCompany.id },
      });
      expect(deniedCreate.statusCode).toBe(403);
      expect(deniedCreate.payload).not.toContain('Foreign Tenant');
      expect(await Partner.query().findOne({ name: 'Cross-company write' })).toBeUndefined();
      await GroupMembership.query().findById(partnerMembership.id).patch({ active: false });
      const count = await as(alice.access_token, {
        method: 'GET',
        url: '/api/base.partner?count=true&limit=500',
      });
      expect(count.statusCode).toBe(200);
      expect(count.json<{ total: number }>().total).toBe(1);
      const exportRows = await as(alice.access_token, {
        method: 'GET',
        url: '/api/base.partner?limit=500',
      });
      expect(JSON.stringify(exportRows.json())).not.toContain('Foreign Partner');
      const ownPartner = await Partner.query().findOne({ name: 'Alice Regular' }).throwIfNotFound();
      const mixedCompanyDomain = encodeURIComponent(
        JSON.stringify(['|', ['id', '=', ownPartner.id], ['id', '=', foreignPartner.id]])
      );
      const scopedOrCount = await as(alice.access_token, {
        method: 'GET',
        url: `/api/base.partner?domain=${mixedCompanyDomain}&count=true&limit=1`,
      });
      expect(scopedOrCount.statusCode).toBe(200);
      const scopedOrCountBody = scopedOrCount.json<{ total: number; data: { id: number }[] }>();
      expect(scopedOrCountBody).toMatchObject({
        success: true,
        model: 'base.partner',
        count: 1,
        total: 1,
      });
      expect(scopedOrCountBody.data.map(({ id }) => id)).toEqual([ownPartner.id]);
      const scopedOrExport = await as(alice.access_token, {
        method: 'GET',
        url: `/api/base.partner?domain=${mixedCompanyDomain}&limit=500`,
      });
      expect(scopedOrExport.statusCode).toBe(200);
      expect(scopedOrExport.json<{ data: { id: number }[] }>().data.map(({ id }) => id)).toEqual([
        ownPartner.id,
      ]);
      expect(scopedOrExport.payload).not.toContain('Foreign Partner');
      const scopedGroups = await as(alice.access_token, {
        method: 'GET',
        url: `/api/base.partner/group-count?group_by=company_id&domain=${mixedCompanyDomain}`,
      });
      expect(scopedGroups.statusCode, scopedGroups.payload).toBe(200);
      expect(
        scopedGroups.json<{
          groups: { values: { company_id: number }; count: number }[];
          hasMore: boolean;
        }>().groups
      ).toEqual([{ values: { company_id: 1 }, count: 1 }]);
      const groupedFixtures = [
        await Partner.query().insert({ name: 'Grouped Count Probe A', is_company: false }),
        await Partner.query().insert({ name: 'Grouped Count Probe B', is_company: true }),
      ];
      const groupedFixtureDomain = encodeURIComponent(
        JSON.stringify([['id', 'in', groupedFixtures.map(({ id }) => id)]])
      );
      const firstGroupPage = await as(admin.access_token, {
        method: 'GET',
        url: `/api/base.partner/group-count?group_by=is_company&domain=${groupedFixtureDomain}&limit=1`,
      });
      expect(firstGroupPage.statusCode).toBe(200);
      expect(firstGroupPage.json()).toMatchObject({
        limit: 1,
        offset: 0,
        hasMore: true,
        groups: [{ values: { is_company: false }, count: 1 }],
      });
      const secondGroupPage = await as(admin.access_token, {
        method: 'GET',
        url: `/api/base.partner/group-count?group_by=is_company&domain=${groupedFixtureDomain}&limit=1&offset=1`,
      });
      expect(secondGroupPage.statusCode).toBe(200);
      expect(secondGroupPage.json()).toMatchObject({
        limit: 1,
        offset: 1,
        hasMore: false,
        groups: [{ values: { is_company: true }, count: 1 }],
      });
      const hiddenGroup = await as(admin.access_token, {
        method: 'GET',
        url: '/api/base.user/group-count?group_by=password',
      });
      expect(hiddenGroup.statusCode).toBe(400);
      const malformedGroup = await as(alice.access_token, {
        method: 'GET',
        url: '/api/base.partner/group-count?group_by=company_id%20desc',
      });
      expect(malformedGroup.statusCode).toBe(400);
      const excessiveLimit = await as(alice.access_token, {
        method: 'GET',
        url: '/api/base.partner/group-count?group_by=company_id&limit=501',
      });
      expect(excessiveLimit.statusCode).toBe(400);
      const excessiveOffset = await as(alice.access_token, {
        method: 'GET',
        url: '/api/base.partner/group-count?group_by=company_id&offset=10001',
      });
      expect(excessiveOffset.statusCode).toBe(400);
      expect(
        (
          await as(alice.access_token, {
            method: 'GET',
            url: '/auth/me',
            headers: { 'x-company-id': String(foreignCompany.id) },
          })
        ).statusCode
      ).toBe(403);
    });

    it('lets an ordinary user read business models only', async () => {
      const list = await as(alice.access_token, { method: 'GET', url: '/api/models' });
      const names = list.json<{ models: { model: string }[] }>().models.map((m) => m.model);
      expect(names).toContain('base.partner');
      expect(names).not.toContain('base.user');
      expect(names).not.toContain('auth.refresh_token');

      const read = await as(alice.access_token, { method: 'GET', url: '/api/base.partner' });
      expect(read.statusCode).toBe(200);
      expect(read.json<{ data: { name: string }[] }>().data.map((record) => record.name)).toEqual([
        'Alice Regular',
      ]);
      const otherPartner = await Partner.query().findOne({ name: 'System User' }).throwIfNotFound();
      expect(
        (
          await as(alice.access_token, {
            method: 'GET',
            url: `/api/base.partner/${otherPartner.id}`,
          })
        ).statusCode
      ).toBe(404);
      const ownCompany = await as(alice.access_token, {
        method: 'GET',
        url: '/api/base.company?with=country',
      });
      expect(ownCompany.json<{ data: { name: string }[] }>().data).toMatchObject([
        { name: 'MoonWitness' },
      ]);
      const publicCountry = await as(alice.access_token, {
        method: 'GET',
        url: `/api/base.country?domain=${encodeURIComponent(JSON.stringify([['code', '=', 'US']]))}`,
      });
      expect(publicCountry.json<{ data: { name: string }[] }>().data).toMatchObject([
        { name: 'United States' },
      ]);
      const scopedFilter = await as(alice.access_token, {
        method: 'GET',
        url: `/api/base.partner?domain=${encodeURIComponent(JSON.stringify([['id', '>', 0]]))}&order=name%20desc`,
      });
      expect(
        scopedFilter.json<{ data: { name: string }[] }>().data.map(({ name }) => name)
      ).toEqual(['Alice Regular']);
      const scopedRpc = await rpc(alice.access_token, [
        'base.partner',
        'search_read',
        [[['id', '>', 0]]],
        { order: 'name desc' },
      ]);
      expect(
        scopedRpc.json<{ result: { name: string }[] }>().result.map(({ name }) => name)
      ).toEqual(['Alice Regular']);
      expect(
        (
          await rpc(alice.access_token, [
            'base.partner',
            'search_read',
            [[]],
            { with: 'company.country' },
          ])
        ).statusCode
      ).toBe(403);
      expect(
        (
          await as(alice.access_token, {
            method: 'GET',
            url: '/api/base.partner?with=company.country',
          })
        ).statusCode
      ).toBe(403);
      const readViaRpc = await rpc(alice.access_token, ['base.partner', 'search_read', [[]]]);
      expect(readViaRpc.statusCode).toBe(200);
      expect(readViaRpc.json<{ result: { name: string }[] }>().result).toMatchObject([
        { name: 'Alice Regular' },
      ]);
    });

    it('denies writes, actions and administrative models to ordinary users', async () => {
      const denied = [
        await as(alice.access_token, {
          method: 'POST',
          url: '/api/base.partner',
          payload: { name: 'Nope' },
        }),
        await as(alice.access_token, {
          method: 'PUT',
          url: '/api/base.partner/1',
          payload: { name: 'Nope' },
        }),
        await as(alice.access_token, { method: 'DELETE', url: '/api/base.partner/1' }),
        await as(alice.access_token, {
          method: 'POST',
          url: '/api/base.partner/1/action/action_archive',
        }),
        await as(alice.access_token, { method: 'GET', url: '/api/base.user' }),
      ];
      expect(denied.map((response) => response.statusCode)).toEqual([403, 403, 403, 403, 403]);

      const rpcWrite = await rpc(alice.access_token, [
        'base.partner',
        'create',
        [{ name: 'Nope' }],
      ]);
      expect(rpcWrite.statusCode).toBe(403);
      expect(rpcWrite.json()).toMatchObject({ error: { code: -32003 } });
    });

    it('keeps model discovery, permission metadata and direct reads aligned for every registered model', async () => {
      const models = app.models.getNames();
      const roleCases = [
        { token: alice.access_token, role: 'user', userId: alice.user.id },
        { token: admin.access_token, role: 'superadmin', userId: admin.user.id },
        { token: system.access_token, role: 'system', userId: system.user.id },
      ] as const;

      for (const { token, role, userId } of roleCases) {
        const groupIds =
          role === 'user'
            ? (await GroupMembership.query().where({ user_id: userId, active: true })).map(
                ({ group_id }) => group_id
              )
            : [];
        const activeGroups =
          groupIds.length === 0
            ? []
            : await AccessGroup.query()
                .whereIn('id', groupIds)
                .where({ active: true })
                .select('id');
        const activeGroupIds = activeGroups.map(({ id }) => id);
        const grants =
          activeGroupIds.length === 0
            ? []
            : await ModelAccess.query().whereIn('group_id', activeGroupIds).where({ active: true });
        const listed = await as(token, { method: 'GET', url: '/api/models' });
        expect(listed.statusCode).toBe(200);
        const visible = new Set(
          listed.json<{ models: { model: string }[] }>().models.map(({ model }) => model)
        );

        for (const model of models) {
          const expected = {
            read: canAccess(role, model, 'read', grants),
            create: canAccess(role, model, 'create', grants),
            write: canAccess(role, model, 'write', grants),
            unlink: canAccess(role, model, 'unlink', grants),
          };
          expect(visible.has(model), `${role} discovery permission for ${model}`).toBe(
            expected.read
          );

          const metadata = await as(token, { method: 'GET', url: `/api/${model}/fields` });
          expect(metadata.statusCode, `${role} metadata access for ${model}`).toBe(
            expected.read ? 200 : 403
          );
          if (expected.read) {
            expect(
              metadata.json<{ permissions: typeof expected }>().permissions,
              `${role} permission metadata for ${model}`
            ).toEqual(expected);
          }

          const read = await as(token, { method: 'GET', url: `/api/${model}?limit=1` });
          expect(read.statusCode, `${role} direct read authorization for ${model}`).toBe(
            expected.read ? 200 : 403
          );

          const deniedOperations: InjectOptions[] = [];
          if (!expected.create)
            deniedOperations.push({ method: 'POST', url: `/api/${model}`, payload: {} });
          if (!expected.write)
            deniedOperations.push({ method: 'PUT', url: `/api/${model}/1`, payload: {} });
          if (!expected.unlink) deniedOperations.push({ method: 'DELETE', url: `/api/${model}/1` });
          if (!canAccess(role, model, 'action', grants))
            deniedOperations.push({
              method: 'POST',
              url: `/api/${model}/1/action/action_archive`,
            });

          for (const operation of deniedOperations) {
            const response = await as(token, operation);
            expect(response.statusCode, `${role} denied ${operation.method} ${operation.url}`).toBe(
              403
            );
          }
        }
      }
    });

    it('reports active group grants consistently across every registered model', async () => {
      const models = app.models.getNames();
      const group = await AccessGroup.query().insert({
        code: 'registry_grants',
        name: 'Registry Grants',
      });
      const membership = await GroupMembership.query().insert({
        user_id: alice.user.id,
        group_id: group.id,
      });
      for (const model_name of models) {
        await ModelAccess.query().insert({
          group_id: group.id,
          model_name,
          read: true,
          create: true,
          write: true,
          unlink: true,
        });
      }
      const grants = await ModelAccess.query().where({ group_id: group.id, active: true });
      const listed = await as(alice.access_token, { method: 'GET', url: '/api/models' });
      expect(listed.statusCode).toBe(200);
      const visible = new Set(
        listed.json<{ models: { model: string }[] }>().models.map(({ model }) => model)
      );

      for (const model of models) {
        const expected = {
          read: canAccess('user', model, 'read', grants),
          create: canAccess('user', model, 'create', grants),
          write: canAccess('user', model, 'write', grants),
          unlink: canAccess('user', model, 'unlink', grants),
        };
        expect(visible.has(model), `granted discovery permission for ${model}`).toBe(expected.read);

        const metadata = await as(alice.access_token, {
          method: 'GET',
          url: `/api/${model}/fields`,
        });
        expect(metadata.statusCode, `granted metadata access for ${model}`).toBe(
          expected.read ? 200 : 403
        );
        if (expected.read) {
          expect(
            metadata.json<{ permissions: typeof expected }>().permissions,
            `granted permission metadata for ${model}`
          ).toEqual(expected);
        }

        // Exercise every allowed HTTP authorization branch without changing data:
        // managed identity fields fail create validation, while absent IDs stop
        // write/unlink/action handlers before any record can be mutated.
        const allowedOperations: {
          operation: string;
          request: InjectOptions;
          statuses: number[];
        }[] = [];
        if (expected.create) {
          allowedOperations.push({
            operation: 'create',
            request: { method: 'POST', url: `/api/${model}`, payload: { id: 1 } },
            statuses: [400],
          });
        }
        if (expected.write) {
          allowedOperations.push({
            operation: 'write',
            request: {
              method: 'PATCH',
              url: `/api/${model}/2147483647`,
              payload: {},
            },
            statuses: [400, 404],
          });
        }
        if (expected.unlink) {
          allowedOperations.push({
            operation: 'unlink',
            request: { method: 'DELETE', url: `/api/${model}/2147483647` },
            statuses: [404],
          });
        }
        if (canAccess('user', model, 'action', grants)) {
          allowedOperations.push({
            operation: 'action',
            request: {
              method: 'POST',
              url: `/api/${model}/2147483647/action/action_archive`,
            },
            statuses: [404],
          });
        }
        for (const { operation, request, statuses } of allowedOperations) {
          const response = await as(alice.access_token, request);
          expect(
            statuses,
            `granted ${operation} authorization for ${model} should reach its safe validation boundary (got ${response.statusCode})`
          ).toContain(response.statusCode);
        }
      }

      await GroupMembership.query().findById(membership.id).patch({ active: false });
    });

    it('allows model-specific user writes granted through an access group', async () => {
      const group = await AccessGroup.query().insert({
        code: 'partner_creators',
        name: 'Partner Creators',
      });
      const membership = await GroupMembership.query().insert({
        user_id: alice.user.id,
        group_id: group.id,
      });
      await ModelAccess.query().insert({
        group_id: group.id,
        model_name: 'base.tag',
        create: true,
        write: true,
        unlink: true,
      });
      expect(
        await ModelAccess.query().findOne({ group_id: group.id, model_name: 'base.tag' })
      ).toMatchObject({ create: true, write: true, unlink: true });

      const created = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.tag',
        payload: { name: 'Group-created tag' },
      });
      expect(created.statusCode).toBe(201);
      const tagId = created.json<{ data: { id: number } }>().data.id;
      const tagPermissions = await as(alice.access_token, {
        method: 'GET',
        url: '/api/base.tag/fields',
      });
      expect(tagPermissions.statusCode, tagPermissions.payload).toBe(200);
      expect(tagPermissions.json<{ permissions: { write: boolean } }>().permissions.write).toBe(
        true
      );
      const updated = await as(alice.access_token, {
        method: 'PATCH',
        url: `/api/base.tag/${tagId}`,
        payload: { name: 'Group-updated tag' },
      });
      expect(updated.statusCode, updated.payload).toBe(200);
      expect(updated.json<{ data: { name: string } }>().data.name).toBe('Group-updated tag');

      const archived = await as(alice.access_token, {
        method: 'POST',
        url: `/api/base.tag/${tagId}/action/action_archive`,
      });
      expect(archived.statusCode).toBe(200);
      const restored = await as(alice.access_token, {
        method: 'POST',
        url: `/api/base.tag/${tagId}/action/action_unarchive`,
      });
      expect(restored.statusCode).toBe(200);

      const deleted = await as(alice.access_token, {
        method: 'DELETE',
        url: `/api/base.tag/${tagId}`,
      });
      expect(deleted.statusCode).toBe(200);
      expect(await Tag.query().findById(tagId)).toMatchObject({ active: false });

      const rpcCreated = await rpc(alice.access_token, [
        'base.tag',
        'create',
        [{ name: 'Group-created RPC tag' }],
      ]);
      expect(rpcCreated.statusCode, rpcCreated.payload).toBe(200);
      expect(rpcCreated.json()).not.toHaveProperty('error');
      const rpcTagId = rpcCreated.json<{ result: number }>().result;
      const rpcUpdated = await rpc(alice.access_token, [
        'base.tag',
        'write',
        [[rpcTagId], { name: 'Group-updated RPC tag' }],
      ]);
      expect(rpcUpdated.statusCode, rpcUpdated.payload).toBe(200);
      expect(rpcUpdated.json()).not.toHaveProperty('error');
      expect(await Tag.query().findById(rpcTagId)).toMatchObject({
        name: 'Group-updated RPC tag',
      });
      const rpcUnlinked = await rpc(alice.access_token, ['base.tag', 'unlink', [[rpcTagId]]]);
      expect(rpcUnlinked.statusCode, rpcUnlinked.payload).toBe(200);
      expect(rpcUnlinked.json()).not.toHaveProperty('error');
      expect(await Tag.query().findById(rpcTagId)).toMatchObject({ active: false });

      const unrelatedModelWrites = await Promise.all([
        as(alice.access_token, {
          method: 'POST',
          url: '/api/base.partner',
          payload: { name: 'Out-of-scope partner' },
        }),
        as(alice.access_token, {
          method: 'PATCH',
          url: '/api/base.partner/1',
          payload: { name: 'Out-of-scope update' },
        }),
        as(alice.access_token, {
          method: 'POST',
          url: '/api/base.partner/1/action/action_archive',
        }),
        as(alice.access_token, { method: 'DELETE', url: '/api/base.partner/1' }),
      ]);
      expect(unrelatedModelWrites.map(({ statusCode }) => statusCode)).toEqual([
        403, 403, 403, 403,
      ]);

      await GroupMembership.query().findById(membership.id).patch({ active: false });
      const revoked = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.tag',
        payload: { name: 'Revoked group tag' },
      });
      expect(revoked.statusCode).toBe(403);

      const protectedGrant = await as(admin.access_token, {
        method: 'POST',
        url: '/api/base.model_access',
        payload: { group_id: group.id, model_name: 'base.model_access', create: true },
      });
      expect(protectedGrant.statusCode).toBe(400);
    });

    it('persists REST mutations for both administrative roles', async () => {
      for (const { role, token } of [
        { role: 'superadmin', token: admin.access_token },
        { role: 'system', token: system.access_token },
      ] as const) {
        const created = await as(token, {
          method: 'POST',
          url: '/api/base.tag',
          payload: { name: `${role} created tag` },
        });
        expect(created.statusCode, `${role} create`).toBe(201);
        const tagId = created.json<{ data: { id: number } }>().data.id;
        expect(await Tag.query().findById(tagId)).toMatchObject({
          name: `${role} created tag`,
        });

        const updated = await as(token, {
          method: 'PATCH',
          url: `/api/base.tag/${tagId}`,
          payload: { name: `${role} updated tag` },
        });
        expect(updated.statusCode, `${role} write`).toBe(200);
        expect(await Tag.query().findById(tagId)).toMatchObject({
          name: `${role} updated tag`,
        });

        const archived = await as(token, {
          method: 'POST',
          url: `/api/base.tag/${tagId}/action/action_archive`,
        });
        expect(archived.statusCode, `${role} archive`).toBe(200);
        expect(await Tag.query().findById(tagId)).toMatchObject({ active: false });

        const restored = await as(token, {
          method: 'POST',
          url: `/api/base.tag/${tagId}/action/action_unarchive`,
        });
        expect(restored.statusCode, `${role} unarchive`).toBe(200);
        expect(await Tag.query().findById(tagId)).toMatchObject({ active: true });

        const unlinked = await as(token, {
          method: 'DELETE',
          url: `/api/base.tag/${tagId}`,
        });
        expect(unlinked.statusCode, `${role} unlink`).toBe(200);
        expect(await Tag.query().findById(tagId)).toMatchObject({ active: false });
      }
    });

    it('persists group-granted user mutations on an owned addon record', async () => {
      const group = await AccessGroup.query().insert({
        code: 'category_maintainers',
        name: 'Category Maintainers',
      });
      const membership = await GroupMembership.query().insert({
        user_id: alice.user.id,
        group_id: group.id,
      });
      await ModelAccess.query().insert({
        group_id: group.id,
        model_name: 'base.partner_category',
        create: true,
        write: true,
        unlink: true,
      });

      const created = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.partner_category',
        payload: { code: `alice-category-${Date.now()}`, name: 'Alice category' },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const categoryId = created.json<{ data: { id: number } }>().data.id;
      expect(await PartnerCategory.query().findById(categoryId)).toMatchObject({
        name: 'Alice category',
      });

      const updated = await as(alice.access_token, {
        method: 'PATCH',
        url: `/api/base.partner_category/${categoryId}`,
        payload: { name: 'Alice updated category' },
      });
      expect(updated.statusCode, updated.payload).toBe(200);
      expect(await PartnerCategory.query().findById(categoryId)).toMatchObject({
        name: 'Alice updated category',
      });

      const archived = await as(alice.access_token, {
        method: 'POST',
        url: `/api/base.partner_category/${categoryId}/action/action_archive`,
      });
      expect(archived.statusCode).toBe(200);
      expect(await PartnerCategory.query().findById(categoryId)).toMatchObject({ active: false });

      const restored = await as(alice.access_token, {
        method: 'POST',
        url: `/api/base.partner_category/${categoryId}/action/action_unarchive`,
      });
      expect(restored.statusCode).toBe(200);
      expect(await PartnerCategory.query().findById(categoryId)).toMatchObject({ active: true });

      const unlinked = await as(alice.access_token, {
        method: 'DELETE',
        url: `/api/base.partner_category/${categoryId}`,
      });
      expect(unlinked.statusCode).toBe(200);
      expect(await PartnerCategory.query().findById(categoryId)).toMatchObject({ active: false });

      await GroupMembership.query().findById(membership.id).patch({ active: false });
    });

    it('persists granted activity writes and denies unlink without losing the record', async () => {
      const group = await AccessGroup.query().insert({
        code: 'activity_maintainers',
        name: 'Activity Maintainers',
      });
      await GroupMembership.query().insert({ user_id: alice.user.id, group_id: group.id });
      await ModelAccess.query().insert({
        group_id: group.id,
        model_name: 'base.activity',
        create: true,
        write: true,
      });
      await ModelAccess.query().insert({
        group_id: group.id,
        model_name: 'base.tag_link',
        create: true,
      });
      const partner = await Partner.query().findById(alice.user.partner_id).throwIfNotFound();
      const foreignCompany = await Company.query().insert({ name: 'Activity Foreign Company' });
      const foreignPartner = await Partner.query().insert({
        name: 'Activity Foreign Partner',
        company_id: foreignCompany.id,
      });
      const priorityTag = await Tag.query().insert({ name: 'Scoped Activity Priority' });

      const allowedOwnTagLink = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.tag_link',
        payload: {
          tag_id: priorityTag.id,
          resource_model: Partner.modelName,
          resource_id: partner.id,
        },
      });
      expect(allowedOwnTagLink.statusCode, allowedOwnTagLink.payload).toBe(201);
      const ownTagLinkId = allowedOwnTagLink.json<{ data: { id: number } }>().data.id;
      expect(await TagLink.query().findById(ownTagLinkId)).toMatchObject({
        tag_id: priorityTag.id,
        resource_model: Partner.modelName,
        resource_id: partner.id,
      });

      const deniedForeignTagLink = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.tag_link',
        payload: {
          tag_id: priorityTag.id,
          resource_model: Partner.modelName,
          resource_id: foreignPartner.id,
        },
      });
      expect(deniedForeignTagLink.statusCode).toBe(400);
      expect(
        await TagLink.query().findOne({
          resource_model: Partner.modelName,
          resource_id: foreignPartner.id,
        })
      ).toBeUndefined();

      const deniedForeignParent = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.activity',
        payload: {
          summary: 'Must not reference another company',
          resource_model: Partner.modelName,
          resource_id: foreignPartner.id,
        },
      });
      expect(deniedForeignParent.statusCode).toBe(400);
      expect(
        await Activity.query().findOne({ summary: 'Must not reference another company' })
      ).toBeUndefined();
      const deniedRpcForeignParent = await rpc(alice.access_token, [
        'base.activity',
        'create',
        [
          {
            summary: 'Must not RPC-reference another company',
            resource_model: Partner.modelName,
            resource_id: foreignPartner.id,
          },
        ],
      ]);
      expect(deniedRpcForeignParent.statusCode).toBe(200);
      expect(deniedRpcForeignParent.json<{ error: { message: string } }>().error.message).toBe(
        'Invalid related record reference'
      );
      expect(
        await Activity.query().findOne({ summary: 'Must not RPC-reference another company' })
      ).toBeUndefined();

      const archivedTag = await Tag.query().insert({ name: 'Archived Activity Parent' });
      await Tag.query().findById(archivedTag.id).patch({ active: false });
      const deniedArchivedParent = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.activity',
        payload: {
          summary: 'Must not reference an archived record',
          resource_model: Tag.modelName,
          resource_id: archivedTag.id,
        },
      });
      expect(deniedArchivedParent.statusCode).toBe(400);
      expect(
        await Activity.query().findOne({ summary: 'Must not reference an archived record' })
      ).toBeUndefined();

      const created = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.activity',
        payload: {
          summary: 'Review customer request',
          resource_model: Partner.modelName,
          resource_id: partner.id,
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const activityId = created.json<{ data: { id: number } }>().data.id;
      expect(await Activity.query().findById(activityId)).toMatchObject({
        summary: 'Review customer request',
        resource_model: Partner.modelName,
        resource_id: partner.id,
      });

      const deniedForeignReassignment = await as(alice.access_token, {
        method: 'PATCH',
        url: `/api/base.activity/${activityId}`,
        payload: { resource_id: foreignPartner.id },
      });
      expect(deniedForeignReassignment.statusCode).toBe(400);
      expect(await Activity.query().findById(activityId)).toMatchObject({
        resource_model: Partner.modelName,
        resource_id: partner.id,
      });

      const updated = await as(alice.access_token, {
        method: 'PATCH',
        url: `/api/base.activity/${activityId}`,
        payload: { summary: 'Customer request reviewed' },
      });
      expect(updated.statusCode, updated.payload).toBe(200);
      expect(await Activity.query().findById(activityId)).toMatchObject({
        summary: 'Customer request reviewed',
      });

      const deniedUnlink = await as(alice.access_token, {
        method: 'DELETE',
        url: `/api/base.activity/${activityId}`,
      });
      expect(deniedUnlink.statusCode).toBe(403);
      expect(await Activity.query().findById(activityId)).toMatchObject({
        summary: 'Customer request reviewed',
      });
    });

    it('scopes group-granted partner category links to the caller company', async () => {
      const group = await AccessGroup.query().insert({
        code: 'partner_category_link_maintainers',
        name: 'Partner Category Link Maintainers',
      });
      await GroupMembership.query().insert({ user_id: alice.user.id, group_id: group.id });
      await ModelAccess.query().insert({
        group_id: group.id,
        model_name: 'base.partner_category_link',
        create: true,
      });

      const ownPartner = await Partner.query().findById(alice.user.partner_id).throwIfNotFound();
      const foreignCompany = await Company.query().insert({
        name: 'Category Link Foreign Company',
      });
      const foreignPartner = await Partner.query().insert({
        name: 'Category Link Foreign Partner',
        company_id: foreignCompany.id,
      });
      const category = await PartnerCategory.query().insert({
        code: `alice-category-link-${Date.now()}`,
        name: 'Alice category link',
      });

      const allowed = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.partner_category_link',
        payload: { partner_id: ownPartner.id, category_id: category.id },
      });
      expect(allowed.statusCode, allowed.payload).toBe(201);
      const allowedId = allowed.json<{ data: { id: number } }>().data.id;
      expect(await PartnerCategoryLink.query().findById(allowedId)).toMatchObject({
        partner_id: ownPartner.id,
        category_id: category.id,
      });

      const denied = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.partner_category_link',
        payload: { partner_id: foreignPartner.id, category_id: category.id },
      });
      expect([400, 403]).toContain(denied.statusCode);
      expect(
        await PartnerCategoryLink.query().findOne({
          partner_id: foreignPartner.id,
          category_id: category.id,
        })
      ).toBeUndefined();
      await PartnerCategoryLink.query().delete().where('category_id', category.id);
      await PartnerCategory.query().deleteById(category.id);
      await Partner.query().deleteById(foreignPartner.id);
      await Company.query().deleteById(foreignCompany.id);
      await GroupMembership.query().delete().where({ user_id: alice.user.id, group_id: group.id });
      await ModelAccess.query().delete().where('group_id', group.id);
      await AccessGroup.query().deleteById(group.id);
    });

    it('scopes group-granted partner addresses to the caller company', async () => {
      const group = await AccessGroup.query().insert({
        code: 'partner_address_maintainers',
        name: 'Partner Address Maintainers',
      });
      await GroupMembership.query().insert({ user_id: alice.user.id, group_id: group.id });
      await ModelAccess.query().insert({
        group_id: group.id,
        model_name: 'base.partner_address',
        create: true,
      });

      const ownPartner = await Partner.query().findById(alice.user.partner_id).throwIfNotFound();
      const foreignCompany = await Company.query().insert({ name: 'Address Foreign Company' });
      const foreignPartner = await Partner.query().insert({
        name: 'Address Foreign Partner',
        company_id: foreignCompany.id,
      });
      const allowed = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.partner_address',
        payload: {
          partner_id: ownPartner.id,
          label: 'Home',
          street: '1 Main Street',
          city: 'Jakarta',
        },
      });
      expect(allowed.statusCode, allowed.payload).toBe(201);
      const allowedId = allowed.json<{ data: { id: number } }>().data.id;
      expect(await PartnerAddress.query().findById(allowedId)).toMatchObject({
        partner_id: ownPartner.id,
        label: 'Home',
        street: '1 Main Street',
      });

      const denied = await as(alice.access_token, {
        method: 'POST',
        url: '/api/base.partner_address',
        payload: {
          partner_id: foreignPartner.id,
          label: 'Foreign Home',
          street: '2 Main Street',
          city: 'Jakarta',
        },
      });
      expect([400, 403]).toContain(denied.statusCode);
      expect(
        await PartnerAddress.query().findOne({ partner_id: foreignPartner.id })
      ).toBeUndefined();

      await PartnerAddress.query().deleteById(allowedId);
      await Partner.query().deleteById(foreignPartner.id);
      await Company.query().deleteById(foreignCompany.id);
      await GroupMembership.query().delete().where({ user_id: alice.user.id, group_id: group.id });
      await ModelAccess.query().delete().where('group_id', group.id);
      await AccessGroup.query().deleteById(group.id);
    });

    it('keeps group-granted organization mutations inside the user company', async () => {
      const company = await Company.query().findOne({ name: 'MoonWitness' }).throwIfNotFound();
      const foreignCompany = await Company.query().insert({ name: 'Organization Foreign Tenant' });
      const foreignDepartment = await OrganizationDepartment.query().insert({
        company_id: foreignCompany.id,
        code: 'foreign_ops',
        name: 'Foreign Operations',
      });
      const group = await AccessGroup.query().insert({
        code: 'organization_maintainers',
        name: 'Organization Maintainers',
      });
      const membership = await GroupMembership.query().insert({
        user_id: alice.user.id,
        group_id: group.id,
      });
      await ModelAccess.query().insert({
        group_id: group.id,
        model_name: 'organization.department',
        create: true,
        write: true,
      });

      const created = await as(alice.access_token, {
        method: 'POST',
        url: '/api/organization.department',
        payload: { company_id: company.id, code: 'alice_ops', name: 'Alice Operations' },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const departmentId = created.json<{ data: { id: number } }>().data.id;
      expect(await OrganizationDepartment.query().findById(departmentId)).toMatchObject({
        company_id: company.id,
        name: 'Alice Operations',
      });

      const updated = await as(alice.access_token, {
        method: 'PATCH',
        url: `/api/organization.department/${departmentId}`,
        payload: { name: 'Alice Operations Updated' },
      });
      expect(updated.statusCode, updated.payload).toBe(200);
      expect(await OrganizationDepartment.query().findById(departmentId)).toMatchObject({
        company_id: company.id,
        name: 'Alice Operations Updated',
      });

      const deniedUnlink = await as(alice.access_token, {
        method: 'DELETE',
        url: `/api/organization.department/${departmentId}`,
      });
      expect(deniedUnlink.statusCode).toBe(403);
      expect(await OrganizationDepartment.query().findById(departmentId)).toMatchObject({
        company_id: company.id,
        name: 'Alice Operations Updated',
      });

      const foreignRead = await as(alice.access_token, {
        method: 'GET',
        url: `/api/organization.department/${foreignDepartment.id}`,
      });
      expect(foreignRead.statusCode).toBe(404);
      const foreignCreate = await as(alice.access_token, {
        method: 'POST',
        url: '/api/organization.department',
        payload: {
          company_id: foreignCompany.id,
          code: 'alice_foreign',
          name: 'Unauthorized Department',
        },
      });
      expect(foreignCreate.statusCode).toBe(403);
      expect(foreignCreate.payload).not.toContain('Organization Foreign Tenant');
      expect(await OrganizationDepartment.query().findById(foreignDepartment.id)).toMatchObject({
        company_id: foreignCompany.id,
        name: 'Foreign Operations',
      });

      await GroupMembership.query().findById(membership.id).patch({ active: false });
    });

    it('scopes structured addresses and categories to the user partner profile', async () => {
      const aliceUser = await User.query().findOne({ login: 'alice' }).throwIfNotFound();
      const customerCategory = await PartnerCategory.query()
        .findOne({ code: 'customer' })
        .throwIfNotFound();
      const indonesia = await Country.query().findOne({ code: 'ID' }).throwIfNotFound();
      await Partner.query().findById(aliceUser.partner_id).patch({ country_id: indonesia.id });
      await PartnerAddress.query().insert({
        partner_id: aliceUser.partner_id,
        label: 'Alice home',
        address_type: 'contact',
        street: '1 Main Street',
        city: 'Jakarta',
        country_id: indonesia.id,
        is_primary: true,
      });
      await PartnerCategoryLink.query().insert({
        partner_id: aliceUser.partner_id,
        category_id: customerCategory.id,
      });

      const profile = await as(alice.access_token, {
        method: 'GET',
        url: '/api/base.partner?with=addresses.country',
      });
      expect(profile.statusCode).toBe(200);
      expect(
        profile.json<{ data: { name: string; addresses: { city: string }[] }[] }>().data
      ).toMatchObject([{ name: 'Alice Regular', addresses: [{ city: 'Jakarta' }] }]);

      const multipleSafeRelations = await as(alice.access_token, {
        method: 'GET',
        url: '/api/base.partner?with=company,country',
      });
      expect(multipleSafeRelations.statusCode, multipleSafeRelations.payload).toBe(200);
      expect(
        multipleSafeRelations.json<{
          data: { company: { name: string }; country: { name: string } }[];
        }>().data
      ).toMatchObject([{ company: { name: 'MoonWitness' }, country: { name: 'Indonesia' } }]);

      const multipleSafeRelationsRpc = await rpc(alice.access_token, [
        'base.partner',
        'search_read',
        [[]],
        { with: 'company,country' },
      ]);
      expect(multipleSafeRelationsRpc.statusCode).toBe(200);
      expect(
        multipleSafeRelationsRpc.json<{
          result: { company: { name: string }; country: { name: string } }[];
        }>().result
      ).toMatchObject([{ company: { name: 'MoonWitness' }, country: { name: 'Indonesia' } }]);

      const mixedSafeAndDeniedRelations = await as(alice.access_token, {
        method: 'GET',
        url: '/api/base.partner?with=company,private_notes',
      });
      expect(mixedSafeAndDeniedRelations.statusCode).toBe(403);

      const mixedSafeAndDeniedRelationsRpc = await rpc(alice.access_token, [
        'base.partner',
        'search_read',
        [[]],
        { with: 'company,private_notes' },
      ]);
      expect(mixedSafeAndDeniedRelationsRpc.statusCode).toBe(403);

      const assignments = await as(alice.access_token, {
        method: 'GET',
        url: '/api/base.partner_category_link?with=category',
      });
      expect(assignments.statusCode).toBe(200);
      expect(assignments.json<{ data: { partner_id: number }[] }>().data).toHaveLength(1);
      expect(assignments.json<{ data: { partner_id: number }[] }>().data[0]?.partner_id).toBe(
        aliceUser.partner_id
      );
    });

    it('hides internal auth models even from administrators', async () => {
      const rest = await as(admin.access_token, { method: 'GET', url: '/api/auth.refresh_token' });
      expect(rest.statusCode).toBe(403);
      const viaRpc = await rpc(admin.access_token, ['auth.refresh_token', 'search_read', [[]]]);
      expect(viaRpc.statusCode).toBe(403);
      const list = await as(admin.access_token, { method: 'GET', url: '/api/models' });
      expect(JSON.stringify(list.json())).not.toContain('auth.refresh_token');
    });

    it('stamps audit fields with the authenticated user', async () => {
      const created = await as(admin.access_token, {
        method: 'POST',
        url: '/api/base.partner',
        payload: { name: 'Audited Partner' },
      });
      expect(created.statusCode).toBe(201);
      const row = await Partner.query().findById(created.json<{ data: { id: number } }>().data.id);
      expect(row?.create_uid).toBe(admin.user.id);
    });

    it('rejects client writes to ORM-managed identity and audit fields over REST and RPC', async () => {
      const partner = await Partner.query().insert({
        name: 'Server-managed metadata probe',
        company_id: 1,
      });
      const managedFields = ['id', 'create_date', 'write_date', 'create_uid', 'write_uid'] as const;
      for (const field of managedFields) {
        const proposedValue = field.endsWith('_date') ? new Date().toISOString() : partner.id + 1;
        const payload = { name: 'Forged metadata', [field]: proposedValue };
        const create = await as(admin.access_token, {
          method: 'POST',
          url: '/api/base.partner',
          payload,
        });
        expect(create.statusCode, `REST create rejects ${field}`).toBe(400);

        const update = await as(admin.access_token, {
          method: 'PATCH',
          url: `/api/base.partner/${partner.id}`,
          payload: { [field]: proposedValue },
        });
        expect(update.statusCode, `REST update rejects ${field}`).toBe(400);

        const rpcCreate = await rpc(admin.access_token, ['base.partner', 'create', [payload]]);
        expect(
          rpcCreate.json<{ error: { code: number } }>().error.code,
          `RPC create rejects ${field}`
        ).toBe(-32602);

        const rpcUpdate = await rpc(admin.access_token, [
          'base.partner',
          'write',
          [[partner.id], { [field]: proposedValue }],
        ]);
        expect(
          rpcUpdate.json<{ error: { code: number } }>().error.code,
          `RPC update rejects ${field}`
        ).toBe(-32602);
      }
      await expect(Partner.query().findById(partner.id)).resolves.toMatchObject({
        name: 'Server-managed metadata probe',
      });
      await expect(Partner.query().findOne({ name: 'Forged metadata' })).resolves.toBeUndefined();
    });

    it('does not let password hashes be probed through filters or sorting', async () => {
      const probe = await as(admin.access_token, {
        method: 'GET',
        url: `/api/base.user?domain=${encodeURIComponent(JSON.stringify([['password', 'like', 'scrypt%']]))}`,
      });
      expect(probe.statusCode).toBe(400);
      const sorted = await as(admin.access_token, {
        method: 'GET',
        url: '/api/base.user?order=password%20asc',
      });
      expect(sorted.statusCode).toBe(400);
    });

    it('uses stable cursor pagination with bounded pages', async () => {
      const first = await as(admin.access_token, {
        method: 'GET',
        url: '/api/base.partner?cursor=0&limit=2&order=id%20asc&count=true',
      });
      expect(first.statusCode).toBe(200);
      const firstPage = first.json<{
        data: { id: number }[];
        total: number;
        nextCursor?: number;
      }>();
      expect(firstPage.data).toHaveLength(2);
      expect(firstPage.nextCursor).toBe(firstPage.data[1]?.id);
      expect(firstPage.total).toBeGreaterThan(2);

      const next = await as(admin.access_token, {
        method: 'GET',
        url: `/api/base.partner?cursor=${firstPage.nextCursor}&limit=2`,
      });
      const nextIds = next.json<{ data: { id: number }[] }>().data.map(({ id }) => id);
      expect(nextIds.every((id) => id > (firstPage.nextCursor ?? 0))).toBe(true);

      expect(
        (
          await as(admin.access_token, {
            method: 'GET',
            url: '/api/base.partner?cursor=0&limit=2&offset=1',
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await as(admin.access_token, {
            method: 'GET',
            url: '/api/base.partner?cursor=0&order=name%20desc',
          })
        ).statusCode
      ).toBe(400);
    });

    it('stores append-only API changes without password or token values', async () => {
      const partner = await as(admin.access_token, {
        method: 'POST',
        url: '/api/base.partner',
        payload: { name: 'Audit Trail Person' },
      });
      const partnerId = partner.json<{ data: { id: number } }>().data.id;
      const created = await as(admin.access_token, {
        method: 'POST',
        url: '/api/base.user',
        payload: {
          login: 'audit-user',
          password: 'secret-audit-password',
          partner_id: partnerId,
          role: 'user',
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.payload).not.toContain('secret-audit-password');
      expect(created.payload).not.toContain('scrypt$');
      const userId = created.json<{ data: { id: number } }>().data.id;
      const event = await AuditLog.query()
        .findOne({ model: 'base.user', record_id: userId, operation: 'create' })
        .throwIfNotFound();
      expect(event.actor_id).toBe(admin.user.id);
      expect(event.changes).toContain('audit-user');
      expect(event.changes).not.toContain('secret-audit-password');
      expect(event.changes).not.toContain('scrypt$');
      const outboxEvent = await OutboxEvent.query()
        .findOne({
          aggregate_model: 'base.user',
          aggregate_id: userId,
          event_type: 'record.created',
        })
        .throwIfNotFound();
      expect(outboxEvent.status).toBe('pending');
      expect(outboxEvent.payload).not.toContain('secret-audit-password');
      expect(outboxEvent.payload).not.toContain('scrypt$');

      const restUser = await as(admin.access_token, {
        method: 'GET',
        url: `/api/base.user/${userId}?with=partner`,
      });
      expect(restUser.statusCode).toBe(200);
      expect(restUser.payload).not.toContain('secret-audit-password');
      expect(restUser.payload).not.toContain('scrypt$');

      const rpcUser = await rpc(admin.access_token, ['base.user', 'search_read', [[]], {}]);
      expect(rpcUser.statusCode).toBe(200);
      expect(rpcUser.payload).not.toContain('secret-audit-password');
      expect(rpcUser.payload).not.toContain('scrypt$');
      const ormUser = await User.query().findById(userId).throwIfNotFound();
      expect(JSON.stringify(ormUser.toJSON())).not.toContain('scrypt$');
      expect(
        JSON.stringify(await User.search_read([['id', '=', userId]], { limit: 1 }))
      ).not.toContain('scrypt$');

      const sensitiveError = await as(admin.access_token, {
        method: 'POST',
        url: '/api/base.user',
        payload: {
          login: 'invalid-secret-probe',
          partner_id: partnerId,
          password: 'secret-validation-probe',
          unexpected_secret: 'secret-error-probe',
        },
      });
      expect(sensitiveError.statusCode).toBe(400);
      expect(sensitiveError.payload).not.toContain('secret-validation-probe');
      expect(sensitiveError.payload).not.toContain('secret-error-probe');

      expect(
        (await as(alice.access_token, { method: 'GET', url: '/api/base.audit_log' })).statusCode
      ).toBe(403);
      expect(
        (await as(admin.access_token, { method: 'GET', url: '/api/base.audit_log' })).statusCode
      ).toBe(200);
      expect(
        (
          await as(admin.access_token, {
            method: 'DELETE',
            url: `/api/base.audit_log/${event.id}?hard=true`,
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await as(admin.access_token, {
            method: 'POST',
            url: '/api/base.audit_log',
            payload: { model: 'base.partner', record_id: partnerId, operation: 'create' },
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await as(admin.access_token, {
            method: 'PATCH',
            url: `/api/base.audit_log/${event.id}`,
            payload: { changes: '{"forged":true}' },
          })
        ).statusCode
      ).toBe(403);

      for (const [method, args] of [
        ['create', [[{ model: 'base.partner', record_id: partnerId, operation: 'create' }]]],
        ['write', [[event.id], { changes: '{"forged":true}' }]],
        ['unlink', [[event.id]]],
      ] as const) {
        const rpcMutation = await rpc(admin.access_token, ['base.audit_log', method, args]);
        expect(rpcMutation.statusCode).toBe(403);
        expect(rpcMutation.json<{ error: { code: number } }>().error.code).toBe(-32003);
      }
      await expect(AuditLog.query().findById(event.id)).resolves.toMatchObject({
        id: event.id,
        model: 'base.user',
        record_id: userId,
        operation: 'create',
      });

      const rpcWrite = await rpc(admin.access_token, [
        'base.partner',
        'write',
        [[partnerId], { phone: '555-0100' }],
      ]);
      expect(rpcWrite.statusCode).toBe(200);
      const rpcEvent = await AuditLog.query().findOne({
        model: 'base.partner',
        record_id: partnerId,
        operation: 'write',
      });
      expect(rpcEvent?.changes).toContain('555-0100');
    });

    it('rolls back a business create when the audit outbox cannot be recorded', async () => {
      await db.raw(`
        CREATE TRIGGER reject_outbox_insert
        BEFORE INSERT ON outbox_events
        BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;
      `);
      const response = await as(admin.access_token, {
        method: 'POST',
        url: '/api/base.partner',
        payload: { name: 'Must roll back' },
      });
      await db.raw('DROP TRIGGER reject_outbox_insert');
      expect(response.statusCode).toBe(500);
      expect(await Partner.query().findOne({ name: 'Must roll back' })).toBeUndefined();
    });

    it('rejects login and refresh for users whose partner is inactive', async () => {
      const session = (await login('alice', USER_PASSWORD)).json<TokenBody>().data;
      await Partner.query().findById(alice.user.partner_id).patch({ active: false });

      expect((await login('alice', USER_PASSWORD)).statusCode).toBe(401);
      const refreshed = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refresh_token: session.refresh_token },
      });
      expect(refreshed.statusCode).toBe(401);
    });

    it('uses the current database role instead of stale JWT role claims', async () => {
      await User.query().findById(admin.user.id).patch({ role: 'user' });
      try {
        expect(
          (await as(admin.access_token, { method: 'GET', url: '/api/base.user' })).statusCode
        ).toBe(403);
      } finally {
        await User.query().findById(admin.user.id).patch({ role: 'superadmin' });
      }
    });

    it('applies role and active-state changes immediately to existing access tokens', async () => {
      await User.query().findById(admin.user.id).patch({ role: 'user' });
      try {
        const demoted = await as(admin.access_token, {
          method: 'GET',
          url: '/api/base.user',
        });
        expect(demoted.statusCode).toBe(403);
        await User.query().findById(admin.user.id).patch({ active: false });
        const disabled = await as(admin.access_token, {
          method: 'GET',
          url: '/api/base.user',
        });
        expect(disabled.statusCode).toBe(401);
      } finally {
        await User.query().findById(admin.user.id).patch({ role: 'superadmin', active: true });
      }
    });
  });
});
