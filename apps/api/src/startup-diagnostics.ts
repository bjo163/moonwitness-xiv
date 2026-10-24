import { databaseErrorContext } from './database/errors.js';

type StartupErrorContext = Record<string, string>;

function safeName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const { name } = error;
    if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(name)) return name;
  }
  return 'Error';
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'`]+/giu, '[redacted-url]')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(
      /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\b\s*[:=]\s*[^\s,;]+/giu,
      '$1=[redacted]'
    )
    .replace(/\b(authorization\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .slice(0, 300);
}

export function startupErrorContext(error: unknown): StartupErrorContext {
  const context = databaseErrorContext(error);
  if (Object.keys(context).length > 0) return { name: safeName(error), ...context };
  const message =
    error instanceof Error ? redactSensitiveText(error.message) : 'Unknown startup error';
  return { name: safeName(error), message };
}

export function formatStartupFailure(error: unknown): string {
  return JSON.stringify({ event: 'api_startup_failure', context: startupErrorContext(error) });
}
