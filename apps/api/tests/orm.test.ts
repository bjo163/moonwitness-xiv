import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import knex, { type Knex } from 'knex';
import { Model } from 'objection';
import type { QueryContext } from 'objection';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BaseModel, Registry, Environment } from '@moonwitness/orm';
import { Company, Language, User } from '@moonwitness/orm-base';
import { OrganizationDepartment } from '@moonwitness/orm-organization';
import { LocalFileAttachmentStorage, type AttachmentStorage } from '@moonwitness/orm-storage';
import { buildApp } from '../src/app.js';
import type { FastifyInstance, InjectOptions } from 'fastify';

class TestItem extends BaseModel {
  static override modelName = 'test.item';
  static override tableName = 'test_items';
  static override defaultOrder = 'name asc';
  static override exposedActions = [...BaseModel.exposedActions, 'action_toggle_company'];

  name!: string;
  email?: string;
  is_company?: boolean;
  parent_id?: number | null;
  city?: string;
  state?: 'draft' | 'confirmed' | 'cancelled';

  override async $beforeInsert(context: QueryContext) {
    await super.$beforeInsert(context);
    if (this.is_company === undefined) this.is_company = false;
    if (!this.state) this.state = 'draft';
  }

  async action_toggle_company(): Promise<this> {
    return this.update({ is_company: !this.is_company });
  }

  async action_confirm(): Promise<this> {
    return this.update({ state: 'confirmed' });
  }

  async action_cancel(): Promise<this> {
    return this.update({ state: 'cancelled' });
  }

  static override jsonSchema = {
    type: 'object',
    required: ['name'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      email: { type: 'string' },
      is_company: { type: 'boolean' },
      active: { type: 'boolean' },
    },
  };
}

Registry.register(TestItem);

describe('Enterprise BaseModel & Fastify Integration', () => {
  let testDb: Knex;
  let app: FastifyInstance;
  let attachmentStorageDirectory: string;
  const attachmentStorageOperations: string[] = [];
  let accessToken = '';
  /** Injects a request authenticated as the seeded superadmin. */
  const send = (options: InjectOptions) =>
    app.inject({
      ...options,
      headers: { authorization: `Bearer ${accessToken}`, ...options.headers },
    });

  beforeAll(async () => {
    testDb = knex({
      client: 'better-sqlite3',
      connection: {
        filename: ':memory:',
      },
      useNullAsDefault: true,
    });

    Model.knex(testDb);

    await testDb.schema.createTable('test_items', (table) => {
      table.increments('id').primary();
      table.string('name').notNullable();
      table.string('email');
      table.boolean('is_company').defaultTo(false);
      table.integer('parent_id').nullable();
      table.string('city');
      table.string('state').defaultTo('draft');
      table.boolean('active').defaultTo(true);
      table.timestamp('create_date').defaultTo(testDb.fn.now());
      table.timestamp('write_date').defaultTo(testDb.fn.now());
      table.integer('create_uid').nullable();
      table.integer('write_uid').nullable();
    });

    process.env.NODE_ENV = 'test';
    attachmentStorageDirectory = await mkdtemp(path.join(tmpdir(), 'moonwitness-attachments-'));
    const localStorage = new LocalFileAttachmentStorage(attachmentStorageDirectory);
    const attachmentStorage: AttachmentStorage = {
      put: async (key, content) => {
        attachmentStorageOperations.push('put');
        return localStorage.put(key, content);
      },
      get: async (key) => {
        attachmentStorageOperations.push('get');
        return localStorage.get(key);
      },
      delete: async (key) => {
        attachmentStorageOperations.push('delete');
        return localStorage.delete(key);
      },
      list: () => localStorage.list(),
    };
    app = await buildApp({
      db: testDb,
      superadminPassword: 'api-test-password',
      jwtSecret: 'test-secret-test-secret-test-secret-123',
      attachmentStorage,
    });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'superadmin', password: 'api-test-password' },
    });
    accessToken = login.json<{ data: { access_token: string } }>().data.access_token;
  }, 30000);

  afterAll(async () => {
    await app.close();
    await testDb.destroy();
    await rm(attachmentStorageDirectory, { recursive: true, force: true });
  });

  it('should register models in Registry', () => {
    expect(Registry.has('test.item')).toBe(true);
  });

  it('blocks generic attachments for witness records excluded from generic access', async () => {
    const witness = await testDb('knowledge_witness_testimonies')
      .where({ external_key: 'synthetic-witness-scoped-001' })
      .first('id');
    const superadmin = await testDb('users').where({ login: 'superadmin' }).first('id');
    if (!witness || !superadmin) throw new Error('Synthetic witness fixture is required');

    const key = randomUUID();
    const content = Buffer.from('SYNTHETIC-WITNESS-ATTACHMENT-CANARY');
    await new LocalFileAttachmentStorage(attachmentStorageDirectory).put(key, content);
    await testDb('attachments').insert({
      name: 'synthetic-witness-attachment-canary.txt',
      resource_model: 'knowledge.witness_testimony',
      resource_id: Number(witness.id),
      mimetype: 'text/plain',
      size_bytes: content.length,
      storage_key: key,
      checksum: 'a'.repeat(64),
      create_uid: Number(superadmin.id),
    });
    const attachment = await testDb('attachments')
      .where({ name: 'synthetic-witness-attachment-canary.txt' })
      .first('id');
    if (!attachment) throw new Error('Synthetic witness attachment fixture is required');

    attachmentStorageOperations.splice(0, attachmentStorageOperations.length);
    const download = await send({
      method: 'GET',
      url: `/api/base.attachment/${attachment.id}/download`,
    });
    expect(download.statusCode).toBe(404);
    expect(download.payload).not.toContain('SYNTHETIC-WITNESS-ATTACHMENT-CANARY');
    expect(attachmentStorageOperations).not.toContain('get');

    const upload = await send({
      method: 'POST',
      url: `/api/base.attachment/upload?resource_model=knowledge.witness_testimony&resource_id=${witness.id}&name=blocked.txt`,
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-mime': 'text/plain',
      },
      payload: Buffer.from('SHOULD-NOT-BE-STORED'),
    });
    expect(upload.statusCode).toBe(404);
    expect(attachmentStorageOperations).not.toContain('put');
    expect(
      await testDb('attachments').where({ name: 'blocked.txt', resource_id: witness.id })
    ).toHaveLength(0);
    await testDb('attachments').where({ id: attachment.id }).delete();
    await new LocalFileAttachmentStorage(attachmentStorageDirectory).delete(key);
  });

  it('keeps synthetic privacy projections out of generic REST and JSON-RPC', async () => {
    const witness = await testDb('knowledge_witness_testimonies')
      .where({ external_key: 'synthetic-witness-scoped-001' })
      .first('company_id');
    if (!witness) throw new Error('Synthetic witness fixture is required');

    const projectionKey = `generic-api-canary-${randomUUID()}`;
    const canary = `SYNTHETIC-PRIVACY-GENERIC-CANARY-${randomUUID()}`;
    const projection = JSON.stringify({ excerpt: canary });
    await testDb('knowledge_privacy_projections').insert({
      company_id: witness.company_id,
      projection_key: projectionKey,
      subject_ref_sha256: 'a'.repeat(64),
      projection_json: projection,
      projection_digest: createHash('sha256').update(projection, 'utf8').digest('hex'),
      synthetic: true,
      visibility: 'RESTRICTED',
      state: 'active',
    });

    try {
      const rest = await send({
        method: 'GET',
        url: '/api/knowledge.privacy_projection',
      });
      expect(rest.statusCode).toBe(403);
      expect(rest.payload).not.toContain(canary);
      expect(rest.payload).not.toContain(projectionKey);

      const rpc = await send({
        method: 'POST',
        url: '/jsonrpc',
        payload: {
          jsonrpc: '2.0',
          id: 'privacy-projection-canary',
          method: 'call',
          params: {
            service: 'object',
            method: 'execute_kw',
            args: ['knowledge.privacy_projection', 'search_read', [[]], {}],
          },
        },
      });
      expect(rpc.statusCode, rpc.payload).toBe(403);
      expect(rpc.json<{ error: { code: number; message: string } }>().error).toMatchObject({
        code: -32003,
        message: 'Forbidden',
      });
      expect(rpc.payload).not.toContain(canary);
      expect(rpc.payload).not.toContain(projectionKey);
    } finally {
      await testDb('knowledge_privacy_projections')
        .where({ projection_key: projectionKey })
        .delete();
    }
  });

  it('keeps INTERNAL story pages out of generic REST and JSON-RPC', async () => {
    const superadmin = await testDb('users').where({ login: 'superadmin' }).first('id');
    const company = await testDb('companies').first('id');
    if (!superadmin || !company) throw new Error('Synthetic story actor is required');
    const storyId = `mw:story:api-canary-${randomUUID()}`;
    const pageId = `mw:story-page:api-canary-${randomUUID()}`;
    const canary = `SYNTHETIC-INTERNAL-STORY-CANARY-${randomUUID()}`;
    const story = {
      schema_version: 1,
      story_id: storyId,
      version: 1,
      title: 'Synthetic API canary',
      visibility: 'INTERNAL',
      pages: [{ page_id: pageId, page_order: 1, original_text: canary }],
    };
    const storyJson = JSON.stringify(story);
    await testDb('knowledge_story_versions').insert({
      company_id: company.id,
      story_id: storyId,
      version: 1,
      visibility: 'INTERNAL',
      title: story.title,
      story_json: storyJson,
      story_digest: createHash('sha256').update(storyJson, 'utf8').digest('hex'),
      page_count: 1,
      recorded_by_id: superadmin.id,
    });
    const version = await testDb('knowledge_story_versions')
      .where({ story_id: storyId })
      .first('id');
    if (!version) throw new Error('Synthetic story canary fixture is required');
    await testDb('knowledge_story_page_versions').insert({
      story_version_id: version.id,
      page_id: pageId,
      page_order: 1,
      original_text: canary,
      original_text_digest: createHash('sha256').update(canary, 'utf8').digest('hex'),
    });

    const rest = await send({ method: 'GET', url: '/api/knowledge.story_version' });
    expect(rest.statusCode).toBe(403);
    expect(rest.payload).not.toContain(canary);
    expect(rest.payload).not.toContain(storyId);
    const rpc = await send({
      method: 'POST',
      url: '/jsonrpc',
      payload: {
        jsonrpc: '2.0',
        id: 'story-canary',
        method: 'call',
        params: {
          service: 'object',
          method: 'execute_kw',
          args: ['knowledge.story_page_version', 'search_read', [[]], {}],
        },
      },
    });
    expect(rpc.statusCode).toBe(403);
    expect(rpc.payload).not.toContain(canary);
    expect(rpc.payload).not.toContain(storyId);
  });

  it('keeps INTERNAL local-AI suggestions out of generic REST and JSON-RPC', async () => {
    const superadmin = await testDb('users').where({ login: 'superadmin' }).first('id');
    const company = await testDb('companies').first('id');
    if (!superadmin || !company) throw new Error('Synthetic suggestion actor is required');
    const suggestionId = `mw:suggestion:api-canary-${randomUUID()}`;
    const canary = `SYNTHETIC-INTERNAL-SUGGESTION-CANARY-${randomUUID()}`;
    const suggestionJson = JSON.stringify({ id: suggestionId, kind: 'claim', text: canary });
    await testDb('knowledge_research_suggestion_versions').insert({
      company_id: company.id,
      suggestion_id: suggestionId,
      version: 1,
      visibility: 'INTERNAL',
      status: 'unreviewed',
      suggestion_json: suggestionJson,
      suggestion_digest: createHash('sha256').update(suggestionJson, 'utf8').digest('hex'),
      recorded_by_id: superadmin.id,
    });

    const rest = await send({
      method: 'GET',
      url: '/api/knowledge.research_suggestion_version',
    });
    expect(rest.statusCode).toBe(403);
    expect(rest.payload).not.toContain(canary);
    expect(rest.payload).not.toContain(suggestionId);
    const rpc = await send({
      method: 'POST',
      url: '/jsonrpc',
      payload: {
        jsonrpc: '2.0',
        id: 'suggestion-canary',
        method: 'call',
        params: {
          service: 'object',
          method: 'execute_kw',
          args: ['knowledge.research_suggestion_version', 'search_read', [[]], {}],
        },
      },
    });
    expect(rpc.statusCode).toBe(403);
    expect(rpc.payload).not.toContain(canary);
    expect(rpc.payload).not.toContain(suggestionId);
  });

  it('does not expose password hashes in database error responses', async () => {
    const payload = { login: 'superadmin', partner_id: 2, password: 'test-error-password' };
    const response = await send({ method: 'POST', url: '/api/base.user', payload });
    expect(response.statusCode).toBe(409);
    expect(response.payload).not.toContain('scrypt$');
    expect(response.payload).not.toContain(payload.password);
    const rpc = await send({
      method: 'POST',
      url: '/jsonrpc',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'call',
        params: {
          service: 'object',
          method: 'execute_kw',
          args: ['base.user', 'create', [payload]],
        },
      },
    });
    expect(rpc.json<{ error: { message: string } }>().error.message).toBe('Execution error');
    expect(rpc.payload).not.toContain('scrypt$');
    expect(rpc.payload).not.toContain(payload.password);
  });

  it('serves seeded user profiles through the generic addon endpoint', async () => {
    const response = await send({
      method: 'GET',
      url: '/api/base.user?with=partner.company',
    });
    expect(response.statusCode, response.payload).toBe(200);
    const body = response.json<{
      data: {
        login: string;
        partner: {
          name: string;
          company: { name: string };
        };
      }[];
    }>();
    expect(body.data).toHaveLength(2);
    const admin = body.data.find((user) => user.login === 'superadmin');
    expect(admin?.partner).toMatchObject({ name: 'Super Administrator' });
    expect(admin?.partner.company).toMatchObject({ name: 'MoonWitness' });
    expect(admin).not.toHaveProperty('email');
    expect(admin).not.toHaveProperty('name');
    expect(admin).not.toHaveProperty('password');
    const partner = await send({
      method: 'GET',
      url: '/api/base.partner?domain=%5B%5B%22name%22%2C%22%3D%22%2C%22Acme%20Studio%22%5D%5D&with=[addresses.country,category_links.category]',
    });
    expect(partner.statusCode, partner.payload).toBe(200);
    expect(
      partner.json<{
        data: {
          addresses: { city: string; country: { code: string } }[];
          category_links: { category: { code: string } }[];
        }[];
      }>().data[0]
    ).toMatchObject({
      addresses: [{ city: 'San Francisco', country: { code: 'US' } }],
      category_links: [{ category: { code: 'customer' } }],
    });
    expect(response.payload).not.toContain('scrypt$');
    const english = await Language.query().findOne({ code: 'en-US' }).throwIfNotFound();
    const superadmin = await User.query().findOne({ login: 'superadmin' }).throwIfNotFound();
    await testDb('users').where({ id: superadmin.id }).update({ language_id: english.id });
    try {
      const commaRelations = await send({
        method: 'GET',
        url: '/api/base.user?with=partner%2Clanguage&count=true&order=login%20asc',
      });
      expect(commaRelations.statusCode, commaRelations.payload).toBe(200);
      const commaRelationBody = commaRelations.json<{
        total: number;
        data: {
          login: string;
          partner: { name: string };
          language: { code: string } | null;
        }[];
      }>();
      expect(commaRelationBody.total).toBe(2);
      expect(commaRelationBody.data).toHaveLength(2);
      expect(commaRelationBody.data.find((user) => user.login === 'superadmin')).toMatchObject({
        partner: { name: 'Super Administrator' },
        language: { code: 'en-US' },
      });
    } finally {
      await testDb('users').where({ id: superadmin.id }).update({ language_id: null });
    }
    const privateField = await send({ method: 'GET', url: '/api/base.user?fields=password' });
    expect(privateField.statusCode).toBe(400);
  });

  it('serves seeded organization records and rejects a hierarchy cycle through the generic API', async () => {
    const list = await send({
      method: 'GET',
      url: '/api/organization.department?order=name%20asc',
    });
    expect(list.statusCode, list.payload).toBe(200);
    expect(list.json<{ data: { code: string }[] }>().data.map(({ code }) => code)).toEqual([
      'operations',
      'product',
    ]);

    const department = await OrganizationDepartment.query()
      .findOne({ code: 'product' })
      .throwIfNotFound();
    const cycle = await send({
      method: 'PATCH',
      url: `/api/organization.department/${department.id}`,
      payload: { parent_id: department.id },
    });
    expect(cycle.statusCode, cycle.payload).toBe(403);
    expect((await OrganizationDepartment.query().findById(department.id))?.parent_id).toBeNull();

    const foreignCompany = await Company.query().insertAndFetch({ name: 'Foreign Organization' });
    const foreignDepartment = await OrganizationDepartment.query().insertAndFetch({
      company_id: foreignCompany.id,
      code: 'foreign',
      name: 'Foreign Department',
    });
    const crossCompany = await send({
      method: 'POST',
      url: '/api/organization.team',
      payload: {
        company_id: department.company_id,
        department_id: foreignDepartment.id,
        code: 'cross_company',
        name: 'Cross Company Team',
      },
    });
    expect(crossCompany.statusCode, crossCompany.payload).toBe(403);
    expect(await testDb('organization_teams').count({ count: '*' }).first()).toMatchObject({
      count: 2,
    });
  });

  it('bounds generic query cost and rejects unknown fields through mass assignment', async () => {
    const malformedDomains: unknown[][] = [
      [['name', 'contains', 'value']],
      [['name', '=', { nested: 'value' }]],
      [['name', '=', ['not', 'a', 'scalar']]],
      [['bad field', '=', 'value']],
      [...Array<string>(33).fill('!'), ['active', '=', true]],
    ];
    for (const domain of malformedDomains) {
      const response = await send({
        method: 'GET',
        url: `/api/base.partner?domain=${encodeURIComponent(JSON.stringify(domain))}`,
      });
      expect(response.statusCode, response.payload).toBe(400);
    }

    const malformedRpcDomain = await send({
      method: 'POST',
      url: '/jsonrpc',
      payload: {
        jsonrpc: '2.0',
        method: 'call',
        params: {
          service: 'object',
          method: 'execute_kw',
          args: ['base.partner', 'search_read', [[['name', 'contains', 'value']]], {}],
        },
        id: 3,
      },
    });
    expect(malformedRpcDomain.statusCode).toBe(200);
    expect(malformedRpcDomain.json<{ error: { code: number } }>().error.code).toBe(-32602);

    const tooManyTerms = await send({
      method: 'GET',
      url: `/api/base.partner?domain=${encodeURIComponent(JSON.stringify(Array.from({ length: 101 }, (_, index) => ['id', '=', index])))}`,
    });
    expect(tooManyTerms.statusCode).toBe(400);

    const tooManyFields = await send({
      method: 'GET',
      url: `/api/base.partner?fields=${Array.from({ length: 101 }, (_, index) => `field_${index}`).join(',')}`,
    });
    expect(tooManyFields.statusCode).toBe(400);

    const oversizedOrder = await send({
      method: 'GET',
      url: `/api/base.partner?order=${'id asc,'.repeat(80)}`,
    });
    expect(oversizedOrder.statusCode).toBe(400);

    const oversizedRelation = await send({
      method: 'GET',
      url: `/api/base.partner?with=${'addresses,'.repeat(65)}`,
    });
    expect(oversizedRelation.statusCode).toBe(400);

    const overNestedRelation = await send({
      method: 'GET',
      url: '/api/base.user?with=partner.company.country.currency',
    });
    expect(overNestedRelation.statusCode).toBe(400);

    const oversizedRpcGraph = await send({
      method: 'POST',
      url: '/jsonrpc',
      payload: {
        jsonrpc: '2.0',
        method: 'call',
        params: {
          service: 'object',
          method: 'execute_kw',
          args: ['base.user', 'search_read', [[]], { with: 'partner.company.country.currency' }],
        },
        id: 1,
      },
    });
    expect(oversizedRpcGraph.statusCode).toBe(200);
    expect(oversizedRpcGraph.json<{ error: { code: number } }>().error.code).toBe(-32602);

    const oversizedRpcFields = await send({
      method: 'POST',
      url: '/jsonrpc',
      payload: {
        jsonrpc: '2.0',
        method: 'call',
        params: {
          service: 'object',
          method: 'execute_kw',
          args: [
            'base.partner',
            'search_read',
            [[]],
            { fields: Array.from({ length: 101 }, (_, index) => `field_${index}`) },
          ],
        },
        id: 2,
      },
    });
    expect(oversizedRpcFields.json<{ error: { code: number } }>().error.code).toBe(-32602);

    const unknownField = await send({
      method: 'POST',
      url: '/api/base.partner',
      payload: { name: 'Mass assignment probe', is_admin: true },
    });
    expect(unknownField.statusCode).toBe(400);
    expect(
      await testDb('partners').where({ name: 'Mass assignment probe' }).first()
    ).toBeUndefined();
  });

  it('rejects JSON request bodies above the configured one-megabyte limit', async () => {
    const oversizedBody = await send({
      method: 'POST',
      url: '/jsonrpc',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ payload: 'x'.repeat(1024 * 1024) }),
    });
    expect(oversizedBody.statusCode).toBe(413);
  });

  it('validates polymorphic resource references for base extensions', async () => {
    const partner = await testDb('partners').where({ name: 'Acme Studio' }).first('id');
    expect(partner).toBeDefined();
    const tag = await send({
      method: 'POST',
      url: '/api/base.tag',
      payload: { name: 'Priority', color: '#123ABC' },
    });
    expect(tag.statusCode).toBe(201);
    const tagId = tag.json<{ data: { id: number } }>().data.id;

    const invalidLink = await send({
      method: 'POST',
      url: '/api/base.tag_link',
      payload: { tag_id: tagId, resource_model: 'missing.model', resource_id: partner?.id },
    });
    expect(invalidLink.statusCode).toBe(400);

    const link = await send({
      method: 'POST',
      url: '/api/base.tag_link',
      payload: { tag_id: tagId, resource_model: 'base.partner', resource_id: partner?.id },
    });
    expect(link.statusCode).toBe(201);

    const invalidActivity = await send({
      method: 'POST',
      url: '/api/base.activity',
      payload: {
        summary: 'Call customer',
        resource_model: 'base.partner',
        resource_id: 999999,
      },
    });
    expect(invalidActivity.statusCode).toBe(400);

    const activity = await send({
      method: 'POST',
      url: '/api/base.activity',
      payload: {
        summary: 'Call customer',
        activity_type: 'call',
        resource_model: 'base.partner',
        resource_id: partner?.id,
      },
    });
    expect(activity.statusCode).toBe(201);
    const forgedAttachment = await send({
      method: 'POST',
      url: '/api/base.attachment',
      payload: {
        name: 'proposal.pdf',
        resource_model: 'base.partner',
        resource_id: partner?.id,
        mimetype: 'application/pdf',
        size_bytes: 2048,
        storage_key: 'partners/acme/proposal.pdf',
      },
    });
    expect(forgedAttachment.statusCode).toBe(400);
    const traversalFilename = await send({
      method: 'POST',
      url: `/api/base.attachment/upload?resource_model=base.partner&resource_id=${partner?.id}&name=..%2Fsecret.txt`,
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-mime': 'text/plain',
      },
      payload: Buffer.from('not stored'),
    });
    expect(traversalFilename.statusCode).toBe(400);
    const unsupportedMime = await send({
      method: 'POST',
      url: `/api/base.attachment/upload?resource_model=base.partner&resource_id=${partner?.id}&name=payload.svg`,
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-mime': 'image/svg+xml',
      },
      payload: Buffer.from('<svg/>'),
    });
    expect(unsupportedMime.statusCode).toBe(400);
    const oversized = await send({
      method: 'POST',
      url: `/api/base.attachment/upload?resource_model=base.partner&resource_id=${partner?.id}&name=large.txt`,
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-mime': 'text/plain',
      },
      payload: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    expect(oversized.statusCode).toBe(413);

    const attachment = await send({
      method: 'POST',
      url:
        '/api/base.attachment/upload?resource_model=base.partner&resource_id=' +
        partner?.id +
        '&name=proposal.pdf',
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-mime': 'application/pdf',
      },
      payload: Buffer.from('%PDF attachment content'),
    });
    expect(attachment.statusCode).toBe(201);
    expect(attachmentStorageOperations).toContain('put');
    expect(attachment.json<{ data: Record<string, unknown> }>().data).not.toHaveProperty(
      'storage_key'
    );
    const attachmentId = attachment.json<{ data: { id: number } }>().data.id;
    const downloaded = await send({
      method: 'GET',
      url: `/api/base.attachment/${attachmentId}/download`,
    });
    expect(downloaded.statusCode).toBe(200);
    expect(attachmentStorageOperations).toContain('get');
    expect(downloaded.headers['content-disposition']).toContain('proposal.pdf');
    expect(downloaded.payload).toBe('%PDF attachment content');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    const storageFiles = await readdir(attachmentStorageDirectory);
    expect(storageFiles).toHaveLength(1);
    const preexistingKey = storageFiles[0];
    if (!preexistingKey) throw new Error('Expected uploaded attachment file');
    await writeFile(
      path.join(attachmentStorageDirectory, preexistingKey),
      Buffer.from('legacy bytes')
    );
    const invalidAttachmentUpdate = await send({
      method: 'PATCH',
      url: `/api/base.attachment/${attachmentId}`,
      payload: { resource_id: null },
    });
    expect(invalidAttachmentUpdate.statusCode).toBe(400);
    const archivedAttachment = await send({
      method: 'DELETE',
      url: `/api/base.attachment/${attachmentId}`,
    });
    expect(archivedAttachment.statusCode).toBe(200);
    expect(await readdir(attachmentStorageDirectory)).toHaveLength(1);
    const restoreAttachment = await send({
      method: 'POST',
      url: `/api/base.attachment/${attachmentId}/action/action_unarchive`,
      payload: {},
    });
    expect(restoreAttachment.statusCode).toBe(200);
    const restoredDownload = await send({
      method: 'GET',
      url: `/api/base.attachment/${attachmentId}/download`,
    });
    expect(restoredDownload.payload).toBe('legacy bytes');
    const deletedAttachment = await send({
      method: 'DELETE',
      url: `/api/base.attachment/${attachmentId}?hard=true`,
    });
    expect(deletedAttachment.statusCode).toBe(200);
    expect(attachmentStorageOperations).toContain('delete');
    expect(await readdir(attachmentStorageDirectory)).toHaveLength(0);
    await testDb.raw(`
      CREATE TRIGGER reject_outbox_insert
      BEFORE INSERT ON outbox_events
      BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;
    `);
    const rolledBackAttachment = await send({
      method: 'POST',
      url:
        '/api/base.attachment/upload?resource_model=base.partner&resource_id=' +
        partner?.id +
        '&name=rollback.txt',
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-mime': 'text/plain',
      },
      payload: Buffer.from('rollback bytes'),
    });
    await testDb.raw('DROP TRIGGER reject_outbox_insert');
    expect(rolledBackAttachment.statusCode).toBe(500);
    expect(await readdir(attachmentStorageDirectory)).toHaveLength(0);

    const referencedPartnerDelete = await send({
      method: 'DELETE',
      url: `/api/base.partner/${partner?.id}?hard=true`,
    });
    expect(referencedPartnerDelete.statusCode).toBe(409);
  });

  it('should create and search records with BaseModel', async () => {
    const env = new Environment({ userId: 1 });
    const Items = env.get<typeof TestItem>('test.item');

    const item = await Items.create({
      name: 'Acme Corp',
      email: 'acme@test.local',
      is_company: true,
    });

    expect(item.id).toBeDefined();
    expect(item.name).toBe('Acme Corp');
    expect(item.create_uid).toBe(1);
    expect(item.active).toBe(true);
    expect(item.create_date).toBeDefined();

    const child = await Items.create({
      name: 'John Doe',
      email: 'john@test.local',
      is_company: false,
      parent_id: item.id,
    });

    expect(child.id).toBeDefined();
    expect(child.parent_id).toBe(item.id);
  });

  it('should search with domain notation and activeTest', async () => {
    const companies = await TestItem.search([['is_company', '=', true]]);
    expect(companies.length).toBeGreaterThanOrEqual(1);
    expect(companies[0].name).toBe('Acme Corp');

    const searchRes = await TestItem.search([['name', 'like', '%John%']]);
    expect(searchRes.length).toBe(1);
    expect(searchRes[0].name).toBe('John Doe');

    const readData = await TestItem.search_read([['id', '=', companies[0].id]], {
      fields: ['name', 'email'],
    });
    expect(readData[0]).toHaveProperty('id');
    expect(readData[0]).toHaveProperty('name', 'Acme Corp');
    expect(readData[0]).toHaveProperty('email', 'acme@test.local');

    const count = await TestItem.search_count([['is_company', '=', true]]);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('should handle write and unlink (archive vs hard-delete)', async () => {
    const temp = await TestItem.create({ name: 'Temp Item' });
    expect(temp.active).toBe(true);

    await temp.update({ city: 'Jakarta' });
    expect(temp.city).toBe('Jakarta');

    // Soft delete (archive)
    await temp.remove();
    expect(temp.active).toBe(false);

    // Filtered by active_test by default
    const activeSearch = await TestItem.search([['id', '=', temp.id]]);
    expect(activeSearch.length).toBe(0);

    // Search with activeTest = false includes inactive
    const inactiveSearch = await TestItem.search([['id', '=', temp.id]], { activeTest: false });
    expect(inactiveSearch.length).toBe(1);
    expect(inactiveSearch[0].active).toBe(false);

    // Unarchive
    await temp.action_unarchive();
    expect(temp.active).toBe(true);

    // Hard delete
    const hardDeleted = await temp.remove(true);
    expect(hardDeleted).toBe(true);
    const notFound = await TestItem.browse(temp.id);
    expect(notFound).toBeNull();
  });

  it('should execute custom model actions', async () => {
    const record = await TestItem.create({ name: 'Action Test', state: 'draft' });
    expect(record.state).toBe('draft');

    await record.action_confirm();
    expect(record.state).toBe('confirmed');

    await record.action_cancel();
    expect(record.state).toBe('cancelled');
  });

  it('should test Fastify Generic REST API endpoints', async () => {
    const resModels = await send({
      method: 'GET',
      url: '/api/models',
    });
    expect(resModels.statusCode).toBe(200);
    const bodyModels = JSON.parse(resModels.payload);
    expect(bodyModels.success).toBe(true);
    expect(bodyModels.models.some((model: { model: string }) => model.model === 'test.item')).toBe(
      true
    );

    // Create via POST
    const resCreate = await send({
      method: 'POST',
      url: '/api/test.item',
      payload: {
        name: 'REST API Item',
        email: 'rest@api.local',
        is_company: true,
      },
    });
    expect(resCreate.statusCode).toBe(201);
    const createdData = JSON.parse(resCreate.payload).data;
    const itemId = createdData.id;

    // Search via GET
    const resSearch = await send({
      method: 'GET',
      url: `/api/test.item?domain=${encodeURIComponent(JSON.stringify([['id', '=', itemId]]))}`,
    });
    expect(resSearch.statusCode, resSearch.payload).toBe(200);
    const searchBody = JSON.parse(resSearch.payload);
    expect(searchBody.data.length).toBe(1);
    expect(searchBody.data[0].name).toBe('REST API Item');

    // Update via PUT
    const resUpdate = await send({
      method: 'PUT',
      url: `/api/test.item/${itemId}`,
      payload: { city: 'Bandung' },
    });
    expect(resUpdate.statusCode).toBe(200);
    expect(JSON.parse(resUpdate.payload).data.city).toBe('Bandung');

    // Model Action
    const resAction = await send({
      method: 'POST',
      url: `/api/test.item/${itemId}/action/action_toggle_company`,
    });
    expect(resAction.statusCode).toBe(200);
    const actionResult = JSON.parse(resAction.payload);
    expect(actionResult.result.is_company).toBe(false);

    // Delete (archive)
    const resDelete = await send({
      method: 'DELETE',
      url: `/api/test.item/${itemId}`,
    });
    expect(resDelete.statusCode).toBe(200);
  });

  it('should handle JSON-RPC execute_kw call', async () => {
    const rpcRes = await send({
      method: 'POST',
      url: '/jsonrpc',
      payload: {
        jsonrpc: '2.0',
        method: 'call',
        params: {
          service: 'object',
          method: 'execute_kw',
          args: [
            'test.item',
            'search_read',
            [[['name', 'like', '%Acme%']]],
            { fields: ['id', 'name'], limit: 5 },
          ],
        },
        id: 42,
      },
    });

    expect(rpcRes.statusCode).toBe(200);
    const rpcBody = JSON.parse(rpcRes.payload);
    expect(rpcBody.id).toBe(42);
    expect(Array.isArray(rpcBody.result), rpcRes.payload).toBe(true);
    expect(rpcBody.result.length).toBeGreaterThan(0);
  });
});
