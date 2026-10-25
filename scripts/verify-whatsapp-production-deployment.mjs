import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 10_000;
const BODY_SNIPPET_LIMIT = 160;
// A device id that can never match a stored account. The webhook route rejects the missing
// HMAC signature before it touches the database, so this probe proves routing only.
export const PROBE_DEVICE_ID = 'moonwitness-deploy-probe';
export const REQUIRED_WHATSAPP_MODELS = [
  'whatsapp.account',
  'whatsapp.conversation',
  'whatsapp.message',
];

const PROBES = [
  { id: 'livez', method: 'GET', path: '/livez', expect: 'alive' },
  { id: 'readyz', method: 'GET', path: '/readyz', expect: 'models' },
  { id: 'whatsapp-readyz', method: 'GET', path: '/whatsapp/readyz', expect: 'gatewayReadiness' },
  { id: 'whatsapp-account', method: 'GET', path: '/whatsapp/account', expect: 'protected' },
  {
    id: 'whatsapp-conversations',
    method: 'GET',
    path: '/whatsapp/conversations',
    expect: 'protected',
  },
  { id: 'auth-me', method: 'GET', path: '/auth/me', expect: 'protected' },
  { id: 'api-models', method: 'GET', path: '/api/models', expect: 'protected' },
  {
    id: 'gowa-webhook',
    method: 'POST',
    path: `/whatsapp/gowa/webhook/${PROBE_DEVICE_ID}`,
    expect: 'webhookSignature',
  },
];

export function parseArguments(argv) {
  const options = { baseUrl: '', timeoutMs: DEFAULT_TIMEOUT_MS, json: false, allowHttp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--allow-http') {
      options.allowHttp = true;
      continue;
    }
    if (argument === '--base-url' || argument === '--timeout-ms') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.startsWith('--'))
        throw new Error(`${argument} needs a value`);
      index += 1;
      if (argument === '--base-url') options.baseUrl = value;
      else options.timeoutMs = Number(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.baseUrl.length === 0) throw new Error('--base-url is required');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number of milliseconds');
  }
  return { ...options, ...validateOrigin(options.baseUrl, options.allowHttp) };
}

function validateOrigin(rawValue, allowHttp) {
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error('--base-url must be a full http or https origin');
  }
  if (url.username || url.password) throw new Error('--base-url must not contain credentials');
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--base-url must be an origin without a path, query, or fragment');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || allowHttp))) {
    throw new Error(
      '--base-url must use https (http is only accepted for a loopback origin or with --allow-http)'
    );
  }
  return { origin: url.origin };
}

/** Reduce a fetch Response to the plain data the evaluation rules need. */
export async function requestProbe(origin, probe, fetchImpl, timeoutMs) {
  const target = new URL(probe.path, origin);
  const init = {
    method: probe.method,
    headers: { accept: 'application/json' },
    redirect: 'manual',
    signal: globalThis.AbortSignal.timeout(timeoutMs),
  };
  if (probe.method === 'POST') {
    init.headers['content-type'] = 'application/json';
    init.body = '{}';
  }
  const response = await fetchImpl(target.toString(), init);
  const text = await response.text().catch(() => '');
  return {
    probeId: probe.id,
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    text,
  };
}

function parseJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function snippet(text) {
  // Upstream bodies are untrusted and may echo tokens, so diagnostics stay printable and short.
  return text
    .replace(/[^\x20-\x7e]/gu, ' ')
    .replace(/ {2,}/gu, ' ')
    .trim()
    .slice(0, BODY_SNIPPET_LIMIT);
}

function moonwitnessEnvelope(body) {
  return Boolean(body) && body.success === false && typeof body.error === 'string';
}

/**
 * Turn one collected probe response into a pass/fail verdict. Pure so the routing rules are
 * testable without a live deployment.
 */
export function evaluateProbe(probe, response) {
  const body = parseJson(response.text);
  const base = { probeId: probe.id, method: probe.method, path: probe.path };

  if (response.status === 404) {
    return {
      ...base,
      result: 'fail',
      reason: 'route-missing',
      detail: `HTTP 404; body: ${response.contentType || 'unknown'} ${snippet(response.text)}`,
    };
  }

  switch (probe.expect) {
    case 'alive':
      return response.status === 200 && body?.status === 'alive'
        ? { ...base, result: 'pass', reason: 'api-answers', detail: 'HTTP 200 status=alive' }
        : { ...base, result: 'fail', reason: 'unexpected', detail: `HTTP ${response.status}` };
    case 'models': {
      if (response.status !== 200 && response.status !== 503) {
        return { ...base, result: 'fail', reason: 'unexpected', detail: `HTTP ${response.status}` };
      }
      const models = Array.isArray(body?.registeredModels) ? body.registeredModels : null;
      if (!models) {
        return {
          ...base,
          result: 'fail',
          reason: 'unexpected',
          detail: `HTTP ${response.status} without a registeredModels list`,
        };
      }
      const missing = REQUIRED_WHATSAPP_MODELS.filter((name) => !models.includes(name));
      return missing.length === 0
        ? {
            ...base,
            result: 'pass',
            reason: 'whatsapp-models-registered',
            detail: `HTTP ${response.status}, ${models.length} models registered`,
          }
        : {
            ...base,
            result: 'fail',
            reason: 'whatsapp-build-missing',
            detail: `HTTP ${response.status} without ${missing.join(', ')}`,
          };
    }
    case 'gatewayReadiness': {
      if (response.status === 200 && body?.status === 'reachable') {
        return {
          ...base,
          result: 'pass',
          reason: 'gateway-reachable',
          detail: 'HTTP 200 reachable',
        };
      }
      if (response.status === 503 && body?.status === 'unreachable') {
        return {
          ...base,
          result: 'pass',
          reason: 'gateway-unreachable',
          detail: 'HTTP 503 unreachable; routing is correct, the gateway check failed',
        };
      }
      return { ...base, result: 'fail', reason: 'unexpected', detail: `HTTP ${response.status}` };
    }
    case 'protected': {
      if (response.status === 401 && moonwitnessEnvelope(body)) {
        return {
          ...base,
          result: 'pass',
          reason: 'auth-guarded',
          detail: 'HTTP 401 rejected anonymously',
        };
      }
      if (response.status === 200 || (response.status >= 200 && response.status < 300)) {
        return {
          ...base,
          result: 'fail',
          reason: 'unauthenticated-data',
          detail: `HTTP ${response.status} returned data without credentials`,
        };
      }
      if (response.status >= 500) {
        return {
          ...base,
          result: 'fail',
          reason: 'server-error',
          detail: `HTTP ${response.status}`,
        };
      }
      return {
        ...base,
        result: 'fail',
        reason: 'foreign-envelope',
        detail: `HTTP ${response.status}; body: ${response.contentType || 'unknown'} ${snippet(response.text)}`,
      };
    }
    case 'webhookSignature': {
      if (response.status === 401 && moonwitnessEnvelope(body)) {
        return {
          ...base,
          result: 'pass',
          reason: 'callback-reachable',
          detail: 'HTTP 401 on a missing HMAC signature; GoWA can reach the callback route',
        };
      }
      return {
        ...base,
        result: 'fail',
        reason: response.status === 405 ? 'callback-method-blocked' : 'unexpected',
        detail: `HTTP ${response.status}; expected 401 invalid-signature`,
      };
    }
    default:
      return { ...base, result: 'fail', reason: 'unexpected', detail: `HTTP ${response.status}` };
  }
}

/**
 * A 404 on `/livez` together with responses that are not this API's envelope means the origin is a
 * different service, not a Moonwitness API that is missing WhatsApp routes. Report that separately
 * so the operator fixes the deployment target instead of the application.
 */
export function classifyOrigin(results) {
  const livez = results.find((entry) => entry.probeId === 'livez');
  const envelopes = results.filter(
    (entry) => entry.reason === 'auth-guarded' || entry.result === 'pass'
  );
  if (livez?.result === 'pass' || envelopes.length >= 2) return 'moonwitness-api';
  const foreign = results.filter(
    (entry) => entry.reason === 'route-missing' || entry.reason === 'foreign-envelope'
  );
  return foreign.length > 0 ? 'unknown-origin' : 'unreachable';
}

export function buildReport(baseUrl, results) {
  const origin = classifyOrigin(results);
  const blocking = results.filter((entry) => entry.result === 'fail');
  const status =
    blocking.length === 0 ? 'ready' : origin === 'unknown-origin' ? 'wrong-origin' : 'not-ready';
  return {
    baseUrl,
    origin,
    status,
    checks: results,
    failures: blocking.map((entry) => entry.probeId),
  };
}

export function guidanceFor(report) {
  const notes = [];
  const reasonPresent = (reason) => report.checks.some((entry) => entry.reason === reason);

  if (report.origin === 'unknown-origin') {
    return [
      `No probe answered with the Moonwitness API envelope, so ${report.baseUrl} is not this ` +
        'application. Point the deployment, or the proxy in front of it, at the built API before ' +
        'changing any WhatsApp configuration.',
      'Do not enable the GoWA callback until this command reports ready.',
    ];
  }
  if (report.origin === 'unreachable') {
    notes.push(
      `${report.baseUrl} did not answer any probe. Check the container is running, the published port, and TLS.`
    );
  }
  const prefixes = [
    ...new Set(
      report.checks
        .filter((entry) => entry.reason === 'route-missing')
        .map((entry) => `/${entry.path.split('/')[1] || ''}`)
    ),
  ];
  if (prefixes.length > 0) {
    notes.push(
      `Paths that returned 404: ${prefixes.join(', ')}. Route every API prefix in the Board rewrite list ` +
        'through the public proxy: /api, /auth, /jsonrpc, /health, /livez, /readyz, /metrics, /notifications, /workflows, /whatsapp.'
    );
  }
  if (reasonPresent('whatsapp-build-missing')) {
    notes.push(
      'The running image does not register the WhatsApp models; deploy a build from this workspace.'
    );
  }
  if (reasonPresent('gateway-unreachable')) {
    notes.push(
      'WhatsApp routing is proven, but WHATSAPP_GATEWAY_URL is unreachable or its reported version does not match WHATSAPP_GATEWAY_EXPECTED_VERSION.'
    );
  }
  if (reasonPresent('unauthenticated-data')) {
    notes.push(
      'An endpoint answered without credentials. Treat this as a security incident and stop the rollout.'
    );
  }
  if (reasonPresent('callback-method-blocked')) {
    notes.push(
      'The callback route rejected POST at the proxy; GoWA cannot deliver events to this origin.'
    );
  }
  if (reasonPresent('transport-error')) {
    notes.push('At least one probe failed at the transport layer, so the result is inconclusive.');
  }
  if (report.status === 'ready' && notes.length === 0) {
    return [
      'The published API exposes the WhatsApp routes and the callback endpoint. WHATSAPP_WEBHOOK_URL ' +
        'may point at this origin; the callback is pushed to GoWA on the next account connect.',
    ];
  }
  notes.push('Do not enable the GoWA callback until this command reports ready.');
  return notes;
}

export function renderTextReport(report) {
  const lines = [`Deployment verification for ${report.baseUrl}`, ''];
  for (const check of report.checks) {
    lines.push(
      `${check.result === 'pass' ? 'PASS' : 'FAIL'} ${check.method} ${check.path} — ${check.detail}`
    );
  }
  lines.push('', `Origin classification: ${report.origin}`, `Status: ${report.status}`);
  for (const note of guidanceFor(report)) lines.push(`- ${note}`);
  return `${lines.join('\n')}\n`;
}

export async function verifyDeployment({ origin, timeoutMs, fetchImpl = globalThis.fetch }) {
  const results = [];
  for (const probe of PROBES) {
    try {
      results.push(evaluateProbe(probe, await requestProbe(origin, probe, fetchImpl, timeoutMs)));
    } catch (error) {
      results.push({
        probeId: probe.id,
        method: probe.method,
        path: probe.path,
        result: 'fail',
        reason: 'transport-error',
        detail: error?.name === 'TimeoutError' ? 'request timed out' : 'request failed',
      });
    }
  }
  return buildReport(origin, results);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await verifyDeployment({
    origin: options.origin,
    timeoutMs: options.timeoutMs,
  });
  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : renderTextReport(report)
  );
  if (report.status !== 'ready') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Verification failed'}\n`);
    process.exitCode = 1;
  });
}
