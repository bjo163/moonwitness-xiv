import { describe, expect, it } from 'vitest';
import '../src/config/env.js';
import { gowaRequest } from '../src/whatsapp/gowa-client.js';
import { expectedWhatsAppGatewayVersion } from '../src/whatsapp/version-guard.js';

const enabled = process.env.GOWA_CONTRACT_TEST === '1';

describe.skipIf(!enabled)('live GoWA contract', () => {
  it('reports the configured expected version through GET /app/info', async () => {
    const expectedVersion = expectedWhatsAppGatewayVersion();

    const info = await gowaRequest<{ version?: string }>('/app/info');
    expect(info.version).toBe(expectedVersion);
  }, 15_000);

  it('answers the public health probe', async () => {
    await expect(gowaRequest<string>('/health')).resolves.toBe('OK');
  }, 15_000);
});
