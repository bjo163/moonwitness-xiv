import { describe, expect, it } from 'vitest';
import '../src/config/env.js';
import { gowaRequest } from '../src/whatsapp/gowa-client.js';
import { expectedWhatsAppGatewayVersion } from '../src/whatsapp/version-guard.js';

const enabled = process.env.GOWA_CONTRACT_TEST === '1';
const contractDeviceId = process.env.WHATSAPP_CONTRACT_DEVICE_ID;

describe.skipIf(!enabled)('live GoWA contract', () => {
  it('reports the configured expected version through GET /app/info', async () => {
    const expectedVersion = expectedWhatsAppGatewayVersion();

    const info = await gowaRequest<{ version?: string }>('/app/info');
    expect(info.version).toBe(expectedVersion);
  }, 15_000);

  it('answers the public health probe', async () => {
    await expect(gowaRequest<string>('/health')).resolves.toBe('OK');
  }, 15_000);

  it.skipIf(!contractDeviceId)(
    'returns the linked account JID from device-scoped GET /app/status',
    async () => {
      const status = await gowaRequest<{
        is_connected?: boolean;
        is_logged_in?: boolean;
        jid?: string;
      }>('/app/status', { deviceId: contractDeviceId });
      expect(status.is_connected).toBe(true);
      expect(status.is_logged_in).toBe(true);
      if (!status.jid || !/^\d+@s\.whatsapp\.net$/u.test(status.jid)) {
        throw new Error('GoWA device-scoped app status did not provide the linked phone JID');
      }
    },
    15_000
  );
});
