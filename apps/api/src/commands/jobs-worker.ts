import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabase } from '../database/knex.js';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest, registerJobHandler, runWorkerLoop } from '@moonwitness/jobs';
import { readWorkerHealthPort, startWorkerHealthServer } from './worker-health.js';
import {
  manifest as workflowAddon,
  registerWorkflowExpiryHandler,
} from '@moonwitness/orm-workflow';
import { manifest as notificationAddon } from '@moonwitness/orm-notification';
import { createProcessShutdownController } from '../lifecycle/process-shutdown.js';
import { manifest as storageManifest } from '@moonwitness/orm-storage';
import { whatsappManifest } from '../whatsapp/manifest.js';
import { registerWhatsAppAttachmentJob } from './whatsapp-attachments-job.js';

const db = createDatabase();
let workerHealth: Awaited<ReturnType<typeof startWorkerHealthServer>> = null;
const shutdown = createProcessShutdownController(() => {
  workerHealth?.setReady(false);
});

try {
  await installAddons(db, [
    baseManifest,
    jobsManifest,
    notificationAddon,
    workflowAddon,
    storageManifest,
    whatsappManifest,
  ]);
  const unregisterWhatsAppAttachmentJob = registerWhatsAppAttachmentJob(db);
  const handlerModule = process.env.JOB_HANDLERS_MODULE;
  if (handlerModule) await import(pathToFileURL(path.resolve(handlerModule)).href);
  if (!shutdown.signal.aborted) {
    workerHealth = await startWorkerHealthServer({
      db,
      host: process.env.WORKER_HEALTH_HOST || '127.0.0.1',
      name: 'jobs-worker',
      port: readWorkerHealthPort(process.env.JOBS_WORKER_HEALTH_PORT, 'JOBS_WORKER_HEALTH_PORT'),
    });
  }
  const unregisterExample = registerJobHandler({
    name: 'example.noop',
    version: 1,
    parse(payload: unknown): unknown {
      return payload;
    },
    async run() {
      return { completed: true };
    },
  });
  const unregisterWorkflow = registerWorkflowExpiryHandler();
  try {
    await runWorkerLoop({ workerId: `moonwitness-${randomUUID()}` }, shutdown.signal);
  } finally {
    unregisterWorkflow();
    unregisterExample();
    unregisterWhatsAppAttachmentJob();
  }
} finally {
  shutdown.dispose();
  await workerHealth?.close();
  await db.destroy();
}
