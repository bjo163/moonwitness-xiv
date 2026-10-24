import type { Knex } from 'knex';

const reviewWorkflow = {
  startState: 'submitted',
  startRoles: ['user', 'superadmin'],
  timeoutMinutes: 10080,
  resourceModels: ['knowledge.research_graph_record'],
  transitions: [
    {
      action: 'approve',
      from: 'submitted',
      to: 'approved',
      roles: ['user', 'superadmin'],
      requireDifferentActor: true,
    },
    {
      action: 'reject',
      from: 'submitted',
      to: 'rejected',
      roles: ['user', 'superadmin'],
      requireDifferentActor: true,
    },
  ],
} as const;

/** Seed the API-owned review workflow without coupling generic workflow packages to research. */
export async function ensureResearchReviewWorkflow(db: Knex): Promise<void> {
  const config = JSON.stringify(reviewWorkflow);
  await db.transaction(async (trx) => {
    if (trx.client.config.client === 'pg') {
      await trx.raw('select pg_advisory_xact_lock(?, hashtext(?))', [
        1297564238,
        'moonwitness.workflow.research-review.install',
      ]);
    }
    const latest = await trx('workflow_definitions')
      .where({ code: 'research.review', enabled: true })
      .orderBy('version', 'desc')
      .forUpdate()
      .first('version', 'config');
    if (latest && (Number(latest.version) !== 1 || String(latest.config) !== config)) {
      throw new Error(
        'The selected research.review workflow definition differs from the API contract'
      );
    }
    const existing = await trx('workflow_definitions')
      .where({ code: 'research.review', version: 1 })
      .first('config', 'enabled');
    if (existing) {
      if (
        String(existing.config) !== config ||
        (existing.enabled !== true && existing.enabled !== 1 && existing.enabled !== '1')
      ) {
        throw new Error(
          'The installed research.review workflow definition differs from the API contract'
        );
      }
      return;
    }
    await trx('workflow_definitions').insert({
      code: 'research.review',
      version: 1,
      name: 'Research review',
      config,
      enabled: true,
    });
  });
}
