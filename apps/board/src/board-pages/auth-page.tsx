'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@moonwitness/client';
import { useAuth } from '@/hooks/use-auth-context';
import { Logo } from '@/components/manga/logo';
import {
  ArrowRightIcon,
  LockIcon,
  MailIcon,
  VisibilityIcon,
  VisibilityOffIcon,
} from '@moonwitness/ui/icons';
import { Button } from '@moonwitness/ui/components/button';
import { Input } from '@moonwitness/ui/components/input';
import { Label } from '@moonwitness/ui/components/label';
import { Panel } from '@moonwitness/ui/components/panel';
import { useSfx } from '@moonwitness/ui/components/audio';
import { LoadingSpinner } from '@moonwitness/ui/components/effects';

type Mode = 'login' | 'register';

function safeReturnPath(value: unknown): string {
  const hasControlCharacter =
    typeof value === 'string' &&
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
  if (
    typeof value !== 'string' ||
    !(value === '/board' || value.startsWith('/board/')) ||
    value.startsWith('//') ||
    value.includes('\\') ||
    hasControlCharacter
  )
    return '/board';
  try {
    const target = new URL(value, 'https://moonwitness.invalid');
    if (
      target.origin !== 'https://moonwitness.invalid' ||
      !(target.pathname === '/board' || target.pathname.startsWith('/board/'))
    )
      return '/board';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return '/board';
  }
}

export function AuthPage({ mode }: { mode: Mode }) {
  const { user, login, register } = useAuth();
  const { play } = useSfx();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const from = safeReturnPath(searchParams?.get('returnTo'));
  const isLogin = mode === 'login';

  useEffect(() => {
    if (user) router.replace(from);
  }, [from, router, user]);
  if (user) return null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim() || undefined;
    setBusy(true);
    setError(null);
    try {
      if (isLogin) {
        await login({ login: value('login')!, password: String(form.get('password')) });
      } else {
        await register({
          login: value('login')!,
          password: String(form.get('password')),
          name: value('name'),
          email: value('email'),
        });
      }
      play('success');
      router.replace(from);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Cannot reach the server. Is the API running?'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shadow" data-auth-mode={mode}>
      <header className="auth-shadow-header">
        <Link href="/" aria-label="MoonWitness home" className="auth-shadow-home">
          <Logo surface="dark" className="auth-shadow-logo" />
        </Link>
        <Button asChild treatment="brush" className="auth-shadow-follow">
          <Link href="/" aria-label="Follow the Signal — return to MoonWitness home">
            Follow the Signal <ArrowRightIcon aria-hidden="true" />
          </Link>
        </Button>
      </header>

      <main className="auth-shadow-main">
        <section className="auth-shadow-form-side" aria-labelledby="auth-title">
          <Panel surface="ink" frame="line" density="comfortable" className="auth-shadow-card">
            <div className="auth-shadow-eyebrow">
              <span className="auth-shadow-eyebrow-mark" aria-hidden="true" />
              MoonWitness access // {isLogin ? 'Sign in' : 'Create account'}
            </div>
            <h1 id="auth-title" className="auth-shadow-title">
              <span>{isLogin ? 'Enter' : 'Join'}</span>
              <span className="auth-shadow-title-line">
                <small>the</small>
                <em>{isLogin ? 'Shadow' : 'Crew'}</em>
              </span>
            </h1>
            <p className="auth-shadow-intro">
              {isLogin
                ? 'Sign in to access your MoonWitness workspace.'
                : 'Create an account to join your MoonWitness workspace.'}
            </p>

            <form id="auth-form" onSubmit={onSubmit} className="auth-shadow-fields">
              {!isLogin && (
                <div className="auth-shadow-field">
                  <Label htmlFor="name">Full name</Label>
                  <Input id="name" name="name" autoComplete="name" maxLength={255} />
                </div>
              )}

              <div className="auth-shadow-field">
                <Label htmlFor="login">Email or Username</Label>
                <div className="auth-shadow-input-wrap">
                  <MailIcon aria-hidden="true" className="auth-shadow-input-icon" />
                  <Input
                    id="login"
                    name="login"
                    autoComplete="username"
                    placeholder="Enter your email or username"
                    required
                    minLength={isLogin ? 1 : 3}
                    maxLength={255}
                    className="auth-shadow-input"
                  />
                </div>
              </div>

              {!isLogin && (
                <div className="auth-shadow-field">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    maxLength={255}
                  />
                </div>
              )}

              <div className="auth-shadow-field">
                <Label htmlFor="password">Password</Label>
                <div className="auth-shadow-input-wrap">
                  <LockIcon aria-hidden="true" className="auth-shadow-input-icon" />
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={isLogin ? 'current-password' : 'new-password'}
                    placeholder="Enter your password"
                    required
                    minLength={isLogin ? 1 : 6}
                    className="auth-shadow-input auth-shadow-password"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="auth-shadow-visibility"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    aria-controls="password"
                    onClick={() => setShowPassword((visible) => !visible)}
                  >
                    {showPassword ? (
                      <VisibilityOffIcon aria-hidden="true" />
                    ) : (
                      <VisibilityIcon aria-hidden="true" />
                    )}
                  </Button>
                </div>
              </div>

              {error ? (
                <p role="alert" className="auth-shadow-error">
                  {error}
                </p>
              ) : null}

              <Button
                id="auth-submit"
                type="submit"
                size="lg"
                treatment="brush"
                className="auth-shadow-submit"
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? <LoadingSpinner /> : null}
                {busy
                  ? isLogin
                    ? 'Entering the shadow…'
                    : 'Creating account…'
                  : isLogin
                    ? 'Enter the Shadow'
                    : 'Create account'}
                {!busy ? <ArrowRightIcon aria-hidden="true" /> : null}
              </Button>
            </form>

            <p className="auth-shadow-switch">
              {isLogin ? 'New to MoonWitness?' : 'Already part of the crew?'}{' '}
              <Button asChild variant="link" className="auth-shadow-switch-link">
                <Link
                  id="auth-switch"
                  href={`${isLogin ? '/register' : '/login'}?returnTo=${encodeURIComponent(from)}`}
                >
                  {isLogin ? 'Create an account' : 'Sign in'}
                </Link>
              </Button>
            </p>
            <p className="auth-shadow-access-note">
              <span aria-hidden="true" />
              Your credentials stay private and secure.
            </p>
          </Panel>
        </section>

        <aside className="auth-shadow-art" aria-label="MoonWitness night city artwork">
          <picture className="auth-shadow-picture">
            <source
              media="(max-width: 899px)"
              srcSet="/illustrations/auth-login-mobile.webp"
              width="1000"
              height="600"
            />
            <img
              src="/illustrations/auth-login-desktop.webp"
              alt="A hooded person looking over a neon city beneath a full moon."
              width="1200"
              height="1200"
              fetchPriority="high"
              decoding="async"
            />
          </picture>
          <div className="auth-shadow-art-shade" aria-hidden="true" />
          <p className="auth-shadow-art-copy">
            Same moon.
            <br />
            Different people.
          </p>
          <span className="auth-shadow-art-caption">Stories beyond borders</span>
        </aside>
      </main>

      <footer className="auth-shadow-footer">
        <span>MoonWitness&nbsp; // &nbsp;Create · Curate · Publish</span>
        <span className="auth-shadow-footer-note">A shared sky for every story.</span>
      </footer>
    </div>
  );
}
