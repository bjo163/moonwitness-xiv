import type { Role } from '@moonwitness/client';

export function canReadResearch(role: Role | null | undefined, companyId?: number): boolean {
  return (
    role === 'system' ||
    ((role === 'superadmin' || role === 'user') &&
      Number.isSafeInteger(companyId) &&
      (companyId ?? 0) > 0)
  );
}
