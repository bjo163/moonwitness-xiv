import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabase } from '../database/knex.js';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest, runOutboxLoop } from '@moonwitness/jobs';
import {
  manifest as notificationAddon,
  registerNotificationOutboxConsumer,
} from '@moonwitness/orm-notification';
import { manifest as workflowAddon } from '@moonwitness/orm-workflow';
import { readWorkerHealthPort, startWorkerHealthServer } from './worker-health.js';
import {
  manifest as integrationAddon,
  registerWebhookOutboxConsumer,
} from '@moonwitness/orm-integration';
import { manifest as requestAddon } from '@moonwitness/orm-request';
import { createProcessShutdownController } from '../lifecycle/process-shutdown.js';
import { whatsappManifest } from '../whatsapp/manifest.js';
import { registerWhatsAppOutboxConsumer } from '../whatsapp/outbox-consumer.js';
import { createAttachmentStorage } from '../storage/attachment-storage.js';
import { closeS3AttachmentStorage, S3AttachmentStorage } from '@moonwitness/orm-storage';
import { validateWhatsAppProductionConfig } from '../whatsapp/config.js';

validateWhatsAppProductionConfig(process.env);
const db = createDatabase();
let workerHealth: Awaited<ReturnType<typeof startWorkerHealthServer>> = null;
let unregisterNotificationConsumer = () => {};
let unregisterWebhookConsumer = () => {};
let unregisterWhatsAppConsumer = () => {};
const attachmentStorage = createAttachmentStorage();
const shutdown = createProcessShutdownController(() => {
  workerHealth?.setReady(false);
});

try {
  await installAddons(db, [
    baseManifest,
    jobsManifest,
    notificationAddon,
    integrationAddon,
    workflowAddon,
    requestAddon,
    whatsappManifest,
  ]);
  unregisterNotificationConsumer = registerNotificationOutboxConsumer();
  unregisterWebhookConsumer = registerWebhookOutboxConsumer(async (secretRef, companyId) => {
    if (!secretRef.startsWith(`MW_WEBHOOK_SECRET_C${companyId}_`)) return null;
    if (!/^MW_WEBHOOK_SECRET_C[1-9][0-9]*_[A-Z0-9_]{1,100}$/u.test(secretRef)) return null;
    return process.env[secretRef] ?? null;
  });
  unregisterWhatsAppConsumer = registerWhatsAppOutboxConsumer(attachmentStorage);
  const consumerModule = process.env.OUTBOX_HANDLERS_MODULE;
  if (consumerModule) await import(pathToFileURL(path.resolve(consumerModule)).href);
  if (!shutdown.signal.aborted) {
    workerHealth = await startWorkerHealthServer({
      db,
      host: process.env.WORKER_HEALTH_HOST || '127.0.0.1',
      name: 'outbox-worker',
      metricsToken: process.env.METRICS_TOKEN,
      port: readWorkerHealthPort(
        process.env.OUTBOX_WORKER_HEALTH_PORT,
        'OUTBOX_WORKER_HEALTH_PORT'
      ),
    });
  }
  await runOutboxLoop(`moonwitness-outbox-${randomUUID()}`, shutdown.signal);
} finally {
  shutdown.dispose();
  unregisterNotificationConsumer();
  unregisterWebhookConsumer();
  unregisterWhatsAppConsumer();
  await workerHealth?.close();
  if (attachmentStorage instanceof S3AttachmentStorage)
    await closeS3AttachmentStorage(attachmentStorage);
  await db.destroy();
}
