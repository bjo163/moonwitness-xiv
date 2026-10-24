import { Textarea } from '@moonwitness/ui/components/textarea';
import { AccentMarker } from '@moonwitness/ui/components/effects';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@moonwitness/ui/components/button';
import { useAuth } from '@/hooks/use-auth-context';
import { client } from '@/lib/client';

interface WorkflowTransition {
  action: string;
  from: string;
  to: string;
  roles: readonly string[];
  requireDifferentActor?: boolean;
}

interface WorkflowDefinition {
  code: string;
  name: string;
  version: number;
  canStart: boolean;
  transitions: readonly WorkflowTransition[];
}

interface WorkflowInstance {
  id: number;
  definition_code: string;
  resource_model: string;
  resource_id: number;
  started_by_id: number;
  current_state: string;
  status: 'active' | 'completed' | 'rejected' | 'timed_out' | 'cancelled';
  revision: number;
}

interface WorkflowEvent {
  sequence: number;
  action: string;
  from_state: string;
  to_state: string;
  comment: string | null;
}

interface ApiList<T> {
  success: boolean;
  data: T[];
}

interface WorkflowDetailResponse {
  success: boolean;
  data: WorkflowInstance & { events: WorkflowEvent[] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Workflow request failed. Please retry.';
}

export function WorkflowPanel({ model, recordId }: { model: string; recordId: number }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const companyId = client.getCompanyId() ?? null;
  const [comment, setComment] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const definitionsQuery = useQuery({
    queryKey: ['workflows', 'definitions', companyId, model],
    queryFn: () =>
      client.request<ApiList<WorkflowDefinition>>(
        `/workflows/definitions?resource_model=${encodeURIComponent(model)}`
      ),
    staleTime: 60_000,
  });
  const instancesQuery = useQuery({
    queryKey: ['workflows', 'instances', companyId, model, recordId],
    queryFn: () =>
      client.request<ApiList<WorkflowInstance>>(
        `/workflows/instances?limit=100&resource_model=${encodeURIComponent(model)}&resource_id=${recordId}`
      ),
  });
  const instance = instancesQuery.data?.data[0];
  const detailQuery = useQuery({
    queryKey: ['workflows', 'instance', companyId, instance?.id],
    queryFn: () => client.request<WorkflowDetailResponse>(`/workflows/instances/${instance?.id}`),
    enabled: instance !== undefined,
  });
  const definitions = definitionsQuery.data?.data ?? [];
  const startableDefinition = definitions.find((candidate) => candidate.canStart);
  const definition = definitions.find(
    (candidate) => candidate.code === (instance?.definition_code ?? definitions[0]?.code)
  );
  const allowedTransitions = useMemo(
    () =>
      instance && definition && user
        ? definition.transitions.filter(
            (transition) =>
              transition.from === instance.current_state &&
              transition.roles.includes(user.role) &&
              !(transition.requireDifferentActor && instance.started_by_id === user.id)
          )
        : [],
    [definition, instance, user]
  );
  const refresh = async () => {
    setActionError(null);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['workflows', 'instances', companyId, model, recordId],
      }),
      queryClient.invalidateQueries({ queryKey: ['workflows', 'instance', companyId] }),
    ]);
  };
  const startMutation = useMutation({
    mutationFn: () => {
      if (!startableDefinition) throw new Error('No approval workflow is available to start.');
      return client.request('/workflows/instances', {
        method: 'POST',
        body: {
          code: startableDefinition.code,
          resource_model: model,
          resource_id: recordId,
          idempotency_key: crypto.randomUUID(),
        },
      });
    },
    onSuccess: refresh,
    onError: (error: unknown) => setActionError(errorMessage(error)),
  });
  const actionMutation = useMutation({
    mutationFn: (action: string) => {
      if (!instance) throw new Error('Workflow is no longer available. Reload and retry.');
      return client.request(`/workflows/instances/${instance.id}/actions`, {
        method: 'POST',
        body: {
          action,
          expected_revision: instance.revision,
          idempotency_key: crypto.randomUUID(),
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        },
      });
    },
    onSuccess: async () => {
      setComment('');
      await refresh();
    },
    onError: (error: unknown) => setActionError(errorMessage(error)),
  });

  if (definitionsQuery.isLoading || instancesQuery.isLoading) {
    return (
      <section aria-label="Approval workflow" className="ink-panel p-5">
        Loading approval workflow…
      </section>
    );
  }
  if (definitionsQuery.isError || instancesQuery.isError) {
    return (
      <section aria-label="Approval workflow" className="ink-panel space-y-3 p-5">
        <h2 className="font-display text-lg">Approval workflow</h2>
        <p role="alert" className="text-sm text-pink-700">
          {errorMessage(definitionsQuery.error ?? instancesQuery.error)}
        </p>
      </section>
    );
  }

  if (!instance && !definitions.some((candidate) => candidate.canStart)) return null;

  return (
    <section aria-labelledby="workflow-panel-title" className="ink-panel space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <AccentMarker>Review and approval</AccentMarker>
          <h2 id="workflow-panel-title" className="font-display text-xl">
            Approval workflow
          </h2>
        </div>
        {instance && (
          <span className="rounded border border-ink/30 px-2 py-1 text-xs font-bold uppercase">
            {instance.status.replace('_', ' ')}
          </span>
        )}
      </div>
      {instance ? (
        <>
          <p className="text-sm">
            Current state: <strong>{instance.current_state}</strong> · Revision {instance.revision}
          </p>
          {detailQuery.isLoading ? (
            <p role="status" className="text-sm text-ink-soft">
              Loading approval history…
            </p>
          ) : detailQuery.data ? (
            <ol aria-label="Approval history" className="space-y-2 border-l-2 border-ink/20 pl-4">
              {detailQuery.data.data.events.map((event) => (
                <li key={event.sequence} className="text-sm">
                  <strong>{event.action}</strong> · {event.from_state} → {event.to_state}
                  {event.comment && <p className="text-ink-soft">{event.comment}</p>}
                </li>
              ))}
            </ol>
          ) : detailQuery.isError ? (
            <p role="alert" className="text-sm text-pink-700">
              {errorMessage(detailQuery.error)}
            </p>
          ) : null}
          {instance.status === 'active' && allowedTransitions.length > 0 && (
            <div className="space-y-3">
              <label className="grid gap-1 text-sm font-semibold">
                Review comment
                <Textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  maxLength={2000}
                  rows={2}
                  className="border-2 border-ink bg-card p-2"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                {allowedTransitions.map((transition) => (
                  <Button
                    key={transition.action}
                    variant={transition.action === 'reject' ? 'outline' : 'default'}
                    onClick={() => actionMutation.mutate(transition.action)}
                    disabled={actionMutation.isPending}
                  >
                    {actionMutation.isPending ? 'Saving…' : transition.action.replaceAll('_', ' ')}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </>
      ) : null}
      {(!instance || instance.status !== 'active') && startableDefinition && (
        <Button onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
          {startMutation.isPending ? 'Starting…' : `Start ${startableDefinition.name}`}
        </Button>
      )}
      {actionError && (
        <p role="alert" className="text-sm font-semibold text-pink-700">
          {actionError}
        </p>
      )}
    </section>
  );
}
