import { MoonWitnessClient } from '@moonwitness/client';

/**
 * Single SDK instance. Next rewrites keep browser requests on this app's origin.
 */
export const client = new MoonWitnessClient({
  baseUrl:
    process.env.NEXT_PUBLIC_API_URL ??
    (typeof window === 'undefined' ? 'http://localhost' : window.location.origin),
  storageKey: 'mw-board-session',
});
