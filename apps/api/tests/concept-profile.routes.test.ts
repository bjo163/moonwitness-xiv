import Fastify from 'fastify';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as workflowManifest } from '@moonwitness/orm-workflow';
import { manifest as knowledgeManifest, storeConceptProfiles } from '@moonwitness/orm-knowledge';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conceptProfileRoutes } from '../src/routes/concept-profile.routes.js';

const profileId = 'mw:concept-profile:api-synthetic-candidate';
const profileDocument = {
  format: 'moonwitness-concept-profiles/v1',
  profiles: [
    {
      id: profileId,
      concept_id: 'mw:concept:api-synthetic-concept',
      tradition: 'Synthetic test tradition',
      interpretive_scope: 'Synthetic provisional scope.',
      epistemic_status: 'provisional',
      uncertainty: { level: 'high', note: 'Synthetic fixture; no interpretive claim.' },
      interpretations: [
        {
          claim_type: 'human_interpretation',
          text: 'Synthetic candidate only.',
          status: 'candidate',
          evidence_ids: [],
        },
      ],
    },
  ],
};

describe('concept profile read route authorization boundary', () => {
  let db: Knex;
  let app: ReturnType<typeof Fastify>;
  let userId: number;
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
    await db('company_memberships')
      .insert({ user_id: userId, company_id: companyId, is_default: true })
      .onConflict(['user_id', 'company_id'])
      .ignore();
    app = Fastify();
    app.decorateRequest('auth', null);
    app.decorate('db', db);
    app.addHook('onRequest', async (request) => {
      if (request.headers.authorization === 'Bearer test')
        request.auth = {
          userId,
          companyId: request.headers['x-test-company'] === 'foreign' ? companyId + 999 : companyId,
          role: 'superadmin',
          groupPermissions: [],
        };
    });
    await app.register(conceptProfileRoutes);
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  it('reads one INTERNAL candidate version and denies foreign or inactive tenant access', async () => {
    const [stored] = await storeConceptProfiles(db, {
      authenticatedActor: { userId, companyId, role: 'superadmin' },
      corpusRootDirectory: process.cwd(),
      document: profileDocument,
    });
    const read = await app.inject({
      method: 'GET',
      url: `/api/research/concept-profiles/${profileId}?version=1`,
      headers: { authorization: 'Bearer test' },
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers['cache-control']).toBe('private, no-store');
    expect(read.json().data).toMatchObject({
      profileId,
      conceptId: 'mw:concept:api-synthetic-concept',
      version: 1,
      digest: stored!.digest,
      visibility: 'INTERNAL',
      document: profileDocument,
    });

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/research/concept-profiles/${profileId}`,
      headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ success: false, error: 'Profile is unavailable' });

    await db('company_memberships')
      .where({ user_id: userId, company_id: companyId })
      .update({ active: false });
    const revoked = await app.inject({
      method: 'GET',
      url: `/api/research/concept-profiles/${profileId}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.json()).toEqual({ success: false, error: 'Profile is unavailable' });
  });

  it('requires authentication and rejects a malformed profile version', async () => {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: `/api/research/concept-profiles/${profileId}`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    const malformed = await app.inject({
      method: 'GET',
      url: `/api/research/concept-profiles/${profileId}?version=01`,
      headers: { authorization: 'Bearer test' },
    });
    expect(malformed.statusCode).toBe(400);
  });
});
