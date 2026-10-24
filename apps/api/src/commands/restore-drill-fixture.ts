import { chmod, readFile, writeFile } from 'node:fs/promises';
import knex, { type Knex } from 'knex';
import { createAuthService, manifest as authManifest } from '@moonwitness/auth';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as workflowManifest } from '@moonwitness/orm-workflow';
import { manifest as requestManifest, PurchaseRequest } from '@moonwitness/orm-request';
import { manifest as knowledgeManifest } from '@moonwitness/orm-knowledge';
import { installAddons } from '@moonwitness/orm';
import { config } from '../config/env.js';
import { validateJwtSecret } from '../plugins/auth.plugin.js';
import {
  Company,
  Partner,
  PartnerAddress,
  User,
  initializeSuperadminPassword,
  manifest as baseManifest,
} from '@moonwitness/orm-base';

const tableNames = [
  '_orm_addons',
  '_orm_data',
  'companies',
  'partners',
  'users',
  'partner_addresses',
  'company_memberships',
  'group_memberships',
  'notification_templates',
  'notification_preferences',
  'notifications',
  'purchase_requests',
  'workflow_definitions',
  'workflow_instances',
  'workflow_events',
  'workflow_approvals',
  'knowledge_research_graph_releases',
  'knowledge_research_graph_records',
  'knowledge_research_active_releases',
  'knowledge_research_review_events',
  'knowledge_research_actor_identities',
] as const;
const fixture = {
  businessName: 'Restore Drill Business',
  childName: 'Restore Drill Contact',
  addressLabel: 'Restore Drill Headquarters',
  login: 'restore-drill-user',
  email: 'restore-drill-user@example.test',
} as const;
const createFixtureAuthService = () =>
  createAuthService({ refreshTokenSecret: validateJwtSecret(config.auth?.jwtSecret) });

interface RestoreExpectations {
  counts: Record<(typeof tableNames)[number], string>;
  ids: {
    address: number;
    business: number;
    child: number;
    company: number;
    superadmin: number;
    system: number;
    user: number;
    request: number;
    researchRelease: number;
    researchRecord: number;
    reviewWorkflow: number;
    reviewEvent: number;
    researchReviewEvent: number;
    requesterIdentity: number;
    reviewerIdentity: number;
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function countTables(db: Knex): Promise<RestoreExpectations['counts']> {
  const entries = await Promise.all(
    tableNames.map(async (table) => {
      const row = await db(table).count({ count: '*' }).first();
      return [table, String(row?.count ?? '0')] as const;
    })
  );
  return Object.fromEntries(entries) as RestoreExpectations['counts'];
}

function bindFixtureModels(db: Knex): void {
  for (const addon of [baseManifest, authManifest, jobsManifest, notificationManifest]) {
    for (const model of addon.models) model.knex(db);
  }
  for (const addon of [workflowManifest, requestManifest, knowledgeManifest]) {
    for (const model of addon.models) model.knex(db);
  }
}

async function recordId(db: Knex, externalId: string, model: string): Promise<number> {
  const identity = await db('_orm_data').where({ id: externalId, model }).first('record_id');
  assert(identity, `Missing external identity ${externalId}`);
  return Number(identity.record_id);
}

async function recordExpectations(db: Knex): Promise<RestoreExpectations> {
  const user = await User.query().findOne({ login: fixture.login }).throwIfNotFound();
  const business = await Partner.query().findOne({ name: fixture.businessName }).throwIfNotFound();
  const child = await Partner.query().findOne({ name: fixture.childName }).throwIfNotFound();
  const address = await PartnerAddress.query()
    .findOne({ label: fixture.addressLabel })
    .throwIfNotFound();
  const request = await PurchaseRequest.query()
    .findOne({ title: 'Laptop replacement' })
    .throwIfNotFound();

  return {
    counts: await countTables(db),
    ids: {
      address: address.id,
      business: business.id,
      child: child.id,
      company: await recordId(db, 'base.company_default', 'base.company'),
      superadmin: await recordId(db, 'base.user_superadmin', 'base.user'),
      system: await recordId(db, 'base.user_system', 'base.user'),
      user: user.id,
      request: request.id,
      researchRelease: Number((await db('knowledge_research_graph_releases').first('id'))?.id),
      researchRecord: Number((await db('knowledge_research_graph_records').first('id'))?.id),
      reviewWorkflow: Number(
        (
          await db('workflow_instances')
            .where({ resource_model: 'knowledge.research_graph_record' })
            .first('id')
        )?.id
      ),
      reviewEvent: Number(
        (await db('workflow_events').where({ action: 'submit-review' }).first('id'))?.id
      ),
      researchReviewEvent: Number((await db('knowledge_research_review_events').first('id'))?.id),
      requesterIdentity: Number(
        (await db('knowledge_research_actor_identities').orderBy('id').first('id'))?.id
      ),
      reviewerIdentity: Number(
        (await db('knowledge_research_actor_identities').orderBy('id', 'desc').first('id'))?.id
      ),
    },
  };
}

async function seed(db: Knex, expectationsPath: string): Promise<void> {
  await installAddons(db, [
    baseManifest,
    authManifest,
    jobsManifest,
    notificationManifest,
    workflowManifest,
    requestManifest,
    knowledgeManifest,
  ]);
  await initializeSuperadminPassword('synthetic-restore-drill-admin-password');

  const company = await Company.query().findById(
    await recordId(db, 'base.company_default', 'base.company')
  );
  assert(company, 'Default company fixture was not installed');
  const business = await Partner.query().insert({
    name: fixture.businessName,
    email: 'restore-drill-business@example.test',
    is_company: true,
    company_id: company.id,
  });
  const child = await Partner.query().insert({
    name: fixture.childName,
    parent_id: business.id,
    company_id: company.id,
  });
  const address = await PartnerAddress.query().insert({
    partner_id: business.id,
    label: fixture.addressLabel,
    address_type: 'contact',
    street: '10 Recovery Lane',
    city: 'Recovery City',
    postal_code: '00010',
    is_primary: true,
  });
  const session = await createFixtureAuthService().register({
    login: fixture.login,
    password: requiredEnvironment('RESTORE_DRILL_PASSWORD'),
    name: 'Restore Drill User',
    email: fixture.email,
  });
  assert(session.login === fixture.login, 'Synthetic fixture login did not succeed');
  assert(child.parent_id === business.id, 'Synthetic partner hierarchy did not persist');
  assert(address.partner_id === business.id, 'Synthetic partner address did not persist');

  // A fully synthetic graph/review chain exercises the installed ORM schema and
  // PostgreSQL backup coverage without importing or asserting an external corpus.
  await db('knowledge_research_actor_identities').insert([
    {
      user_id: Number((await db('users').where({ login: 'system' }).first('id'))?.id),
      canonical_user_id: 'mw:user:restore-requester',
    },
    {
      user_id: Number((await db('users').where({ login: fixture.login }).first('id'))?.id),
      canonical_user_id: 'mw:user:restore-reviewer',
    },
  ]);
  const releaseDigest = 'd'.repeat(64);
  const manifestDigest = 'e'.repeat(64);
  const graphRelease = await db('knowledge_research_graph_releases')
    .insert({
      release_digest: releaseDigest,
      manifest_digest: manifestDigest,
      manifest_json: JSON.stringify({
        corpus_key: 'restore-drill-synthetic',
        records: ['mw:node:restore-drill'],
      }),
      record_count: 1,
      schema_version: 'restore-drill/synthetic-v1',
    })
    .returning('id');
  const releaseId = Number(graphRelease[0]?.id);
  const graphRecord = await db('knowledge_research_graph_records')
    .insert({
      release_id: releaseId,
      record_key: 'mw:node:restore-drill',
      record_kind: 'node',
      visibility: 'INTERNAL',
      content_json: JSON.stringify({
        id: 'mw:node:restore-drill',
        kind: 'SyntheticRestoreFixture',
        claim: 'No corpus claim.',
      }),
      content_digest: 'f'.repeat(64),
    })
    .returning('id');
  await db('knowledge_research_active_releases').insert({
    corpus_key: 'restore-drill-synthetic',
    release_id: releaseId,
    activated_at: '2026-10-16T00:00:00.000Z',
  });
  await db('workflow_definitions').insert({
    code: 'restore.drill.review',
    version: 1,
    name: 'Synthetic restore drill review',
    config: JSON.stringify({ startState: 'submitted', transitions: [] }),
    enabled: true,
  });
  const workflowDefinition = await db('workflow_definitions')
    .where({ code: 'restore.drill.review', version: 1 })
    .first('id');
  const companyId = Number((await db('companies').first('id'))?.id);
  const requesterId = Number((await db('users').where({ login: 'system' }).first('id'))?.id);
  const reviewerId = Number((await db('users').where({ login: fixture.login }).first('id'))?.id);
  const workflowInstance = await db('workflow_instances')
    .insert({
      definition_id: workflowDefinition.id,
      definition_version: 1,
      definition_snapshot: JSON.stringify({ code: 'restore.drill.review', version: 1 }),
      company_id: companyId,
      resource_model: 'knowledge.research_graph_record',
      resource_id: Number(graphRecord[0]?.id),
      started_by_id: requesterId,
      current_state: 'approved',
      status: 'completed',
      revision: 1,
      completed_at: '2026-10-16T00:01:00.000Z',
    })
    .returning('id');
  const workflowInstanceId = Number(workflowInstance[0]?.id);
  const workflowEvent = await db('workflow_events')
    .insert({
      instance_id: workflowInstanceId,
      sequence: 1,
      actor_id: reviewerId,
      action: 'submit-review',
      from_state: 'submitted',
      to_state: 'approved',
      revision: 1,
      idempotency_key: 'restore-drill-review-event-001',
      payload: JSON.stringify({
        outcome: 'accepted',
        subject_id: 'mw:node:restore-drill',
        claim: 'No corpus claim.',
      }),
      comment: 'Synthetic restore drill decision',
      created_at: '2026-10-16T00:01:00.000Z',
    })
    .returning('id');
  await db('knowledge_research_review_events').insert({
    event_id: 'mw:event:restore-drill-review-001',
    workflow_instance_id: workflowInstanceId,
    workflow_event_sequence: 1,
    subject_id: 'mw:node:restore-drill',
    subject_revision: 1,
    research_release_digest: releaseDigest,
    idempotency_key: 'restore-drill-review-001',
    event_json: JSON.stringify({
      event_id: 'mw:event:restore-drill-review-001',
      outcome: 'accepted',
      claim: 'No corpus claim.',
    }),
    event_digest: 'a'.repeat(64),
  });
  assert(workflowEvent.length > 0, 'Synthetic linked workflow event did not persist');

  const expected = await recordExpectations(db);
  assert(expected.ids.child === child.id, 'Synthetic child identity changed');
  assert(expected.ids.address === address.id, 'Synthetic address identity changed');
  await writeFile(expectationsPath, `${JSON.stringify(expected, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(expectationsPath, 0o600);
  process.stdout.write(`${JSON.stringify({ status: 'seeded', tableCounts: expected.counts })}\n`);
}

async function verify(db: Knex, expectationsPath: string): Promise<void> {
  const expected = JSON.parse(await readFile(expectationsPath, 'utf8')) as RestoreExpectations;
  const actual = await recordExpectations(db);
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    'Restored counts or record IDs differ'
  );
  const reviewEvent = await db('knowledge_research_review_events')
    .where({ id: expected.ids.researchReviewEvent })
    .first();
  assert(reviewEvent, 'Synthetic research review event was not restored');
  assert(
    Number(reviewEvent.workflow_instance_id) === expected.ids.reviewWorkflow &&
      Number(reviewEvent.workflow_event_sequence) === 1 &&
      String(reviewEvent.research_release_digest) === 'd'.repeat(64),
    'Research review event lost its linked workflow/release identity'
  );
  assert(
    await db('knowledge_research_active_releases')
      .where({ corpus_key: 'restore-drill-synthetic', release_id: expected.ids.researchRelease })
      .first(),
    'Active synthetic research release pointer was not restored'
  );
  assert(
    await db('knowledge_research_graph_records')
      .where({ id: expected.ids.researchRecord, release_id: expected.ids.researchRelease })
      .first(),
    'Synthetic research graph record was not restored with its release'
  );
  assert(
    await db('workflow_events')
      .where({
        id: expected.ids.reviewEvent,
        instance_id: expected.ids.reviewWorkflow,
        sequence: 1,
      })
      .first(),
    'Linked synthetic workflow event was not restored'
  );
  assert(
    await db('workflow_instances')
      .where({ id: expected.ids.reviewWorkflow, resource_id: expected.ids.researchRecord })
      .first(),
    'Review workflow instance was not restored with its research resource link'
  );
  assert(
    await db('knowledge_research_actor_identities')
      .where({
        id: expected.ids.requesterIdentity,
        canonical_user_id: 'mw:user:restore-requester',
      })
      .first(),
    'Synthetic requester identity mapping was not restored'
  );
  assert(
    await db('knowledge_research_actor_identities')
      .where({
        id: expected.ids.reviewerIdentity,
        canonical_user_id: 'mw:user:restore-reviewer',
      })
      .first(),
    'Synthetic reviewer identity mapping was not restored'
  );

  const business = await Partner.query().findById(expected.ids.business).throwIfNotFound();
  assert(
    business.company_id === expected.ids.company,
    'Business company relation was not restored'
  );
  const addresses = await PartnerAddress.query().where({ partner_id: expected.ids.business });
  assert(
    addresses.some((address) => address.id === expected.ids.address && address.is_primary),
    'Business address relation was not restored'
  );
  const children = await Partner.query().where({ parent_id: expected.ids.business });
  assert(
    children.some((child) => child.id === expected.ids.child),
    'Parent/child partner relation was not restored'
  );
  assert(
    await db('company_memberships')
      .where({ user_id: expected.ids.user, company_id: expected.ids.company })
      .first(),
    'Synthetic user company membership was not restored'
  );

  const session = await createFixtureAuthService().login(
    fixture.login,
    requiredEnvironment('RESTORE_DRILL_PASSWORD')
  );
  assert(
    session.userId === expected.ids.user,
    'Synthetic account could not authenticate after restore'
  );
  process.stdout.write(
    `${JSON.stringify({
      status: 'verified',
      tableCounts: actual.counts,
      relationshipChecks: [
        'user-company-membership',
        'partner-child',
        'partner-address',
        'active-research-release-record',
        'actor-mappings',
        'research-review-workflow-event',
      ],
      syntheticLogin: 'passed',
    })}\n`
  );
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'seed' && mode !== 'verify') throw new Error('Expected mode: seed or verify');
  const connectionString = requiredEnvironment('RESTORE_DRILL_DATABASE_URL');
  const expectationsPath = requiredEnvironment('RESTORE_DRILL_EXPECTATIONS_FILE');
  const schema = process.env.RESTORE_DRILL_SCHEMA;
  if (schema && !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(schema)) {
    throw new Error('RESTORE_DRILL_SCHEMA must be a safe PostgreSQL schema name');
  }
  const db = knex({
    client: 'pg',
    connection: { connectionString, statement_timeout: 30_000 },
    pool: { min: 0, max: 4, acquireTimeoutMillis: 10_000 },
    ...(schema ? { searchPath: [schema] } : {}),
  });
  try {
    await db.raw('select 1');
    if (mode === 'seed') await seed(db, expectationsPath);
    else {
      bindFixtureModels(db);
      await verify(db, expectationsPath);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Restore fixture failed'}\n`);
  process.exitCode = 1;
});
