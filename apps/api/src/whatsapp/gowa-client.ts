import { readWhatsAppGatewayConfig } from './config.js';
import {
  recordWhatsAppGatewayRequest,
  startWhatsAppGatewayRequest,
} from '../observability/metrics.js';

type GowaEnvelope<T> = { code?: string; message?: string; results?: T; status?: number };

export class GowaError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly upstreamCode?: string
  ) {
    super(message);
  }
}

const MAX_CONCURRENT_GATEWAY_REQUESTS = 8;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 10_000;

interface GatewayProtectionState {
  activeRequests: number;
  consecutiveFailures: number;
  openUntil: number | null;
  probeInFlight: boolean;
}

const gatewayProtection = new Map<string, GatewayProtectionState>();

function protectionState(url: string): GatewayProtectionState {
  const key = new URL(url).origin;
  let state = gatewayProtection.get(key);
  if (!state) {
    state = {
      activeRequests: 0,
      consecutiveFailures: 0,
      openUntil: null,
      probeInFlight: false,
    };
    gatewayProtection.set(key, state);
  }
  return state;
}

async function protectedFetch(url: string, init: RequestInit): Promise<Response> {
  const state = protectionState(url);
  const now = Date.now();
  let halfOpenProbe = false;
  if (state.openUntil !== null) {
    if (now < state.openUntil || state.probeInFlight) {
      throw new GowaError('WhatsApp gateway circuit is open', 503, 'CIRCUIT_OPEN');
    }
    state.probeInFlight = true;
    halfOpenProbe = true;
  }
  if (state.activeRequests >= MAX_CONCURRENT_GATEWAY_REQUESTS) {
    if (halfOpenProbe) state.probeInFlight = false;
    throw new GowaError('WhatsApp gateway is at its concurrency limit', 503, 'GATEWAY_BUSY');
  }
  state.activeRequests++;
  try {
    const response = await fetch(url, init);
    if (response.status >= 500) {
      state.consecutiveFailures++;
      if (halfOpenProbe || state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
        state.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      }
    } else {
      state.consecutiveFailures = 0;
      state.openUntil = null;
    }
    return response;
  } catch (error) {
    state.consecutiveFailures++;
    if (halfOpenProbe || state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      state.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    }
    throw error;
  } finally {
    state.activeRequests--;
    if (halfOpenProbe) state.probeInFlight = false;
  }
}

async function measuredFetch(url: string, init: RequestInit): Promise<Response> {
  const finish = startWhatsAppGatewayRequest();
  const startedAt = performance.now();
  try {
    const response = await protectedFetch(url, init);
    recordWhatsAppGatewayRequest(
      init.method ?? 'GET',
      new URL(url).pathname,
      String(response.status),
      (performance.now() - startedAt) / 1000
    );
    return response;
  } catch (error) {
    const outcome =
      error instanceof GowaError && error.upstreamCode === 'CIRCUIT_OPEN'
        ? 'circuit_open'
        : error instanceof GowaError && error.upstreamCode === 'GATEWAY_BUSY'
          ? 'busy'
          : error instanceof Error && error.name === 'TimeoutError'
            ? 'timeout'
            : 'network_error';
    recordWhatsAppGatewayRequest(
      init.method ?? 'GET',
      new URL(url).pathname,
      outcome,
      (performance.now() - startedAt) / 1000
    );
    throw error;
  } finally {
    finish();
  }
}

export async function gowaRequest<T>(
  path: string,
  options: {
    method?: string;
    deviceId?: string;
    body?: string | FormData;
    contentType?: string;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const config = readWhatsAppGatewayConfig();
  const headers = new Headers({
    authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`,
  });
  if (options.deviceId) headers.set('X-Device-Id', options.deviceId);
  if (options.contentType) headers.set('content-type', options.contentType);
  const response = await measuredFetch(`${config.url}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? config.timeoutMs),
  });
  const raw = await response.text();
  let envelope: GowaEnvelope<T> | null = null;
  try {
    envelope = raw ? (JSON.parse(raw) as GowaEnvelope<T>) : null;
  } catch {
    // Some GOWA endpoints return plain text for successful downloads.
  }
  if (!response.ok || (envelope?.code && envelope.code !== 'SUCCESS')) {
    throw new GowaError(
      `WhatsApp gateway request failed (${response.status})`,
      response.status,
      envelope?.code
    );
  }
  return (envelope?.results ?? envelope ?? raw) as T;
}

export async function gowaBinary(path: string, deviceId?: string): Promise<Response> {
  const config = readWhatsAppGatewayConfig();
  const headers = new Headers({
    authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`,
  });
  if (deviceId) headers.set('X-Device-Id', deviceId);
  const response = await measuredFetch(`${config.url}${path}`, {
    headers,
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok)
    throw new GowaError(`WhatsApp gateway request failed (${response.status})`, response.status);
  return response;
}

export function gowaOriginPath(value: string): string {
  const requested = new URL(value, readWhatsAppGatewayConfig().url);
  if (
    !['http:', 'https:'].includes(requested.protocol) ||
    !requested.pathname.startsWith('/statics/')
  )
    throw new GowaError('WhatsApp gateway returned an invalid media URL', 502);
  return `${requested.pathname}${requested.search}`;
}
