'use client';

import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CompanyIcon, MailIcon, PartnerIcon, SecurityIcon, UserIcon } from '@moonwitness/ui/icons';
import { toast } from '@moonwitness/ui/components/toast';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Button } from '@moonwitness/ui/components/button';
import { Input } from '@moonwitness/ui/components/input';
import { Label } from '@moonwitness/ui/components/label';
import { Skeleton } from '@moonwitness/ui/components/skeleton';
import { useAuth } from '@/hooks/use-auth-context';
import { client } from '@/lib/client';

interface PartnerProfile {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  mobile?: string;
  job_title?: string;
  website?: string;
  city?: string;
  country?: number | string | [number, string];
  company?: number | string | [number, string];
}

function relationLabel(value: number | string | [number, string] | undefined): string | undefined {
  return Array.isArray(value) ? value[1] : typeof value === 'string' ? value : undefined;
}

export function ProfilePage() {
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const currentUser = await client.getMe();
      if (!currentUser.partner_id) return null;
      const result = await client.model<PartnerProfile>('base.partner').searchRead({
        domain: [['id', '=', currentUser.partner_id]],
        limit: 1,
      });
      return result.records[0] ?? null;
    },
    enabled: Boolean(user),
  });

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    try {
      setSaving(true);
      await client.request('/auth/me/profile', {
        method: 'PATCH',
        body: {
          name: value('name'),
          email: value('email') || null,
          phone: value('phone') || null,
          mobile: value('mobile') || null,
          job_title: value('job_title') || null,
          website: value('website') || null,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['profile', user?.id] });
      toast.success('Profile updated');
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : 'Could not update profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Breadcrumbs items={[{ label: 'Profile' }]} />
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">My account</p>
        <h1 className="ink-title mt-2 text-4xl sm:text-5xl">Profile</h1>
        <p className="mt-2 text-ink-soft">Your user account and linked contact information.</p>
      </header>

      <section className="ink-panel overflow-hidden bg-card">
        <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-4 border-b-2 border-ink bg-lime/20 p-6 sm:flex sm:flex-wrap sm:p-8">
          <div className="grid size-16 place-items-center border-2 border-ink bg-lime shadow-ink-sm">
            <UserIcon className="size-8" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="break-words font-display text-2xl uppercase sm:text-3xl">
              {data?.name ?? user?.login}
            </h2>
            <p className="font-mono text-sm text-ink-soft">@{user?.login}</p>
          </div>
          <span className="col-start-2 inline-flex w-fit items-center gap-1.5 border-2 border-ink bg-paper-raised px-3 py-1.5 font-mono text-xs font-bold uppercase sm:ml-auto">
            <SecurityIcon className="size-4" /> {user?.role}
          </span>
        </div>

        {isLoading ? (
          <div className="grid gap-4 p-6 sm:grid-cols-2 sm:p-8">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : error ? (
          <p className="p-6 text-sm text-pink">Could not load the linked contact profile.</p>
        ) : (
          <dl className="grid gap-px bg-ink/15 sm:grid-cols-2">
            <ProfileDetail icon={PartnerIcon} label="Contact name" value={data?.name} />
            <ProfileDetail icon={MailIcon} label="Email" value={data?.email} />
            <ProfileDetail icon={UserIcon} label="Job title" value={data?.job_title} />
            <ProfileDetail
              icon={CompanyIcon}
              label="Company"
              value={relationLabel(data?.company)}
            />
            <ProfileDetail icon={PartnerIcon} label="Phone" value={data?.phone ?? data?.mobile} />
            <ProfileDetail
              icon={CompanyIcon}
              label="Location"
              value={[data?.city, relationLabel(data?.country)].filter(Boolean).join(', ')}
            />
          </dl>
        )}
      </section>
      {data && (
        <form
          key={`${data.id}-${data.name}`}
          onSubmit={(event) => void saveProfile(event)}
          className="ink-panel space-y-5 bg-card p-5 sm:p-8"
        >
          <div>
            <h2 className="font-display text-xl uppercase tracking-wide">Edit contact details</h2>
            <p className="text-sm text-ink-soft">
              Only the contact linked to your account can be changed here.
            </p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <ProfileInput name="name" label="Full name" value={data.name} required />
            <ProfileInput name="email" label="Email" value={data.email} type="email" />
            <ProfileInput name="phone" label="Phone" value={data.phone} type="tel" />
            <ProfileInput name="mobile" label="Mobile" value={data.mobile} type="tel" />
            <ProfileInput name="job_title" label="Job title" value={data.job_title} />
            <ProfileInput name="website" label="Website" value={data.website} type="url" />
          </div>
          <div className="flex justify-end border-t border-ink/20 pt-5">
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save profile'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function ProfileInput({
  name,
  label,
  value,
  type = 'text',
  required = false,
}: {
  name: string;
  label: string;
  value?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={`profile-${name}`}>{label}</Label>
      <Input
        id={`profile-${name}`}
        name={name}
        type={type}
        defaultValue={value ?? ''}
        required={required}
      />
    </div>
  );
}

function ProfileDetail({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof PartnerIcon;
  label: string;
  value?: string;
}) {
  return (
    <div className="grid min-h-20 grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3 bg-card p-5">
      <dt className="col-span-2 flex items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-ink-faint">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {label}
      </dt>
      <dd className="col-start-2 mt-1 break-words text-sm font-medium">
        {value || 'Not provided'}
      </dd>
    </div>
  );
}
