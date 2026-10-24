import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readWhatsAppGatewayConfig,
  validateWhatsAppProductionConfig,
} from '../src/whatsapp/config.js';
import { GowaError, gowaRequest } from '../src/whatsapp/gowa-client.js';
import { renderMetrics } from '../src/observability/metrics.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WhatsApp gateway configuration', () => {
  it('uses the hosted GoWA development default and a bounded default timeout', () => {
    const config = readWhatsAppGatewayConfig({ NODE_ENV: 'development' });

    expect(config).toEqual({
      url: 'https://wa.moonwitness.biz.id',
      username: 'moonwitness',
      password: 'moonwitness',
      timeoutMs: 20_000,
    });
  });

  it('requires unique gateway credentials in production', () => {
    expect(() => readWhatsAppGatewayConfig({ NODE_ENV: 'production' })).toThrow(
      'Production requires non-default WHATSAPP_GATEWAY_USERNAME and WHATSAPP_GATEWAY_PASSWORD'
    );
    expect(() =>
      readWhatsAppGatewayConfig({
        NODE_ENV: 'production',
        WHATSAPP_GATEWAY_USERNAME: 'tenant',
        WHATSAPP_GATEWAY_PASSWORD: 'moonwitness',
      })
    ).toThrow('Production requires non-default');
    expect(
      readWhatsAppGatewayConfig({
        NODE_ENV: 'production',
        WHATSAPP_GATEWAY_USERNAME: 'tenant',
        WHATSAPP_GATEWAY_PASSWORD: 'random-secret',
      }).username
    ).toBe('tenant');
  });

  it('rejects embedded URL credentials and invalid timeout values', () => {
    expect(() =>
      readWhatsAppGatewayConfig({
        WHATSAPP_GATEWAY_URL: 'http://user:pass@127.0.0.1:3001',
      })
    ).toThrow('must not contain embedded credentials');
    expect(() => readWhatsAppGatewayConfig({ WHATSAPP_GATEWAY_TIMEOUT_MS: '100' })).toThrow(
      'WHATSAPP_GATEWAY_TIMEOUT_MS'
    );
  });

  it('requires a valid HTTPS origin and strong paired secret for production receipts', () => {
    const base = {
      NODE_ENV: 'production',
      WHATSAPP_GATEWAY_USERNAME: 'tenant',
      WHATSAPP_GATEWAY_PASSWORD: 'unique-gateway-password',
    };
    expect(() =>
      validateWhatsAppProductionConfig({
        ...base,
        WHATSAPP_WEBHOOK_URL: 'https://api.example.test',
      })
    ).toThrow('configured together');
    expect(() =>
      validateWhatsAppProductionConfig({
        ...base,
        WHATSAPP_WEBHOOK_URL: 'http://api.example.test',
        WHATSAPP_WEBHOOK_SECRET: 'a'.repeat(40),
      })
    ).toThrow('production requires https');
    expect(() =>
      validateWhatsAppProductionConfig({
        ...base,
        WHATSAPP_WEBHOOK_URL: 'https://api.example.test',
        WHATSAPP_WEBHOOK_SECRET: 'short',
      })
    ).toThrow('at least 32 characters');
    expect(() =>
      validateWhatsAppProductionConfig({
        ...base,
        WHATSAPP_WEBHOOK_URL: 'https://api.example.test',
        WHATSAPP_WEBHOOK_SECRET: 'a'.repeat(40),
      })
    ).not.toThrow();
  });

  it('does not expose upstream error text in API errors', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('WHATSAPP_GATEWAY_URL', 'http://gowa.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 'ERROR',
              message: 'Authorization Basic c2VjcmV0 leaked-private-number body',
            }),
            { status: 503 }
          )
      )
    );

    const error = await gowaRequest('/health').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GowaError);
    expect(error).toMatchObject({ statusCode: 503 });
    expect((error as Error).message).toBe('WhatsApp gateway request failed (503)');
    expect((error as Error).message).not.toContain('Authorization');
  });

  it('preserves successful plain-text GoWA responses such as /health', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('WHATSAPP_GATEWAY_URL', 'http://gowa.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('OK', { status: 200 }))
    );

    await expect(gowaRequest<string>('/health')).resolves.toBe('OK');
    const metrics = renderMetrics(1);
    expect(metrics).toContain('route="/health",outcome="2xx"');
    expect(metrics).toContain('moonwitness_whatsapp_gateway_requests_in_flight 0');
  });

  it('opens the gateway circuit after repeated failures and allows one recovery probe', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('WHATSAPP_GATEWAY_URL', 'http://breaker.test');
    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(gowaRequest('/health')).rejects.toMatchObject({ statusCode: 503 });
    }
    await expect(gowaRequest('/health')).rejects.toMatchObject({ upstreamCode: 'CIRCUIT_OPEN' });
    expect(fetchMock).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(10_000);
    fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));
    await expect(gowaRequest('/health')).resolves.toBe('OK');
    expect(fetchMock).toHaveBeenCalledTimes(6);
    vi.useRealTimers();
  });

  it('caps concurrent requests to the gateway', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('WHATSAPP_GATEWAY_URL', 'http://concurrency.test');
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);

    const requests = Array.from({ length: 8 }, () => gowaRequest('/health'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
    await expect(gowaRequest('/health')).rejects.toMatchObject({ upstreamCode: 'GATEWAY_BUSY' });
    for (const resolve of pending) resolve(new Response('OK', { status: 200 }));
    await expect(Promise.all(requests)).resolves.toHaveLength(8);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });
});
