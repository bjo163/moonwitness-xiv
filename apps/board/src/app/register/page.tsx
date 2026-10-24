import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthPage } from '../../board-pages/auth-page';
import { BoardProviders } from '../../providers';

// Next.js route metadata must be exported from the route file alongside its component.
// oxlint-disable-next-line react/only-export-components
export const metadata: Metadata = {
  title: 'Create account',
  robots: { index: false, follow: false },
};
export default function RegisterPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh" />}>
      <BoardProviders>
        <AuthPage mode="register" />
      </BoardProviders>
    </Suspense>
  );
}
