import type { Knex } from 'knex';

export interface HttpMetric {
  count: number;
  seconds: number;
}

type WhatsAppMetricRow = {
  status?: string;
  event_type?: string;
  total?: string | number;
  oldest?: string | null;
};

const httpMetrics = new Map<string, HttpMetric>();
const gatewayMetrics = new Map<string, HttpMetric>();
const pollMetrics = new Map<string, HttpMetric>();
const mediaMetrics = new Map<string, { transfers: number; bytes: number }>();
let gatewayRequestsInFlight = 0;

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

export function recordHttpRequest(method: string, route: string, status: number, seconds: number) {
  const key = [method, route, String(status)].join('\u0000');
  const current = httpMetrics.get(key) ?? { count: 0, seconds: 0 };
  current.count += 1;
  current.seconds += seconds;
  httpMetrics.set(key, current);
}

function addDurationSample(target: Map<string, HttpMetric>, key: string, seconds: number) {
  const current = target.get(key) ?? { count: 0, seconds: 0 };
  current.count += 1;
  current.seconds += Math.max(0, seconds);
  target.set(key, current);
}

export function startWhatsAppGatewayRequest(): () => void {
  gatewayRequestsInFlight += 1;
  return () => {
    gatewayRequestsInFlight = Math.max(0, gatewayRequestsInFlight - 1);
  };
}

export function recordWhatsAppGatewayRequest(
  method: string,
  route: string,
  outcome: string,
  seconds: number
) {
  const safeMethod = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())
    ? method.toUpperCase()
    : 'OTHER';
  const path = route.split(/[?#]/u, 1)[0] || '/';
  const parts = path.split('/').filter(Boolean);
  const normalizedRoute =
    parts[0] === 'devices' &&
    parts.length >= 3 &&
    ['status', 'login', 'logout', 'webhook'].includes(parts[2] ?? '')
      ? `/devices/${parts[2]}`
      : parts[0] === 'chat' && ['archive', 'pin'].includes(parts.at(-1) ?? '')
        ? `/chat/${parts.at(-1)}`
        : parts[0] === 'message' &&
            ['download', 'read', 'forward', 'reaction', 'edit', 'revoke'].includes(
              parts.at(-1) ?? ''
            )
          ? `/message/${parts.at(-1)}`
          : path;
  const safeRoute = [
    '/health',
    '/app/info',
    '/devices',
    '/devices/status',
    '/devices/login',
    '/devices/logout',
    '/devices/webhook',
    '/chats',
    '/chat/archive',
    '/chat/pin',
    '/message/download',
    '/message/read',
    '/message/forward',
    '/message/reaction',
    '/message/edit',
    '/message/revoke',
    '/group/info',
    '/group/participants',
    '/user/info',
    '/user/avatar',
    '/user/check',
    '/send/text',
    '/send/image',
    '/send/video',
    '/send/audio',
    '/send/file',
    '/send/status',
  ].includes(normalizedRoute)
    ? normalizedRoute
    : '/other';
  const safeOutcome = /^2[0-9]{2}$/u.test(outcome)
    ? '2xx'
    : /^4[0-9]{2}$/u.test(outcome)
      ? '4xx'
      : /^5[0-9]{2}$/u.test(outcome)
        ? '5xx'
        : ['timeout', 'circuit_open', 'busy', 'network_error'].includes(outcome)
          ? outcome
          : 'other';
  addDurationSample(gatewayMetrics, [safeMethod, safeRoute, safeOutcome].join('\u0000'), seconds);
}

export function recordWhatsAppPoll(route: string, seconds: number) {
  const safeRoute = [
    '/whatsapp/account',
    '/whatsapp/conversations',
    '/whatsapp/conversations/:id/messages',
  ].includes(route)
    ? route
    : '/other';
  addDurationSample(pollMetrics, safeRoute, seconds);
}

export function recordWhatsAppMediaTransfer(direction: 'inbound' | 'outbound', bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return;
  const current = mediaMetrics.get(direction) ?? { transfers: 0, bytes: 0 };
  current.transfers += 1;
  current.bytes += bytes;
  mediaMetrics.set(direction, current);
}

function appendDurationMetrics(
  lines: string[],
  prefix: string,
  metrics: Map<string, HttpMetric>,
  labels: (key: string) => string
) {
  lines.push(
    `# HELP ${prefix}_seconds_sum Total observed duration in seconds.`,
    `# TYPE ${prefix}_seconds_sum counter`
  );
  for (const [key, metric] of metrics)
    lines.push(`${prefix}_seconds_sum{${labels(key)}} ${metric.seconds}`);
  lines.push(
    `# HELP ${prefix}_seconds_count Number of duration observations.`,
    `# TYPE ${prefix}_seconds_count counter`
  );
  for (const [key, metric] of metrics)
    lines.push(`${prefix}_seconds_count{${labels(key)}} ${metric.count}`);
}

export async function readWhatsAppDatabaseMetrics(db: Knex): Promise<string[]> {
  try {
    const eventTypes = ['whatsapp.message.send', 'whatsapp.status.publish'];
    const [accountRows, queueRows, retryRows, oldestRows] = (await Promise.all([
      db('whatsapp_accounts').select('status').count({ total: 'id' }).groupBy('status'),
      db('outbox_events')
        .whereIn('event_type', eventTypes)
        .select('event_type', 'status')
        .count({ total: 'id' })
        .groupBy('event_type', 'status'),
      db('outbox_events')
        .whereIn('event_type', eventTypes)
        .where('attempts', '>', 1)
        .select('event_type')
        .count({ total: 'id' })
        .groupBy('event_type'),
      db('outbox_events')
        .whereIn('event_type', eventTypes)
        .whereIn('status', ['pending', 'processing'])
        .select('event_type')
        .min({ oldest: 'created_at' })
        .groupBy('event_type'),
    ])) as unknown as [
      WhatsAppMetricRow[],
      WhatsAppMetricRow[],
      WhatsAppMetricRow[],
      WhatsAppMetricRow[],
    ];
    const lines = [
      '# HELP moonwitness_whatsapp_database_metrics_available Whether WhatsApp database metrics were read.',
      '# TYPE moonwitness_whatsapp_database_metrics_available gauge',
      'moonwitness_whatsapp_database_metrics_available 1',
      '# HELP moonwitness_whatsapp_accounts Number of WhatsApp accounts by connection state.',
      '# TYPE moonwitness_whatsapp_accounts gauge',
    ];
    const accountStates = [
      'disconnected',
      'connecting',
      'qr',
      'qr_expired',
      'connected',
      'reconnecting',
      'error',
    ];
    for (const state of accountStates) {
      const row = accountRows.find((item) => item.status === state);
      lines.push(`moonwitness_whatsapp_accounts{status="${state}"} ${Number(row?.total ?? 0)}`);
    }
    lines.push(
      '# HELP moonwitness_whatsapp_outbox_events WhatsApp outbox events by type and state.',
      '# TYPE moonwitness_whatsapp_outbox_events gauge'
    );
    for (const kind of ['message', 'status']) {
      const eventType = kind === 'message' ? 'whatsapp.message.send' : 'whatsapp.status.publish';
      for (const state of ['pending', 'processing', 'published', 'dead']) {
        const row = queueRows.find(
          (item) => item.event_type === eventType && item.status === state
        );
        lines.push(
          `moonwitness_whatsapp_outbox_events{kind="${kind}",status="${state}"} ${Number(row?.total ?? 0)}`
        );
      }
      const retries = retryRows.find((item) => item.event_type === eventType);
      lines.push(
        `moonwitness_whatsapp_outbox_retried_events{kind="${kind}"} ${Number(retries?.total ?? 0)}`
      );
      const oldest = oldestRows.find((item) => item.event_type === eventType)?.oldest;
      const ageSeconds = oldest
        ? Math.max(0, (Date.now() - new Date(String(oldest)).getTime()) / 1000)
        : 0;
      lines.push(
        `moonwitness_whatsapp_outbox_oldest_active_seconds{kind="${kind}"} ${Number.isFinite(ageSeconds) ? ageSeconds : 0}`
      );
    }
    return lines;
  } catch {
    return [
      '# HELP moonwitness_whatsapp_database_metrics_available Whether database metrics were read.',
      '# TYPE moonwitness_whatsapp_database_metrics_available gauge',
      'moonwitness_whatsapp_database_metrics_available 0',
    ];
  }
}

export function renderMetrics(
  uptimeSeconds: number,
  whatsappDatabaseMetrics: string[] = []
): string {
  const lines = [
    '# HELP moonwitness_http_requests_total Completed HTTP requests.',
    '# TYPE moonwitness_http_requests_total counter',
  ];
  for (const [key, metric] of httpMetrics) {
    const [method, route, status] = key.split('\u0000');
    const labels = `method="${escapeLabel(method ?? '')}",route="${escapeLabel(route ?? '')}",status="${escapeLabel(status ?? '')}"`;
    lines.push(`moonwitness_http_requests_total{${labels}} ${metric.count}`);
  }
  lines.push(
    '# HELP moonwitness_http_request_duration_seconds_sum Total HTTP request duration.',
    '# TYPE moonwitness_http_request_duration_seconds_sum counter'
  );
  for (const [key, metric] of httpMetrics) {
    const [method, route, status] = key.split('\u0000');
    const labels = `method="${escapeLabel(method ?? '')}",route="${escapeLabel(route ?? '')}",status="${escapeLabel(status ?? '')}"`;
    lines.push(`moonwitness_http_request_duration_seconds_sum{${labels}} ${metric.seconds}`);
  }
  lines.push(
    '# HELP moonwitness_http_request_duration_seconds_count Completed request duration observations.',
    '# TYPE moonwitness_http_request_duration_seconds_count counter'
  );
  for (const [key, metric] of httpMetrics) {
    const [method, route, status] = key.split('\u0000');
    const labels = `method="${escapeLabel(method ?? '')}",route="${escapeLabel(route ?? '')}",status="${escapeLabel(status ?? '')}"`;
    lines.push(`moonwitness_http_request_duration_seconds_count{${labels}} ${metric.count}`);
  }
  lines.push(
    '# HELP moonwitness_process_uptime_seconds Process uptime.',
    '# TYPE moonwitness_process_uptime_seconds gauge',
    `moonwitness_process_uptime_seconds ${uptimeSeconds}`
  );
  appendDurationMetrics(
    lines,
    'moonwitness_whatsapp_gateway_request_duration',
    gatewayMetrics,
    (key) => {
      const [method, route, outcome] = key.split('\u0000');
      return `method="${method}",route="${escapeLabel(route ?? '/other')}",outcome="${outcome}"`;
    }
  );
  lines.push(
    '# HELP moonwitness_whatsapp_gateway_requests_in_flight Current GoWA REST requests.',
    '# TYPE moonwitness_whatsapp_gateway_requests_in_flight gauge',
    `moonwitness_whatsapp_gateway_requests_in_flight ${gatewayRequestsInFlight}`,
    '# HELP moonwitness_whatsapp_webhook_configured Whether GoWA inbound callbacks have both URL and HMAC secret configured.',
    '# TYPE moonwitness_whatsapp_webhook_configured gauge',
    `moonwitness_whatsapp_webhook_configured ${process.env.WHATSAPP_WEBHOOK_URL && process.env.WHATSAPP_WEBHOOK_SECRET ? 1 : 0}`
  );
  appendDurationMetrics(
    lines,
    'moonwitness_whatsapp_poll_duration',
    pollMetrics,
    (route) => `route="${escapeLabel(route)}"`
  );
  lines.push(
    '# HELP moonwitness_whatsapp_media_transfers_total Number of media files accepted or cached by the API.',
    '# TYPE moonwitness_whatsapp_media_transfers_total counter',
    '# HELP moonwitness_whatsapp_media_bytes_total Total bytes in WhatsApp media transfers.',
    '# TYPE moonwitness_whatsapp_media_bytes_total counter'
  );
  for (const direction of ['inbound', 'outbound']) {
    const metric = mediaMetrics.get(direction) ?? { transfers: 0, bytes: 0 };
    lines.push(
      `moonwitness_whatsapp_media_transfers_total{direction="${direction}"} ${metric.transfers}`
    );
    lines.push(`moonwitness_whatsapp_media_bytes_total{direction="${direction}"} ${metric.bytes}`);
  }
  lines.push(...whatsappDatabaseMetrics);
  return `${lines.join('\n')}\n`;
}
