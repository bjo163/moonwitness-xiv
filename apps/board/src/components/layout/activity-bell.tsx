import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClockIcon,
  CalendarIcon,
  CheckIcon,
  CheckSquareIcon,
  ExternalLinkIcon,
  MailIcon,
  PhoneIcon,
} from '@moonwitness/ui/icons';
import { client } from '@/lib/client';
import { scopedQueryKey } from '@/lib/query-scope';
import { useAuth } from '@/hooks/use-auth-context';
import { Button } from '@moonwitness/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@moonwitness/ui/components/popover';
import { cn } from '@/lib/utils';

export interface ActivityRecord {
  id: number;
  summary: string;
  activity_type: 'todo' | 'call' | 'meeting' | 'email';
  state: 'planned' | 'done' | 'cancelled';
  deadline?: string;
  note?: string;
  assigned_to_id?: number;
  resource_model: string;
  resource_id: number;
}

export function ActivityBell() {
  const { user } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'all' | 'overdue' | 'today' | 'upcoming'>('all');
  const [todayStr, setTodayStr] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    const timer = window.setInterval(
      () => setTodayStr(new Date().toISOString().slice(0, 10)),
      60_000
    );
    return () => window.clearInterval(timer);
  }, []);

  // Fetch pending activities
  const { data: activities = [], isLoading } = useQuery<ActivityRecord[]>({
    queryKey: scopedQueryKey(['activities_bell', user?.id]),
    queryFn: async () => {
      const res = await client.model<ActivityRecord>('base.activity').searchRead({
        domain: [['state', '=', 'planned']],
        order: 'deadline asc, id desc',
        limit: 30,
      });
      return res.records;
    },
    refetchInterval: 30000, // Background poll every 30s
  });

  // Mark done mutation
  const markDoneMutation = useMutation({
    mutationFn: async (activityId: number) => {
      await client.model('base.activity').write(activityId, { state: 'done' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activities_bell'] });
      queryClient.invalidateQueries({ queryKey: ['kpi'] });
      queryClient.invalidateQueries({ queryKey: ['records', 'base.activity'] });
      queryClient.invalidateQueries({ queryKey: ['activities'] });
    },
  });

  const overdue = activities.filter((a) => a.deadline && a.deadline < todayStr);
  const dueToday = activities.filter((a) => a.deadline === todayStr);
  const upcoming = activities.filter((a) => !a.deadline || a.deadline > todayStr);

  const displayedList =
    activeTab === 'overdue'
      ? overdue
      : activeTab === 'today'
        ? dueToday
        : activeTab === 'upcoming'
          ? upcoming
          : activities;

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'call':
        return <PhoneIcon className="size-3.5 text-lime" />;
      case 'meeting':
        return <CalendarIcon className="size-3.5 text-pink" />;
      case 'email':
        return <MailIcon className="size-3.5 text-lime" />;
      default:
        return <CheckSquareIcon className="size-3.5 text-ink-faint" />;
    }
  };

  const handleOpenRecord = (resourceModel: string, resourceId: number) => {
    setOpen(false);
    router.push(`/board/m/${resourceModel}/${resourceId}`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id="activity-bell-btn"
          variant="outline"
          size="icon"
          className="relative"
          aria-label="Pending activities"
          title="Pending activities"
        >
          <CalendarClockIcon className="size-4" />
          {overdue.length > 0 ? (
            <span className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center border-2 border-ink bg-pink text-[10px] font-bold text-on-pink shadow-[1px_1px_0_0_var(--ink)] animate-pulse">
              {overdue.length}
            </span>
          ) : activities.length > 0 ? (
            <span className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center border-2 border-ink bg-lime text-[10px] font-bold text-on-accent shadow-[1px_1px_0_0_var(--ink)]">
              {activities.length}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-0 font-sans shadow-ink-lg">
        {/* Header */}
        <div className="flex items-center justify-between border-b-2 border-ink bg-paper-raised px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="font-display text-sm uppercase tracking-wider text-ink">
              Activities
            </span>
            <span className="border border-ink bg-lime px-1.5 py-0.2 font-mono text-[10px] font-bold text-on-accent">
              {activities.length}
            </span>
          </div>
          <span className="font-mono text-[11px] text-ink-faint">{todayStr}</span>
        </div>

        {/* Filter Tabs */}
        <div className="flex border-b-2 border-ink bg-paper text-[11px] font-mono">
          <Button
            type="button"
            onClick={() => setActiveTab('all')}
            className={cn(
              'flex-1 py-1.5 text-center font-bold transition-colors',
              activeTab === 'all' ? 'bg-ink text-paper' : 'text-ink-soft hover:bg-paper-raised'
            )}
          >
            All ({activities.length})
          </Button>
          <Button
            type="button"
            onClick={() => setActiveTab('overdue')}
            className={cn(
              'flex-1 py-1.5 text-center font-bold transition-colors',
              activeTab === 'overdue'
                ? 'bg-pink text-on-pink'
                : 'text-ink-soft hover:bg-paper-raised'
            )}
          >
            Overdue ({overdue.length})
          </Button>
          <Button
            type="button"
            onClick={() => setActiveTab('today')}
            className={cn(
              'flex-1 py-1.5 text-center font-bold transition-colors',
              activeTab === 'today'
                ? 'bg-lime text-on-accent'
                : 'text-ink-soft hover:bg-paper-raised'
            )}
          >
            Today ({dueToday.length})
          </Button>
          <Button
            type="button"
            onClick={() => setActiveTab('upcoming')}
            className={cn(
              'flex-1 py-1.5 text-center font-bold transition-colors',
              activeTab === 'upcoming'
                ? 'border-b-2 border-lime font-black text-ink bg-paper-raised'
                : 'text-ink-soft hover:bg-paper-raised'
            )}
          >
            Later ({upcoming.length})
          </Button>
        </div>

        {/* Activity Items List */}
        <div className="max-h-72 overflow-y-auto divide-y divide-ink/15 bg-paper-raised">
          {isLoading ? (
            <div className="p-6 text-center font-mono text-xs text-ink-faint">
              Loading reminders...
            </div>
          ) : displayedList.length === 0 ? (
            <div className="p-6 text-center font-mono text-xs text-ink-faint">
              No pending activities in this view.
            </div>
          ) : (
            displayedList.map((act) => {
              const isOverdue = act.deadline && act.deadline < todayStr;
              const isToday = act.deadline === todayStr;

              return (
                <div
                  key={act.id}
                  className="group flex items-start justify-between gap-3 p-3 transition-colors hover:bg-paper"
                >
                  <div
                    className="flex-1 cursor-pointer"
                    onClick={() => handleOpenRecord(act.resource_model, act.resource_id)}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      {getActivityIcon(act.activity_type)}
                      <span className="font-display text-xs uppercase tracking-wide text-ink line-clamp-1 group-hover:text-lime-600 transition-colors">
                        {act.summary}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 font-mono text-[10px]">
                      <span className="text-ink-faint">
                        {act.resource_model} #{act.resource_id}
                      </span>
                      {act.deadline && (
                        <span
                          className={cn(
                            'border px-1 py-0.2 font-bold uppercase',
                            isOverdue
                              ? 'border-pink bg-pink/15 text-pink'
                              : isToday
                                ? 'border-lime bg-lime/20 text-lime-800 dark:text-lime'
                                : 'border-ink/20 text-ink-faint'
                          )}
                        >
                          {act.deadline}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon-xs"
                      title="Mark as Done"
                      disabled={markDoneMutation.isPending}
                      onClick={() => markDoneMutation.mutate(act.id)}
                      className="size-6 hover:border-lime hover:bg-lime hover:text-on-accent"
                    >
                      <CheckIcon className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Open Record"
                      onClick={() => handleOpenRecord(act.resource_model, act.resource_id)}
                      className="size-6 text-ink-faint hover:text-ink"
                    >
                      <ExternalLinkIcon className="size-3" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="border-t-2 border-ink bg-paper p-2 text-center">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setOpen(false);
              router.push('/board/m/base.activity');
            }}
            className="w-full font-mono text-xs text-ink-soft hover:bg-lime hover:text-on-accent"
          >
            View All Activities Table →
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
