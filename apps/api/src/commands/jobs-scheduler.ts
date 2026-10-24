import { createDatabase } from '../database/knex.js';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest, runSchedulerLoop } from '@moonwitness/jobs';
import { readWorkerHealthPort, startWorkerHealthServer } from './worker-health.js';
import { manifest as workflowAddon } from '@moonwitness/orm-workflow';
import { manifest as notificationAddon } from '@moonwitness/orm-notification';
import { createProcessShutdownController } from '../lifecycle/process-shutdown.js';
import { manifest as storageManifest } from '@moonwitness/orm-storage';
import { whatsappManifest } from '../whatsapp/manifest.js';
import {
  ensureWhatsAppAttachmentCron,
  registerWhatsAppAttachmentJob,
} from './whatsapp-attachments-job.js';

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
  await ensureWhatsAppAttachmentCron(db);
  const unregisterWhatsAppAttachmentJob = registerWhatsAppAttachmentJob(db);
  if (!shutdown.signal.aborted) {
    workerHealth = await startWorkerHealthServer({
      db,
      host: process.env.WORKER_HEALTH_HOST || '127.0.0.1',
      name: 'jobs-scheduler',
      port: readWorkerHealthPort(
        process.env.JOBS_SCHEDULER_HEALTH_PORT,
        'JOBS_SCHEDULER_HEALTH_PORT'
      ),
    });
  }
  try {
    await runSchedulerLoop(shutdown.signal);
  } finally {
    unregisterWhatsAppAttachmentJob();
  }
} finally {
  shutdown.dispose();
  await workerHealth?.close();
  await db.destroy();
}
