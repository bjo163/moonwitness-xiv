'use client';
import { Button } from '@moonwitness/ui/components/button';
import { useEffect } from 'react';
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <section className="ink-panel max-w-xl p-10 text-center" role="alert">
        <p className="font-mono text-sm uppercase text-pink">Something interrupted this signal</p>
        <h1 className="ink-title mt-3 text-5xl">Page unavailable</h1>
        <p className="my-4 text-ink-soft">Your work is still here. Try loading this page again.</p>
        <Button className="mw-button" onClick={reset}>
          Try again
        </Button>
      </section>
    </main>
  );
}
