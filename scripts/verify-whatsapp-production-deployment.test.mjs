import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PROBE_DEVICE_ID,
  buildReport,
  classifyOrigin,
  evaluateProbe,
  guidanceFor,
  parseArguments,
  renderTextReport,
  verifyDeployment,
} from './verify-whatsapp-production-deployment.mjs';

const probes = {
  livez: { id: 'livez', method: 'GET', path: '/livez', expect: 'alive' },
  readyz: { id: 'readyz', method: 'GET', path: '/readyz', expect: 'models' },
  gateway: {
    id: 'whatsapp-readyz',
    method: 'GET',
    path: '/whatsapp/readyz',
    expect: 'gatewayReadiness',
  },
  protected: {
    id: 'whatsapp-account',
    method: 'GET',
    path: '/whatsapp/account',
    expect: 'protected',
  },
  callback: {
    id: 'gowa-webhook',
    method: 'POST',
    path: `/whatsapp/gowa/webhook/${PROBE_DEVICE_ID}`,
    expect: 'webhookSignature',
  },
};

const response = (status, body, contentType = 'application/json; charset=utf-8') => ({
  status,
  contentType,
  text: typeof body === 'string' ? body : JSON.stringify(body),
});

const authRejected = () => response(401, { success: false, error: 'Authentication required' });
const modelsRegistered = () =>
  response(200, {
    status: 'healthy',
    registeredModels: [
      'base.attachment',
      'whatsapp.account',
      'whatsapp.conversation',
      'whatsapp.message',
    ],
  });

test('a fully routed deployment is reported as ready', async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    const body =
      path === '/livez'
        ? response(200, { status: 'alive' })
        : path === '/readyz'
          ? modelsRegistered()
          : path === '/whatsapp/readyz'
            ? response(200, { status: 'reachable', gateway: 'connected' })
            : path === '/whatsapp/gowa/webhook/moonwitness-deploy-probe'
              ? response(401, { success: false, error: 'Invalid webhook signature' })
              : authRejected();
    return {
      status: body.status,
      headers: { get: () => body.contentType },
      text: async () => body.text,
    };
  };

  const report = await verifyDeployment({
    origin: 'https://api.example',
    timeoutMs: 5000,
    fetchImpl,
  });
  assert.equal(report.status, 'ready');
  assert.equal(report.origin, 'moonwitness-api');
  assert.deepEqual(report.failures, []);
});

test('classifies a different service on the domain instead of blaming the WhatsApp build', () => {
  // Observed on the shared domain in October 2026: a Hono worker answering "Hello Hono!" at root
  // with its own health payloads. Those 404s must not be reported as missing WhatsApp routes.
  const results = [
    {
      ...probes.livez,
      ...evaluateProbe(probes.livez, response(404, '404 Not Found', 'text/plain')),
    },
    {
      ...probes.protected,
      ...evaluateProbe(probes.protected, response(404, '{"error":{"code":"unauthorized"}}')),
    },
    {
      ...probes.callback,
      ...evaluateProbe(probes.callback, response(404, '404 Not Found', 'text/plain')),
    },
  ];
  assert.equal(classifyOrigin(results), 'unknown-origin');
  const report = buildReport('https://api.example', results);
  assert.equal(report.status, 'wrong-origin');
  assert.match(guidanceFor(report).join('\n'), /is not this application/u);
});

test('a Moonwitness API without the WhatsApp prefix is reported as not-ready with the missing paths', () => {
  const results = [
    { ...probes.livez, ...evaluateProbe(probes.livez, response(200, { status: 'alive' })) },
    { ...probes.readyz, ...evaluateProbe(probes.readyz, modelsRegistered()) },
    {
      ...probes.protected,
      ...evaluateProbe(probes.protected, response(404, 'Route GET:/whatsapp/account not found')),
    },
    {
      ...probes.callback,
      ...evaluateProbe(
        probes.callback,
        response(404, 'Route POST:/whatsapp/gowa/webhook/x not found')
      ),
    },
  ];
  const report = buildReport('https://api.example', results);
  assert.equal(report.origin, 'moonwitness-api');
  assert.equal(report.status, 'not-ready');
  assert.match(guidanceFor(report).join('\n'), /Paths that returned 404: \/whatsapp/u);
});

test('an image without the WhatsApp models asks for a rebuild instead of proxy changes', () => {
  const result = evaluateProbe(
    probes.readyz,
    response(200, { status: 'healthy', registeredModels: ['base.attachment'] })
  );
  assert.equal(result.result, 'fail');
  assert.equal(result.reason, 'whatsapp-build-missing');
  assert.match(result.detail, /whatsapp\.account/u);
});

test('gateway unreachable still proves routing and never blocks the callback conclusion', () => {
  const result = evaluateProbe(
    probes.gateway,
    response(503, { status: 'unreachable', gateway: 'disconnected' })
  );
  assert.equal(result.result, 'pass');
  assert.equal(result.reason, 'gateway-unreachable');
  assert.match(
    guidanceFor(buildReport('https://api.example', [result])).join('\n'),
    /WHATSAPP_GATEWAY_URL/u
  );
});

test('an endpoint that answers anonymously fails the check instead of passing', () => {
  const result = evaluateProbe(
    probes.protected,
    response(200, { success: true, data: { status: 'connected' } })
  );
  assert.equal(result.result, 'fail');
  assert.equal(result.reason, 'unauthenticated-data');
  assert.match(
    guidanceFor(buildReport('https://api.example', [result])).join('\n'),
    /security incident/u
  );
});

test('a proxy that blocks POST to the callback is reported separately', () => {
  const result = evaluateProbe(
    probes.callback,
    response(405, { success: false, error: 'Method Not Allowed' })
  );
  assert.equal(result.reason, 'callback-method-blocked');
  assert.match(
    guidanceFor(buildReport('https://api.example', [result])).join('\n'),
    /rejected POST/u
  );
});

test('transport failures never echo an upstream body or credential material', () => {
  const fetchImpl = async () => {
    throw new Error('https://user:hunter2@api.example leaked');
  };
  return verifyDeployment({ origin: 'https://api.example', timeoutMs: 50, fetchImpl }).then(
    (report) => {
      const rendered = renderTextReport(report);
      assert.equal(report.status, 'not-ready');
      assert.equal(rendered.includes('hunter2'), false);
      assert.equal(rendered.includes('api.example leaked'), false);
      assert.match(rendered, /request failed/u);
    }
  );
});

test('rejects a base URL that carries credentials, a path, or plain http to a remote host', () => {
  assert.throws(
    () => parseArguments(['--base-url', 'https://user:pass@api.example']),
    /credentials/u
  );
  assert.throws(
    () => parseArguments(['--base-url', 'https://api.example/whatsapp']),
    /without a path/u
  );
  assert.throws(() => parseArguments(['--base-url', 'http://api.example']), /must use https/u);
  assert.equal(
    parseArguments(['--base-url', 'http://127.0.0.1:3000']).origin,
    'http://127.0.0.1:3000'
  );
  assert.equal(parseArguments(['--base-url', 'https://api.example', '--json']).json, true);
  assert.throws(
    () => parseArguments(['--base-url', 'https://api.example', '--nope']),
    /Unknown argument/u
  );
});

test('every probed prefix is also proxied by the Board rewrite list', async () => {
  const config = await readFile(
    fileURLToPath(new URL('../apps/board/next.config.ts', import.meta.url)),
    'utf8'
  );
  for (const entry of [
    "'/api/:path*'",
    "'/auth/:path*'",
    "'/livez'",
    "'/readyz'",
    "'/whatsapp/:path*'",
  ]) {
    assert.ok(config.includes(entry), `Board rewrite list must keep ${entry}`);
  }
});
