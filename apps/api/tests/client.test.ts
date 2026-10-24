import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knex from 'knex';
import type { FastifyInstance } from 'fastify';
import {
  AuthenticationError,
  ConflictError,
  MemoryStorage,
  MoonWitnessClient,
  PermissionDeniedError,
} from '@moonwitness/client';
import { buildApp } from '../src/app.js';

const ADMIN_PASSWORD = 'admin-test-password';

/** Routes SDK fetches through app.inject so the SDK is exercised against the real routes. */
function injectFetch(app: FastifyInstance): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: init?.headers as Record<string, string>,
      payload: init?.body as string | undefined,
    });
    return new Response(res.statusCode === 204 ? null : res.body, {
      status: res.statusCode,
      headers: res.headers as Record<string, string>,
    });
  }) as typeof fetch;
}

describe('@moonwitness/client against the real API', () => {
  let app: FastifyInstance;
  let fetchImpl: typeof fetch;
  const newClient = (storage = new MemoryStorage()) =>
    new MoonWitnessClient({ baseUrl: 'http://api.test', fetch: fetchImpl, storage });

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
    fetchImpl = injectFetch(app);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it('logs in, lists models, and reads views and fields with permissions', async () => {
    const client = newClient();
    await client.login({ login: 'superadmin', password: ADMIN_PASSWORD });
    expect(client.currentUser).toMatchObject({ login: 'superadmin', role: 'superadmin' });

    const models = await client.getModels();
    expect(models.map((m) => m.model)).toContain('base.partner');

    const partners = client.model('base.partner');
    const views = await partners.getViews();
    expect(views.model).toBe('base.partner');
    expect(views.permissions).toEqual({ read: true, create: true, write: true, unlink: true });
    expect(views.list.columns.length).toBeGreaterThan(0);
    expect(views.form.sections.length).toBeGreaterThan(0);

    const { fields, permissions } = await partners.getFields();
    expect(permissions.write).toBe(true);
    expect(fields.find((f) => f.name === 'name')).toMatchObject({ type: 'string', required: true });
  });

  it('looks up both approved local citations and passages through the SDK', async () => {
    const client = newClient();
    await client.login({ login: 'superadmin', password: ADMIN_PASSWORD });

    const citation = await client.getSourceCitation('mw:source:tanzil-quran-text');
    expect(citation).toMatchObject({
      sourceId: 'mw:source:tanzil-quran-text',
      editionId: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
      locale: 'ar',
      publication: 'source_bytes',
      availablePassages: ['Q7:46'],
    });
    expect(citation.citation).toContain('CC BY 3.0');

    const passage = await client.getCorpusPassage(citation.editionId, 'Q7:46');
    expect(passage).toMatchObject({
      sourceId: citation.sourceId,
      editionId: citation.editionId,
      locator: 'Q7:46',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(passage.text.length).toBeGreaterThan(0);
    expect(passage.citation).toBe(citation.citation);

    const webpCitation = await client.getSourceCitation('mw:source:ebible-webp-protestant');
    expect(webpCitation).toMatchObject({
      sourceId: 'mw:source:ebible-webp-protestant',
      expressionId: 'mw:expression:webp-protestant',
      editionId: 'mw:edition:webp-protestant-2020-stable',
      locale: 'en-US',
      availablePassages: ['Genesis 1:1'],
    });
    expect(webpCitation.expressionId).not.toBe(webpCitation.editionId);
    const webpPassage = await client.getCorpusPassage(webpCitation.editionId, 'Genesis 1:1');
    expect(webpPassage).toMatchObject({
      sourceId: webpCitation.sourceId,
      expressionId: webpCitation.expressionId,
      editionId: webpCitation.editionId,
      locator: 'Genesis 1:1',
      sha256: 'ae5c2799fad97b0e65334aa39be6193d487419f0d31713caaac58a47f6b4d8b1',
    });
    expect(webpPassage.text).toBe('In the beginning, God created the heavens and the earth.');

    await expect(client.getSourceCitation('mw:source:unknown')).rejects.toMatchObject({
      status: 404,
    });
    await expect(client.getCorpusPassage(citation.editionId, 'Q7:47')).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      client.getCorpusPassage(webpCitation.editionId, 'Genesis 1:2')
    ).rejects.toMatchObject({ status: 404 });
    await expect(newClient().getCorpusPassage(citation.editionId, 'Q7:46')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('performs CRUD with pagination totals and archive semantics', async () => {
    const client = newClient();
    await client.login({ login: 'superadmin', password: ADMIN_PASSWORD });
    const partners = client.model<{ id: number; name: string; active: boolean }>('base.partner');

    const created = await partners.create({ name: 'SDK Partner' });
    expect(created.id).toBeGreaterThan(0);

    const page = await partners.searchRead({
      domain: [['name', '=', 'SDK Partner']],
      limit: 5,
      count: true,
    });
    expect(page.records).toHaveLength(1);
    expect(page.total).toBe(1);
    expect((await partners.searchRead({ limit: 1 })).total).toBeUndefined();

    const updated = await partners.write(created.id, { name: 'SDK Partner 2' });
    expect(updated.name).toBe('SDK Partner 2');
    expect((await partners.read(created.id)).name).toBe('SDK Partner 2');

    await partners.unlink(created.id);
    expect((await partners.read(created.id)).active).toBe(false);
  });

  it('keeps comma-separated relation loading compatible between SDK and generic API', async () => {
    const client = newClient();
    await client.login({ login: 'superadmin', password: ADMIN_PASSWORD });
    const users = client.model<{
      login: string;
      partner: { name: string };
      language: { code: string } | null;
    }>('base.user');

    const result = await users.searchRead({
      domain: [['login', '=', 'superadmin']],
      with: 'partner,language',
      count: true,
    });

    expect(result.total).toBe(1);
    expect(result.records[0]).toMatchObject({
      login: 'superadmin',
      partner: { name: 'Super Administrator' },
    });
    expect(result.records[0]).toHaveProperty('language');
  });

  it('registers, persists the session in storage, and maps conflicts', async () => {
    const storage = new MemoryStorage();
    const client = newClient(storage);
    await client.register({ login: 'sdkuser', password: 'sdk-user-password', name: 'SDK User' });
    expect(client.currentUser?.role).toBe('user');

    // A fresh client over the same storage is authenticated immediately (page reload).
    const reloaded = newClient(storage);
    expect(reloaded.isAuthenticated).toBe(true);
    expect((await reloaded.getMe()).login).toBe('sdkuser');

    await expect(
      newClient().register({ login: 'sdkuser', password: 'another-password' })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('maps RBAC denials to PermissionDeniedError', async () => {
    const client = newClient();
    await client.login({ login: 'sdkuser', password: 'sdk-user-password' });
    const views = await client.model('base.partner').getViews();
    expect(views.permissions.write).toBe(false);
    expect(views.fields.every((f) => f.readonly)).toBe(true);
    await expect(client.model('base.partner').create({ name: 'x' })).rejects.toBeInstanceOf(
      PermissionDeniedError
    );
  });

  it('silently refreshes an expired access token', async () => {
    const storage = new MemoryStorage();
    const client = newClient(storage);
    const tokens = await client.login({ login: 'superadmin', password: ADMIN_PASSWORD });

    // Simulate an expired access token while the refresh token is still valid.
    storage.setItem('moonwitness_auth', JSON.stringify({ ...tokens, access_token: 'expired' }));
    const stale = newClient(storage);
    expect((await stale.getModels()).length).toBeGreaterThan(0);
    expect(JSON.parse(storage.getItem('moonwitness_auth')!).access_token).not.toBe('expired');
  });

  it('survives concurrent 401s without tripping refresh-token reuse detection', async () => {
    const storage = new MemoryStorage();
    const tokens = await newClient(storage).login({
      login: 'superadmin',
      password: ADMIN_PASSWORD,
    });
    storage.setItem('moonwitness_auth', JSON.stringify({ ...tokens, access_token: 'expired' }));
    const stale = newClient(storage);
    const staleInAnotherTab = newClient(storage);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? stale : staleInAnotherTab).getModels()
      )
    );
    expect(results.every((models) => models.length > 0)).toBe(true);
    // Both tabs may rotate at once; neither rotation may revoke the shared family.
    expect((await stale.refresh()).user.login).toBe('superadmin');
    expect((await staleInAnotherTab.refresh()).user.login).toBe('superadmin');
  });

  it('ends the session when the refresh token is revoked', async () => {
    const storage = new MemoryStorage();
    let expired = 0;
    const client = new MoonWitnessClient({
      baseUrl: 'http://api.test',
      fetch: fetchImpl,
      storage,
      onSessionExpired: () => expired++,
    });
    const tokens = await client.login({ login: 'superadmin', password: ADMIN_PASSWORD });
    await newClient().request('/auth/logout', {
      method: 'POST',
      body: { refresh_token: tokens.refresh_token },
    });
    storage.setItem('moonwitness_auth', JSON.stringify({ ...tokens, access_token: 'expired' }));
    const stale = new MoonWitnessClient({
      baseUrl: 'http://api.test',
      fetch: fetchImpl,
      storage,
      onSessionExpired: () => expired++,
    });

    await expect(stale.getModels()).rejects.toBeInstanceOf(AuthenticationError);
    expect(stale.isAuthenticated).toBe(false);
    expect(expired).toBe(1);
  });
});
