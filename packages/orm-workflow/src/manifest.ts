import { defineAddon, ref, seed } from '@moonwitness/orm';
import { ModelAccess } from '@moonwitness/orm-base';
import { Cron } from '@moonwitness/jobs';
import { WorkflowApproval, WorkflowDefinition, WorkflowEvent, WorkflowInstance } from './models.js';
import { views } from './views.js';

const requestApprovalExample = {
  startState: 'draft',
  startRoles: ['user', 'superadmin', 'system'],
  timeoutMinutes: 10080,
  resourceModels: ['base.partner'],
  transitions: [
    {
      action: 'submit',
      from: 'draft',
      to: 'submitted',
      roles: ['user', 'superadmin', 'system'],
    },
    {
      action: 'approve',
      from: 'submitted',
      to: 'approved',
      roles: ['user', 'superadmin', 'system'],
      requiredApprovals: 1,
      requireDifferentActor: true,
    },
    {
      action: 'reject',
      from: 'submitted',
      to: 'rejected',
      roles: ['user', 'superadmin', 'system'],
    },
  ],
};

export const manifest = defineAddon({
  name: 'workflow',
  version: '1.2.0',
  depends: ['base', 'jobs', 'notification'],
  models: [WorkflowDefinition, WorkflowInstance, WorkflowEvent, WorkflowApproval],
  setup: async (trx) => {
    const client = String(trx.client.config.client);
    if (client === 'pg') {
      await trx.raw(`
        CREATE OR REPLACE FUNCTION moonwitness_reject_workflow_event_mutation()
        RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'Workflow events are append-only';
        END;
        $$ LANGUAGE plpgsql
      `);
      await trx.raw(`DROP TRIGGER IF EXISTS workflow_events_append_only ON workflow_events`);
      await trx.raw(`
        CREATE TRIGGER workflow_events_append_only
        BEFORE UPDATE OR DELETE ON workflow_events
        FOR EACH ROW EXECUTE FUNCTION moonwitness_reject_workflow_event_mutation()
      `);
    } else if (client === 'better-sqlite3' || client === 'sqlite3') {
      await trx.raw(`
        CREATE TRIGGER IF NOT EXISTS workflow_events_reject_update
        BEFORE UPDATE ON workflow_events
        BEGIN SELECT RAISE(ABORT, 'Workflow events are append-only'); END
      `);
      await trx.raw(`
        CREATE TRIGGER IF NOT EXISTS workflow_events_reject_delete
        BEFORE DELETE ON workflow_events
        BEGIN SELECT RAISE(ABORT, 'Workflow events are append-only'); END
      `);
    }
  },
  data: [
    seed(WorkflowDefinition, 'workflow.definition_sample_request_v1', {
      code: 'sample.request_approval',
      version: 1,
      name: 'Sample request approval',
      config: JSON.stringify(requestApprovalExample),
    }),
    ...([WorkflowInstance, WorkflowEvent, WorkflowApproval] as const).map((model) =>
      seed(ModelAccess, `workflow.access_user_${model.modelName.replaceAll('.', '_')}_read`, {
        group: ref('base.group_user'),
        model_name: model.modelName,
        read: true,
        create: false,
        write: false,
        unlink: false,
      })
    ),
    seed(ModelAccess, 'workflow.access_user_definition_read', {
      group: ref('base.group_user'),
      model_name: WorkflowDefinition.modelName,
      read: true,
      create: false,
      write: false,
      unlink: false,
    }),
    seed(Cron, 'workflow.cron_expire_due', {
      code: 'workflow.expire_due',
      name: 'Expire overdue workflow instances',
      handler: 'workflow.expire_due',
      payload: '{}',
      cron_expression: '* * * * *',
      timezone: 'UTC',
      enabled: true,
      next_run_at: '2026-01-01T00:00:00.000Z',
      misfire_policy: 'coalesce',
      concurrency_policy: 'forbid',
      max_catch_up: 1,
    }),
  ],
  views,
  menus: [
    { model: WorkflowInstance.modelName, label: 'Workflows', group: 'Workspace', sequence: 18 },
    { model: WorkflowEvent.modelName, label: 'Workflow History', group: 'Workspace', sequence: 19 },
    {
      model: WorkflowApproval.modelName,
      label: 'Workflow Approvals',
      group: 'Workspace',
      sequence: 20,
    },
    {
      model: WorkflowDefinition.modelName,
      label: 'Workflow Definitions',
      group: 'Technical',
      sequence: 480,
      developmentOnly: true,
    },
  ],
});
