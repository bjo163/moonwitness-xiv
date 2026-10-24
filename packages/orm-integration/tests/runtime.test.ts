import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecureContextOptions } from 'node:tls';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installAddons } from '@moonwitness/orm';
import { Company, manifest as baseManifest } from '@moonwitness/orm-base';
import { dispatchOneOutboxEvent, jobsManifest, OutboxEvent } from '@moonwitness/jobs';
import { manifest as integrationManifest } from '../src/manifest.js';
import { sendSignedRequest } from '../src/transport.js';
import {
  enqueueWebhookEvent,
  registerWebhookOutboxConsumer,
  verifyWebhookSignature,
  type WebhookDeliveryRequest,
  WebhookDelivery,
  WebhookEndpoint,
} from '../src/index.js';

const hasOpenSsl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
const hasPowerShellCertificates =
  process.platform === 'win32' &&
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '[System.Security.Cryptography.X509Certificates.CertificateRequest].AssemblyQualifiedName',
    ],
    { stdio: 'ignore' }
  ).status === 0;

async function createReceiverCertificate(directory: string): Promise<{
  ca: Buffer;
  keyOrPfx: SecureContextOptions;
}> {
  const certificatePath = join(directory, 'receiver-cert.pem');
  if (hasOpenSsl) {
    const caKeyPath = join(directory, 'ca-key.pem');
    const caCertificatePath = join(directory, 'ca-cert.pem');
    const requestPath = join(directory, 'receiver.csr');
    const keyPath = join(directory, 'receiver-key.pem');
    const extensionPath = join(directory, 'receiver.ext');
    await writeFile(
      extensionPath,
      'subjectAltName=DNS:receiver.example\nextendedKeyUsage=serverAuth\n'
    );
    const result = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        caKeyPath,
        '-out',
        caCertificatePath,
        '-days',
        '1',
        '-subj',
        '/CN=MoonWitness test CA',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
      ],
      { encoding: 'utf8', stdio: 'pipe' }
    );
    if (result.status !== 0) throw new Error(`OpenSSL could not create test CA: ${result.stderr}`);
    const keyResult = spawnSync(
      'openssl',
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        requestPath,
        '-subj',
        '/CN=receiver.example',
      ],
      { encoding: 'utf8', stdio: 'pipe' }
    );
    if (keyResult.status !== 0)
      throw new Error(`OpenSSL could not create test key: ${keyResult.stderr}`);
    const signedResult = spawnSync(
      'openssl',
      [
        'x509',
        '-req',
        '-in',
        requestPath,
        '-CA',
        caCertificatePath,
        '-CAkey',
        caKeyPath,
        '-CAcreateserial',
        '-out',
        certificatePath,
        '-days',
        '1',
        '-extfile',
        extensionPath,
      ],
      { encoding: 'utf8', stdio: 'pipe' }
    );
    if (signedResult.status !== 0)
      throw new Error(`OpenSSL could not sign test cert: ${signedResult.stderr}`);
    const certificate = await readFile(certificatePath);
    const ca = await readFile(caCertificatePath);
    return {
      ca,
      keyOrPfx: { key: await readFile(keyPath), cert: certificate, ca },
    };
  }

  if (hasPowerShellCertificates) {
    const certificateDerPath = join(directory, 'receiver-cert.cer');
    const pfxPath = join(directory, 'receiver.pfx');
    const passphrase = 'moonwitness-test-only';
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          "$ErrorActionPreference = 'Stop'",
          '$rsa = [System.Security.Cryptography.RSA]::Create(2048)',
          "$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=receiver.example', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)",
          '$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()',
          "$san.AddDnsName('receiver.example')",
          '$request.CertificateExtensions.Add($san.Build())',
          '$certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1), [DateTimeOffset]::UtcNow.AddDays(1))',
          `$pfx = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, '${passphrase}')`,
          '$der = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)',
          '[System.IO.File]::WriteAllBytes($env:MW_TEST_PFX_PATH, $pfx)',
          '[System.IO.File]::WriteAllBytes($env:MW_TEST_CERT_PATH, $der)',
        ].join('\n'),
      ],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          MW_TEST_PFX_PATH: pfxPath,
          MW_TEST_CERT_PATH: certificateDerPath,
        },
      }
    );
    if (result.status !== 0) {
      throw new Error(`PowerShell could not create test cert: ${result.stderr}`);
    }
    const certificateDer = await readFile(certificateDerPath);
    const base64 =
      certificateDer
        .toString('base64')
        .match(/.{1,64}/gu)
        ?.join('\n') ?? '';
    const certificate = Buffer.from(
      `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`
    );
    return {
      ca: certificate,
      keyOrPfx: { pfx: await readFile(pfxPath), passphrase },
    };
  }

  throw new Error('A test certificate generator is unavailable');
}

describe('webhook outbox delivery', () => {
  let db: Knex;
  let companyId: number;

  beforeEach(async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    await installAddons(db, [baseManifest, jobsManifest, integrationManifest]);
    companyId = (await Company.query().findOne({ name: 'MoonWitness' }).throwIfNotFound()).id;
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function addEndpoint(
    targetCompanyId: number,
    name: string,
    url = 'https://receiver.example/hooks'
  ) {
    return WebhookEndpoint.query().insert({
      company_id: targetCompanyId,
      name,
      url,
      event_types: '["base.partner.updated"]',
      secret_ref: `MW_WEBHOOK_SECRET_C${targetCompanyId}_${name.replaceAll(/[^A-Z0-9]/giu, '_').toUpperCase()}`,
      enabled: true,
    });
  }

  async function enqueue(company: number): Promise<number> {
    return db.transaction((transaction) =>
      enqueueWebhookEvent(
        {
          companyId: company,
          eventType: 'base.partner.updated',
          aggregateModel: 'base.partner',
          aggregateId: 42,
          payload: { name: 'Example partner' },
        },
        transaction
      )
    );
  }

  it('filters endpoints by company and retries with stable identity and signature', async () => {
    const endpoint = await addEndpoint(companyId, 'COMPANY_A');
    const secondCompany = await Company.query().insert({ name: 'Other Company' });
    await addEndpoint(secondCompany.id, 'COMPANY_B');
    const eventId = await enqueue(companyId);
    const secret = 's'.repeat(48);
    const requests: WebhookDeliveryRequest[] = [];
    const references: { reference: string; company: number }[] = [];
    let sendAttempts = 0;
    const resolveSecret = async (reference: string, company: number) => {
      references.push({ reference, company });
      return secret;
    };
    const unregister = registerWebhookOutboxConsumer(resolveSecret, {
      resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
      send: async (request) => {
        requests.push(request);
        sendAttempts += 1;
        return sendAttempts === 1 ? 503 : 204;
      },
    });

    try {
      expect(await dispatchOneOutboxEvent('webhook-test-worker')).toBe(true);
      const outbox = await OutboxEvent.query().findById(eventId).throwIfNotFound();
      await OutboxEvent.query()
        .findById(eventId)
        .patch({
          available_at: new Date(Date.now() - 1_000).toISOString(),
        });
      expect(outbox.status).toBe('pending');
      expect(await dispatchOneOutboxEvent('webhook-test-worker')).toBe(true);

      const deliveries = await WebhookDelivery.query().where({ outbox_event_id: eventId });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        endpoint_id: endpoint.id,
        company_id: companyId,
        status: 'delivered',
        attempts: 2,
        response_status: 204,
      });
      expect(references).toEqual([
        { reference: endpoint.secret_ref, company: companyId },
        { reference: endpoint.secret_ref, company: companyId },
      ]);
      expect(requests).toHaveLength(2);
      const firstRequest = requests[0];
      const secondRequest = requests[1];
      expect(firstRequest.eventId).toBe(eventId);
      expect(secondRequest.eventId).toBe(eventId);
      expect(firstRequest.idempotencyKey).toBe(`moonwitness:${eventId}`);
      expect(secondRequest.idempotencyKey).toBe(firstRequest.idempotencyKey);
      expect(firstRequest.signature).toBe(secondRequest.signature);
      expect(
        verifyWebhookSignature(
          secret,
          eventId,
          'base.partner.updated',
          firstRequest.body,
          `sha256=${firstRequest.signature}`
        )
      ).toBe(true);
      expect(firstRequest.targetAddress).toBe('8.8.8.8');
    } finally {
      unregister();
    }
  });

  it('records and blocks a private DNS answer before calling the transport', async () => {
    await addEndpoint(companyId, 'BLOCK_PRIVATE');
    const eventId = await enqueue(companyId);
    let sends = 0;
    const unregister = registerWebhookOutboxConsumer(async () => 's'.repeat(48), {
      resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
      send: async () => {
        sends += 1;
        return 204;
      },
    });

    try {
      expect(await dispatchOneOutboxEvent('webhook-test-worker')).toBe(true);
      expect(sends).toBe(0);
      expect(await WebhookDelivery.query().findOne({ outbox_event_id: eventId })).toMatchObject({
        status: 'dead',
        attempts: 1,
        last_error_code: 'WEBHOOK_SSRF_BLOCKED',
      });
      expect(await OutboxEvent.query().findById(eventId)).toMatchObject({ status: 'published' });
    } finally {
      unregister();
    }
  });

  it('rejects mixed public and private DNS answers before calling the transport', async () => {
    await addEndpoint(companyId, 'BLOCK_MIXED_DNS');
    const eventId = await enqueue(companyId);
    let sends = 0;
    const unregister = registerWebhookOutboxConsumer(async () => 's'.repeat(48), {
      resolveAddresses: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      send: async () => {
        sends += 1;
        return 204;
      },
    });

    try {
      expect(await dispatchOneOutboxEvent('webhook-mixed-dns-worker')).toBe(true);
      expect(sends).toBe(0);
      expect(await WebhookDelivery.query().findOne({ outbox_event_id: eventId })).toMatchObject({
        status: 'dead',
        attempts: 1,
        last_error_code: 'WEBHOOK_SSRF_BLOCKED',
      });
      expect(await OutboxEvent.query().findById(eventId)).toMatchObject({ status: 'published' });
    } finally {
      unregister();
    }
  });

  it('bounds a stalled DNS lookup and leaves the delivery retryable', async () => {
    await addEndpoint(companyId, 'DNS_TIMEOUT');
    const eventId = await enqueue(companyId);
    let sends = 0;
    const unregister = registerWebhookOutboxConsumer(async () => 's'.repeat(48), {
      resolveAddresses: async () => new Promise<never>(() => {}),
      send: async () => {
        sends += 1;
        return 204;
      },
    });

    try {
      expect(await dispatchOneOutboxEvent('webhook-dns-timeout-worker')).toBe(true);
      expect(sends).toBe(0);
      expect(await WebhookDelivery.query().findOne({ outbox_event_id: eventId })).toMatchObject({
        status: 'retrying',
        attempts: 1,
        last_error_code: 'WEBHOOK_DNS_TIMEOUT',
      });
    } finally {
      unregister();
    }
  }, 10_000);

  it.skipIf(!hasOpenSsl && !hasPowerShellCertificates)(
    'delivers a signed retry through a real local HTTPS receiver',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'moonwitness-webhook-'));
      const { ca, keyOrPfx } = await createReceiverCertificate(directory);
      const secret = 'local-https-receiver-test-secret-32chars';
      const received: {
        body: string;
        eventId: string | undefined;
        eventType: string | undefined;
        idempotencyKey: string | undefined;
        signatureValid: boolean;
        status: number;
      }[] = [];
      const server = createServer(keyOrPfx, (incoming, outgoing) => {
        if (incoming.url === '/slow') {
          outgoing.writeHead(200);
          outgoing.write('first byte');
          const heartbeat = setInterval(() => outgoing.write('next byte'), 25);
          outgoing.on('close', () => clearInterval(heartbeat));
          return;
        }
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const eventId = incoming.headers['x-mw-event-id'];
          const eventType = incoming.headers['x-mw-event-type'];
          const signature = incoming.headers['x-mw-signature'];
          const status = received.length === 0 ? 503 : 204;
          received.push({
            body,
            eventId: typeof eventId === 'string' ? eventId : undefined,
            eventType: typeof eventType === 'string' ? eventType : undefined,
            idempotencyKey:
              typeof incoming.headers['idempotency-key'] === 'string'
                ? incoming.headers['idempotency-key']
                : undefined,
            signatureValid:
              typeof eventId === 'string' &&
              typeof eventType === 'string' &&
              typeof signature === 'string' &&
              verifyWebhookSignature(secret, Number(eventId), eventType, body, signature),
            status,
          });
          outgoing.writeHead(status);
          outgoing.end();
        });
      });

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('HTTPS receiver did not bind');
        const port = address.port;
        const endpoint = await addEndpoint(
          companyId,
          'LOCAL_HTTPS',
          'https://receiver.example/hooks'
        );
        const eventId = await enqueue(companyId);
        const unregister = registerWebhookOutboxConsumer(async () => secret, {
          // The runtime validates a public DNS answer first. This test-only adapter then
          // routes the production sender's pinned connection to the local TLS fixture.
          resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
          send: (delivery) =>
            sendSignedRequest(
              { ...delivery, targetAddress: '127.0.0.1' },
              { port, ca, ...(delivery.url.pathname === '/slow' ? { timeoutMs: 200 } : {}) }
            ),
        });

        try {
          expect(await dispatchOneOutboxEvent('webhook-https-test-worker')).toBe(true);
          await OutboxEvent.query()
            .findById(eventId)
            .patch({ available_at: new Date(Date.now() - 1_000).toISOString() });
          expect(await dispatchOneOutboxEvent('webhook-https-test-worker')).toBe(true);

          expect(received).toHaveLength(2);
          expect(received.map(({ status }) => status)).toEqual([503, 204]);
          expect(received.every(({ signatureValid }) => signatureValid)).toBe(true);
          expect(received.map(({ eventId: receivedId }) => receivedId)).toEqual([
            String(eventId),
            String(eventId),
          ]);
          expect(received.map(({ eventType }) => eventType)).toEqual([
            'base.partner.updated',
            'base.partner.updated',
          ]);
          expect(received[0]?.idempotencyKey).toBe(`moonwitness:${eventId}`);
          expect(received[1]?.idempotencyKey).toBe(received[0]?.idempotencyKey);
          expect(JSON.parse(received[0]?.body ?? 'null')).toMatchObject({
            id: eventId,
            companyId,
            type: 'base.partner.updated',
            aggregate: { model: 'base.partner', id: 42 },
            data: { name: 'Example partner' },
          });
          expect(await WebhookDelivery.query().findOne({ outbox_event_id: eventId })).toMatchObject(
            {
              endpoint_id: endpoint.id,
              status: 'delivered',
              attempts: 2,
              response_status: 204,
            }
          );

          const timeoutRequest: WebhookDeliveryRequest = {
            url: new URL('https://receiver.example/slow'),
            targetAddress: '127.0.0.1',
            body: '{}',
            eventId: 9001,
            eventType: 'base.partner.updated',
            signature: '0'.repeat(64),
            idempotencyKey: 'moonwitness:9001',
            signal: new AbortController().signal,
          };
          await expect(
            sendSignedRequest(timeoutRequest, { port, ca, timeoutMs: 200 })
          ).rejects.toThrow('WEBHOOK_TIMEOUT');
        } finally {
          unregister();
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
        await rm(directory, { recursive: true, force: true });
      }
    },
    20_000
  );
});
