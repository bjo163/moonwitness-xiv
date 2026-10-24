import Link from 'next/link';
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <section className="ink-panel max-w-xl p-10 text-center">
        <p className="font-mono text-sm uppercase text-pink">404 · Signal lost</p>
        <h1 className="ink-title mt-3 text-5xl">Page not found</h1>
        <p className="my-4 text-ink-soft">This address does not match a MoonWitness page.</p>
        <Link className="underline" href="/">
          Return home
        </Link>
      </section>
    </main>
  );
}
