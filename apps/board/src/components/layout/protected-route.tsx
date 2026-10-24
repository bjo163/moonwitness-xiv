'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { useAuth } from '@/hooks/use-auth-context';

const subscribeToNothing = () => () => {};
const getClientMountedSnapshot = () => true;
const getServerMountedSnapshot = () => false;

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const mounted = useSyncExternalStore(
    subscribeToNothing,
    getClientMountedSnapshot,
    getServerMountedSnapshot
  );
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const safePathname = pathname ?? '/board';
  const query = search?.toString();
  const from = `${safePathname}${query ? `?${query}` : ''}`;
  useEffect(() => {
    if (mounted && !user) router.replace(`/login?returnTo=${encodeURIComponent(from)}`);
  }, [from, mounted, router, user]);
  if (!mounted || !user) {
    return (
      <main className="min-h-dvh p-8" aria-busy="true">
        <div className="mw-skeleton h-12 w-48" />
      </main>
    );
  }
  return <AppShell>{children}</AppShell>;
}
