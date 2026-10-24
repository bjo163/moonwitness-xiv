'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, MoonIcon, SettingsIcon, SunIcon } from '@moonwitness/ui/icons';
import { toast } from '@moonwitness/ui/components/toast';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { NotificationPreferences } from '@/components/settings/notification-preferences';
import { Button } from '@moonwitness/ui/components/button';
import { Label } from '@moonwitness/ui/components/label';
import { Input } from '@moonwitness/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@moonwitness/ui/components/select';
import { Skeleton } from '@moonwitness/ui/components/skeleton';
import { useAuth } from '@/hooks/use-auth-context';
import { client } from '@/lib/client';
import {
  DEFAULT_PREFERENCES,
  readPreferences,
  savePreferences,
  type BoardPreferences,
} from '@/lib/preferences';

interface LanguageOption {
  id: number;
  code: string;
  name: string;
}

const TIMEZONES = [
  'UTC',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
];

export function SettingsPage() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [storedPreferences] = useState<BoardPreferences>(readPreferences);
  const [preferenceDraft, setPreferenceDraft] = useState<Partial<BoardPreferences>>({});
  const [saved, setSaved] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const queryClient = useQueryClient();
  const { data: userPreferences, isLoading: userLoading } = useQuery({
    queryKey: ['settings', 'user', user?.id],
    queryFn: () => client.getMe(),
    enabled: Boolean(user),
  });
  const { data: languages = [], isLoading: languagesLoading } = useQuery({
    queryKey: ['settings', 'languages'],
    queryFn: async () => {
      const result = await client.model<LanguageOption>('base.language').searchRead({
        limit: 200,
        order: 'name asc',
      });
      return result.records;
    },
  });

  const preferences: BoardPreferences = {
    ...storedPreferences,
    language:
      languages.find((option) => option.id === userPreferences?.language_id)?.code ??
      storedPreferences.language,
    timezone: userPreferences?.timezone ?? storedPreferences.timezone,
    ...preferenceDraft,
  };

  const save = async () => {
    try {
      if (user) {
        const selectedLanguage = languages.find(
          (language) => language.code === preferences.language
        );
        await client.request('/auth/me/preferences', {
          method: 'PATCH',
          body: { language_id: selectedLanguage?.id ?? null, timezone: preferences.timezone },
        });
        queryClient.setQueryData(['settings', 'user', user.id], {
          ...userPreferences,
          language_id: selectedLanguage?.id ?? null,
          timezone: preferences.timezone,
        });
      }
      savePreferences(preferences);
      setPreferenceDraft({});
      setSaved(true);
      toast.success('Settings saved');
      window.setTimeout(() => setSaved(false), 1800);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save settings');
    }
  };

  const updatePreference = <K extends keyof BoardPreferences>(key: K, value: BoardPreferences[K]) =>
    setPreferenceDraft((current) => ({ ...current, [key]: value }));

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get('current_password') ?? '');
    const newPassword = String(form.get('new_password') ?? '');
    const confirmPassword = String(form.get('confirm_password') ?? '');
    if (newPassword !== confirmPassword) {
      toast.error('New password and confirmation do not match');
      return;
    }
    try {
      setChangingPassword(true);
      await client.request('/auth/me/password', {
        method: 'POST',
        body: { current_password: currentPassword, new_password: newPassword },
      });
      await logout();
      toast.success('Password changed. Please sign in again with your new password.');
      router.replace('/login');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not change password');
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Breadcrumbs items={[{ label: 'Settings' }]} />
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">Workspace</p>
        <h1 className="ink-title mt-2 text-4xl sm:text-5xl">Settings</h1>
        <p className="mt-2 text-ink-soft">Personal display and regional preferences.</p>
      </header>

      <section className="ink-panel space-y-6 bg-card p-5 sm:p-8">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center border-2 border-ink bg-lime shadow-ink-sm">
            <SettingsIcon className="size-5" />
          </span>
          <div>
            <h2 className="font-display text-xl uppercase tracking-wide">Appearance</h2>
            <p className="text-sm text-ink-soft">Choose a theme for this browser.</p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {(['light', 'dark'] as const).map((theme) => {
            const Icon = theme === 'light' ? SunIcon : MoonIcon;
            const selected = preferences.theme === theme;
            return (
              <Button
                key={theme}
                type="button"
                aria-pressed={selected}
                onClick={() => updatePreference('theme', theme)}
                className={`flex items-center gap-3 border-2 p-4 text-left transition-colors ${selected ? 'border-ink bg-lime/30 shadow-ink-sm' : 'border-ink/30 hover:border-ink'}`}
              >
                <Icon className="size-5" />
                <span className="font-display uppercase">{theme} theme</span>
                {selected && <CheckIcon className="ml-auto size-4" />}
              </Button>
            );
          })}
        </div>
      </section>

      <NotificationPreferences />

      <section className="ink-panel space-y-6 bg-card p-5 sm:p-8">
        <div>
          <h2 className="font-display text-xl uppercase tracking-wide">Language & time</h2>
          <p className="text-sm text-ink-soft">
            Regional preferences are saved to your user account.
          </p>
        </div>
        {userLoading || languagesLoading ? (
          <div className="grid gap-5 sm:grid-cols-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="settings-language">Language</Label>
              <Select
                value={preferences.language}
                onValueChange={(language) => updatePreference('language', language)}
              >
                <SelectTrigger id="settings-language" className="w-full">
                  <SelectValue placeholder="Select language" />
                </SelectTrigger>
                <SelectContent>
                  {languages.map((language) => (
                    <SelectItem key={language.id} value={language.code}>
                      {language.name} ({language.code})
                    </SelectItem>
                  ))}
                  {languages.length === 0 && (
                    <SelectItem value={DEFAULT_PREFERENCES.language}>English (en-US)</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-timezone">Time zone</Label>
              <Select
                value={preferences.timezone}
                onValueChange={(timezone) => updatePreference('timezone', timezone)}
              >
                <SelectTrigger id="settings-timezone" className="w-full">
                  <SelectValue placeholder="Select time zone" />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((timezone) => (
                    <SelectItem key={timezone} value={timezone}>
                      {timezone}
                    </SelectItem>
                  ))}
                  {!TIMEZONES.includes(preferences.timezone) && (
                    <SelectItem value={preferences.timezone}>{preferences.timezone}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        <div className="flex justify-end border-t border-ink/20 pt-5">
          <Button
            onClick={() => void save()}
            disabled={userLoading || languagesLoading}
            className="gap-2"
          >
            {saved ? <CheckIcon className="size-4" /> : null}
            {saved ? 'Saved' : 'Save settings'}
          </Button>
        </div>
      </section>

      <form
        onSubmit={(event) => void changePassword(event)}
        className="ink-panel space-y-5 bg-card p-5 sm:p-8"
      >
        <div>
          <h2 className="font-display text-xl uppercase tracking-wide">Change password</h2>
          <p className="text-sm text-ink-soft">
            Use at least 12 characters. Saved sign-in sessions are revoked; other access tokens can
            remain valid for up to 15 minutes.
          </p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              name="current_password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              name="new_password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={1024}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              name="confirm_password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={1024}
              required
            />
          </div>
        </div>
        <div className="flex justify-end border-t border-ink/20 pt-5">
          <Button type="submit" disabled={changingPassword} variant="outline">
            {changingPassword ? 'Updating…' : 'Change password'}
          </Button>
        </div>
      </form>
    </div>
  );
}
