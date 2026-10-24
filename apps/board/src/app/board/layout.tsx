import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { ProtectedRoute } from '../../components/layout/protected-route';
import { BoardProviders } from '../../providers';

// Next.js route metadata must be exported from the route file alongside its component.
// oxlint-disable-next-line react/only-export-components
export const metadata: Metadata = { title: 'Board', robots: { index: false, follow: false } };
export default function BoardLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<main className="min-h-dvh p-8" aria-busy="true" />}>
      <BoardProviders>
        <ProtectedRoute>{children}</ProtectedRoute>
      </BoardProviders>
    </Suspense>
  );
}
