import { defineModel, fields } from '@moonwitness/orm';
import { Company, User } from '@moonwitness/orm-base';
import type { StaticHookArguments } from 'objection';

export const WorkflowDefinition = defineModel('workflow.definition', {
  table: 'workflow_definitions',
  order: 'code asc, version desc',
  unique: [['code', 'version']],
  fields: {
    code: fields.string({ required: true, pattern: '^[a-z][a-z0-9_.-]{2,127}$' }),
    version: fields.integer({ required: true, default: 1 }),
    name: fields.string({ required: true }),
    config: fields.text({ required: true }),
    enabled: fields.boolean({ required: true, default: true }),
  },
});

export const WorkflowInstance = defineModel('workflow.instance', {
  table: 'workflow_instances',
  order: 'create_date desc, id desc',
  fields: {
    definition: fields.belongsTo(WorkflowDefinition, { required: true }),
    definition_version: fields.integer({ required: true }),
    definition_snapshot: fields.text({ required: true, hidden: true }),
    company: fields.belongsTo(Company, { required: true }),
    resource_model: fields.string({ required: true }),
    resource_id: fields.integer({ required: true }),
    started_by: fields.belongsTo(User, { required: true }),
    current_state: fields.string({ required: true }),
    status: fields.enum(['active', 'completed', 'rejected', 'timed_out', 'cancelled'], {
      required: true,
      default: 'active',
    }),
    revision: fields.integer({ required: true, default: 0 }),
    due_at: fields.string(),
    completed_at: fields.string(),
  },
});

export const WorkflowEvent = defineModel('workflow.event', {
  table: 'workflow_events',
  order: 'sequence asc, id asc',
  unique: [['instance', 'sequence']],
  fields: {
    instance: fields.belongsTo(WorkflowInstance, { required: true }),
    sequence: fields.integer({ required: true }),
    actor: fields.belongsTo(User),
    action: fields.string({ required: true }),
    from_state: fields.string({ required: true }),
    to_state: fields.string({ required: true }),
    revision: fields.integer({ required: true }),
    idempotency_key: fields.string({ required: true, unique: true, hidden: true }),
    payload: fields.text({ hidden: true }),
    comment: fields.text(),
    created_at: fields.string({ required: true }),
  },
});

/** Fail early in ORM use; database triggers below also protect raw SQL paths. */
const rejectWorkflowEventMutation = (): never => {
  throw new Error('Workflow events are append-only');
};

WorkflowEvent.beforeUpdate = (
  _args: StaticHookArguments<InstanceType<typeof WorkflowEvent>>
): never => rejectWorkflowEventMutation();
WorkflowEvent.beforeDelete = (
  _args: StaticHookArguments<InstanceType<typeof WorkflowEvent>>
): never => rejectWorkflowEventMutation();
WorkflowEvent.prototype.$beforeUpdate = rejectWorkflowEventMutation;
WorkflowEvent.prototype.$beforeDelete = rejectWorkflowEventMutation;

export const WorkflowApproval = defineModel('workflow.approval', {
  table: 'workflow_approvals',
  order: 'create_date asc, id asc',
  unique: [['instance', 'action', 'actor']],
  fields: {
    instance: fields.belongsTo(WorkflowInstance, { required: true }),
    action: fields.string({ required: true }),
    actor: fields.belongsTo(User, { required: true }),
    decision: fields.enum(['approved', 'rejected'], { required: true }),
    comment: fields.text(),
    decided_at: fields.string({ required: true }),
  },
});
