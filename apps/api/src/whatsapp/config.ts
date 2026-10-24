export interface WhatsAppGatewayConfig {
  url: string;
  username: string;
  password: string;
  timeoutMs: number;
}

const DEV_USERNAME = 'moonwitness';
const DEV_PASSWORD = 'moonwitness';

function parseTimeout(value: string | undefined): number {
  if (!value) return 20_000;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 500 || timeout > 120_000) {
    throw new Error('WHATSAPP_GATEWAY_TIMEOUT_MS must be an integer between 500 and 120000');
  }
  return timeout;
}

export function readWhatsAppGatewayConfig(
  env: NodeJS.ProcessEnv = process.env
): WhatsAppGatewayConfig {
  const production = env.NODE_ENV === 'production';
  const username = env.WHATSAPP_GATEWAY_USERNAME || (production ? '' : DEV_USERNAME);
  const password = env.WHATSAPP_GATEWAY_PASSWORD || (production ? '' : DEV_PASSWORD);

  if (
    production &&
    (!username || !password || username === DEV_USERNAME || password === DEV_PASSWORD)
  ) {
    throw new Error(
      'Production requires non-default WHATSAPP_GATEWAY_USERNAME and WHATSAPP_GATEWAY_PASSWORD'
    );
  }

  const rawUrl = env.WHATSAPP_GATEWAY_URL || 'https://wa.moonwitness.biz.id';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('WHATSAPP_GATEWAY_URL must be a valid http or https URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('WHATSAPP_GATEWAY_URL must be a valid http or https URL');
  }
  if (url.username || url.password) {
    throw new Error('WHATSAPP_GATEWAY_URL must not contain embedded credentials');
  }

  return {
    url: url.toString().replace(/\/$/u, ''),
    username,
    password,
    timeoutMs: parseTimeout(env.WHATSAPP_GATEWAY_TIMEOUT_MS),
  };
}

export function validateWhatsAppProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production') readWhatsAppGatewayConfig(env);
  const webhookUrl = env.WHATSAPP_WEBHOOK_URL;
  const webhookSecret = env.WHATSAPP_WEBHOOK_SECRET;
  if (Boolean(webhookUrl) !== Boolean(webhookSecret)) {
    throw new Error('WHATSAPP_WEBHOOK_URL and WHATSAPP_WEBHOOK_SECRET must be configured together');
  }
  if (!webhookUrl || !webhookSecret) return;
  if (webhookSecret.length < 32) {
    throw new Error('WHATSAPP_WEBHOOK_SECRET must contain at least 32 characters');
  }
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new Error('WHATSAPP_WEBHOOK_URL must be a valid public http or https origin');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (env.NODE_ENV === 'production' && url.protocol !== 'https:')
  ) {
    throw new Error('WHATSAPP_WEBHOOK_URL must be an origin; production requires https');
  }
}
