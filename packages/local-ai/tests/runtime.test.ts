import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalAiRuntime, readLocalAiConfig, type LocalAiConfig } from '../src/index.js';

const servers: Server[] = [];

async function localEndpoint(
  handler: (body: string) => { status: number; body: string }
): Promise<URL> {
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      const result = handler(body);
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(result.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('test server did not bind TCP');
  return new URL(`http://127.0.0.1:${address.port}`);
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe('local AI runtime contract', () => {
  it('defaults to disabled and makes no provider request', async () => {
    let called = false;
    const config = readLocalAiConfig({});
    const runtime = createLocalAiRuntime(config, async () => {
      called = true;
      return new Response('{}');
    });
    expect(config).toEqual({ mode: 'disabled', timeoutMs: 15_000 });
    expect(await runtime.generate({ prompt: 'synthetic prompt' })).toEqual({ status: 'disabled' });
    expect(called).toBe(false);
  });

  it.each(['https://example.com', 'http://192.168.1.5:11434', 'http://127.0.0.1.evil.test'])(
    'rejects non-loopback or non-HTTP endpoint %s',
    (endpoint) => {
      expect(() => readLocalAiConfig({ AI_MODE: 'local', LOCAL_AI_ENDPOINT: endpoint })).toThrow(
        /LOCAL_AI_ENDPOINT/
      );
    }
  );

  it('uses the local protocol and returns typed generated output', async () => {
    const endpoint = await localEndpoint((body) => {
      expect(JSON.parse(body)).toEqual({ prompt: 'synthetic prompt' });
      return { status: 200, body: JSON.stringify({ text: 'synthetic response' }) };
    });
    const config = readLocalAiConfig({ AI_MODE: 'local', LOCAL_AI_ENDPOINT: endpoint.href });
    expect(await createLocalAiRuntime(config).generate({ prompt: 'synthetic prompt' })).toEqual({
      status: 'generated',
      text: 'synthetic response',
    });
  });

  it('fails closed on invalid provider response or HTTP errors', async () => {
    const invalidResponse: LocalAiConfig = {
      mode: 'local',
      endpoint: await localEndpoint(() => ({ status: 200, body: JSON.stringify({ text: 42 }) })),
      timeoutMs: 1000,
    };
    expect(await createLocalAiRuntime(invalidResponse).generate({ prompt: 'x' })).toEqual({
      status: 'unavailable',
      reason: 'invalid_response',
    });
    const failedResponse: LocalAiConfig = {
      mode: 'local',
      endpoint: await localEndpoint(() => ({ status: 503, body: '{}' })),
      timeoutMs: 1000,
    };
    expect(await createLocalAiRuntime(failedResponse).generate({ prompt: 'x' })).toEqual({
      status: 'unavailable',
      reason: 'provider_unreachable',
    });
  });

  it('maps a provider timeout into an unavailable result', async () => {
    const runtime = createLocalAiRuntime(
      {
        mode: 'local',
        endpoint: new URL('http://127.0.0.1:11434'),
        timeoutMs: 1000,
      },
      async () => {
        const timeout = new Error('request timed out');
        timeout.name = 'TimeoutError';
        throw timeout;
      }
    );
    expect(await runtime.generate({ prompt: 'synthetic prompt' })).toEqual({
      status: 'unavailable',
      reason: 'timeout',
    });
  });

  it('rejects oversized prompts and does not follow redirects', async () => {
    const endpoint = await localEndpoint(() => ({ status: 302, body: '{}' }));
    const runtime = createLocalAiRuntime({ mode: 'local', endpoint, timeoutMs: 1000 });
    await expect(runtime.generate({ prompt: ' ' })).rejects.toThrow(/prompt/);
    await expect(runtime.generate({ prompt: 'x'.repeat(20_001) })).rejects.toThrow(/prompt/);
    expect(await runtime.generate({ prompt: 'valid' })).toEqual({
      status: 'unavailable',
      reason: 'provider_unreachable',
    });
  });
});
