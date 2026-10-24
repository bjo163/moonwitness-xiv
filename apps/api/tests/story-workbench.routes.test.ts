import Fastify from 'fastify';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as workflowManifest } from '@moonwitness/orm-workflow';
import { manifest as knowledgeManifest } from '@moonwitness/orm-knowledge';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storyWorkbenchRoutes } from '../src/routes/story-workbench.routes.js';

const storyId = 'mw:story:api-editorial-sample';

describe('story workbench tenant and revision boundary', () => {
  let db: Knex;
  let app: ReturnType<typeof Fastify>;
  let userId: number;
  let editorUserId: number;
  let companyId: number;

  beforeEach(async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    await installAddons(db, [
      baseManifest,
      jobsManifest,
      notificationManifest,
      workflowManifest,
      knowledgeManifest,
    ]);
    userId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
    companyId = Number((await db('companies').first('id'))?.id);
    const editorPartnerIds = await db('partners')
      .insert({ name: 'Synthetic editorial user', company_id: companyId })
      .returning('id');
    const editorPartnerId =
      typeof editorPartnerIds[0] === 'object' ? editorPartnerIds[0].id : editorPartnerIds[0];
    const editorUserIds = await db('users')
      .insert({
        login: 'story-editor',
        password: 'test-only-hash',
        partner_id: editorPartnerId,
        role: 'user',
        active: true,
      })
      .returning('id');
    editorUserId = typeof editorUserIds[0] === 'object' ? editorUserIds[0].id : editorUserIds[0];
    await db('company_memberships').insert({
      user_id: editorUserId,
      company_id: companyId,
      is_default: true,
    });
    await db('company_memberships')
      .insert({ user_id: userId, company_id: companyId, is_default: true })
      .onConflict(['user_id', 'company_id'])
      .ignore();
    app = Fastify();
    app.decorateRequest('auth', null);
    app.decorate('db', db);
    app.addHook('onRequest', async (request) => {
      const auth = request.headers.authorization;
      if (!auth) return;
      request.auth = {
        userId: auth === 'Bearer user' ? editorUserId : userId,
        companyId: auth === 'Bearer foreign' ? companyId + 999 : companyId,
        role: auth === 'Bearer user' ? 'user' : 'superadmin',
        groupPermissions: [],
      };
    });
    await app.register(storyWorkbenchRoutes);
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  const headers = { authorization: 'Bearer test' };
  const userHeaders = { authorization: 'Bearer user' };
  const document = (version: number, text: string) => ({
    schema_version: 1,
    story_id: storyId,
    version,
    title: 'Synthetic editorial sample',
    visibility: 'INTERNAL',
    pages: [
      { page_id: 'mw:story-page:api-editorial-sample-1', page_order: 1, original_text: text },
    ],
  });

  it('appends immutable exact-text revisions and reads the requested tenant version', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/api/research/stories/${storyId}`,
      headers,
      payload: document(1, '  original\r\n  '),
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.json().data.story.pages[0].original_text).toBe('  original\r\n  ');

    const second = await app.inject({
      method: 'POST',
      url: `/api/research/stories/${storyId}`,
      headers,
      payload: document(2, 'Revised.'),
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().data.previousDigest).toBe(first.json().data.digest);

    const exact = await app.inject({
      method: 'GET',
      url: `/api/research/stories/${storyId}?version=1`,
      headers,
    });
    expect(exact.statusCode).toBe(200);
    expect(exact.json().data.story.pages[0].original_text).toBe('  original\r\n  ');
    const latest = await app.inject({
      method: 'GET',
      url: `/api/research/stories/${storyId}`,
      headers,
    });
    expect(latest.json().data.version).toBe(2);
  });

  it('allows tenant users, hides foreign records and rejects publication-shaped input', async () => {
    const unauthorized = await app.inject({
      method: 'GET',
      url: `/api/research/stories/${storyId}`,
    });
    expect(unauthorized.statusCode).toBe(401);
    const createdByUser = await app.inject({
      method: 'POST',
      url: `/api/research/stories/${storyId}`,
      headers: userHeaders,
      payload: document(1, 'Synthetic.'),
    });
    expect(createdByUser.statusCode).toBe(201);
    const userRead = await app.inject({
      method: 'GET',
      url: `/api/research/stories/${storyId}`,
      headers: userHeaders,
    });
    expect(userRead.statusCode).toBe(200);
    await db('company_memberships')
      .where({ user_id: editorUserId, company_id: companyId })
      .update({ active: false });
    const inactive = await app.inject({
      method: 'GET',
      url: `/api/research/stories/${storyId}`,
      headers: userHeaders,
    });
    expect(inactive.statusCode).toBe(404);
    await db('company_memberships')
      .where({ user_id: editorUserId, company_id: companyId })
      .update({ active: true });
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/research/stories/${storyId}`,
      headers,
      payload: { ...document(1, 'Synthetic.'), publication: 'PUBLIC' },
    });
    expect(invalid.statusCode).toBe(400);
    const valid = await app.inject({
      method: 'POST',
      url: `/api/research/stories/${storyId}`,
      headers,
      payload: document(2, 'Synthetic superadmin revision.'),
    });
    expect(valid.statusCode).toBe(201);
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/research/stories/${storyId}`,
      headers: { authorization: 'Bearer foreign' },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ success: false, error: 'Story is unavailable' });
  });
});
