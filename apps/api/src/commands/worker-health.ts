import Fastify, { type FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { timingSafeEqual } from 'node:crypto';
import { testConnection } from '../database/knex.js';
import { readWhatsAppDatabaseMetrics, renderMetrics } from '../observability/metrics.js';

export interface WorkerHealthOptions {
  db: Knex;
  host: string;
  name: string;
  port: number;
  metricsToken?: string;
}

export interface WorkerHealthServer {
  app: FastifyInstance;
  setReady(ready: boolean): void;
  close(): Promise<void>;
}

export function readWorkerHealthPort(value: string | undefined, name: string): number {
  if (value === undefined || value === '') return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be an integer between 0 and 65535; 0 disables worker probes`);
  }
  return port;
}

export async function startWorkerHealthServer(
  options: WorkerHealthOptions
): Promise<WorkerHealthServer | null> {
  if (options.port === 0) return null;
  const app = Fastify({ logger: false });
  let ready = true;
  let closing: Promise<void> | undefined;
  app.get('/livez', async (_request, reply) =>
    reply.header('Cache-Control', 'no-store').send({ status: 'alive', worker: options.name })
  );
  app.get('/readyz', async (_request, reply) => {
    const healthy = ready && (await testConnection(options.db));
    return reply
      .header('Cache-Control', 'no-store')
      .status(healthy ? 200 : 503)
      .send({ status: healthy ? 'ready' : 'not-ready', worker: options.name });
  });
  app.get('/metrics', async (request, reply) => {
    const token = options.metricsToken;
    if (!token) return reply.code(404).send({ success: false, error: 'Not found' });
    const authorization = request.headers.authorization ?? '';
    const supplied = authorization.startsWith('Bearer ')
      ? Buffer.from(authorization.slice(7))
      : Buffer.alloc(0);
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return reply.code(401).header('WWW-Authenticate', 'Bearer').send({
        success: false,
        error: 'Authentication required',
      });
    return reply
      .header('Cache-Control', 'no-store')
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(renderMetrics(process.uptime(), await readWhatsAppDatabaseMetrics(options.db)));
  });
  try {
    await app.listen({ host: options.host, port: options.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  return {
    app,
    setReady(nextReady) {
      ready = nextReady;
    },
    close() {
      ready = false;
      closing ??= app.close();
      return closing;
    },
  };
}
