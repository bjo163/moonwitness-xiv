import knex from 'knex';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readWorkerHealthPort,
  startWorkerHealthServer,
  type WorkerHealthServer,
} from '../src/commands/worker-health.js';

describe('worker health endpoints', () => {
  let health: WorkerHealthServer | null = null;
  let db: ReturnType<typeof knex> | undefined;

  async function reservePort(): Promise<number> {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Failed to reserve a port');
    const { port } = address;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve()))
    );
    return port;
  }

  afterEach(async () => {
    await health?.close();
    health = null;
    await db?.destroy();
    db = undefined;
  });

  it('disables probes by default and validates configured ports', () => {
    expect(readWorkerHealthPort(undefined, 'JOBS_WORKER_HEALTH_PORT')).toBe(0);
    expect(readWorkerHealthPort('0', 'JOBS_WORKER_HEALTH_PORT')).toBe(0);
    expect(readWorkerHealthPort('9123', 'JOBS_WORKER_HEALTH_PORT')).toBe(9123);
    expect(() => readWorkerHealthPort('-1', 'JOBS_WORKER_HEALTH_PORT')).toThrow(
      'JOBS_WORKER_HEALTH_PORT must be an integer between 0 and 65535'
    );
    expect(() => readWorkerHealthPort('70000', 'JOBS_WORKER_HEALTH_PORT')).toThrow(
      'JOBS_WORKER_HEALTH_PORT must be an integer between 0 and 65535'
    );
  });

  it('keeps worker health probes disabled when the configured port is zero', async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    health = await startWorkerHealthServer({
      db,
      host: '127.0.0.1',
      name: 'test-worker',
      port: 0,
    });
    expect(health).toBeNull();
  });

  it('serves internal liveness and database-backed readiness probes', async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    health = await startWorkerHealthServer({
      db,
      host: '127.0.0.1',
      name: 'test-worker',
      port: await reservePort(),
      metricsToken: 'worker-metrics-token-at-least-32-characters',
    });
    if (!health) throw new Error('A nonzero test port is required to start the probe server');
    const address = health.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Health server is not listening');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const alive = await fetch(`${baseUrl}/livez`);
    expect(alive.status).toBe(200);
    expect(alive.headers.get('cache-control')).toBe('no-store');
    expect(await alive.json()).toMatchObject({ status: 'alive', worker: 'test-worker' });
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(401);
    const metrics = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: 'Bearer worker-metrics-token-at-least-32-characters' },
    });
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(await metrics.text()).toContain('moonwitness_whatsapp_gateway_request_duration');

    health.setReady(false);
    expect((await fetch(`${baseUrl}/livez`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(503);
    health.setReady(true);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);

    await db.destroy();
    db = undefined;
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(503);
  });
});
