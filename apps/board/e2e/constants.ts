export const E2E_JWT_SECRET = 'e2e-only-jwt-secret-that-is-never-used-outside-tests';

// The protected-route guard preserves the requested page as a safe returnTo,
// including when a session ends, so login URLs can carry that query string.
export const loginPageUrl = /\/login(?:\?returnTo=[^#]*)?$/u;
import { randomUUID } from 'node:crypto';

export const E2E_SUPERADMIN_PASSWORD =
  process.env.MW_E2E_SUPERADMIN_PASSWORD ?? 'e2e-only-password';

export function createE2eSuffix(): string {
  return randomUUID();
}
