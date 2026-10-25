import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knex from 'knex';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import {
  recordWhatsAppGatewayRequest,
  recordWhatsAppMediaTransfer,
  recordWhatsAppPoll,
} from '../src/observability/metrics.js';

describe('health and metrics endpoints', () => {
  let app: FastifyInstance;
  let whatsappGatewayReady = true;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    app = await buildApp({
      db,
      superadminPassword: 'observability-test-password',
      jwtSecret: 'test-secret-test-secret-test-secret-123',
      metricsToken: 'metrics-secret-token-at-least-32-chars',
      checkWhatsAppGateway: async () => whatsappGatewayReady,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('separates liveness from database readiness', async () => {
    const liveness = await app.inject({
      url: '/livez',
      headers: { 'x-request-id': 'trace:board-123' },
    });
    expect(liveness.statusCode).toBe(200);
    expect(liveness.headers['x-request-id']).toBe('trace:board-123');
    expect((await app.inject('/readyz')).json()).toMatchObject({
      status: 'healthy',
      database: 'connected',
    });
    expect((await app.inject('/health')).statusCode).toBe(200);
    const invalidRequestId = await app.inject({
      url: '/livez',
      headers: { 'x-request-id': 'x'.repeat(120) },
    });
    expect(invalidRequestId.headers['x-request-id']).not.toBe('x'.repeat(120));
    expect(invalidRequestId.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(invalidRequestId.headers['cache-control']).toBe('no-store');
  });

  it('keeps liveness available while reporting a failed readiness dependency', async () => {
    const testConnection = app.testConnection;
    app.testConnection = async () => false;
    try {
      expect((await app.inject('/livez')).statusCode).toBe(200);
      expect((await app.inject('/readyz')).statusCode).toBe(503);
      expect((await app.inject('/readyz')).json()).toMatchObject({
        status: 'unhealthy',
        database: 'disconnected',
      });
    } finally {
      app.testConnection = testConnection;
    }
  });

  it('reports GoWA reachability independently from API readiness', async () => {
    const reachable = await app.inject('/whatsapp/readyz');
    expect(reachable.statusCode).toBe(200);
    expect(reachable.json()).toMatchObject({ status: 'reachable', gateway: 'connected' });

    whatsappGatewayReady = false;
    try {
      const unavailable = await app.inject('/whatsapp/readyz');
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({ status: 'unreachable', gateway: 'disconnected' });
      expect((await app.inject('/readyz')).statusCode).toBe(200);
    } finally {
      whatsappGatewayReady = true;
    }
  });

  it('reports webhook availability separately in readiness and Prometheus metrics', async () => {
    const previousUrl = process.env.WHATSAPP_WEBHOOK_URL;
    const previousSecret = process.env.WHATSAPP_WEBHOOK_SECRET;
    process.env.WHATSAPP_WEBHOOK_URL = 'https://api.example.test';
    process.env.WHATSAPP_WEBHOOK_SECRET = 'test-webhook-secret-that-is-long-enough';
    try {
      const ready = await app.inject('/whatsapp/readyz');
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({ status: 'reachable', webhook_configured: true });

      const metrics = await app.inject({
        url: '/metrics',
        headers: { authorization: 'Bearer metrics-secret-token-at-least-32-chars' },
      });
      expect(metrics.body).toContain('moonwitness_whatsapp_webhook_configured 1');

      delete process.env.WHATSAPP_WEBHOOK_SECRET;
      const incomplete = await app.inject('/whatsapp/readyz');
      expect(incomplete.json()).toMatchObject({ status: 'reachable', webhook_configured: false });
    } finally {
      if (previousUrl === undefined) delete process.env.WHATSAPP_WEBHOOK_URL;
      else process.env.WHATSAPP_WEBHOOK_URL = previousUrl;
      if (previousSecret === undefined) delete process.env.WHATSAPP_WEBHOOK_SECRET;
      else process.env.WHATSAPP_WEBHOOK_SECRET = previousSecret;
    }
  });

  it('protects Prometheus metrics and records route status and duration', async () => {
    expect((await app.inject('/metrics')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/metrics',
          headers: { authorization: 'Bearer wrong-token' },
        })
      ).statusCode
    ).toBe(401);

    await app.inject('/api/models');
    await app.db('outbox_events').insert({
      event_type: 'whatsapp.message.send',
      aggregate_model: 'whatsapp.message',
      aggregate_id: 1,
      payload: '{}',
      status: 'pending',
      attempts: 2,
      max_attempts: 4,
      available_at: new Date().toISOString(),
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const metrics = await app.inject({
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-secret-token-at-least-32-chars' },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toContain('moonwitness_http_requests_total');
    expect(metrics.body).toContain('route="/api/models"');
    expect(metrics.body).toContain('moonwitness_http_request_duration_seconds_sum');
    expect(metrics.body).toContain('moonwitness_process_uptime_seconds');
    expect(metrics.body).toContain('moonwitness_whatsapp_accounts{status="connected"} 0');
    expect(metrics.body).toContain(
      'moonwitness_whatsapp_outbox_events{kind="message",status="pending"} 1'
    );
    expect(metrics.body).toContain('moonwitness_whatsapp_outbox_retried_events{kind="message"} 1');
    const queueAge = Number(
      metrics.body.match(
        /moonwitness_whatsapp_outbox_oldest_active_seconds\{kind="message"\} ([0-9.]+)/u
      )?.[1]
    );
    expect(queueAge).toBeGreaterThanOrEqual(60);
    expect(metrics.body).toContain('moonwitness_whatsapp_database_metrics_available');
  });

  it('exports low-cardinality GoWA, inbox polling, and media metrics without private identifiers', async () => {
    recordWhatsAppGatewayRequest(
      'GET',
      '/message/private-number-123/download?phone=private-number-123',
      '200',
      0.25
    );
    recordWhatsAppPoll('/whatsapp/conversations', 0.5);
    recordWhatsAppMediaTransfer('inbound', 42);

    const metrics = await app.inject({
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-secret-token-at-least-32-chars' },
    });
    expect(metrics.body).toContain(
      'moonwitness_whatsapp_gateway_request_duration_seconds_count{method="GET",route="/message/download",outcome="2xx"} 1'
    );
    expect(metrics.body).toContain('moonwitness_whatsapp_poll_duration_seconds_count');
    expect(metrics.body).toContain('route="/whatsapp/conversations"');
    expect(metrics.body).toContain(
      'moonwitness_whatsapp_media_bytes_total{direction="inbound"} 42'
    );
    expect(metrics.body).not.toContain('private-number-123');
  });
});
