import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knex from 'knex';
import type { FastifyInstance } from 'fastify';
import { Company } from '@moonwitness/orm-base';
import type { SecurityContext } from '../src/auth/rules.js';
import { buildApp } from '../src/app.js';
import { registerRecordRule, clearRecordRules, getRecordRuleDomain } from '../src/auth/rules.js';
import { canAccess, canManageBaseUser, operationFor, rpcOperation } from '../src/auth/policy.js';

const ADMIN_PASSWORD = 'admin-rules-password';

describe('Row-Level Security & Multi-Tenancy Record Rules', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({
      db: knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
      }),
      superadminPassword: ADMIN_PASSWORD,
      jwtSecret: 'test-secret-test-secret-test-secret-123',
      loginRateMax: 1000,
    });
    await app.ready();
  }, 30000);

  afterAll(async () => {
    clearRecordRules();
    await app.close();
  });

  it('superadmin and system roles bypass row-level domain filtering', async () => {
    const fakeSuperReq = {
      auth: { userId: 1, role: 'superadmin' },
      env: app.env,
    } as unknown as SecurityContext['request'] & { auth: { userId: number; role: string } };

    const domain = await getRecordRuleDomain(fakeSuperReq, 'base.partner');
    expect(domain).toEqual([]);
  });

  it('evaluates custom registered record rules for regular users', async () => {
    registerRecordRule('base.partner', (_ctx) => {
      return [['name', 'ilike', 'Enterprise%']];
    });

    const fakeUserReq = {
      auth: { userId: 42, role: 'user', partnerId: 99, companyId: 10 },
      env: app.env,
    } as unknown as SecurityContext['request'] & {
      auth: { userId: number; role: string; partnerId: number; companyId: number };
    };

    const domain = await getRecordRuleDomain(fakeUserReq, 'base.partner');
    expect(domain).toEqual([
      ['company_id', '=', 10],
      ['name', 'ilike', 'Enterprise%'],
    ]);
    clearRecordRules();
  });

  it('keeps public reference data open and applies safe fallback scopes', async () => {
    const userReq = {
      auth: { userId: 8, role: 'user', companyId: 10 },
      env: app.env,
    } as unknown as SecurityContext['request'] & {
      auth: { userId: number; role: string; companyId: number };
    };
    expect(await getRecordRuleDomain(userReq, 'base.country')).toEqual([]);
    expect(await getRecordRuleDomain(userReq, 'base.partner')).toEqual([
      ['company_id', '=', 10],
      ['id', '=', -1],
    ]);
    expect(await getRecordRuleDomain(userReq, 'base.company')).toEqual([['id', '=', 10]]);
    expect(await getRecordRuleDomain(userReq, 'base.partner_address')).toEqual([
      ['partner_id', '=', -1],
    ]);
    expect(await getRecordRuleDomain(userReq, 'base.audit_log')).toEqual([['create_uid', '=', 8]]);
    expect(
      await getRecordRuleDomain({ env: app.env } as SecurityContext['request'], 'base.partner')
    ).toEqual([]);
  });

  it('scopes notification inbox and preferences by company and authenticated recipient', async () => {
    const userReq = {
      auth: { userId: 42, role: 'user', companyId: 10 },
      env: app.env,
    } as unknown as SecurityContext['request'] & {
      auth: { userId: number; role: string; companyId: number };
    };
    await expect(getRecordRuleDomain(userReq, 'notification.notification')).resolves.toEqual([
      ['company_id', '=', 10],
      ['recipient_id', '=', 42],
    ]);
    await expect(getRecordRuleDomain(userReq, 'notification.preference')).resolves.toEqual([
      ['company_id', '=', 10],
      ['user_id', '=', 42],
    ]);
  });

  it('keeps WhatsApp scoped for superadmin through dedicated, generic REST and JSON-RPC APIs', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'superadmin', password: ADMIN_PASSWORD },
    });
    const headers = { authorization: `Bearer ${login.json().data.access_token}` };
    const company = await Company.query().findOne({ name: 'MoonWitness' }).throwIfNotFound();
    const foreign = await Company.query().insert({ name: 'WhatsApp foreign tenant' });
    const [ownAccount] = await app
      .db('whatsapp_accounts')
      .insert({
        company_id: company.id,
        status: 'connected',
        qr_code: 'private-session-fixture',
      })
      .returning('id');
    const [foreignAccount] = await app
      .db('whatsapp_accounts')
      .insert({
        company_id: foreign.id,
        status: 'connected',
        qr_code: 'foreign-session-fixture',
      })
      .returning('id');
    const list = await app.inject({ method: 'GET', url: '/api/whatsapp.account', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.map((row: { id: number }) => row.id)).toEqual([ownAccount.id]);
    expect(JSON.stringify(list.json())).not.toContain('private-session-fixture');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/whatsapp.account/${foreignAccount.id}`,
          headers,
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/whatsapp/account',
          headers: { ...headers, 'x-company-id': String(foreign.id) },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/whatsapp.account',
          headers,
          payload: { company_id: foreign.id },
        })
      ).statusCode
    ).toBe(403);
    const rpc = await app.inject({
      method: 'POST',
      url: '/jsonrpc',
      headers,
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'call',
        params: {
          service: 'object',
          method: 'execute_kw',
          args: ['whatsapp.account', 'search_read', [[]]],
        },
      },
    });
    expect(rpc.json().result.map((row: { id: number }) => row.id)).toEqual([ownAccount.id]);
    const denied = await app.inject({
      method: 'POST',
      url: '/jsonrpc',
      headers,
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'call',
        params: {
          service: 'object',
          method: 'execute_kw',
          args: ['whatsapp.account', 'write', [[ownAccount.id], { company_id: foreign.id }]],
        },
      },
    });
    expect(denied.json().error).toBeDefined();
  });

  it('multi-tenant requests resolve company from X-Company-Id header', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'superadmin', password: ADMIN_PASSWORD },
    });

    expect(loginRes.statusCode).toBe(200);
    const token = loginRes.json().data.access_token;

    const company = await Company.query().findOne({ name: 'MoonWitness' }).throwIfNotFound();
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': String(company.id),
      },
    });

    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().data.company_id).toBe(company.id);
    const denied = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': '999999' },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('central access policy', () => {
  it('denies internal and admin-only models to users while honoring explicit grants', () => {
    const grant = {
      model_name: 'base.partner',
      read: false,
      create: true,
      write: false,
      unlink: false,
    };
    expect(canAccess('user', 'auth.refresh_token', 'read')).toBe(false);
    expect(canAccess('user', 'base.user', 'read')).toBe(false);
    for (const model of [
      'knowledge.witness_testimony',
      'knowledge.witness_correction',
      'knowledge.witness_interpretation',
      'knowledge.story_version',
      'knowledge.story_page_version',
      'knowledge.research_suggestion_version',
      'knowledge.concept_profile_review_decision',
      'knowledge.textual_alignment_candidate_review_decision',
    ]) {
      const fullWitnessGrant = {
        model_name: model,
        read: true,
        create: true,
        write: true,
        unlink: true,
      };
      for (const operation of ['read', 'create', 'write', 'unlink', 'action'] as const) {
        expect(canAccess('user', model, operation)).toBe(false);
        expect(canAccess('user', model, operation, [fullWitnessGrant])).toBe(false);
        expect(canAccess('superadmin', model, operation)).toBe(false);
        expect(canAccess('system', model, operation)).toBe(false);
      }
    }
    expect(canAccess('user', 'base.partner', 'read')).toBe(true);
    expect(canAccess('user', 'base.partner', 'action', [grant])).toBe(false);
    expect(canAccess('user', 'base.partner', 'create', [grant])).toBe(true);
    expect(canAccess('unknown', 'base.partner', 'read')).toBe(false);
    expect(canAccess('system', 'auth.refresh_token', 'read')).toBe(false);
    expect(canAccess('system', 'base.partner', 'unlink')).toBe(true);
    expect(canAccess('superadmin', 'base.audit_log', 'write')).toBe(false);
  });

  it('keeps privacy and witness records out of generic access for every role and operation', () => {
    const roles = ['user', 'superadmin', 'system'];
    const operations = ['read', 'create', 'write', 'unlink', 'action'] as const;
    const grants = [
      {
        model_name: 'knowledge.privacy_projection',
        read: true,
        create: true,
        write: true,
        unlink: true,
      },
    ];

    for (const model of [
      'knowledge.privacy_revocation',
      'knowledge.privacy_projection',
      'knowledge.witness_testimony',
      'knowledge.witness_correction',
      'knowledge.witness_interpretation',
    ]) {
      for (const role of roles) {
        for (const operation of operations) {
          expect(canAccess(role, model, operation, grants)).toBe(false);
        }
      }
    }
  });

  it('protects system users and maps HTTP and RPC operations with default deny', () => {
    expect(canManageBaseUser('system', 'unlink', 'system')).toBe(true);
    expect(canManageBaseUser('user', 'read')).toBe(false);
    expect(canManageBaseUser('superadmin', 'read', 'system')).toBe(true);
    expect(canManageBaseUser('superadmin', 'write', 'system')).toBe(false);
    expect(canManageBaseUser('superadmin', 'create', undefined, 'system')).toBe(false);
    expect(canManageBaseUser('superadmin', 'write', 'user', 'user')).toBe(true);
    expect(operationFor('GET', '/api/base.partner')).toBe('read');
    expect(operationFor('POST', '/api/base.partner/action/:method')).toBe('action');
    expect(operationFor('PATCH', '/api/base.partner')).toBe('write');
    expect(operationFor('DELETE', '/api/base.partner')).toBe('unlink');
    expect(operationFor('OPTIONS', '/api/base.partner')).toBe('action');
    expect(rpcOperation('search_read')).toBe('read');
    expect(rpcOperation('create')).toBe('create');
    expect(rpcOperation('unlink')).toBe('unlink');
    expect(rpcOperation('unknown')).toBeNull();
  });
});
