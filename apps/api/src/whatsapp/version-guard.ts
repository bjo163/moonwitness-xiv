import { gowaRequest } from './gowa-client.js';

export const DEFAULT_WHATSAPP_GATEWAY_EXPECTED_VERSION = 'v9.6.0';

export function expectedWhatsAppGatewayVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.WHATSAPP_GATEWAY_EXPECTED_VERSION || DEFAULT_WHATSAPP_GATEWAY_EXPECTED_VERSION;
}

export function isWhatsAppGatewayVersionCompatible(
  actualVersion: unknown,
  expectedVersion = expectedWhatsAppGatewayVersion()
): boolean {
  return typeof actualVersion === 'string' && actualVersion === expectedVersion;
}

export async function checkWhatsAppGatewayVersion(
  request: (path: string, options: { timeoutMs: number }) => Promise<unknown> = gowaRequest,
  expectedVersion = expectedWhatsAppGatewayVersion()
): Promise<boolean> {
  await request('/health', { timeoutMs: 5_000 });
  const info = (await request('/app/info', { timeoutMs: 5_000 })) as { version?: unknown } | null;
  return isWhatsAppGatewayVersionCompatible(info?.version, expectedVersion);
}
