import { GowaError } from './gowa-client.js';

export function whatsappLogErrorContext(error: unknown): Record<string, string | number> {
  if (error instanceof GowaError) {
    const context: Record<string, string | number> = {
      error_name: 'GowaError',
      status_code: error.statusCode,
    };
    if (error.upstreamCode && /^[A-Za-z0-9_-]{1,40}$/u.test(error.upstreamCode)) {
      context.upstream_code = error.upstreamCode;
    }
    return context;
  }

  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(error.name)
      ? error.name
      : 'Error';
  return { error_name: name };
}
