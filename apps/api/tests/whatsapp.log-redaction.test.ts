import { describe, expect, it } from 'vitest';
import { GowaError } from '../src/whatsapp/gowa-client.js';
import { whatsappLogErrorContext } from '../src/whatsapp/log-redaction.js';

describe('WhatsApp log redaction', () => {
  it('keeps gateway status while excluding upstream message content', () => {
    const error = new GowaError(
      'Authorization: Basic private-credential 628123456789',
      503,
      'ERROR'
    );
    const context = whatsappLogErrorContext(error);

    expect(context).toEqual({ error_name: 'GowaError', status_code: 503, upstream_code: 'ERROR' });
    expect(JSON.stringify(context)).not.toMatch(/private-credential|628123456789|Authorization/u);
  });

  it('drops arbitrary error messages and unsafe upstream codes', () => {
    const error = new GowaError('private message and phone 628123456789', 502, 'token=secret');
    const context = whatsappLogErrorContext(error);

    expect(context).toEqual({ error_name: 'GowaError', status_code: 502 });
    expect(JSON.stringify(context)).not.toMatch(/private message|628123456789|secret/u);
  });
});
