import { Checkbox } from '@moonwitness/ui/components/checkbox';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Skeleton } from '@moonwitness/ui/components/skeleton';
import { useAuth } from '@/hooks/use-auth-context';
import { client } from '@/lib/client';
import { scopedQueryKey } from '@/lib/query-scope';

type NotificationChannel = 'in_app' | 'email';

interface Preference {
  channel: NotificationChannel;
  enabled: boolean;
}

interface PreferenceResponse {
  success: boolean;
  data: Preference[];
}

export function NotificationPreferences() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = scopedQueryKey(['notification_preferences', user?.id]);
  const query = useQuery({
    queryKey,
    queryFn: async () =>
      (await client.request<PreferenceResponse>('/notifications/preferences')).data,
    enabled: Boolean(user),
  });
  const update = useMutation({
    mutationFn: ({ channel, enabled }: Preference) =>
      client.request(`/notifications/preferences/${channel}`, {
        method: 'PUT',
        body: { enabled },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const enabled = (channel: NotificationChannel) =>
    query.data?.find((preference) => preference.channel === channel)?.enabled ??
    channel === 'in_app';

  return (
    <section
      className="ink-panel space-y-5 bg-card p-5 sm:p-8"
      aria-labelledby="notification-preferences-title"
    >
      <div>
        <h2
          id="notification-preferences-title"
          className="font-display text-xl uppercase tracking-wide"
        >
          Notifications
        </h2>
        <p className="text-sm text-ink-soft">
          Choose which channels may receive notifications for this company.
        </p>
      </div>
      {query.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-pink">
          Notification preferences could not be loaded.
        </p>
      ) : (
        <div className="space-y-3">
          {(['in_app', 'email'] as const).map((channel) => (
            <label
              key={channel}
              className="flex cursor-pointer items-start gap-3 border-2 border-ink/20 p-3 transition-colors hover:border-ink"
            >
              <Checkbox
                checked={enabled(channel)}
                disabled={update.isPending}
                onChange={(event) =>
                  update.mutate({ channel, enabled: event.currentTarget.checked })
                }
                className="mt-0.5 size-4 accent-ink"
              />
              <span>
                <span className="block font-display text-sm uppercase">
                  {channel === 'in_app' ? 'In-app inbox' : 'Email'}
                </span>
                <span className="block text-xs text-ink-soft">
                  {channel === 'in_app'
                    ? 'Show messages in the Board notification inbox.'
                    : 'Demo channel only. Delivery is suppressed; no email is sent.'}
                </span>
              </span>
            </label>
          ))}
          {update.isError && (
            <p role="alert" className="text-sm text-pink">
              Preference could not be saved. Try again.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
