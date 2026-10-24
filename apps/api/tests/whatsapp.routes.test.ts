import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { Model } from 'objection';
import knex, { type Knex } from 'knex';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeS3AttachmentStorage,
  S3AttachmentStorage,
  type AttachmentStorage,
} from '@moonwitness/orm-storage';
import { whatsappRoutes } from '../src/routes/whatsapp.routes.js';
import { whatsappManifest } from '../src/whatsapp/manifest.js';
import { createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { MAX_ATTACHMENT_BYTES } from '@moonwitness/types';
import { dispatchOneOutboxEvent, jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as organizationManifest } from '@moonwitness/orm-organization';
import {
  dispatchQueuedWhatsAppMessage,
  registerWhatsAppOutboxConsumer,
} from '../src/whatsapp/outbox-consumer.js';
import {
  MalwareScannerUnavailableError,
  type AttachmentScanner,
} from '../src/whatsapp/clamav-scanner.js';

const postgres = process.env.WHATSAPP_TEST_POSTGRES === 'true';

function pngFixture(size = 68): Buffer {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5sAAAAASUVORK5CYII=',
    'base64'
  );
  if (size <= png.length) return png.subarray(0, size);
  const result = Buffer.alloc(size);
  png.copy(result);
  return result;
}

function multipartPayload(
  fields: Record<string, string>,
  file?: { name: string; mime: string; bytes: Buffer }
): { payload: Buffer; contentType: string } {
  const boundary = `mw-test-${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`
      )
    );
    chunks.push(file.bytes, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('WhatsApp API GoWA bridge', () => {
  let db: Knex;
  let app: ReturnType<typeof Fastify>;
  let companyId: number;
  let foreignCompanyId: number;
  let schema: string;
  let deviceExists = false;
  let providerConnected = false;
  let qrExpired = false;
  let qrLoginCount = 0;
  let deviceCreateCount = 0;
  let providerChats: Array<Record<string, unknown>> = [];
  let providerChatRequests: URL[] = [];
  let providerChatActions: Array<{ path: string; body: Record<string, unknown> }> = [];
  let providerWebhookUpdates: Array<{ path: string; body: Record<string, unknown> }> = [];
  let providerMessages: Array<Record<string, unknown>> = [];
  let providerMessageRequests: URL[] = [];
  let providerReadRequests: URL[] = [];
  let providerReadBodies: Array<Record<string, unknown>> = [];
  let failReadReceipt = false;
  let failPreviewFetch = false;
  let failTextSend = false;
  let failTextBeforeAcceptance = false;
  let textSendFailureStatus = 503;
  let acceptThenTimeout = false;
  let providerTextSendCount = 0;
  let providerTextSendBodies: Array<Record<string, unknown>> = [];
  let failAttachmentPut = false;
  let scanAsInfected = false;
  let scannerUnavailable = false;
  let providerImageSendCount = 0;
  let providerImageReplyIds: string[] = [];
  let providerForwardRequests: Array<{ sourceId: string; body: Record<string, unknown> }> = [];
  let providerReactionRequests: Array<{ messageId: string; body: Record<string, unknown> }> = [];
  let providerMessageMutationRequests: Array<{
    operation: string;
    messageId: string;
    body: Record<string, unknown>;
  }> = [];
  let providerDownloadBytes = Buffer.alloc(0);
  let providerDownloadDeclaredLength: number | null = null;
  let providerDownloadFileName = 'incoming.png';
  let streamPutCount = 0;
  let streamGetCount = 0;
  let videoPosterCallCount = 0;
  let bufferGetCount = 0;
  let providerAvatarUrl = 'https://pps.whatsapp.net/avatar.png';
  let providerAvatarId = 'avatar-1';
  let avatarCdnFetchCount = 0;
  let groupMetadataFails = false;
  let providerGroupInfo: Record<string, unknown> = {
    name: 'Project Group',
    topic: 'Project updates',
    participant_count: 2,
  };
  let providerGroupParticipants: Array<Record<string, unknown>> = [
    {
      jid: '628111111111@s.whatsapp.net',
      phone_number: '628111111111@s.whatsapp.net',
      display_name: 'Rani\u202E',
      is_admin: true,
      is_super_admin: false,
    },
    { jid: '987654321@lid', display_name: 'Anonymous member' },
    { jid: 'bad\u0000jid@lid', display_name: 'Invalid' },
  ];
  let profileRequestsFail = false;
  let phoneCheckResult: boolean | null = true;
  let phoneCheckRequests: URL[] = [];
  const previousGateway = process.env.WHATSAPP_GATEWAY_URL;
  const previousWebhookUrl = process.env.WHATSAPP_WEBHOOK_URL;
  const previousWebhookSecret = process.env.WHATSAPP_WEBHOOK_SECRET;
  const stored = new Map<string, Buffer>();
  const attachmentScanner: AttachmentScanner = {
    async scan(source) {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      if (scannerUnavailable) throw new MalwareScannerUnavailableError();
      const bytes = Buffer.concat(chunks);
      return scanAsInfected || bytes.includes(Buffer.from('EICAR-TEST-FILE'))
        ? { status: 'infected', signature: 'EICAR-Test-Signature' }
        : { status: 'clean' };
    },
    async ping() {
      return !scannerUnavailable;
    },
  };
  const memoryStorage: AttachmentStorage = {
    async put(key, content) {
      stored.set(key, Buffer.from(content));
      return { key, sizeBytes: content.byteLength, checksum: 'test' };
    },
    async get(key) {
      bufferGetCount++;
      return stored.get(key) ?? null;
    },
    async putStream(key, content) {
      streamPutCount++;
      const chunks: Buffer[] = [];
      for await (const chunk of content) chunks.push(Buffer.from(chunk));
      return this.put(key, Buffer.concat(chunks));
    },
    async getStream(key) {
      streamGetCount++;
      const content = stored.get(key) ?? null;
      return content ? Readable.from([content]) : null;
    },
    async delete(key) {
      stored.delete(key);
    },
    async *list() {
      for (const [key, content] of stored)
        yield { key, sizeBytes: content.length, checksum: 'test' };
    },
  };
  let activeStorage: AttachmentStorage = memoryStorage;
  const storage: AttachmentStorage = {
    async put(key, content) {
      if (failAttachmentPut) throw new Error('attachment storage unavailable');
      return activeStorage.put(key, content);
    },
    get: (key) => activeStorage.get(key),
    putStream: async (key, content, maxBytes) => {
      if (failAttachmentPut) throw new Error('attachment storage unavailable');
      return activeStorage.putStream
        ? activeStorage.putStream(key, content, maxBytes)
        : activeStorage.put(key, Buffer.concat(await Array.fromAsync(content)));
    },
    getStream: (key) =>
      activeStorage.getStream
        ? activeStorage.getStream(key)
        : activeStorage.get(key).then((content) => (content ? Readable.from([content]) : null)),
    delete: (key) => activeStorage.delete(key),
    list: () => activeStorage.list(),
  };

  beforeAll(async () => {
    schema = `wa_test_${randomUUID().replaceAll('-', '')}`;
    db = postgres
      ? knex({
          client: 'pg',
          connection: process.env.WHATSAPP_TEST_DATABASE_URL ?? process.env.DATABASE_URL,
          searchPath: [schema],
        })
      : knex({
          client: 'better-sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true,
        });
    if (postgres) await db.raw(`CREATE SCHEMA "${schema}"`);
    Model.knex(db);
    await installAddons(db, [
      baseManifest,
      jobsManifest,
      notificationManifest,
      organizationManifest,
      whatsappManifest,
    ]);
    companyId = Number((await db('companies').first('id'))?.id);
    const [foreignCompany] = await db('companies')
      .insert({ name: `WhatsApp isolation ${randomUUID()}`, timezone: 'UTC' })
      .returning(['id']);
    foreignCompanyId = Number(foreignCompany.id);
  }, 120_000);

  beforeEach(async () => {
    process.env.WHATSAPP_GATEWAY_URL = 'http://gowa.test';
    delete process.env.WHATSAPP_WEBHOOK_URL;
    delete process.env.WHATSAPP_WEBHOOK_SECRET;
    deviceExists = false;
    providerConnected = false;
    qrExpired = false;
    qrLoginCount = 0;
    deviceCreateCount = 0;
    providerChats = [];
    providerChatRequests = [];
    providerChatActions = [];
    providerWebhookUpdates = [];
    providerMessages = [];
    providerMessageRequests = [];
    providerReadRequests = [];
    providerReadBodies = [];
    failReadReceipt = false;
    failPreviewFetch = false;
    failTextSend = false;
    failTextBeforeAcceptance = false;
    textSendFailureStatus = 503;
    acceptThenTimeout = false;
    providerTextSendCount = 0;
    providerTextSendBodies = [];
    failAttachmentPut = false;
    scanAsInfected = false;
    scannerUnavailable = false;
    providerImageSendCount = 0;
    providerImageReplyIds = [];
    providerForwardRequests = [];
    providerReactionRequests = [];
    providerMessageMutationRequests = [];
    providerDownloadBytes = pngFixture();
    providerDownloadDeclaredLength = null;
    providerDownloadFileName = 'incoming.png';
    streamPutCount = 0;
    streamGetCount = 0;
    videoPosterCallCount = 0;
    providerAvatarUrl = 'https://pps.whatsapp.net/avatar.png';
    providerAvatarId = 'avatar-1';
    avatarCdnFetchCount = 0;
    groupMetadataFails = false;
    providerGroupInfo = {
      name: 'Project Group',
      topic: 'Project updates',
      participant_count: 2,
    };
    providerGroupParticipants = [
      {
        jid: '628111111111@s.whatsapp.net',
        phone_number: '628111111111@s.whatsapp.net',
        display_name: 'Rani\u202E',
        is_admin: true,
        is_super_admin: false,
      },
      { jid: '987654321@lid', display_name: 'Anonymous member' },
      { jid: 'bad\u0000jid@lid', display_name: 'Invalid' },
    ];
    profileRequestsFail = false;
    phoneCheckResult = true;
    phoneCheckRequests = [];
    bufferGetCount = 0;
    stored.clear();
    activeStorage = memoryStorage;
    const mockFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? 'GET';
      const json = (results: unknown, status = 200) =>
        new Response(
          JSON.stringify({ status, code: status < 400 ? 'SUCCESS' : 'ERROR', results }),
          {
            status,
            headers: { 'content-type': 'application/json' },
          }
        );
      if (url.pathname === '/devices' && method === 'POST') {
        deviceCreateCount++;
        deviceExists = true;
        return json({ device_id: 'moonwitness-company-' + companyId });
      }
      if (/^\/devices\/[^/]+\/webhook$/u.test(url.pathname) && method === 'PATCH') {
        providerWebhookUpdates.push({
          path: url.pathname,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return json({});
      }
      if (/^\/devices\/[^/]+$/u.test(url.pathname) && method === 'GET')
        return deviceExists
          ? json({ device_id: 'moonwitness-company-' + companyId })
          : json({ message: 'not found' }, 404);
      if (/^\/devices\/[^/]+\/status$/u.test(url.pathname))
        return json({
          device_id: 'moonwitness-company-' + companyId,
          is_connected: providerConnected,
          is_logged_in: providerConnected,
          jid: providerConnected ? '6281234567890@s.whatsapp.net' : '',
        });
      if (/^\/devices\/[^/]+\/login$/u.test(url.pathname)) {
        qrLoginCount++;
        return json({ qr_link: 'http://localhost:3000/statics/images/qrcode/test.png' });
      }
      if (url.pathname === '/statics/images/qrcode/test.png' && qrExpired)
        return json({ message: 'QR expired' }, 404);
      if (url.pathname === '/statics/images/qrcode/test.png')
        return new Response(Buffer.from('qr-image'), { headers: { 'content-type': 'image/png' } });
      if (url.pathname === '/chats') {
        providerChatRequests.push(url);
        const archived = url.searchParams.get('archived');
        return json({
          data: providerChats.filter(
            (chat) => archived === null || String(chat.archived === true) === archived
          ),
        });
      }
      if (url.pathname === '/user/info')
        if (profileRequestsFail) return json({ error: 'provider unavailable' }, 503);
        else return json({ verified_name: 'Verified Contact', status: 'Available for work' });
      if (url.pathname === '/user/avatar') {
        if (profileRequestsFail) return json({ error: 'provider unavailable' }, 503);
        return json({ url: providerAvatarUrl, id: providerAvatarId });
      }
      if (url.pathname === '/user/check') {
        phoneCheckRequests.push(url);
        return json(phoneCheckResult === null ? {} : { is_on_whatsapp: phoneCheckResult });
      }
      if (url.pathname === '/group/info')
        return groupMetadataFails
          ? json({ message: 'provider unavailable' }, 503)
          : json(providerGroupInfo);
      if (url.pathname === '/group/participants')
        return groupMetadataFails
          ? json({ message: 'provider unavailable' }, 503)
          : json({
              group_id: url.searchParams.get('group_id'),
              participants: providerGroupParticipants,
            });
      if (/^\/chat\/.+\/(archive|pin)$/u.test(url.pathname) && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const path = url.pathname.endsWith('/archive') ? 'archive' : 'pin';
        providerChatActions.push({ path, body });
        const jid = decodeURIComponent(
          url.pathname.slice('/chat/'.length).replace(/\/(archive|pin)$/u, '')
        );
        if (path === 'archive') {
          const chat = providerChats.find((item) => item.jid === jid);
          if (chat) chat.archived = body.archived;
        }
        return json({
          [path === 'archive' ? 'archived' : 'pinned']:
            body[path === 'archive' ? 'archived' : 'pinned'],
        });
      }
      if (url.pathname.startsWith('/chat/') && url.pathname.endsWith('/messages')) {
        providerMessageRequests.push(url);
        return failPreviewFetch
          ? json({ message: 'temporary preview failure' }, 503)
          : json({ data: providerMessages });
      }
      if (/^\/message\/[^/]+\/read$/u.test(url.pathname) && method === 'POST') {
        providerReadRequests.push(url);
        providerReadBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return failReadReceipt ? json({ message: 'provider read failed' }, 503) : json({});
      }
      if (url.pathname === '/send/message') {
        providerTextSendCount++;
        providerTextSendBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (failTextBeforeAcceptance) {
          failTextBeforeAcceptance = false;
          throw new Error('simulated network failure before provider acceptance');
        }
        if (acceptThenTimeout) {
          acceptThenTimeout = false;
          const body = JSON.parse(String(init?.body)) as { phone: string; message: string };
          providerMessages.push({
            id: 'accepted-before-response-timeout',
            chat_jid: body.phone,
            content: body.message,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            media_type: 'text',
          });
          throw new Error('simulated network timeout after GoWA accepted the send');
        }
        return failTextSend
          ? json({ message: 'provider send failed' }, textSendFailureStatus)
          : json({ message_id: 'sent-text-id' });
      }
      if (url.pathname === '/send/image') {
        providerImageSendCount++;
        const form = init?.body;
        providerImageReplyIds.push(
          form instanceof FormData ? String(form.get('reply_message_id') ?? '') : ''
        );
        return json({ message_id: 'sent-image-id' });
      }
      if (/^\/message\/.+\/forward$/u.test(url.pathname) && method === 'POST') {
        providerForwardRequests.push({
          sourceId: decodeURIComponent(
            url.pathname.slice('/message/'.length).replace(/\/forward$/u, '')
          ),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return json({ message_id: `forwarded-${providerForwardRequests.length}` });
      }
      if (/^\/message\/[^/]+\/reaction$/u.test(url.pathname) && method === 'POST') {
        providerReactionRequests.push({
          messageId: decodeURIComponent(
            url.pathname.slice('/message/'.length).replace(/\/reaction$/u, '')
          ),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return json({ message_id: `reaction-${providerReactionRequests.length}` });
      }
      if (/^\/message\/[^/]+\/(update|revoke)$/u.test(url.pathname) && method === 'POST') {
        const operation = url.pathname.endsWith('/update') ? 'update' : 'revoke';
        providerMessageMutationRequests.push({
          operation,
          messageId: decodeURIComponent(
            url.pathname.slice('/message/'.length).replace(/\/(update|revoke)$/u, '')
          ),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return json({ message_id: `mutated-${providerMessageMutationRequests.length}` });
      }
      if (/^\/devices\/moonwitness-company-\d+\/logout$/u.test(url.pathname)) return json({});
      if (/^\/message\/[^/]+\/download$/u.test(url.pathname))
        return json({
          file_path: '/statics/media/incoming.png',
          filename: providerDownloadFileName,
        });
      if (url.pathname === '/statics/media/incoming.png')
        return new Response(providerDownloadBytes, {
          headers: {
            'content-type': 'image/png',
            ...(providerDownloadDeclaredLength === null
              ? {}
              : { 'content-length': String(providerDownloadDeclaredLength) }),
          },
        });
      return json({ message: `Unexpected GoWA request: ${method} ${url.pathname}` }, 500);
    });
    vi.stubGlobal('fetch', mockFetch);

    app = Fastify();
    app.decorateRequest('auth', null);
    app.decorate('db', db);
    app.addHook('onRequest', async (request) => {
      if (request.headers.authorization === 'Bearer test')
        request.auth = {
          userId: Number(request.headers['x-test-user-id'] ?? 1),
          companyId:
            request.headers['x-test-company'] === 'none'
              ? undefined
              : request.headers['x-test-company'] === 'foreign'
                ? foreignCompanyId
                : companyId,
          role: request.headers['x-test-role'] === 'user' ? 'user' : 'superadmin',
          groupPermissions: [],
        };
    });
    await app.register(rateLimit, { global: false });
    await app.register(whatsappRoutes, {
      attachmentStorage: storage,
      attachmentScanner,
      createVideoPoster: async () => {
        videoPosterCallCount++;
        return {
          bytes: await sharp({
            create: { width: 1, height: 1, channels: 3, background: '#ff0000' },
          })
            .jpeg()
            .toBuffer(),
          contentType: 'image/jpeg',
        };
      },
      fetchContactAvatar: async () => {
        avatarCdnFetchCount++;
        return new Response(pngFixture(), { headers: { 'content-type': 'image/png' } });
      },
    });
  });

  afterEach(async () => {
    await app.close();
    for (const table of [
      'outbox_events',
      'whatsapp_conversation_labels',
      'whatsapp_conversation_aliases',
      'whatsapp_conversation_reads',
      'whatsapp_internal_notes',
      'whatsapp_messages',
      'whatsapp_conversations',
      'whatsapp_accounts',
      'whatsapp_labels',
      'audit_logs',
    ])
      await db(table).delete();
    stored.clear();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (previousGateway === undefined) delete process.env.WHATSAPP_GATEWAY_URL;
    else process.env.WHATSAPP_GATEWAY_URL = previousGateway;
    if (previousWebhookUrl === undefined) delete process.env.WHATSAPP_WEBHOOK_URL;
    else process.env.WHATSAPP_WEBHOOK_URL = previousWebhookUrl;
    if (previousWebhookSecret === undefined) delete process.env.WHATSAPP_WEBHOOK_SECRET;
    else process.env.WHATSAPP_WEBHOOK_SECRET = previousWebhookSecret;
    if (postgres) await db.raw(`DROP SCHEMA "${schema}" CASCADE`);
    await db.destroy();
  });

  async function connectAndMarkReady() {
    const connected = await app.inject({
      method: 'POST',
      url: '/whatsapp/connect',
      headers: { authorization: 'Bearer test' },
      payload: { company_id: companyId + 1000, device_id: 'untrusted-device' },
    });
    expect(connected.statusCode).toBe(202);
    providerConnected = true;
    await db('whatsapp_accounts')
      .where({ id: connected.json().data.id })
      .update({ status: 'connected' });
    return connected.json().data.id as number;
  }

  async function createFailingUpdateTrigger(
    name: string,
    table: string,
    column: string,
    message: string,
    condition?: string
  ) {
    if (postgres) {
      const functionName = `${name}_function`;
      const action = condition
        ? `IF ${condition} THEN RAISE EXCEPTION '${message}'; END IF;`
        : `RAISE EXCEPTION '${message}';`;
      await db.raw(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${action} RETURN NEW; END; $$`
      );
      await db.raw(
        `CREATE TRIGGER ${name} BEFORE UPDATE OF ${column} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${functionName}()`
      );
      return;
    }
    await db.raw(
      `CREATE TRIGGER ${name} BEFORE UPDATE OF ${column} ON ${table}${condition ? ` WHEN ${condition}` : ''} BEGIN SELECT RAISE(ABORT, '${message}'); END;`
    );
  }

  async function dropFailingUpdateTrigger(name: string, table: string) {
    if (postgres) {
      await db.raw(`DROP TRIGGER ${name} ON ${table}`);
      await db.raw(`DROP FUNCTION ${name}_function()`);
      return;
    }
    await db.raw(`DROP TRIGGER ${name}`);
  }

  it('syncs group metadata and participants within the active company and serves stale cache on provider failure', async () => {
    const [account] = await db('whatsapp_accounts')
      .insert({
        company_id: companyId,
        status: 'connected',
        gateway_device_id: `moonwitness-company-${companyId}`,
      })
      .returning(['id']);
    const [group] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: account.id,
        jid: '120363000000001@g.us',
        name: 'Old group name',
        is_group: true,
        unread_count: 0,
      })
      .returning(['id']);
    const path = `/whatsapp/conversations/${group.id}/group`;
    const response = await app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: 'Bearer test' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      name: 'Project Group',
      topic: 'Project updates',
      participant_count: 2,
      stale: false,
      participants: [
        { jid: '628111111111@s.whatsapp.net', display_name: 'Rani', is_admin: true },
        { jid: '987654321@lid', display_name: 'Anonymous member' },
      ],
    });
    const [saved] = await db('whatsapp_conversations')
      .where({ company_id: companyId, id: group.id })
      .select('name', 'group_topic', 'group_participant_count', 'group_participants_json');
    expect(saved).toMatchObject({
      name: 'Project Group',
      group_topic: 'Project updates',
      group_participant_count: 2,
    });
    expect(JSON.parse(saved.group_participants_json)).toHaveLength(2);

    groupMetadataFails = true;
    const stale = await app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: 'Bearer test' },
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().data).toMatchObject({ name: 'Project Group', stale: true });

    const foreign = await app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('returns company-scoped GoWA contact profile and proxies validated avatar bytes', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111222333@s.whatsapp.net',
        name: 'Saved Contact',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const path = `/whatsapp/conversations/${conversation.id}/contact`;
    const profile = await app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: 'Bearer test' },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().data).toMatchObject({
      name: 'Saved Contact',
      phone_number: '628111222333',
      verified_name: 'Verified Contact',
      status: 'Available for work',
      picture_id: 'avatar-1',
      avatar_available: true,
    });
    const [savedProfile] = await db('whatsapp_conversations')
      .where({ id: conversation.id, company_id: companyId })
      .select(
        'contact_verified_name',
        'contact_status',
        'contact_picture_id',
        'contact_profile_synced_at'
      );
    expect(savedProfile).toMatchObject({
      contact_verified_name: 'Verified Contact',
      contact_status: 'Available for work',
      contact_picture_id: 'avatar-1',
    });
    expect(savedProfile.contact_profile_synced_at).toBeTruthy();
    const avatar = await app.inject({
      method: 'GET',
      url: `${path}/avatar`,
      headers: { authorization: 'Bearer test' },
    });
    expect(avatar.statusCode).toBe(200);
    expect(avatar.headers).toMatchObject({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300',
    });
    expect(Buffer.from(avatar.rawPayload)).toEqual(pngFixture());
    expect(avatarCdnFetchCount).toBe(1);
    const [savedAvatar] = await db('whatsapp_conversations')
      .where({ id: conversation.id, company_id: companyId })
      .select('contact_avatar_key', 'contact_avatar_picture_id');
    expect(savedAvatar).toMatchObject({
      contact_avatar_picture_id: 'avatar-1',
      contact_avatar_key: expect.any(String),
    });
    expect(stored.has(savedAvatar.contact_avatar_key)).toBe(true);
    const cachedAvatar = await app.inject({
      method: 'GET',
      url: `${path}/avatar`,
      headers: { authorization: 'Bearer test' },
    });
    expect(cachedAvatar.statusCode).toBe(200);
    expect(Buffer.from(cachedAvatar.rawPayload)).toEqual(pngFixture());
    expect(avatarCdnFetchCount).toBe(1);

    providerAvatarId = 'avatar-2';
    providerAvatarUrl = 'https://pps.whatsapp.net/avatar-2.png';
    const updatedAvatar = await app.inject({
      method: 'GET',
      url: `${path}/avatar`,
      headers: { authorization: 'Bearer test' },
    });
    expect(updatedAvatar.statusCode).toBe(200);
    expect(avatarCdnFetchCount).toBe(2);
    const [refreshedAvatar] = await db('whatsapp_conversations')
      .where({ id: conversation.id, company_id: companyId })
      .select('contact_avatar_key', 'contact_avatar_picture_id');
    expect(refreshedAvatar.contact_avatar_picture_id).toBe('avatar-2');
    expect(refreshedAvatar.contact_avatar_key).not.toBe(savedAvatar.contact_avatar_key);
    expect(stored.has(savedAvatar.contact_avatar_key)).toBe(false);

    profileRequestsFail = true;
    const staleProfile = await app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: 'Bearer test' },
    });
    expect(staleProfile.statusCode).toBe(200);
    expect(staleProfile.json().data).toMatchObject({
      verified_name: 'Verified Contact',
      status: 'Available for work',
      picture_id: 'avatar-2',
      synced_at: savedProfile.contact_profile_synced_at,
    });
    const staleAvatar = await app.inject({
      method: 'GET',
      url: `${path}/avatar`,
      headers: { authorization: 'Bearer test' },
    });
    expect(staleAvatar.statusCode).toBe(200);
    expect(Buffer.from(staleAvatar.rawPayload)).toEqual(pngFixture());
    expect(avatarCdnFetchCount).toBe(2);
    profileRequestsFail = false;

    providerAvatarUrl = 'https://pps.whatsapp.net.evil.example/avatar.png';
    providerAvatarId = 'avatar-3';
    const rejectedAvatar = await app.inject({
      method: 'GET',
      url: `${path}/avatar`,
      headers: { authorization: 'Bearer test' },
    });
    expect(rejectedAvatar.statusCode).toBe(404);
    expect(avatarCdnFetchCount).toBe(2);
    expect(await db('audit_logs').where({ operation: 'contact_avatar_access' })).toHaveLength(4);

    const foreign = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversation.id}/contact`,
      headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('validates international phone syntax and reports GoWA registration without leaking tenant data', async () => {
    await connectAndMarkReady();
    const invalid = await app.inject({
      method: 'POST',
      url: '/whatsapp/contacts/check',
      headers: { authorization: 'Bearer test' },
      payload: { phone: '+1 234 567' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(phoneCheckRequests).toHaveLength(0);
    const invalidCountryCode = await app.inject({
      method: 'POST',
      url: '/whatsapp/contacts/check',
      headers: { authorization: 'Bearer test' },
      payload: { phone: '+999123456789' },
    });
    expect(invalidCountryCode.statusCode).toBe(400);
    expect(phoneCheckRequests).toHaveLength(0);

    const checked = await app.inject({
      method: 'POST',
      url: '/whatsapp/contacts/check',
      headers: { authorization: 'Bearer test' },
      payload: { phone: '+62 (858) 9342-9926' },
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json().data).toEqual({ phone: '+6285893429926', is_on_whatsapp: true });
    expect(phoneCheckRequests[0]?.searchParams.get('phone')).toBe('6285893429926');

    phoneCheckResult = false;
    const notRegistered = await app.inject({
      method: 'POST',
      url: '/whatsapp/contacts/check',
      headers: { authorization: 'Bearer test' },
      payload: { phone: '6285893429926' },
    });
    expect(notRegistered.statusCode).toBe(200);
    expect(notRegistered.json().data.is_on_whatsapp).toBe(false);

    phoneCheckResult = null;
    const unknown = await app.inject({
      method: 'POST',
      url: '/whatsapp/contacts/check',
      headers: { authorization: 'Bearer test' },
      payload: { phone: '6285893429926' },
    });
    expect(unknown.statusCode).toBe(502);

    const foreign = await app.inject({
      method: 'POST',
      url: '/whatsapp/contacts/check',
      headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
      payload: { phone: '6285893429926' },
    });
    expect(foreign.statusCode).toBe(409);
  });

  it('requires an authenticated active company and creates a stable GoWA device with a proxied QR', async () => {
    expect((await app.inject({ method: 'GET', url: '/whatsapp/account' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/whatsapp/connect',
          headers: { authorization: 'Bearer test', 'x-test-company': 'none' },
        })
      ).statusCode
    ).toBe(403);

    const connected = await app.inject({
      method: 'POST',
      url: '/whatsapp/connect',
      headers: { authorization: 'Bearer test' },
      payload: { company_id: companyId + 1000, device_id: 'untrusted-device' },
    });
    expect(connected.statusCode).toBe(202);
    expect(connected.json().data.status).toBe('qr');
    expect(
      Number(
        await db('whatsapp_accounts')
          .count({ count: '*' })
          .first()
          .then((r) => r?.count)
      )
    ).toBe(1);

    const account = await app.inject({
      method: 'GET',
      url: '/whatsapp/account',
      headers: { authorization: 'Bearer test' },
    });
    expect(account.json().data).toMatchObject({
      status: 'qr',
      qr_code: 'data:image/png;base64,cXItaW1hZ2U=',
    });
    expect(account.json().data).not.toHaveProperty('gateway_device_id');
    expect(
      (await db('whatsapp_accounts').where({ company_id: companyId }).first()).gateway_device_id
    ).toBe(`moonwitness-company-${companyId}`);
    const foreign = await app.inject({
      method: 'GET',
      url: '/whatsapp/account',
      headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
    });
    expect(foreign.json().data).toMatchObject({ status: 'disconnected' });

    providerConnected = true;
    const connectedAlready = await app.inject({
      method: 'POST',
      url: '/whatsapp/connect',
      headers: { authorization: 'Bearer test' },
      payload: {},
    });
    expect(connectedAlready.statusCode).toBe(200);
    expect(connectedAlready.json().data.status).toBe('connected');
    expect(
      Number(
        await db('whatsapp_accounts')
          .count({ count: '*' })
          .first()
          .then((r) => r?.count)
      )
    ).toBe(1);
  });

  it('repairs a connected account with a missing GoWA device mapping and allows pairing again', async () => {
    const [account] = await db('whatsapp_accounts')
      .insert({
        company_id: companyId,
        status: 'connected',
        phone_number: '6281234567890',
        gateway_device_id: null,
      })
      .returning(['id']);
    const headers = { authorization: 'Bearer test' };
    const stale = await app.inject({ method: 'GET', url: '/whatsapp/account', headers });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().data).toMatchObject({
      id: account.id,
      status: 'disconnected',
      phone_number: null,
      qr_code: null,
      last_error: 'WhatsApp device mapping is missing. Connect again.',
    });
    await expect(db('whatsapp_accounts').where({ id: account.id }).first()).resolves.toMatchObject({
      status: 'disconnected',
      phone_number: null,
      gateway_device_id: null,
    });

    const reconnect = await app.inject({
      method: 'POST',
      url: '/whatsapp/connect',
      headers,
      payload: {},
    });
    expect(reconnect.statusCode).toBe(202);
    expect(reconnect.json().data.status).toBe('qr');
    expect(deviceCreateCount).toBe(1);
    await expect(db('whatsapp_accounts').where({ id: account.id }).first()).resolves.toMatchObject({
      status: 'qr',
      gateway_device_id: `moonwitness-company-${companyId}`,
    });
  });

  it('distinguishes a logged-out WhatsApp account from an unreachable GoWA gateway', async () => {
    const headers = { authorization: 'Bearer test' };
    const connect = await app.inject({ method: 'POST', url: '/whatsapp/connect', headers });
    expect(connect.statusCode).toBe(202);
    await app.inject({ method: 'POST', url: '/whatsapp/disconnect', headers });
    const accountAudits = await db('audit_logs').where({ model: 'whatsapp.account' }).orderBy('id');
    expect(accountAudits.map((entry) => entry.operation)).toEqual(['connect', 'disconnect']);
    expect(accountAudits.map((entry) => JSON.parse(entry.changes))).toEqual([
      { area: 'whatsapp', company_id: companyId },
      { area: 'whatsapp', company_id: companyId },
    ]);

    const loggedOut = await app.inject({ method: 'GET', url: '/whatsapp/account', headers });
    expect(loggedOut.json().data.status).toBe('disconnected');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('gateway offline');
      })
    );
    const gatewayDown = await app.inject({ method: 'GET', url: '/whatsapp/account', headers });
    expect(gatewayDown.json().data).toMatchObject({
      status: 'error',
      last_error: 'WhatsApp gateway is temporarily unavailable',
    });
  });

  it('keeps ordinary company members read-only unless the WhatsApp action grants are present', async () => {
    const [account] = await db('whatsapp_accounts')
      .insert({
        company_id: companyId,
        status: 'connected',
        gateway_device_id: `moonwitness-company-${companyId}`,
      })
      .returning(['id']);
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: account.id,
        jid: '628111111111@s.whatsapp.net',
        name: 'Read only',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const headers = { authorization: 'Bearer test', 'x-test-role': 'user' };
    const status = await app.inject({ method: 'GET', url: '/whatsapp/account', headers });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.permissions).toEqual({
      manage: false,
      manageConversations: false,
      createConversation: false,
      send: false,
      manageMessages: false,
    });
    expect(
      (await app.inject({ method: 'POST', url: '/whatsapp/connect', headers })).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/whatsapp/disconnect',
          headers,
          payload: {},
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/whatsapp/conversations',
          headers,
          payload: { phone: '6281234567890' },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/whatsapp/conversations/${conversation.id}/archive`,
          headers,
          payload: { archived: true },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/whatsapp/conversations/${conversation.id}/pin`,
          headers,
          payload: { pinned: true },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/whatsapp/conversations/${conversation.id}/messages`,
          headers,
          payload: { content: 'not allowed' },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/whatsapp/messages/999/retry',
          headers,
        })
      ).statusCode
    ).toBe(403);
  });

  it('stores private conversation notes with company scope and write authorization', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Notes conversation',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const url = `/whatsapp/conversations/${conversation.id}/notes`;
    const created = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer test' },
      payload: { content: '  Internal follow-up\nDo not send to WhatsApp.  ' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      conversation_id: conversation.id,
      user_id: 1,
      body: 'Internal follow-up\nDo not send to WhatsApp.',
    });
    const listed = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer test', 'x-test-role': 'user' },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toHaveLength(1);
    expect(listed.json().data[0].body).toBe('Internal follow-up\nDo not send to WhatsApp.');
    expect(await db('whatsapp_messages').where({ conversation_id: conversation.id })).toHaveLength(
      0
    );
    expect(
      await db('audit_logs').where({
        model: 'whatsapp.internal_note',
        record_id: created.json().data.id,
      })
    ).toHaveLength(1);

    const forbidden = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer test', 'x-test-role': 'user' },
      payload: { content: 'Should be denied' },
    });
    expect(forbidden.statusCode).toBe(403);

    const foreign = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('manages company-scoped conversation labels and filters the inbox by label', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628222222222@s.whatsapp.net',
        name: 'Label conversation',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const [otherConversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628333333333@s.whatsapp.net',
        name: 'Other conversation',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const [created, duplicate] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/whatsapp/labels',
        headers: { authorization: 'Bearer test' },
        payload: { name: '  Priority  ', color: '#11AAFF' },
      }),
      app.inject({
        method: 'POST',
        url: '/whatsapp/labels',
        headers: { authorization: 'Bearer test' },
        payload: { name: 'priority' },
      }),
    ]);
    expect([created.statusCode, duplicate.statusCode].sort()).toEqual([201, 409]);
    const successfulCreate = created.statusCode === 201 ? created : duplicate;
    const label = successfulCreate.json().data as { id: number; name: string; color: string };
    expect(label.name.toLocaleLowerCase()).toBe('priority');
    expect(label.color).toMatch(/^#[0-9a-f]{6}$/u);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/whatsapp/labels',
          headers: { authorization: 'Bearer test' },
          payload: { name: 'Bad color', color: 'red' },
        })
      ).statusCode
    ).toBe(400);

    const update = await app.inject({
      method: 'PUT',
      url: `/whatsapp/conversations/${conversation.id}/labels`,
      headers: { authorization: 'Bearer test' },
      payload: { label_ids: [label.id] },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data).toEqual([label]);
    const page = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations?label_id=${label.id}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().data.map((item: { id: number }) => item.id)).toEqual([conversation.id]);
    expect(page.json().data[0].labels).toEqual([label]);

    const foreignLabel = await db('whatsapp_labels')
      .insert({
        company_id: foreignCompanyId,
        name: 'Foreign',
        normalized_name: 'foreign',
        color: '#000000',
      })
      .returning(['id']);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/whatsapp/conversations/${conversation.id}/labels`,
          headers: { authorization: 'Bearer test' },
          payload: { label_ids: [foreignLabel[0].id] },
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/whatsapp/labels',
          headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
        })
      )
        .json()
        .data.map((item: { id: number }) => item.id)
    ).toEqual([foreignLabel[0].id]);
    const readOnlyUpdate = await app.inject({
      method: 'PUT',
      url: `/whatsapp/conversations/${otherConversation.id}/labels`,
      headers: { authorization: 'Bearer test', 'x-test-role': 'user' },
      payload: { label_ids: [label.id] },
    });
    expect(readOnlyUpdate.statusCode, JSON.stringify(readOnlyUpdate.json())).toBe(403);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/whatsapp/labels/${label.id}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      await db('whatsapp_conversation_labels').where({ company_id: companyId, label_id: label.id })
    ).toHaveLength(0);
    expect(
      await db('audit_logs').where({ model: 'whatsapp.label', record_id: label.id })
    ).toHaveLength(2);
  });

  it('assigns chats to company agents and teams and filters open, closed, and queue views', async () => {
    const accountId = await connectAndMarkReady();
    const superadmin = await db('users').where({ login: 'superadmin' }).first('id', 'login');
    const team = await db('organization_teams')
      .where({ company_id: companyId, code: 'api' })
      .first();
    expect(superadmin).toBeDefined();
    expect(team).toBeDefined();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628444444444@s.whatsapp.net',
        name: 'Assignment conversation',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const auth = {
      authorization: 'Bearer test',
      'x-test-user-id': String(superadmin.id),
    };

    const agents = await app.inject({ method: 'GET', url: '/whatsapp/agents', headers: auth });
    expect(agents.statusCode).toBe(200);
    expect(agents.json().data.members).toContainEqual(
      expect.objectContaining({
        id: Number(superadmin.id),
        login: 'superadmin',
        team_id: Number(team.id),
        team_name: 'API',
      })
    );
    expect(agents.json().data.teams).toContainEqual({ id: Number(team.id), name: 'API' });

    const assigned = await app.inject({
      method: 'PUT',
      url: `/whatsapp/conversations/${conversation.id}/assignment`,
      headers: auth,
      payload: { assigned_user_id: Number(superadmin.id), assigned_team_id: Number(team.id) },
    });
    expect(assigned.statusCode).toBe(200);
    const mine = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations?queue=mine&team_id=${team.id}&work_state=open`,
      headers: auth,
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data).toEqual([
      expect.objectContaining({
        id: conversation.id,
        assigned_user_name: 'superadmin',
        assigned_team_name: 'API',
        work_state: 'open',
      }),
    ]);

    const readOnlyState = await app.inject({
      method: 'PUT',
      url: `/whatsapp/conversations/${conversation.id}/state`,
      headers: { ...auth, 'x-test-role': 'user' },
      payload: { work_state: 'closed' },
    });
    expect(readOnlyState.statusCode).toBe(403);
    const closed = await app.inject({
      method: 'PUT',
      url: `/whatsapp/conversations/${conversation.id}/state`,
      headers: auth,
      payload: { work_state: 'closed' },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().data.work_state).toBe('closed');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/whatsapp/conversations?work_state=open',
          headers: auth,
        })
      ).json().data
    ).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/whatsapp/conversations?work_state=closed',
          headers: auth,
        })
      )
        .json()
        .data.map((item: { id: number }) => item.id)
    ).toEqual([conversation.id]);

    const teamQueueAssignment = await app.inject({
      method: 'PUT',
      url: `/whatsapp/conversations/${conversation.id}/assignment`,
      headers: auth,
      payload: { assigned_user_id: null, assigned_team_id: Number(team.id) },
    });
    expect(teamQueueAssignment.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/whatsapp/conversations?team_id=${team.id}&work_state=closed`,
          headers: auth,
        })
      ).json().data
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/whatsapp/conversations?queue=unassigned',
          headers: auth,
        })
      ).json().data
    ).toHaveLength(0);

    const cleared = await app.inject({
      method: 'PUT',
      url: `/whatsapp/conversations/${conversation.id}/assignment`,
      headers: auth,
      payload: { assigned_user_id: null, assigned_team_id: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/whatsapp/conversations?queue=unassigned',
          headers: auth,
        })
      )
        .json()
        .data.map((item: { id: number }) => item.id)
    ).toEqual([conversation.id]);
    expect(
      await db('audit_logs').where({ model: 'whatsapp.conversation', record_id: conversation.id })
    ).toHaveLength(4);
  });

  it('reuses an active pairing QR and reports an expired QR so it can be refreshed', async () => {
    const auth = { authorization: 'Bearer test' };
    const first = await app.inject({ method: 'POST', url: '/whatsapp/connect', headers: auth });
    expect(first.statusCode).toBe(202);
    expect(qrLoginCount).toBe(1);
    const repeated = await app.inject({ method: 'POST', url: '/whatsapp/connect', headers: auth });
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json().data).toMatchObject({ id: first.json().data.id, status: 'qr' });
    expect(qrLoginCount).toBe(1);
    expect(deviceCreateCount).toBe(1);

    qrExpired = true;
    const expired = await app.inject({ method: 'GET', url: '/whatsapp/account', headers: auth });
    expect(expired.json().data).toMatchObject({
      status: 'qr_expired',
      qr_code: null,
      last_error: expect.stringContaining('expired'),
    });

    qrExpired = false;
    const refreshed = await app.inject({ method: 'POST', url: '/whatsapp/connect', headers: auth });
    expect(refreshed.statusCode).toBe(202);
    expect(refreshed.json().data.status).toBe('qr');
    expect(qrLoginCount).toBe(2);
    expect(deviceCreateCount).toBe(1);
  });

  it('serializes simultaneous connect requests for one company', async () => {
    const headers = { authorization: 'Bearer test' };
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/whatsapp/connect', headers }),
      app.inject({ method: 'POST', url: '/whatsapp/connect', headers }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 202]);
    expect(deviceCreateCount).toBe(1);
    expect(qrLoginCount).toBe(1);
    expect(await db('whatsapp_accounts').where({ company_id: companyId })).toHaveLength(1);
  });

  it('limits outbound message bursts per company and user', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Rate limit test',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const responses = [];
    for (let attempt = 0; attempt < 21; attempt++) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: `/whatsapp/conversations/${conversation.id}/messages`,
          headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
          payload: { content: `Burst ${attempt}` },
        })
      );
    }
    expect(responses.slice(0, 20).every((response) => response.statusCode === 202)).toBe(true);
    expect(responses[20]?.statusCode).toBe(429);
  });

  it('ignores or rejects client supplied company, device, and JID routing fields', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Scoped conversation',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const rejected = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: {
        content: 'must use the server scoped JID',
        company_id: companyId + 1000,
        device_id: 'untrusted-device',
        phone: '6289999999999@s.whatsapp.net',
      },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it('keeps account, conversations, messages, media, and disconnect scoped to the active company', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Tenant private chat',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const [message] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: conversation.id,
        external_id: 'tenant-private-media',
        direction: 'inbound',
        message_type: 'image',
        status: 'received',
        media_key: 'tenant-private-object',
        media_mime_type: 'image/png',
      })
      .returning(['id']);
    const headers = { authorization: 'Bearer test', 'x-test-company': 'foreign' };
    expect(
      (await app.inject({ method: 'GET', url: '/whatsapp/account', headers })).json().data
    ).toMatchObject({
      status: 'disconnected',
      phone_number: null,
    });
    expect(
      (await app.inject({ method: 'GET', url: '/whatsapp/conversations', headers })).json().data
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/whatsapp/conversations/${conversation.id}/messages`,
          headers,
        })
      ).statusCode
    ).toBe(404);
    const foreignConnect = await app.inject({ method: 'POST', url: '/whatsapp/connect', headers });
    expect(foreignConnect.statusCode).toBeGreaterThanOrEqual(200);
    expect(foreignConnect.statusCode).toBeLessThan(300);
    expect((await db('whatsapp_accounts').where({ company_id: companyId }).first()).status).toBe(
      'connected'
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/whatsapp/conversations/${conversation.id}/messages`,
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: { content: 'must stay private' },
        })
      ).statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/whatsapp/media/${message.id}`, headers }))
        .statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/whatsapp/messages/${message.id}/retry`,
          headers,
        })
      ).statusCode
    ).toBe(404);
    const foreignAccount = await db('whatsapp_accounts')
      .where({ company_id: foreignCompanyId })
      .first();
    expect(foreignAccount).toBeTruthy();
    const [foreignConversation] = await db('whatsapp_conversations')
      .insert({
        company_id: foreignCompanyId,
        account_id: foreignAccount.id,
        jid: '628333333333@s.whatsapp.net',
        name: 'Foreign private chat',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const [foreignMessage] = await db('whatsapp_messages')
      .insert({
        company_id: foreignCompanyId,
        account_id: foreignAccount.id,
        conversation_id: foreignConversation.id,
        external_id: 'foreign-private-media',
        direction: 'inbound',
        message_type: 'image',
        status: 'received',
        media_key: 'foreign-private-object',
        media_mime_type: 'image/png',
      })
      .returning(['id']);
    stored.set('foreign-private-object', Buffer.from('foreign-image'));
    const mainHeaders = { authorization: 'Bearer test' };
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/whatsapp/conversations/${foreignConversation.id}/messages`,
          headers: mainHeaders,
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/whatsapp/media/${foreignMessage.id}`,
          headers: mainHeaders,
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/whatsapp/messages/${foreignMessage.id}/retry`,
          headers: mainHeaders,
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/whatsapp/conversations/${foreignConversation.id}/messages`,
          headers: { ...mainHeaders, 'idempotency-key': randomUUID() },
          payload: { content: 'cross tenant attempt' },
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/whatsapp/conversations',
          headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
        })
      )
        .json()
        .data.map((chat: { id: number }) => chat.id)
    ).toContain(foreignConversation.id);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/whatsapp/media/${foreignMessage.id}`,
          headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
        })
      ).body
    ).toBe('foreign-image');
    expect(
      (await app.inject({ method: 'POST', url: '/whatsapp/disconnect', headers, payload: {} }))
        .statusCode
    ).toBe(200);
    expect((await db('whatsapp_accounts').where({ company_id: companyId }).first()).status).toBe(
      'connected'
    );
    expect(
      (await db('whatsapp_accounts').where({ company_id: foreignCompanyId }).first()).status
    ).toBe('disconnected');
  });

  it('uses record IDs as stable tie-breakers for equal conversation and message timestamps', async () => {
    const accountId = await connectAndMarkReady();
    const sameTime = '2026-10-23T11:00:00.000Z';
    const firstConversation = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'First',
        is_group: false,
        unread_count: 0,
        last_message_at: sameTime,
      })
      .returning(['id']);
    const secondConversation = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628222222222@s.whatsapp.net',
        name: 'Second',
        is_group: false,
        unread_count: 0,
        last_message_at: sameTime,
      })
      .returning(['id']);
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    expect(
      inbox
        .json()
        .data.slice(0, 2)
        .map((item: { id: number }) => item.id)
    ).toEqual([secondConversation[0].id, firstConversation[0].id]);

    const conversationId = Number(firstConversation[0].id);
    const firstMessage = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: conversationId,
        external_id: 'same-time-first',
        direction: 'inbound',
        message_type: 'text',
        content: 'First message',
        status: 'received',
        create_date: sameTime,
      })
      .returning(['id']);
    const secondMessage = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: conversationId,
        external_id: 'same-time-second',
        direction: 'inbound',
        message_type: 'text',
        content: 'Second message',
        status: 'received',
        create_date: sameTime,
      })
      .returning(['id']);
    const messages = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test' },
    });
    expect(messages.json().data.map((item: { id: number }) => item.id)).toEqual([
      secondMessage[0].id,
      firstMessage[0].id,
    ]);
  });

  it('sends a GoWA read receipt for the newest cached inbound message', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Private',
        is_group: false,
        unread_count: 2,
      })
      .returning(['id']);
    const [inbound] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: conversation.id,
        external_id: 'provider-inbound-read-id',
        direction: 'inbound',
        message_type: 'text',
        content: 'Read this',
        status: 'received',
        create_date: '2026-10-23T11:00:00.000Z',
      })
      .returning(['id']);

    const response = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/read`,
      headers: { authorization: 'Bearer test' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ marked: true, message_id: inbound.id });
    expect(providerReadRequests[0]?.pathname).toBe('/message/provider-inbound-read-id/read');
    expect(providerReadBodies[0]).toEqual({ phone: '628111111111@s.whatsapp.net' });
    expect(
      (await db('whatsapp_conversations').where({ id: conversation.id }).first()).unread_count
    ).toBe(2);
    expect(
      await db('audit_logs')
        .where({ model: 'whatsapp.message', record_id: inbound.id, operation: 'mark_read' })
        .first()
    ).toBeTruthy();

    await db('whatsapp_conversation_reads')
      .insert({
        company_id: companyId,
        conversation_id: conversation.id,
        user_id: 1,
        last_read_message_id: inbound.id + 100,
        last_read_at: '2026-10-23T12:00:00.000Z',
      })
      .onConflict(['company_id', 'conversation_id', 'user_id'])
      .merge();
    const repeatedRead = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/read`,
      headers: { authorization: 'Bearer test' },
    });
    expect(repeatedRead.statusCode).toBe(200);
    expect(
      await db('whatsapp_conversation_reads')
        .where({ company_id: companyId, conversation_id: conversation.id, user_id: 1 })
        .first()
    ).toMatchObject({
      last_read_message_id: inbound.id + 100,
      last_read_at: '2026-10-23T12:00:00.000Z',
    });

    await db('whatsapp_conversations').where({ id: conversation.id }).update({ unread_count: 1 });
    failReadReceipt = true;
    const failed = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/read`,
      headers: { authorization: 'Bearer test' },
    });
    expect(failed.statusCode).toBe(502);
    expect(
      (await db('whatsapp_conversations').where({ id: conversation.id }).first()).unread_count
    ).toBe(1);

    const foreign = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/read`,
      headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
    });
    expect(foreign.statusCode).toBe(404);
    expect(providerReadRequests).toHaveLength(3);
  });

  it('calculates unread counts and cursors per user, and filters unread conversations', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Unread private',
        is_group: false,
      })
      .returning(['id']);
    const [otherConversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628222222222@s.whatsapp.net',
        name: 'Other unread',
        is_group: false,
      })
      .returning(['id']);
    const inboundRows = await db('whatsapp_messages')
      .insert([
        {
          company_id: companyId,
          account_id: accountId,
          conversation_id: conversation.id,
          external_id: 'unread-first',
          direction: 'inbound',
          message_type: 'text',
          content: 'First',
          status: 'received',
          create_date: '2026-10-23T10:00:00.000Z',
        },
        {
          company_id: companyId,
          account_id: accountId,
          conversation_id: conversation.id,
          external_id: 'unread-latest',
          direction: 'inbound',
          message_type: 'text',
          content: 'Latest',
          status: 'received',
          create_date: '2026-10-23T11:00:00.000Z',
        },
        {
          company_id: companyId,
          account_id: accountId,
          conversation_id: otherConversation.id,
          external_id: 'other-unread',
          direction: 'inbound',
          message_type: 'text',
          content: 'Other',
          status: 'received',
          create_date: '2026-10-23T12:00:00.000Z',
        },
      ])
      .returning(['id']);

    const beforeRead = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    expect(beforeRead.statusCode).toBe(200);
    expect(
      beforeRead
        .json()
        .data.map((item: { id: number; unread_count: number }) => [item.id, item.unread_count])
    ).toEqual(
      expect.arrayContaining([
        [conversation.id, 2],
        [otherConversation.id, 1],
      ])
    );

    const markRead = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/read`,
      headers: { authorization: 'Bearer test' },
    });
    expect(markRead.statusCode).toBe(200);
    expect(markRead.json().data.message_id).toBe(inboundRows[1].id);

    const unreadForCurrentUser = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?unread=true',
      headers: { authorization: 'Bearer test' },
    });
    expect(unreadForCurrentUser.json().data).toHaveLength(1);
    expect(unreadForCurrentUser.json().data[0]).toMatchObject({
      id: otherConversation.id,
      unread_count: 1,
    });

    const unreadForAnotherUser = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?unread=true',
      headers: { authorization: 'Bearer test', 'x-test-user-id': '2' },
    });
    expect(unreadForAnotherUser.json().data).toHaveLength(2);
    expect(
      unreadForAnotherUser.json().data.find((item: { id: number }) => item.id === conversation.id)
        .unread_count
    ).toBe(2);

    const invalidUnread = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?unread=maybe',
      headers: { authorization: 'Bearer test' },
    });
    expect(invalidUnread.statusCode).toBe(400);
  });

  it('syncs recent inbound messages from updated chats before calculating unread counts', async () => {
    await connectAndMarkReady();
    const jid = '628333333333@s.whatsapp.net';
    providerChats = [
      {
        jid,
        name: 'New inbound chat',
        last_message_time: '2026-10-24T14:00:00.000Z',
      },
    ];
    providerMessages = [
      {
        id: 'provider-unread-message',
        is_from_me: false,
        media_type: 'text',
        content: 'New message from provider',
        timestamp: '2026-10-24T14:00:00.000Z',
      },
      {
        id: 'provider-unread-message',
        is_from_me: false,
        media_type: 'text',
        content: 'New message from provider',
        timestamp: '2026-10-24T14:00:00.000Z',
      },
    ];

    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?unread=true',
      headers: { authorization: 'Bearer test' },
    });

    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().data).toHaveLength(1);
    expect(inbox.json().data[0]).toMatchObject({ name: 'New inbound chat', unread_count: 1 });
    expect(providerMessageRequests[0]?.searchParams.get('limit')).toBe('100');
    await expect(
      db('whatsapp_messages')
        .where({ company_id: companyId, external_id: 'provider-unread-message' })
        .first()
    ).resolves.toMatchObject({ direction: 'inbound', content: 'New message from provider' });
  });

  it('retries unread synchronization after a provider preview failure', async () => {
    await connectAndMarkReady();
    const jid = '628444444444@s.whatsapp.net';
    const timestamp = '2026-10-24T15:00:00.000Z';
    providerChats = [{ jid, name: 'Retry preview', last_message_time: timestamp }];
    providerMessages = [
      {
        id: 'retry-preview-message',
        is_from_me: false,
        media_type: 'text',
        content: 'Retry should sync me',
        timestamp,
      },
    ];
    failPreviewFetch = true;

    const failed = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    expect(failed.statusCode).toBe(200);
    expect(providerMessageRequests).toHaveLength(1);
    const [failedConversation] = await db('whatsapp_conversations').where({
      company_id: companyId,
      jid,
    });
    expect(failedConversation.last_message_sync_at).toBeNull();

    failPreviewFetch = false;
    const retried = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    expect(retried.statusCode).toBe(200);
    expect(providerMessageRequests).toHaveLength(2);
    expect(retried.json().data[0]).toMatchObject({
      unread_count: 1,
      last_message: 'Retry should sync me',
    });
    expect(
      await db('whatsapp_conversations').where({ company_id: companyId, jid }).first()
    ).toMatchObject({ last_message_sync_at: timestamp });
  });

  it('archives and unarchives company-scoped conversations, and pins them in provider order', async () => {
    await connectAndMarkReady();
    const jid = '628111111111@s.whatsapp.net';
    providerChats = [
      { jid, name: 'Operations chat', last_message_time: '2026-10-24T10:00:00Z' },
      {
        jid: '628222222222@s.whatsapp.net',
        name: 'Other chat',
        last_message_time: '2026-10-24T10:00:00Z',
      },
    ];
    const activeInbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = activeInbox.json().data.find((chat: { jid: string }) => chat.jid === jid)
      .id as number;

    const foreignArchive = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/archive`,
      headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
      payload: { archived: true },
    });
    expect(foreignArchive.statusCode).toBe(404);
    const invalidArchive = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/archive`,
      headers: { authorization: 'Bearer test' },
      payload: { archived: 'true' },
    });
    expect(invalidArchive.statusCode).toBe(400);

    const pinned = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/pin`,
      headers: { authorization: 'Bearer test' },
      payload: { pinned: true },
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().data.is_pinned).toBe(true);
    expect(providerChatActions.at(-1)).toEqual({ path: 'pin', body: { pinned: true } });
    const afterPin = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?archived=false',
      headers: { authorization: 'Bearer test' },
    });
    expect(afterPin.json().data[0].jid).toBe(jid);

    const archived = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/archive`,
      headers: { authorization: 'Bearer test' },
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.is_archived).toBe(true);
    expect(providerChatActions.at(-1)).toEqual({ path: 'archive', body: { archived: true } });
    const activeAfterArchive = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?archived=false',
      headers: { authorization: 'Bearer test' },
    });
    expect(activeAfterArchive.json().data.map((chat: { jid: string }) => chat.jid)).toEqual([
      '628222222222@s.whatsapp.net',
    ]);
    const archivedInbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?archived=true',
      headers: { authorization: 'Bearer test' },
    });
    expect(archivedInbox.json().data[0]).toMatchObject({ id: conversationId, is_archived: true });
    expect(providerChatRequests.at(-1)?.searchParams.get('archived')).toBe('true');

    const unarchived = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/archive`,
      headers: { authorization: 'Bearer test' },
      payload: { archived: false },
    });
    expect(unarchived.json().data).toMatchObject({ is_archived: false, is_pinned: true });
    const restoredActive = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?archived=false',
      headers: { authorization: 'Bearer test' },
    });
    expect(restoredActive.json().data[0].jid).toBe(jid);
    const audits = await db('audit_logs')
      .where({ model: 'whatsapp.conversation', record_id: conversationId })
      .orderBy('id');
    expect(audits.map((entry) => entry.operation)).toEqual(['pin', 'archive', 'unarchive']);
  });

  it('syncs private and group inboxes and maps GoWA messages without exposing provider session data', async () => {
    await connectAndMarkReady();
    providerChats = [
      {
        jid: '628111111111@s.whatsapp.net',
        name: 'Private',
        last_message_time: '2026-10-23T10:00:00Z',
      },
      { jid: '123456@g.us', name: 'Team', last_message_time: '2026-10-23T11:00:00Z' },
    ];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    expect(inbox.statusCode).toBe(200);
    expect(
      inbox.json().data.map((chat: { jid: string; is_group: boolean }) => [chat.jid, chat.is_group])
    ).toEqual([
      ['123456@g.us', true],
      ['628111111111@s.whatsapp.net', false],
    ]);
    const chatPageOne = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?limit=1&offset=0',
      headers: { authorization: 'Bearer test' },
    });
    const chatPageTwo = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?limit=1&offset=1',
      headers: { authorization: 'Bearer test' },
    });
    expect(chatPageOne.json().data.map((chat: { jid: string }) => chat.jid)).toEqual([
      '123456@g.us',
    ]);
    expect(chatPageTwo.json().data.map((chat: { jid: string }) => chat.jid)).toEqual([
      '628111111111@s.whatsapp.net',
    ]);
    expect(providerChatRequests[1]?.searchParams.get('limit')).toBe('100');
    expect(providerChatRequests[2]?.searchParams.get('limit')).toBe('1');
    expect(providerChatRequests[2]?.searchParams.get('offset')).toBe('1');

    providerMessages = [
      {
        id: 'incoming-image',
        chat_jid: '123456@g.us',
        sender: '628222222222@s.whatsapp.net',
        content: 'See this',
        timestamp: '2026-10-23T11:05:00Z',
        is_from_me: false,
        media_type: 'image',
        filename: 'incoming.png',
      },
      {
        id: 'outgoing-text',
        chat_jid: '123456@g.us',
        sender: '6281234567890@s.whatsapp.net',
        content: 'Noted',
        timestamp: '2026-10-23T11:06:00Z',
        is_from_me: true,
        media_type: 'text',
      },
    ];
    const conversationId = inbox
      .json()
      .data.find((chat: { is_group: boolean }) => chat.is_group).id;
    const messages = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test' },
    });
    expect(messages.json().data.map((item: { content: string }) => item.content)).toEqual([
      'Noted',
      'See this',
    ]);
    const incomingImage = messages
      .json()
      .data.find((item: { content: string }) => item.content === 'See this');
    expect(incomingImage).toMatchObject({ is_unread: true, is_last_read: false });
    await db('whatsapp_conversation_reads').insert({
      company_id: companyId,
      conversation_id: conversationId,
      user_id: 1,
      last_read_message_id: incomingImage.id,
      last_read_at: incomingImage.create_date,
    });
    const messagesWithReadCursor = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test' },
    });
    expect(
      messagesWithReadCursor
        .json()
        .data.find((item: { id: number }) => item.id === incomingImage.id)
    ).toMatchObject({ is_unread: false, is_last_read: true });
    expect(
      messagesWithReadCursor
        .json()
        .data.find((item: { content: string }) => item.content === 'Noted')
    ).toMatchObject({ is_unread: false, is_last_read: false });
    providerMessages.push(
      {
        id: 'late-arriving-old-message',
        chat_jid: '123456@g.us',
        content: 'Old message',
        timestamp: '2020-01-01T00:00:00Z',
        is_from_me: false,
      },
      {
        id: 'invalid-timestamp-message',
        chat_jid: '123456@g.us',
        content: 'Bad timestamp',
        timestamp: 'not-a-date',
        is_from_me: false,
      }
    );
    const refreshedMessages = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test' },
    });
    expect(
      refreshedMessages.json().data.map((item: { content: string }) => item.content)
    ).toContain('Old message');
    expect(
      refreshedMessages.json().data.map((item: { content: string }) => item.content)
    ).not.toContain('Bad timestamp');
    const refreshedConversation = await db('whatsapp_conversations')
      .where({ id: conversationId, company_id: companyId })
      .first();
    expect(refreshedConversation.last_message).toBe('Noted');
    expect(refreshedConversation.last_message_at).toBe('2026-10-23T11:06:00.000Z');
    const contentSearch = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?search=noted&limit=50&offset=0',
      headers: { authorization: 'Bearer test' },
    });
    expect(contentSearch.statusCode).toBe(200);
    expect(contentSearch.json().data.map((chat: { jid: string }) => chat.jid)).toEqual([
      '123456@g.us',
    ]);
    expect(providerChatRequests[4]?.searchParams.get('search')).toBe('noted');
    const phoneSearch = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?search=628111111111&limit=50&offset=0',
      headers: { authorization: 'Bearer test' },
    });
    expect(phoneSearch.json().data.map((chat: { jid: string }) => chat.jid)).toEqual([
      '628111111111@s.whatsapp.net',
    ]);
    const foreignSearch = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?search=noted',
      headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
    });
    expect(foreignSearch.json().data).toEqual([]);
    providerChats[1]!.last_message_time = 'not-a-date';
    await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const invalidChatTimestamp = await db('whatsapp_conversations')
      .where({ id: conversationId, company_id: companyId })
      .first();
    expect(invalidChatTimestamp.last_message_at).toBe('2026-10-23T11:06:00.000Z');
    const firstHistoryRequest = providerMessageRequests.find(
      (url) => url.searchParams.get('limit') === '100' && url.searchParams.get('offset') === '0'
    );
    expect(firstHistoryRequest).toBeTruthy();
    const olderPage = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages?limit=1&offset=1`,
      headers: { authorization: 'Bearer test' },
    });
    expect(olderPage.json().data).toHaveLength(1);
    expect(olderPage.json().data[0].content).toBe('See this');
    const olderHistoryRequest = providerMessageRequests.find(
      (url) => url.searchParams.get('limit') === '1' && url.searchParams.get('offset') === '1'
    );
    expect(olderHistoryRequest).toBeTruthy();
    await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages?limit=50&offset=0`,
      headers: { authorization: 'Bearer test' },
    });
    const incrementalHistoryRequest = providerMessageRequests.find((url) =>
      url.searchParams.has('start_time')
    );
    expect(incrementalHistoryRequest?.searchParams.get('start_time')).toBe(
      '2026-10-23T10:56:00.000Z'
    );
    expect(messages.json().data[1]).toMatchObject({
      direction: 'inbound',
      message_type: 'image',
      sender_jid: '628222222222@s.whatsapp.net',
      media_file_name: 'incoming.png',
    });
    const imageId = messages.json().data[1].id;
    const image = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${imageId}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toContain('image/png');
    expect(image.headers['content-disposition']).toMatch(/^inline;/u);
    expect(image.headers['content-security-policy']).toContain("default-src 'none'; sandbox");
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.body).toBe(pngFixture().toString());
    const mediaAudit = await db('audit_logs')
      .where({
        model: 'whatsapp.message',
        record_id: imageId,
        operation: 'media_access',
      })
      .first();
    expect(JSON.parse(mediaAudit.changes)).toEqual({ area: 'whatsapp', company_id: companyId });
    expect(mediaAudit.changes).not.toContain('628');

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/whatsapp/conversations/${conversationId}/messages`,
          headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/whatsapp/conversations',
          headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
        })
      ).json().data
    ).toEqual([]);
  });

  it('fills an unopened conversation preview from GoWA once and reuses the cache', async () => {
    await connectAndMarkReady();
    const jid = '628111111111@s.whatsapp.net';
    const timestamp = '2026-10-24T10:00:00.000Z';
    providerChats = [{ jid, name: 'Never opened', last_message_time: timestamp }];
    providerMessages = [
      {
        id: 'unopened-latest-message',
        chat_jid: jid,
        content: 'Preview from latest message',
        timestamp,
        is_from_me: false,
        media_type: 'text',
      },
    ];

    const first = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    expect(first.json().data[0]).toMatchObject({
      jid,
      last_message: 'Preview from latest message',
      last_message_at: timestamp,
    });
    expect(
      providerMessageRequests.filter((url) => url.searchParams.get('limit') === '100')
    ).toHaveLength(1);

    const second = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    expect(second.json().data[0].last_message).toBe('Preview from latest message');
    expect(
      providerMessageRequests.filter((url) => url.searchParams.get('limit') === '100')
    ).toHaveLength(1);
  });

  it('sends text to a group and media to a private chat through GoWA, and reports upstream failures', async () => {
    await connectAndMarkReady();
    providerChats = [
      {
        jid: '628111111111@s.whatsapp.net',
        name: 'Private',
        last_message_time: '2026-10-23T10:00:00Z',
      },
      { jid: '123456@g.us', name: 'Team', last_message_time: '2026-10-23T11:00:00Z' },
    ];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const groupId = inbox.json().data.find((chat: { is_group: boolean }) => chat.is_group)
      .id as number;
    const privateId = inbox.json().data.find((chat: { is_group: boolean }) => !chat.is_group)
      .id as number;

    const sentText = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${groupId}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { content: 'Group message' },
    });
    expect(sentText.statusCode).toBe(202);
    expect(sentText.json().data).toMatchObject({
      external_id: expect.stringContaining('pending:'),
      direction: 'outbound',
      content: 'Group message',
      status: 'queued',
    });
    expect(failTextSend).toBe(false);
    const textMessageId = sentText.json().data.id as number;
    const textEvent = await db('outbox_events')
      .where({ aggregate_id: textMessageId, event_type: 'whatsapp.message.send' })
      .first();
    const unregister = registerWhatsAppOutboxConsumer(storage);
    await dispatchOneOutboxEvent('whatsapp-route-test-worker');
    unregister();
    expect((await db('whatsapp_messages').where({ id: textMessageId }).first()).status).toBe(
      'sent'
    );
    expect((await db('outbox_events').where({ id: textEvent.id }).first()).status).toBe(
      'published'
    );

    const [imageQuoteTarget] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: await db('whatsapp_accounts')
          .where({ company_id: companyId })
          .first()
          .then((row) => row.id),
        conversation_id: privateId,
        external_id: 'private-image-quote-target',
        direction: 'inbound',
        message_type: 'text',
        content: 'Image context',
        status: 'received',
      })
      .returning(['id']);
    const imageUpload = multipartPayload(
      { content: 'Photo', reply_to_message_id: String(imageQuoteTarget.id) },
      { name: 'test.png', mime: 'image/png', bytes: pngFixture() }
    );
    const imageIdempotencyKey = randomUUID();
    const sentImage = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${privateId}/messages`,
      headers: {
        authorization: 'Bearer test',
        'idempotency-key': imageIdempotencyKey,
        'content-type': imageUpload.contentType,
      },
      payload: imageUpload.payload,
    });
    expect(sentImage.statusCode).toBe(202);
    expect(sentImage.json().data).toMatchObject({
      message_type: 'image',
      media_file_name: 'test.png',
      status: 'queued',
    });
    const imageMessageId = sentImage.json().data.id as number;
    const imageRetryUpload = multipartPayload(
      { content: 'Photo', reply_to_message_id: String(imageQuoteTarget.id) },
      { name: 'test.png', mime: 'image/png', bytes: pngFixture() }
    );
    const retriedImage = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${privateId}/messages`,
      headers: {
        authorization: 'Bearer test',
        'idempotency-key': imageIdempotencyKey,
        'content-type': imageRetryUpload.contentType,
      },
      payload: imageRetryUpload.payload,
    });
    expect(retriedImage.statusCode).toBe(202);
    expect(retriedImage.json().data.id).toBe(imageMessageId);
    expect(
      await db('whatsapp_messages').where({
        company_id: companyId,
        idempotency_key: imageIdempotencyKey,
      })
    ).toHaveLength(1);
    const imageEvent = await db('outbox_events')
      .where({ aggregate_id: imageMessageId, event_type: 'whatsapp.message.send' })
      .first();
    await dispatchQueuedWhatsAppMessage(imageMessageId, companyId, imageEvent.id, storage);
    expect(providerImageReplyIds.at(-1)).toBe('private-image-quote-target');
    expect((await db('whatsapp_messages').where({ id: imageMessageId }).first()).status).toBe(
      'sent'
    );
    const media = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${sentImage.json().data.id}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(media.body).toBe(pngFixture().toString());

    failTextSend = true;
    const failed = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${groupId}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { content: 'Please fail' },
    });
    expect(failed.statusCode).toBe(202);
    const failedMessageId = failed.json().data.id as number;
    const failedEvent = await db('outbox_events')
      .where({ aggregate_id: failedMessageId, event_type: 'whatsapp.message.send' })
      .first();
    await dispatchQueuedWhatsAppMessage(failedMessageId, companyId, failedEvent.id, storage);
    expect((await db('whatsapp_messages').where({ id: failedMessageId }).first()).status).toBe(
      'unknown'
    );
    const foreign = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${groupId}/messages`,
      headers: {
        authorization: 'Bearer test',
        'x-test-company': 'foreign',
        'idempotency-key': randomUUID(),
      },
      payload: { content: 'Tenant isolation' },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('blocks infected outbound media and fails closed if the malware scanner is unavailable', async () => {
    await connectAndMarkReady();
    providerChats = [
      {
        jid: '628111111111@s.whatsapp.net',
        name: 'Malware test contact',
        last_message_time: '2026-10-24T10:00:00Z',
      },
    ];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox.json().data[0].id as number;
    const infectedPayload = multipartPayload(
      { content: 'Please inspect this file' },
      {
        name: 'sample.bin',
        mime: 'application/octet-stream',
        bytes: Buffer.from('EICAR-TEST-FILE'),
      }
    );
    scanAsInfected = true;
    const infected = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: {
        authorization: 'Bearer test',
        'idempotency-key': randomUUID(),
        'content-type': infectedPayload.contentType,
      },
      payload: infectedPayload.payload,
    });
    expect(infected.statusCode).toBe(422);
    expect(infected.json().error).toContain('malware scan');
    expect(stored.size).toBe(0);
    expect(await db('outbox_events').where({ event_type: 'whatsapp.message.send' })).toHaveLength(
      0
    );

    scanAsInfected = false;
    scannerUnavailable = true;
    const unavailablePayload = multipartPayload(
      { content: 'Retry safely' },
      { name: 'sample.bin', mime: 'application/octet-stream', bytes: Buffer.from('clean test') }
    );
    const unavailable = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: {
        authorization: 'Bearer test',
        'idempotency-key': randomUUID(),
        'content-type': unavailablePayload.contentType,
      },
      payload: unavailablePayload.payload,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error).toContain('malware scanning');
    expect(stored.size).toBe(0);
    expect(await db('outbox_events').where({ event_type: 'whatsapp.message.send' })).toHaveLength(
      0
    );
  });

  it('quarantines infected inbound media before linking it to a downloadable message', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Malware test contact',
        is_group: false,
      })
      .returning(['id']);
    const [message] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: conversation.id,
        external_id: 'incoming-image',
        direction: 'inbound',
        message_type: 'image',
        content: '',
        status: 'received',
        media_scan_status: 'pending',
      })
      .returning(['id']);
    providerDownloadBytes = Buffer.from('EICAR-TEST-FILE');

    const infected = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${message.id}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(infected.statusCode).toBe(410);
    expect(stored.size).toBe(0);
    const blockedRow = await db('whatsapp_messages').where({ id: message.id }).first();
    expect(blockedRow).toMatchObject({ media_scan_status: 'infected', media_key: null });

    const repeat = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${message.id}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(repeat.statusCode).toBe(410);
    expect(stored.size).toBe(0);
  });

  it('creates and caches company-scoped image thumbnails and video posters', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Preview test contact',
        is_group: false,
      })
      .returning(['id']);
    const [image] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: conversation.id,
        external_id: 'incoming-image-preview',
        direction: 'inbound',
        message_type: 'image',
        content: '',
        status: 'received',
        media_scan_status: 'pending',
      })
      .returning(['id']);
    providerDownloadBytes = await sharp({
      create: { width: 1, height: 1, channels: 4, background: '#ff0000' },
    })
      .png()
      .toBuffer();

    const imageThumbnail = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${image.id}/thumbnail`,
      headers: { authorization: 'Bearer test' },
    });
    expect(imageThumbnail.statusCode).toBe(200);
    expect(imageThumbnail.headers['content-type']).toContain('image/webp');
    expect(imageThumbnail.headers['x-original-content-type']).toBe('image/png');
    expect(imageThumbnail.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    const imageRow = await db('whatsapp_messages').where({ id: image.id }).first();
    expect(imageRow).toMatchObject({ media_scan_status: 'clean' });
    expect(imageRow.media_thumbnail_key).toMatch(/^[0-9a-f-]{36}$/u);
    expect(stored.size).toBe(2);
    const imageStreamReads = streamGetCount;

    const cachedImageThumbnail = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${image.id}/thumbnail`,
      headers: { authorization: 'Bearer test' },
    });
    expect(cachedImageThumbnail.statusCode).toBe(200);
    expect(cachedImageThumbnail.rawPayload).toEqual(imageThumbnail.rawPayload);
    expect(streamGetCount).toBe(imageStreamReads);

    const foreign = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${image.id}/thumbnail`,
      headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
    });
    expect(foreign.statusCode).toBe(404);

    const [video] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: conversation.id,
        external_id: 'incoming-video-preview',
        direction: 'inbound',
        message_type: 'video',
        content: '',
        status: 'received',
        media_scan_status: 'pending',
      })
      .returning(['id']);
    providerDownloadBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]);
    const videoPoster = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${video.id}/thumbnail`,
      headers: { authorization: 'Bearer test' },
    });
    expect(videoPoster.statusCode).toBe(200);
    expect(videoPoster.headers['content-type']).toContain('image/jpeg');
    expect(videoPoster.headers['x-original-content-type']).toBe('video/webm');
    expect(videoPosterCallCount).toBe(1);
  });

  it('queues a company-scoped forward and uses GoWA source IDs instead of re-uploading media', async () => {
    const accountId = await connectAndMarkReady();
    providerChats = [
      { jid: '123456@g.us', name: 'Forward source', is_group: true },
      { jid: '628111111111@s.whatsapp.net', name: 'Forward destination' },
    ];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const sourceConversationId = inbox
      .json()
      .data.find((chat: { is_group: boolean }) => chat.is_group).id as number;
    const destination = inbox.json().data.find((chat: { is_group: boolean }) => !chat.is_group);
    const [source] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: sourceConversationId,
        external_id: 'source-provider-image-id',
        direction: 'inbound',
        message_type: 'image',
        content: 'Image from group',
        status: 'received',
        media_mime_type: 'image/png',
        media_file_name: 'source.png',
      })
      .returning(['id']);

    const headers = { authorization: 'Bearer test', 'idempotency-key': randomUUID() };
    const forwarded = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${source.id}/forward`,
      headers,
      payload: { conversation_id: destination.id },
    });
    expect(forwarded.statusCode).toBe(202);
    expect(forwarded.json().data).toMatchObject({
      direction: 'outbound',
      message_type: 'image',
      media_file_name: 'source.png',
      is_forwarded: true,
      status: 'queued',
    });
    const forwardedId = forwarded.json().data.id as number;
    const duplicate = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${source.id}/forward`,
      headers,
      payload: { conversation_id: destination.id },
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json().data.id).toBe(forwardedId);
    const event = await db('outbox_events')
      .where({ aggregate_id: forwardedId, event_type: 'whatsapp.message.send' })
      .first();
    await dispatchQueuedWhatsAppMessage(forwardedId, companyId, event.id, storage);
    expect(providerForwardRequests).toEqual([
      {
        sourceId: 'source-provider-image-id',
        body: { phone: '628111111111@s.whatsapp.net' },
      },
    ]);
    expect((await db('whatsapp_messages').where({ id: forwardedId }).first()).status).toBe('sent');

    const [foreignAccount] = await db('whatsapp_accounts')
      .insert({
        company_id: foreignCompanyId,
        status: 'connected',
        gateway_device_id: 'foreign-device',
      })
      .returning(['id']);
    const [foreignConversation] = await db('whatsapp_conversations')
      .insert({
        company_id: foreignCompanyId,
        account_id: foreignAccount.id,
        jid: '628999999999@s.whatsapp.net',
        name: 'Foreign destination',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const [foreignSource] = await db('whatsapp_messages')
      .insert({
        company_id: foreignCompanyId,
        account_id: foreignAccount.id,
        conversation_id: foreignConversation.id,
        external_id: 'foreign-source-id',
        direction: 'inbound',
        message_type: 'text',
        content: 'Foreign message',
        status: 'received',
      })
      .returning(['id']);
    const foreignForward = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${foreignSource.id}/forward`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { conversation_id: destination.id },
    });
    expect(foreignForward.statusCode).toBe(404);
    expect(providerForwardRequests).toHaveLength(1);
  });

  it('imports message reactions and applies a company-scoped reaction through GoWA', async () => {
    const accountId = await connectAndMarkReady();
    const jid = '628111111111@s.whatsapp.net';
    const groupJid = '123456@g.us';
    providerChats = [
      { jid, name: 'Reaction chat', last_message_time: '2026-10-24T10:00:00Z' },
      { jid: groupJid, name: 'Reaction group', last_message_time: '2026-10-24T09:00:00Z' },
    ];
    providerMessages = [
      {
        id: 'provider-message-to-react',
        chat_jid: jid,
        content: 'A message with a reaction',
        timestamp: '2026-10-24T10:00:00Z',
        is_from_me: false,
        media_type: 'text',
        reactions: [
          {
            emoji: '👀',
            sender_jid: '628222222222@s.whatsapp.net',
            sender_display_name: 'Other participant',
            is_from_me: false,
            timestamp: '2026-10-24T10:01:00Z',
          },
        ],
      },
    ];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox
      .json()
      .data.find((conversation: { jid: string }) => conversation.jid === jid).id as number;
    const history = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test' },
    });
    expect(history.statusCode).toBe(200);
    const source = history.json().data[0];
    expect(source, JSON.stringify(history.json())).toBeDefined();
    expect(source.reactions).toEqual([expect.objectContaining({ emoji: '👀', is_from_me: false })]);

    const reaction = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${source.id}/reaction`,
      headers: { authorization: 'Bearer test' },
      payload: { emoji: '👍' },
    });
    expect(reaction.statusCode).toBe(200);
    expect(reaction.json().data.reactions).toEqual([
      expect.objectContaining({ emoji: '👀', is_from_me: false }),
      expect.objectContaining({ emoji: '👍', is_from_me: true }),
    ]);
    expect(providerReactionRequests).toEqual([
      {
        messageId: 'provider-message-to-react',
        body: { phone: jid, emoji: '👍' },
      },
    ]);
    const stored = await db('whatsapp_messages')
      .where({ id: source.id, company_id: companyId })
      .first();
    expect(JSON.parse(stored.reactions)).toHaveLength(2);

    const groupConversationId = inbox
      .json()
      .data.find((conversation: { jid: string }) => conversation.jid === groupJid).id as number;
    const [groupMessage] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: groupConversationId,
        external_id: 'provider-group-message-to-react',
        direction: 'outbound',
        message_type: 'text',
        content: 'A group message',
        status: 'sent',
      })
      .returning(['id']);
    const groupReaction = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${groupMessage.id}/reaction`,
      headers: { authorization: 'Bearer test' },
      payload: { emoji: '❤️' },
    });
    expect(groupReaction.statusCode).toBe(200);

    const invalid = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${source.id}/reaction`,
      headers: { authorization: 'Bearer test' },
      payload: { emoji: 'not an emoji' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(providerReactionRequests).toHaveLength(2);
    expect(providerReactionRequests[1]).toEqual({
      messageId: 'provider-group-message-to-react',
      body: { phone: groupJid, emoji: '❤️' },
    });

    const foreignAccount = await db('whatsapp_accounts')
      .insert({
        company_id: foreignCompanyId,
        status: 'connected',
        gateway_device_id: 'foreign-device',
      })
      .returning(['id']);
    const [foreignConversation] = await db('whatsapp_conversations')
      .insert({
        company_id: foreignCompanyId,
        account_id: foreignAccount[0].id,
        jid: '628999999999@s.whatsapp.net',
        name: 'Foreign conversation',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const [foreignMessage] = await db('whatsapp_messages')
      .insert({
        company_id: foreignCompanyId,
        account_id: foreignAccount[0].id,
        conversation_id: foreignConversation.id,
        external_id: 'foreign-message-id',
        direction: 'inbound',
        message_type: 'text',
        content: 'Foreign message',
        status: 'received',
      })
      .returning(['id']);
    const crossCompany = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${foreignMessage.id}/reaction`,
      headers: { authorization: 'Bearer test' },
      payload: { emoji: '❤️' },
    });
    expect(crossCompany.statusCode).toBe(404);
    expect(providerReactionRequests).toHaveLength(2);
    expect(accountId).toBeGreaterThan(0);
  });

  it('edits recent own text and revokes own messages only within the active company', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Mutation chat',
        is_group: false,
        unread_count: 0,
        last_message: 'Before edit',
      })
      .returning(['id']);
    const [message] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: conversation.id,
        external_id: 'provider-message-edit-revoke',
        direction: 'outbound',
        message_type: 'text',
        content: 'Before edit',
        status: 'sent',
        create_date: new Date().toISOString(),
      })
      .returning(['id']);

    const edited = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${message.id}/edit`,
      headers: { authorization: 'Bearer test' },
      payload: { content: 'After edit' },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().data).toMatchObject({ content: 'After edit', is_edited: true });
    expect(providerMessageMutationRequests[0]).toEqual({
      operation: 'update',
      messageId: 'provider-message-edit-revoke',
      body: { phone: '628111111111@s.whatsapp.net', message: 'After edit' },
    });
    const editedRecord = await db('whatsapp_messages').where({ id: message.id }).first();
    expect(editedRecord.content).toBe('After edit');
    expect(Boolean(editedRecord.is_edited)).toBe(true);
    expect(Boolean(editedRecord.is_deleted)).toBe(false);

    const revoked = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${message.id}/revoke`,
      headers: { authorization: 'Bearer test' },
    });
    expect(revoked.statusCode).toBe(200);
    expect(providerMessageMutationRequests[1]).toEqual({
      operation: 'revoke',
      messageId: 'provider-message-edit-revoke',
      body: { phone: '628111111111@s.whatsapp.net' },
    });
    const revokedRecord = await db('whatsapp_messages').where({ id: message.id }).first();
    expect(revokedRecord.content).toBe('This message was deleted');
    expect(Boolean(revokedRecord.is_deleted)).toBe(true);
    expect(
      (await db('whatsapp_conversations').where({ id: conversation.id }).first()).last_message
    ).toBe('This message was deleted');

    const [inbound] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: conversation.id,
        external_id: 'provider-inbound-cannot-edit',
        direction: 'inbound',
        message_type: 'text',
        content: 'Customer message',
        status: 'received',
      })
      .returning(['id']);
    const inboundEdit = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${inbound.id}/edit`,
      headers: { authorization: 'Bearer test' },
      payload: { content: 'Attempted edit' },
    });
    const inboundRevoke = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${inbound.id}/revoke`,
      headers: { authorization: 'Bearer test' },
    });
    expect(inboundEdit.statusCode).toBe(409);
    expect(inboundRevoke.statusCode).toBe(409);

    const [expired] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: conversation.id,
        external_id: 'provider-old-text',
        direction: 'outbound',
        message_type: 'text',
        content: 'Too old',
        status: 'sent',
        create_date: new Date(Date.now() - 16 * 60_000).toISOString(),
      })
      .returning(['id']);
    const expiredEdit = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${expired.id}/edit`,
      headers: { authorization: 'Bearer test' },
      payload: { content: 'Too late' },
    });
    expect(expiredEdit.statusCode).toBe(409);

    const foreignAccount = await db('whatsapp_accounts')
      .insert({
        company_id: foreignCompanyId,
        status: 'connected',
        gateway_device_id: 'foreign-device',
      })
      .returning(['id']);
    const [foreignConversation] = await db('whatsapp_conversations')
      .insert({
        company_id: foreignCompanyId,
        account_id: foreignAccount[0].id,
        jid: '628999999999@s.whatsapp.net',
        name: 'Foreign mutation',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const [foreignMessage] = await db('whatsapp_messages')
      .insert({
        company_id: foreignCompanyId,
        account_id: foreignAccount[0].id,
        conversation_id: foreignConversation.id,
        external_id: 'foreign-own-message',
        direction: 'outbound',
        message_type: 'text',
        content: 'Foreign message',
        status: 'sent',
      })
      .returning(['id']);
    const foreignEdit = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${foreignMessage.id}/edit`,
      headers: { authorization: 'Bearer test' },
      payload: { content: 'Cross-tenant attempt' },
    });
    const foreignRevoke = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${foreignMessage.id}/revoke`,
      headers: { authorization: 'Bearer test' },
    });
    expect(foreignEdit.statusCode).toBe(404);
    expect(foreignRevoke.statusCode).toBe(404);

    const deniedEdit = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${message.id}/edit`,
      headers: { authorization: 'Bearer test' },
      payload: { content: 'Restore it' },
    });
    expect(deniedEdit.statusCode).toBe(409);
    expect(providerMessageMutationRequests).toHaveLength(2);
  });

  it('applies signed GoWA edit and revoke events idempotently and redacts deleted media', async () => {
    const accountId = await connectAndMarkReady();
    process.env.WHATSAPP_WEBHOOK_SECRET = 'test-gowa-webhook-secret';
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628222222222@s.whatsapp.net',
        name: 'Webhook mutation',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const [message] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: conversation.id,
        external_id: 'provider-message-webhook-mutation',
        direction: 'outbound',
        message_type: 'text',
        content: 'Before edit',
        status: 'sent',
      })
      .returning(['id']);
    const mediaKey = `webhook-revoked-${randomUUID()}`;
    await storage.put(mediaKey, pngFixture());
    const [mediaMessage] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: conversation.id,
        external_id: 'provider-message-webhook-delete',
        direction: 'outbound',
        message_type: 'image',
        content: 'An image',
        status: 'sent',
        media_key: mediaKey,
        media_mime_type: 'image/png',
        media_file_name: 'secret.png',
      })
      .returning(['id']);
    const postEvent = async (event: string, payload: Record<string, unknown>) => {
      const raw = JSON.stringify({
        event,
        session_id: `moonwitness-company-${companyId}`,
        payload,
      });
      return app.inject({
        method: 'POST',
        url: `/whatsapp/gowa/webhook/moonwitness-company-${companyId}`,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.WHATSAPP_WEBHOOK_SECRET!).update(raw).digest('hex')}`,
        },
        payload: raw,
      });
    };
    const [group] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '120363000000777@g.us',
        name: 'Group cache',
        is_group: true,
        unread_count: 0,
        group_participant_count: 1,
        group_participants_json: JSON.stringify([
          {
            jid: '628111111111@s.whatsapp.net',
            display_name: 'Cached member',
            is_admin: false,
            is_super_admin: false,
          },
        ]),
        group_metadata_synced_at: new Date().toISOString(),
      })
      .returning(['id']);
    expect(
      (
        await postEvent('group.participants', {
          chat_id: '120363000000777@g.us',
          type: 'join',
          jids: ['628222222222@s.whatsapp.net'],
        })
      ).statusCode
    ).toBe(204);
    const invalidatedGroup = await db('whatsapp_conversations').where({ id: group.id }).first();
    expect(invalidatedGroup.group_metadata_synced_at).toBeNull();
    expect(JSON.parse(invalidatedGroup.group_participants_json)).toHaveLength(1);
    groupMetadataFails = true;
    const staleGroup = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${group.id}/group`,
      headers: { authorization: 'Bearer test' },
    });
    expect(staleGroup.statusCode).toBe(200);
    expect(staleGroup.json().data).toMatchObject({ stale: true, participant_count: 1 });
    groupMetadataFails = false;

    expect(
      (
        await postEvent('message.edited', {
          id: 'edit-event-id',
          original_message_id: 'provider-message-webhook-mutation',
          body: 'Edited caption',
        })
      ).statusCode
    ).toBe(204);
    const edited = await db('whatsapp_messages').where({ id: message.id }).first();
    expect(edited.content).toBe('Edited caption');
    expect(Boolean(edited.is_edited)).toBe(true);

    expect(
      (
        await postEvent('message.revoked', {
          id: 'revoke-event-id',
          revoked_message_id: 'provider-message-webhook-delete',
        })
      ).statusCode
    ).toBe(204);
    expect(
      (
        await postEvent('message.revoked', {
          id: 'revoke-event-id',
          revoked_message_id: 'provider-message-webhook-delete',
        })
      ).statusCode
    ).toBe(204);
    const revoked = await db('whatsapp_messages').where({ id: mediaMessage.id }).first();
    expect(Boolean(revoked.is_deleted)).toBe(true);
    expect(revoked).toMatchObject({
      content: 'This message was deleted',
      media_key: null,
      media_mime_type: null,
      media_file_name: null,
    });
    expect(await storage.get(mediaKey)).toBeNull();
    const mediaRead = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${mediaMessage.id}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(mediaRead.statusCode).toBe(404);
  });

  it('stores view-once and future GoWA message types as safe non-downloadable placeholders', async () => {
    await connectAndMarkReady();
    const jid = '628444555666@s.whatsapp.net';
    providerChats = [{ jid, name: 'Safe type chat' }];
    providerMessages = [
      {
        id: 'provider-view-once-message',
        chat_jid: jid,
        media_type: 'image',
        view_once: true,
        content: 'This caption must stay hidden',
        timestamp: '2026-10-24T10:00:00Z',
        is_from_me: false,
      },
      {
        id: 'provider-future-message',
        chat_jid: jid,
        media_type: 'future_event_card',
        content: '',
        timestamp: '2026-10-24T10:01:00Z',
        is_from_me: false,
      },
    ];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox
      .json()
      .data.find((conversation: { jid: string }) => conversation.jid === jid).id;
    const history = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test' },
    });
    expect(history.statusCode).toBe(200);
    const viewOnce = history
      .json()
      .data.find((message: { provider_type?: string }) => message.provider_type === 'view_once');
    const futureType = history
      .json()
      .data.find(
        (message: { provider_type?: string }) => message.provider_type === 'future_event_card'
      );
    expect(viewOnce).toMatchObject({
      message_type: 'text',
      provider_type: 'view_once',
      content: 'View-once media',
      media_mime_type: null,
    });
    expect(viewOnce.content).not.toContain('This caption must stay hidden');
    expect(futureType).toMatchObject({
      message_type: 'text',
      provider_type: 'future_event_card',
      content: '',
    });
    const mediaRead = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${viewOnce.id}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(mediaRead.statusCode).toBe(404);
  });

  it('quotes messages within the same company conversation and forwards the provider reply id', async () => {
    await connectAndMarkReady();
    providerChats = [{ jid: '123456@g.us', name: 'Quoted group' }];
    providerMessages = [
      {
        id: 'group-original-id',
        chat_jid: '123456@g.us',
        content: 'Original group message',
        timestamp: '2026-10-24T10:00:00Z',
        is_from_me: false,
      },
      {
        id: 'group-reply-id',
        chat_jid: '123456@g.us',
        content: 'Existing quote reply',
        timestamp: '2026-10-24T10:01:00Z',
        is_from_me: false,
        context_metadata: { replied_to_id: 'group-original-id' },
      },
    ];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox.json().data[0].id as number;
    const history = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test' },
    });
    const original = history
      .json()
      .data.find((item: { content: string }) => item.content === 'Original group message');
    const existingReply = history
      .json()
      .data.find((item: { content: string }) => item.content === 'Existing quote reply');
    expect(existingReply.reply_to).toMatchObject({
      id: original.id,
      content: 'Original group message',
    });

    const [foreignConversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: (await db('whatsapp_accounts').where({ company_id: companyId }).first()).id,
        jid: '628222222222@s.whatsapp.net',
        name: 'Other conversation',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const [foreignMessage] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: (await db('whatsapp_accounts').where({ company_id: companyId }).first()).id,
        conversation_id: foreignConversation.id,
        external_id: 'other-conversation-message',
        direction: 'inbound',
        message_type: 'text',
        content: 'Do not quote across conversations',
        status: 'received',
      })
      .returning(['id']);
    const crossConversationQuote = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { content: 'Invalid quote', reply_to_message_id: foreignMessage.id },
    });
    expect(crossConversationQuote.statusCode).toBe(404);

    const sent = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { content: 'Reply from Board', reply_to_message_id: original.id },
    });
    expect(sent.statusCode).toBe(202);
    const messageId = sent.json().data.id as number;
    const event = await db('outbox_events')
      .where({ aggregate_id: messageId, event_type: 'whatsapp.message.send' })
      .first();
    await dispatchQueuedWhatsAppMessage(messageId, companyId, event.id, storage);
    expect(providerTextSendBodies.at(-1)).toMatchObject({
      phone: '123456@g.us',
      message: 'Reply from Board',
      reply_message_id: 'group-original-id',
    });
    const persisted = await db('whatsapp_messages').where({ id: messageId }).first();
    expect(persisted).toMatchObject({
      reply_to_message_id: original.id,
      reply_to_external_id: 'group-original-id',
      status: 'sent',
    });
  });

  it('keeps pre-acceptance network failures ambiguous and treats GoWA 4xx as permanent', async () => {
    await connectAndMarkReady();
    providerChats = [{ jid: '628111111111@s.whatsapp.net', name: 'Failure classes' }];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox.json().data[0].id as number;
    const queueMessage = async (content: string) => {
      const response = await app.inject({
        method: 'POST',
        url: `/whatsapp/conversations/${conversationId}/messages`,
        headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
        payload: { content },
      });
      const messageId = response.json().data.id as number;
      const event = await db('outbox_events')
        .where({ aggregate_id: messageId, event_type: 'whatsapp.message.send' })
        .first();
      return { messageId, event };
    };

    const network = await queueMessage('Network failed before acceptance');
    failTextBeforeAcceptance = true;
    await dispatchQueuedWhatsAppMessage(network.messageId, companyId, network.event.id, storage);
    const uncertain = await db('whatsapp_messages').where({ id: network.messageId }).first();
    expect(uncertain.status).toBe('unknown');
    expect(Boolean(uncertain.retryable)).toBe(false);

    const rejection = await queueMessage('Provider rejected request');
    failTextSend = true;
    textSendFailureStatus = 400;
    await dispatchQueuedWhatsAppMessage(
      rejection.messageId,
      companyId,
      rejection.event.id,
      storage
    );
    const failed = await db('whatsapp_messages').where({ id: rejection.messageId }).first();
    expect(failed.status).toBe('failed');
    expect(Boolean(failed.retryable)).toBe(false);
    expect(failed.last_error).toContain('400');
  });

  it('registers the signed receipt callback with GoWA when webhook configuration is complete', async () => {
    process.env.WHATSAPP_WEBHOOK_URL = 'https://api.moonwitness.test';
    process.env.WHATSAPP_WEBHOOK_SECRET = 'test-webhook-secret-that-is-at-least-32-chars';
    const response = await app.inject({
      method: 'POST',
      url: '/whatsapp/connect',
      headers: { authorization: 'Bearer test' },
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    expect(providerWebhookUpdates).toEqual([
      {
        path: `/devices/moonwitness-company-${companyId}/webhook`,
        body: {
          webhook_url: `https://api.moonwitness.test/whatsapp/gowa/webhook/moonwitness-company-${companyId}`,
          webhook_secret: process.env.WHATSAPP_WEBHOOK_SECRET,
          webhook_events:
            'message,message.ack,message.edited,message.revoked,message.deleted,group.participants',
        },
      },
    ]);
  });

  it('authenticates GoWA receipts and applies delivery states monotonically within one company', async () => {
    const accountId = await connectAndMarkReady();
    process.env.WHATSAPP_WEBHOOK_SECRET = 'test-gowa-webhook-secret';
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Receipt test',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const [outbound] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: conversation.id,
        external_id: 'receipt-test-message',
        direction: 'outbound',
        message_type: 'text',
        content: 'receipt test',
        status: 'sent',
      })
      .returning(['id']);
    const [foreignAccount] = await db('whatsapp_accounts')
      .insert({
        company_id: foreignCompanyId,
        gateway_device_id: 'moonwitness-company-foreign',
        status: 'connected',
      })
      .returning(['id']);
    const [foreignConversation] = await db('whatsapp_conversations')
      .insert({
        company_id: foreignCompanyId,
        account_id: foreignAccount.id,
        jid: '628222222222@s.whatsapp.net',
        name: 'Foreign receipt test',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    await db('whatsapp_messages').insert({
      company_id: foreignCompanyId,
      account_id: foreignAccount.id,
      conversation_id: foreignConversation.id,
      external_id: 'receipt-test-message',
      direction: 'outbound',
      message_type: 'text',
      content: 'foreign receipt test',
      status: 'sent',
    });

    const sendReceipt = async (
      receiptType: 'delivered' | 'read',
      signatureSecret = process.env.WHATSAPP_WEBHOOK_SECRET!,
      sessionId = `moonwitness-company-${companyId}`
    ) => {
      const raw = JSON.stringify({
        event: 'message.ack',
        session_id: sessionId,
        payload: { ids: ['receipt-test-message'], receipt_type: receiptType },
      });
      return app.inject({
        method: 'POST',
        url: `/whatsapp/gowa/webhook/moonwitness-company-${companyId}`,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${createHmac('sha256', signatureSecret).update(raw).digest('hex')}`,
        },
        payload: raw,
      });
    };

    expect((await sendReceipt('read', 'wrong-secret')).statusCode).toBe(401);
    expect(
      (await sendReceipt('read', process.env.WHATSAPP_WEBHOOK_SECRET!, 'another-device')).statusCode
    ).toBe(403);
    expect((await db('whatsapp_messages').where({ id: outbound.id }).first()).status).toBe('sent');
    expect((await sendReceipt('delivered')).statusCode).toBe(204);
    expect((await db('whatsapp_messages').where({ id: outbound.id }).first()).status).toBe(
      'delivered'
    );
    expect((await sendReceipt('read')).statusCode).toBe(204);
    expect((await sendReceipt('delivered')).statusCode).toBe(204);
    expect((await db('whatsapp_messages').where({ id: outbound.id }).first()).status).toBe('read');
    expect(
      (await db('whatsapp_messages').where({ company_id: foreignCompanyId }).first()).status
    ).toBe('sent');
  });

  it('ingests signed private and group message events once and keeps media on the GoWA download path', async () => {
    const accountId = await connectAndMarkReady();
    process.env.WHATSAPP_WEBHOOK_SECRET = 'test-gowa-webhook-secret';
    const postMessage = async (payload: Record<string, unknown>) => {
      const raw = JSON.stringify({
        event: 'message',
        session_id: `moonwitness-company-${companyId}`,
        payload,
      });
      return app.inject({
        method: 'POST',
        url: `/whatsapp/gowa/webhook/moonwitness-company-${companyId}`,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.WHATSAPP_WEBHOOK_SECRET!).update(raw).digest('hex')}`,
        },
        payload: raw,
      });
    };
    const privateMessage = {
      id: 'webhook-private-1',
      chat_id: '628111111111@s.whatsapp.net',
      from: '628111111111@s.whatsapp.net',
      sender_display_name: 'Webhook Contact',
      timestamp: '2026-10-24T10:00:00Z',
      is_from_me: false,
      body: 'Inbound from signed webhook',
    };
    expect((await postMessage(privateMessage)).statusCode).toBe(204);
    expect((await postMessage(privateMessage)).statusCode).toBe(204);
    const privateConversation = await db('whatsapp_conversations')
      .where({ company_id: companyId, jid: privateMessage.chat_id })
      .first();
    expect(privateConversation).toMatchObject({ name: 'Webhook Contact', unread_count: 1 });
    expect(
      await db('whatsapp_messages').where({ company_id: companyId, external_id: privateMessage.id })
    ).toMatchObject([
      {
        account_id: accountId,
        conversation_id: privateConversation.id,
        direction: 'inbound',
        status: 'received',
        content: privateMessage.body,
      },
    ]);
    const activeMembers = await db('company_memberships as membership')
      .join('users', 'users.id', 'membership.user_id')
      .where('membership.company_id', companyId)
      .where('users.active', true)
      .select('membership.user_id');
    const firstNotificationEvents = await db('outbox_events').where({
      company_id: companyId,
      event_type: 'notification.deliver',
    });
    expect(firstNotificationEvents).toHaveLength(activeMembers.length);
    for (const event of firstNotificationEvents) {
      const notificationPayload =
        typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      expect(notificationPayload).toMatchObject({
        templateCode: 'whatsapp.inbound_message',
        resource: { model: 'whatsapp.conversation', id: privateConversation.id },
      });
    }

    expect(
      (
        await postMessage({
          id: 'webhook-view-once-private',
          chat_id: privateMessage.chat_id,
          from: privateMessage.from,
          timestamp: '2026-10-24T10:00:10Z',
          is_from_me: false,
          image: 'statics/media/private-view-once.jpg',
          view_once: true,
          body: 'Do not expose this caption',
        })
      ).statusCode
    ).toBe(204);
    expect(
      (
        await postMessage({
          id: 'webhook-future-type-private',
          chat_id: privateMessage.chat_id,
          from: privateMessage.from,
          timestamp: '2026-10-24T10:00:20Z',
          is_from_me: false,
          media_type: 'future_interactive_card',
        })
      ).statusCode
    ).toBe(204);
    const safeProviderMessages = await db('whatsapp_messages')
      .where({ company_id: companyId })
      .whereIn('external_id', ['webhook-view-once-private', 'webhook-future-type-private']);
    const viewOnceMessage = safeProviderMessages.find(
      (message) => message.external_id === 'webhook-view-once-private'
    );
    expect(viewOnceMessage).toMatchObject({
      message_type: 'text',
      provider_type: 'view_once',
      content: 'View-once media',
      media_file_name: null,
    });
    const futureTypeMessage = safeProviderMessages.find(
      (message) => message.external_id === 'webhook-future-type-private'
    );
    expect(futureTypeMessage).toMatchObject({
      message_type: 'text',
      provider_type: 'future_interactive_card',
    });
    const viewOnceRead = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${viewOnceMessage.id}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(viewOnceRead.statusCode).toBe(404);

    const contactLid = '251556368777322@lid';
    expect(
      (
        await postMessage({
          id: 'webhook-private-lid-before-map',
          chat_id: contactLid,
          from: contactLid,
          timestamp: '2026-10-24T10:00:30Z',
          is_from_me: false,
          body: 'First seen as a LID',
        })
      ).statusCode
    ).toBe(204);
    const lidConversation = await db('whatsapp_conversations')
      .where({ company_id: companyId, jid: contactLid })
      .first();
    const contactAvatarKey = randomUUID();
    stored.set(contactAvatarKey, pngFixture());
    await db('whatsapp_conversations')
      .where({ company_id: companyId, id: lidConversation.id })
      .update({
        contact_picture_id: 'lid-avatar',
        contact_avatar_picture_id: 'lid-avatar',
        contact_avatar_key: contactAvatarKey,
      });
    const lidMessage = await db('whatsapp_messages')
      .where({ company_id: companyId, external_id: 'webhook-private-lid-before-map' })
      .first();
    await db('whatsapp_conversation_reads').insert({
      company_id: companyId,
      conversation_id: lidConversation.id,
      user_id: 1,
      last_read_message_id: lidMessage.id,
      last_read_at: lidMessage.create_date,
    });
    const canonicalPhoneJid = '628333444555@s.whatsapp.net';
    expect(
      (
        await postMessage({
          id: 'webhook-private-lid-after-map',
          chat_id: canonicalPhoneJid,
          from: canonicalPhoneJid,
          from_lid: contactLid,
          timestamp: '2026-10-24T10:00:45Z',
          is_from_me: false,
          body: 'Resolved to a phone JID',
        })
      ).statusCode
    ).toBe(204);
    const conversationsAfterLidResolution = await db('whatsapp_conversations')
      .where({ company_id: companyId })
      .whereIn('jid', [contactLid, canonicalPhoneJid]);
    expect(conversationsAfterLidResolution).toHaveLength(1);
    expect(conversationsAfterLidResolution[0]).toMatchObject({
      jid: canonicalPhoneJid,
      contact_picture_id: 'lid-avatar',
      contact_avatar_picture_id: 'lid-avatar',
      contact_avatar_key: contactAvatarKey,
    });
    const mergedMessages = await db('whatsapp_messages')
      .where({ company_id: companyId })
      .whereIn('external_id', ['webhook-private-lid-before-map', 'webhook-private-lid-after-map']);
    expect(new Set(mergedMessages.map((message) => message.conversation_id))).toEqual(
      new Set([conversationsAfterLidResolution[0].id])
    );
    expect(
      await db('whatsapp_conversation_aliases').where({
        company_id: companyId,
        alias_jid: contactLid,
        conversation_id: conversationsAfterLidResolution[0].id,
      })
    ).toHaveLength(1);
    expect(
      await db('whatsapp_conversation_reads').where({
        company_id: companyId,
        conversation_id: conversationsAfterLidResolution[0].id,
        user_id: 1,
        last_read_message_id: lidMessage.id,
      })
    ).toHaveLength(1);
    expect(
      (
        await postMessage({
          id: 'webhook-private-lid-after-known-map',
          chat_id: contactLid,
          from: contactLid,
          timestamp: '2026-10-24T10:00:48Z',
          is_from_me: false,
          body: 'Still grouped after the LID mapping is known',
        })
      ).statusCode
    ).toBe(204);
    const conversationsAfterKnownLid = await db('whatsapp_conversations')
      .where({ company_id: companyId })
      .whereIn('jid', [contactLid, canonicalPhoneJid]);
    expect(conversationsAfterKnownLid).toHaveLength(1);
    expect(conversationsAfterKnownLid[0].jid).toBe(canonicalPhoneJid);
    expect(
      await db('whatsapp_messages').where({
        company_id: companyId,
        external_id: 'webhook-private-lid-after-known-map',
        conversation_id: conversationsAfterLidResolution[0].id,
      })
    ).toHaveLength(1);
    const foreignDeviceId = 'moonwitness-company-foreign-lid-test';
    await db('whatsapp_accounts').insert({
      company_id: foreignCompanyId,
      gateway_device_id: foreignDeviceId,
      status: 'connected',
    });
    const foreignJid = '628444555666@s.whatsapp.net';
    const foreignPayload = {
      event: 'message',
      session_id: foreignDeviceId,
      payload: {
        id: 'webhook-foreign-lid-map',
        chat_id: foreignJid,
        from: foreignJid,
        from_lid: contactLid,
        timestamp: '2026-10-24T10:00:50Z',
        is_from_me: false,
        body: 'Same LID in another company',
      },
    };
    const foreignRaw = JSON.stringify(foreignPayload);
    const foreignResponse = await app.inject({
      method: 'POST',
      url: `/whatsapp/gowa/webhook/${foreignDeviceId}`,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.WHATSAPP_WEBHOOK_SECRET!)
          .update(foreignRaw)
          .digest('hex')}`,
      },
      payload: foreignRaw,
    });
    expect(foreignResponse.statusCode).toBe(204);
    const mainCompanyAlias = await db('whatsapp_conversation_aliases')
      .where({ company_id: companyId, alias_jid: contactLid })
      .first();
    const foreignCompanyAlias = await db('whatsapp_conversation_aliases')
      .where({ company_id: foreignCompanyId, alias_jid: contactLid })
      .first();
    expect(Number(mainCompanyAlias.conversation_id)).toBe(conversationsAfterLidResolution[0].id);
    expect(Number(foreignCompanyAlias.conversation_id)).not.toBe(
      conversationsAfterLidResolution[0].id
    );
    expect(
      await db('whatsapp_conversations').where({
        company_id: foreignCompanyId,
        jid: foreignJid,
      })
    ).toHaveLength(1);

    expect(
      (
        await postMessage({
          id: 'webhook-group-image-1',
          chat_id: '120363123456789@g.us',
          from: '628222222222@s.whatsapp.net',
          from_lid: '251556368777322@lid',
          sender_display_name: 'Group sender',
          timestamp: '2026-10-24T10:01:00Z',
          is_from_me: false,
          image: { path: 'statics/media/provider-image.jpg', caption: 'Group image caption' },
          filename: 'group-image.jpg',
        })
      ).statusCode
    ).toBe(204);
    const groupConversation = await db('whatsapp_conversations')
      .where({ company_id: companyId, jid: '120363123456789@g.us' })
      .first();
    const groupMessage = await db('whatsapp_messages')
      .where({ company_id: companyId, external_id: 'webhook-group-image-1' })
      .first();
    expect(Number(groupConversation.is_group)).toBe(1);
    expect(groupConversation.unread_count).toBe(1);
    expect(groupMessage).toMatchObject({
      account_id: accountId,
      conversation_id: groupConversation.id,
      message_type: 'image',
      media_mime_type: 'image/jpeg',
      media_file_name: 'group-image.jpg',
      sender_jid: '628222222222@s.whatsapp.net',
      sender_display_name: 'Group sender',
      content: 'Group image caption',
      status: 'received',
    });
    expect(groupMessage.media_key).toBeNull();
    const groupHistory = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${groupConversation.id}/messages`,
      headers: { authorization: 'Bearer test' },
    });
    expect(groupHistory.statusCode).toBe(200);
    expect(groupHistory.json().data).toContainEqual(
      expect.objectContaining({
        id: groupMessage.id,
        content: 'Group image caption',
        sender_display_name: 'Group sender',
        sender_jid: '628222222222@s.whatsapp.net',
      })
    );
    expect(
      await db('whatsapp_conversation_aliases').where({
        company_id: companyId,
        alias_jid: '251556368777322@lid',
      })
    ).toHaveLength(1);

    const notificationCountBeforeOutboundEcho = await db('outbox_events')
      .where({ company_id: companyId, event_type: 'notification.deliver' })
      .count({ count: '*' })
      .first();
    const sentAt = new Date().toISOString();
    const [pendingMessage] = await db('whatsapp_messages')
      .insert({
        company_id: companyId,
        account_id: accountId,
        conversation_id: privateConversation.id,
        external_id: `pending:${randomUUID()}`,
        direction: 'outbound',
        message_type: 'text',
        content: 'Echo before HTTP acknowledgement',
        status: 'sending',
        create_date: sentAt,
      })
      .returning(['id']);
    expect(
      (
        await postMessage({
          id: 'webhook-outbound-echo-1',
          chat_id: privateMessage.chat_id,
          from: '6281234567890@s.whatsapp.net',
          sender_display_name: 'My WhatsApp account',
          timestamp: sentAt,
          is_from_me: true,
          body: 'Echo before HTTP acknowledgement',
        })
      ).statusCode
    ).toBe(204);
    const reconciled = await db('whatsapp_messages')
      .where({ company_id: companyId, id: pendingMessage.id })
      .first();
    expect(reconciled).toMatchObject({ external_id: 'webhook-outbound-echo-1', status: 'sent' });
    expect(
      await db('whatsapp_messages').where({
        company_id: companyId,
        external_id: 'webhook-outbound-echo-1',
      })
    ).toHaveLength(1);
    expect(
      (await db('whatsapp_conversations').where({ id: privateConversation.id }).first()).name
    ).toBe('Webhook Contact');
    const notificationCountAfterOutboundEcho = await db('outbox_events')
      .where({ company_id: companyId, event_type: 'notification.deliver' })
      .count({ count: '*' })
      .first();
    expect(Number(notificationCountAfterOutboundEcho?.count)).toBe(
      Number(notificationCountBeforeOutboundEcho?.count)
    );
  });

  it('stores one durable send per idempotency key and rejects changed content', async () => {
    await connectAndMarkReady();
    providerChats = [{ jid: '628111111111@s.whatsapp.net', name: 'Private' }];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox.json().data[0].id as number;
    const key = randomUUID();
    const headers = { authorization: 'Bearer test', 'idempotency-key': key };
    const payload = { content: 'Exactly once from Board' };
    const first = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers,
      payload,
    });
    await db('whatsapp_accounts')
      .where({ company_id: companyId })
      .update({ status: 'disconnected' });
    const duplicate = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json().data.id).toBe(first.json().data.id);
    const queued = await db('outbox_events')
      .where({ event_type: 'whatsapp.message.send' })
      .count('* as count')
      .first();
    expect(Number(queued?.count)).toBe(1);
    const changed = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers,
      payload: { content: 'Different message' },
    });
    expect(changed.statusCode).toBe(409);
    const messageId = first.json().data.id as number;
    await db('whatsapp_messages')
      .where({ id: messageId })
      .update({ status: 'failed', retryable: true });
    const retry = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${messageId}/retry`,
      headers: { authorization: 'Bearer test' },
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().data.status).toBe('queued');
    const messageAudits = await db('audit_logs').where({ model: 'whatsapp.message' }).orderBy('id');
    expect(messageAudits.map((entry) => entry.operation)).toEqual(['send_queued', 'retry_queued']);
    expect(messageAudits.every((entry) => !entry.changes.includes('Exactly once'))).toBe(true);
    const retryEvents = await db('outbox_events')
      .where({ event_type: 'whatsapp.message.send' })
      .count('* as count')
      .first();
    expect(Number(retryEvents?.count)).toBe(2);
    await db('whatsapp_messages').where({ id: messageId }).update({ status: 'unknown' });
    const ambiguousRetry = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${messageId}/retry`,
      headers: { authorization: 'Bearer test' },
    });
    expect(ambiguousRetry.statusCode).toBe(409);
  });

  it('expires queued messages after 24 hours without sending them to GoWA', async () => {
    await connectAndMarkReady();
    providerChats = [{ jid: '628111111111@s.whatsapp.net', name: 'Private' }];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox.json().data[0].id as number;
    const response = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { content: 'expire this queued message' },
    });
    const messageId = response.json().data.id as number;
    const event = await db('outbox_events')
      .where({ aggregate_id: messageId, event_type: 'whatsapp.message.send' })
      .first();
    await db('whatsapp_messages')
      .where({ id: messageId })
      .update({ create_date: new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString() });

    await dispatchQueuedWhatsAppMessage(messageId, companyId, event.id, storage);
    expect(providerTextSendCount).toBe(0);
    const expiredMessage = await db('whatsapp_messages').where({ id: messageId }).first();
    expect(expiredMessage).toMatchObject({
      status: 'failed',
      last_error: 'WhatsApp delivery expired after 24 hours in the queue.',
    });
    expect(Boolean(expiredMessage.retryable)).toBe(false);
  });

  it('repairs the conversation preview after GoWA confirms without sending the message twice', async () => {
    await connectAndMarkReady();
    providerChats = [{ jid: '628111111111@s.whatsapp.net', name: 'Preview recovery' }];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversation = inbox.json().data[0] as { id: number; last_message: string | null };
    const response = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { content: 'Accepted once' },
    });
    const messageId = response.json().data.id as number;
    const event = await db('outbox_events')
      .where({ aggregate_id: messageId, event_type: 'whatsapp.message.send' })
      .first();
    const sendsBefore = providerTextSendCount;
    await createFailingUpdateTrigger(
      'fail_whatsapp_preview',
      'whatsapp_conversations',
      'last_message',
      'simulated preview cache failure'
    );

    await expect(
      dispatchQueuedWhatsAppMessage(messageId, companyId, event.id, storage)
    ).rejects.toThrow('simulated preview cache failure');
    expect((await db('whatsapp_messages').where({ id: messageId }).first()).status).toBe('sent');
    expect(providerTextSendCount).toBe(sendsBefore + 1);

    await dropFailingUpdateTrigger('fail_whatsapp_preview', 'whatsapp_conversations');
    await dispatchQueuedWhatsAppMessage(messageId, companyId, event.id, storage);
    const repaired = await db('whatsapp_conversations').where({ id: conversation.id }).first();
    expect(repaired.last_message).toBe('Accepted once');
    expect(providerTextSendCount).toBe(sendsBefore + 1);

    const olderDeliveryAt = new Date(Date.now() - 60_000).toISOString();
    const newerDeliveryAt = new Date().toISOString();
    await db('whatsapp_messages').where({ id: messageId }).update({ write_date: olderDeliveryAt });
    await db('whatsapp_conversations').where({ id: conversation.id }).update({
      last_message: 'A newer provider message',
      last_message_at: newerDeliveryAt,
    });
    await dispatchQueuedWhatsAppMessage(messageId, companyId, event.id, storage);
    const afterOldEventReplay = await db('whatsapp_conversations')
      .where({ id: conversation.id })
      .first();
    expect(afterOldEventReplay.last_message).toBe('A newer provider message');
    expect(providerTextSendCount).toBe(sendsBefore + 1);
  });

  it('persists the GoWA acknowledgement in the outbox before updating the message row', async () => {
    await connectAndMarkReady();
    providerChats = [{ jid: '628111111111@s.whatsapp.net', name: 'Ack recovery' }];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox.json().data[0].id as number;
    const response = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { content: 'Persist provider acknowledgement' },
    });
    const messageId = response.json().data.id as number;
    const event = await db('outbox_events')
      .where({ aggregate_id: messageId, event_type: 'whatsapp.message.send' })
      .first();
    const sendsBefore = providerTextSendCount;
    await createFailingUpdateTrigger(
      'fail_whatsapp_message_ack',
      'whatsapp_messages',
      'status',
      'simulated message row failure',
      "NEW.status = 'sent'"
    );

    await expect(
      dispatchQueuedWhatsAppMessage(messageId, companyId, event.id, storage)
    ).rejects.toThrow('simulated message row failure');
    const eventAfterAck = await db('outbox_events').where({ id: event.id }).first();
    const persistedPayload = JSON.parse(eventAfterAck.payload) as {
      provider_ack?: { external_id: string };
    };
    expect(persistedPayload.provider_ack?.external_id).toBeTruthy();
    expect((await db('whatsapp_messages').where({ id: messageId }).first()).status).toBe('sending');

    await dropFailingUpdateTrigger('fail_whatsapp_message_ack', 'whatsapp_messages');
    await dispatchQueuedWhatsAppMessage(
      messageId,
      companyId,
      event.id,
      storage,
      persistedPayload.provider_ack
    );
    expect((await db('whatsapp_messages').where({ id: messageId }).first()).status).toBe('sent');
    expect(
      (await db('whatsapp_conversations').where({ id: conversationId }).first()).last_message
    ).toBe('Persist provider acknowledgement');
    expect(providerTextSendCount).toBe(sendsBefore + 1);
  });

  it('reconciles one unambiguous timed-out outbound message from GoWA history', async () => {
    await connectAndMarkReady();
    providerChats = [{ jid: '628111111111@s.whatsapp.net', name: 'Reconcile outbound' }];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox.json().data[0].id as number;
    const response = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { content: 'Delivery response was lost' },
    });
    const messageId = response.json().data.id as number;
    const sentAt = new Date(Date.now() - 5_000).toISOString();
    await db('whatsapp_messages')
      .where({ id: messageId, company_id: companyId })
      .update({ status: 'unknown', create_date: sentAt });
    providerMessages = [
      {
        id: 'gowa-reconciled-message',
        chat_jid: '628111111111@s.whatsapp.net',
        content: 'Delivery response was lost',
        timestamp: new Date(Date.parse(sentAt) + 2_000).toISOString(),
        is_from_me: true,
        media_type: 'text',
      },
    ];
    const accountId = Number(
      (await db('whatsapp_accounts').where({ company_id: companyId }).first()).id
    );
    await db('whatsapp_messages').insert({
      company_id: companyId,
      account_id: accountId,
      conversation_id: conversationId,
      external_id: 'gowa-reconciled-message',
      direction: 'outbound',
      message_type: 'text',
      content: 'Delivery response was lost',
      status: 'sent',
      attempt_count: 1,
      retryable: false,
      create_date: new Date(Date.parse(sentAt) + 2_000).toISOString(),
    });

    const refreshed = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test' },
    });
    const reconciled = await db('whatsapp_messages').where({ id: messageId }).first();
    expect(reconciled).toMatchObject({
      external_id: 'gowa-reconciled-message',
      status: 'sent',
    });
    expect(Boolean(reconciled.retryable)).toBe(false);
    expect(
      refreshed
        .json()
        .data.filter((item: { content: string }) => item.content === 'Delivery response was lost')
    ).toHaveLength(1);
    const reconciledCount = await db('whatsapp_messages')
      .where({ company_id: companyId, external_id: 'gowa-reconciled-message' })
      .count('* as count')
      .first();
    expect(Number(reconciledCount.count)).toBe(1);
  });

  it('recovers when GoWA accepts a send but the HTTP response is lost', async () => {
    await connectAndMarkReady();
    providerChats = [{ jid: '628111111111@s.whatsapp.net', name: 'Lost response' }];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox.json().data[0].id as number;
    const response = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { content: 'Accepted despite response loss' },
    });
    const messageId = response.json().data.id as number;
    const event = await db('outbox_events')
      .where({ aggregate_id: messageId, event_type: 'whatsapp.message.send' })
      .first();
    acceptThenTimeout = true;

    await dispatchQueuedWhatsAppMessage(messageId, companyId, event.id, storage);
    expect((await db('whatsapp_messages').where({ id: messageId }).first()).status).toBe('unknown');
    expect(providerTextSendCount).toBe(1);

    const refreshed = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test' },
    });
    const reconciled = await db('whatsapp_messages').where({ id: messageId }).first();
    expect(reconciled).toMatchObject({
      external_id: 'accepted-before-response-timeout',
      status: 'sent',
    });
    expect(Boolean(reconciled.retryable)).toBe(false);
    expect(
      refreshed
        .json()
        .data.filter(
          (item: { content: string }) => item.content === 'Accepted despite response loss'
        )
    ).toHaveLength(1);
    expect(providerTextSendCount).toBe(1);
  });

  it('does not reconcile timed-out sends when more than one outbound message matches', async () => {
    await connectAndMarkReady();
    providerChats = [{ jid: '628111111111@s.whatsapp.net', name: 'Ambiguous reconcile' }];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox.json().data[0].id as number;
    const first = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { content: 'Same outbound body' },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { content: 'Same outbound body' },
    });
    const at = new Date(Date.now() - 5_000).toISOString();
    await db('whatsapp_messages')
      .whereIn('id', [first.json().data.id, second.json().data.id])
      .update({ status: 'unknown', create_date: at });
    providerMessages = [
      {
        id: 'gowa-ambiguous-message',
        chat_jid: '628111111111@s.whatsapp.net',
        content: 'Same outbound body',
        timestamp: at,
        is_from_me: true,
        media_type: 'text',
      },
    ];

    await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test' },
    });
    const pending = await db('whatsapp_messages')
      .where({ company_id: companyId, direction: 'outbound', content: 'Same outbound body' })
      .orderBy('id');
    expect(pending).toHaveLength(3);
    expect(pending.slice(0, 2).every((message) => message.status === 'unknown')).toBe(true);
    expect(pending.slice(0, 2).every((message) => message.external_id.startsWith('pending:'))).toBe(
      true
    );
  });

  it('stops automatic and manual retries after five delivery attempts', async () => {
    await connectAndMarkReady();
    providerChats = [{ jid: '628111111111@s.whatsapp.net', name: 'Private' }];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox.json().data[0].id as number;
    const response = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { content: 'limited retry message' },
    });
    const messageId = response.json().data.id as number;
    const event = await db('outbox_events')
      .where({ aggregate_id: messageId, event_type: 'whatsapp.message.send' })
      .first();
    await db('whatsapp_accounts')
      .where({ company_id: companyId })
      .update({ status: 'disconnected' });
    await db('whatsapp_messages').where({ id: messageId }).update({ attempt_count: 4 });

    await dispatchQueuedWhatsAppMessage(messageId, companyId, event.id, storage);
    const exhausted = await db('whatsapp_messages').where({ id: messageId }).first();
    expect(exhausted.status).toBe('failed');
    expect(Boolean(exhausted.retryable)).toBe(false);
    const retry = await app.inject({
      method: 'POST',
      url: `/whatsapp/messages/${messageId}/retry`,
      headers: { authorization: 'Bearer test' },
    });
    expect(retry.statusCode).toBe(409);
  });

  it.skipIf(process.env.ATTACHMENT_S3_ACCEPTANCE !== '1')(
    'stores outbound WhatsApp media in live S3 storage and serves it back through the API',
    async () => {
      const s3Storage = new S3AttachmentStorage({
        endpoint: process.env.ATTACHMENT_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
        region: process.env.ATTACHMENT_S3_REGION ?? 'us-east-1',
        bucket: process.env.ATTACHMENT_S3_BUCKET ?? 'moonwitness-attachments',
        accessKeyId: process.env.ATTACHMENT_S3_ACCESS_KEY ?? '',
        secretAccessKey: process.env.ATTACHMENT_S3_SECRET_KEY ?? '',
        forcePathStyle: process.env.ATTACHMENT_S3_FORCE_PATH_STYLE !== 'false',
      });
      activeStorage = s3Storage;
      let mediaKey: string | undefined;
      try {
        await s3Storage.checkReady();
        await connectAndMarkReady();
        providerChats = [
          {
            jid: '628111111111@s.whatsapp.net',
            name: 'S3 acceptance',
            last_message_time: '2026-10-24T00:00:00Z',
          },
        ];
        const inbox = await app.inject({
          method: 'GET',
          url: '/whatsapp/conversations',
          headers: { authorization: 'Bearer test' },
        });
        expect(inbox.statusCode).toBe(200);
        const conversationId = inbox.json().data[0].id as number;
        const content = Buffer.from(`S3 WhatsApp acceptance ${randomUUID()}`);
        const upload = multipartPayload(
          { content: 'S3 acceptance' },
          { name: 's3-acceptance.bin', mime: 'application/octet-stream', bytes: content }
        );
        const sent = await app.inject({
          method: 'POST',
          url: `/whatsapp/conversations/${conversationId}/messages`,
          headers: {
            authorization: 'Bearer test',
            'idempotency-key': randomUUID(),
            'content-type': upload.contentType,
          },
          payload: upload.payload,
        });
        expect(sent.statusCode, sent.payload).toBe(202);
        const messageId = sent.json().data.id as number;
        mediaKey = (await db('whatsapp_messages').where({ id: messageId }).first('media_key'))
          ?.media_key as string | undefined;
        expect(mediaKey).toBeDefined();

        const media = await app.inject({
          method: 'GET',
          url: `/whatsapp/media/${messageId}`,
          headers: { authorization: 'Bearer test' },
        });
        expect(media.statusCode).toBe(200);
        expect(media.body).toBe(content.toString());
      } finally {
        if (mediaKey) await s3Storage.delete(mediaKey).catch(() => undefined);
        activeStorage = memoryStorage;
        await closeS3AttachmentStorage(s3Storage);
      }
    },
    30_000
  );

  it('does not send media to WhatsApp when the attachment cannot be stored first', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Private',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    failAttachmentPut = true;
    const upload = multipartPayload(
      { content: 'Photo' },
      { name: 'test.png', mime: 'image/png', bytes: pngFixture() }
    );
    const response = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/messages`,
      headers: {
        authorization: 'Bearer test',
        'idempotency-key': randomUUID(),
        'content-type': upload.contentType,
      },
      payload: upload.payload,
    });
    expect(response.statusCode, response.payload).toBe(503);
    expect(providerImageSendCount).toBe(0);
    const count = await db('whatsapp_messages').count({ count: '*' }).first();
    expect(Number(count?.count)).toBe(0);
  });

  it('rejects uploaded content when its bytes do not match the declared MIME type', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Private',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const upload = multipartPayload(
      { content: 'Wrong type' },
      { name: 'wrong.jpg', mime: 'image/jpeg', bytes: pngFixture() }
    );
    const response = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/messages`,
      headers: {
        authorization: 'Bearer test',
        'idempotency-key': randomUUID(),
        'content-type': upload.contentType,
      },
      payload: upload.payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('does not match');
    expect(providerImageSendCount).toBe(0);
    const messageCount = await db('whatsapp_messages').count({ count: '*' }).first();
    expect(Number(messageCount?.count)).toBe(0);
  });

  it('rejects empty files and legacy Base64 payloads before creating a message', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Private',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const emptyUpload = multipartPayload(
      { content: 'Invalid file' },
      { name: 'empty.bin', mime: 'application/octet-stream', bytes: Buffer.alloc(0) }
    );
    const emptyResponse = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/messages`,
      headers: {
        authorization: 'Bearer test',
        'idempotency-key': randomUUID(),
        'content-type': emptyUpload.contentType,
      },
      payload: emptyUpload.payload,
    });
    expect(emptyResponse.statusCode).toBe(400);
    const legacy = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/messages`,
      headers: { authorization: 'Bearer test', 'idempotency-key': randomUUID() },
      payload: { content: 'Legacy', media_base64: 'aGVsbG8=' },
    });
    expect(legacy.statusCode).toBe(400);
    const messageCount = await db('whatsapp_messages').count({ count: '*' }).first();
    expect(Number(messageCount?.count)).toBe(0);
  });

  it('sanitizes traversal and control characters from uploaded filenames', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Private',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const upload = multipartPayload(
      { content: 'Filename check' },
      { name: '../../folder\r\nbad.png', mime: 'image/png', bytes: pngFixture() }
    );
    const response = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/messages`,
      headers: {
        authorization: 'Bearer test',
        'idempotency-key': randomUUID(),
        'content-type': upload.contentType,
      },
      payload: upload.payload,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().data.media_file_name).toBe('folder');
  });

  it('serves provider media with an inline-safe MIME derived from its bytes', async () => {
    await connectAndMarkReady();
    providerChats = [{ jid: '628111111111@s.whatsapp.net', name: 'Private' }];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox.json().data[0].id as number;
    providerMessages = [
      {
        id: 'incoming-image',
        chat_jid: '628111111111@s.whatsapp.net',
        content: '',
        timestamp: '2026-10-23T11:00:00Z',
        is_from_me: false,
        media_type: 'image',
        mime_type: 'image/png',
      },
    ];
    const messages = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test' },
    });
    const messageId = messages.json().data[0].id as number;
    providerDownloadBytes = Buffer.from('<script>alert(1)</script>');
    providerDownloadFileName = '../../evil\r\nX.html';
    const response = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${messageId}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/octet-stream');
    expect(response.headers['content-disposition']).toMatch(/^attachment;/u);
    expect(response.headers['content-disposition']).toContain('filename=".._.._evil__X.html"');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'; sandbox");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect((await db('whatsapp_messages').where({ id: messageId }).first()).media_mime_type).toBe(
      'application/octet-stream'
    );
    expect(streamPutCount).toBe(1);
    expect(streamGetCount).toBe(2);
    expect(bufferGetCount).toBe(0);
    const cachedResponse = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${messageId}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(cachedResponse.body).toBe(providerDownloadBytes.toString());
    expect(streamGetCount).toBe(3);
    expect(bufferGetCount).toBe(0);
  });

  it('does not cache provider downloads shorter than their declared content length', async () => {
    await connectAndMarkReady();
    providerChats = [{ jid: '628111111111@s.whatsapp.net', name: 'Private' }];
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      headers: { authorization: 'Bearer test' },
    });
    const conversationId = inbox.json().data[0].id as number;
    providerMessages = [
      {
        id: 'incoming-image',
        chat_jid: '628111111111@s.whatsapp.net',
        content: '',
        timestamp: '2026-10-23T11:00:00Z',
        is_from_me: false,
        media_type: 'image',
      },
    ];
    const messages = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${conversationId}/messages`,
      headers: { authorization: 'Bearer test' },
    });
    const messageId = messages.json().data[0].id as number;
    providerDownloadDeclaredLength = pngFixture().length + 8;
    const response = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${messageId}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toContain('incomplete media');
    expect((await db('whatsapp_messages').where({ id: messageId }).first()).media_key).toBeNull();
    expect(stored.size).toBe(0);
  });

  it('enforces the shared 10 MiB raw-file limit during multipart upload', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Private',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const upload = multipartPayload(
      { content: 'Oversized file' },
      { name: 'too-large.png', mime: 'image/png', bytes: pngFixture(MAX_ATTACHMENT_BYTES + 1) }
    );
    const response = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/messages`,
      headers: {
        authorization: 'Bearer test',
        'idempotency-key': randomUUID(),
        'content-type': upload.contentType,
      },
      payload: upload.payload,
    });
    expect(response.statusCode, response.payload).toBe(413);
    expect(providerImageSendCount).toBe(0);
  });

  it('accepts exactly 10 MiB through multipart streaming', async () => {
    const accountId = await connectAndMarkReady();
    const [conversation] = await db('whatsapp_conversations')
      .insert({
        company_id: companyId,
        account_id: accountId,
        jid: '628111111111@s.whatsapp.net',
        name: 'Private',
        is_group: false,
        unread_count: 0,
      })
      .returning(['id']);
    const upload = multipartPayload(
      { content: 'Maximum size file' },
      { name: 'maximum.png', mime: 'image/png', bytes: pngFixture(MAX_ATTACHMENT_BYTES) }
    );
    const response = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/messages`,
      headers: {
        authorization: 'Bearer test',
        'idempotency-key': randomUUID(),
        'content-type': upload.contentType,
      },
      payload: upload.payload,
    });
    expect(response.statusCode).toBe(202);
    expect(providerImageSendCount).toBe(0);
    const storedContent = [...stored.values()][0];
    expect(storedContent?.byteLength).toBe(MAX_ATTACHMENT_BYTES);
  });
});
