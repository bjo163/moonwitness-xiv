import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WHATSAPP_GATEWAY_EXPECTED_VERSION,
  checkWhatsAppGatewayVersion,
  expectedWhatsAppGatewayVersion,
  isWhatsAppGatewayVersionCompatible,
} from '../src/whatsapp/version-guard.js';

describe('WhatsApp gateway version guard', () => {
  it('defaults to the GoWA version verified by the live contract', () => {
    expect(expectedWhatsAppGatewayVersion({})).toBe('v9.6.0');
    expect(DEFAULT_WHATSAPP_GATEWAY_EXPECTED_VERSION).toBe('v9.6.0');
    expect(isWhatsAppGatewayVersionCompatible('v9.6.0', 'v9.6.0')).toBe(true);
  });

  it('allows an explicit expected version and rejects unknown or different versions', () => {
    expect(expectedWhatsAppGatewayVersion({ WHATSAPP_GATEWAY_EXPECTED_VERSION: 'v9.7.1' })).toBe(
      'v9.7.1'
    );
    expect(isWhatsAppGatewayVersionCompatible('v9.7.1', 'v9.7.1')).toBe(true);
    expect(isWhatsAppGatewayVersionCompatible('v9.7.0', 'v9.7.1')).toBe(false);
    expect(isWhatsAppGatewayVersionCompatible(undefined, 'v9.7.1')).toBe(false);
  });

  it('requires health and the exact expected GoWA version for readiness', async () => {
    const requests: string[] = [];
    const request = async (path: string) => {
      requests.push(path);
      return path === '/app/info' ? { version: 'v9.6.0' } : 'OK';
    };

    await expect(checkWhatsAppGatewayVersion(request, 'v9.6.0')).resolves.toBe(true);
    expect(requests).toEqual(['/health', '/app/info']);
    await expect(
      checkWhatsAppGatewayVersion(async () => ({ version: 'v9.7.0' }), 'v9.6.0')
    ).resolves.toBe(false);
    await expect(
      checkWhatsAppGatewayVersion(async (path) => {
        if (path === '/health') throw new Error('gateway unavailable');
        return { version: 'v9.6.0' };
      }, 'v9.6.0')
    ).rejects.toThrow('gateway unavailable');
  });
});
