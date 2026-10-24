import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import type { StoredResearchGraphRelease } from '@moonwitness/orm-knowledge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { researchDuplicateCandidateRoutes } from '../src/routes/research-duplicate-candidates.routes.js';

const digest = 'a'.repeat(64);
const scopeId = 'mw:concept:duplicate-scope';
const assertion = (id: string, visibility = 'INTERNAL', claim = 'A bounded synthetic claim.') => ({
  id,
  kind: 'Assertion',
  schema_version: 1,
  lifecycle: 'candidate',
  created_at: '2026-10-16T00:00:00.000Z',
  updated_at: '2026-10-16T00:00:00.000Z',
  origin_ref: 'fixture://duplicate-candidates',
  visibility,
  content_revision: 1,
  claim,
  polarity: 'positive',
  scope: { kind: 'research_context', reference_id: scopeId },
  context: { mode: 'analysis', reference_id: scopeId },
  epistemic_status: 'hypothesized',
  review_status: 'pending',
});

function release(records: StoredResearchGraphRelease['records'] = []) {
  return {
    corpusKey: 'research',
    releaseDigest: digest,
    manifestDigest: digest,
    manifestJson: '{}',
    schemaVersion: 'research-graph/v1',
    previousReleaseDigest: null,
    records,
  } satisfies StoredResearchGraphRelease;
}

function record(key: string, kind: 'assertion' | 'evidence', visibility: string, content: unknown) {
  return {
    key,
    kind,
    visibility,
    content,
    contentDigest: 'b'.repeat(64),
  } as StoredResearchGraphRelease['records'][number];
}

describe('research duplicate candidates API', () => {
  afterEach(() => vi.restoreAllMocks());

  async function createApp(
    activeRelease: StoredResearchGraphRelease | null,
    role?: string,
    companyId?: number | null,
    membershipState: 'active' | 'inactive' = 'active',
    companyState: 'active' | 'inactive' = 'active'
  ) {
    const effectiveCompanyId =
      companyId === null
        ? undefined
        : (companyId ?? (role === 'user' || role === 'superadmin' ? 12 : undefined));
    const app = Fastify();
    app.decorateRequest('auth', null);
    app.decorate('knex', {
      transaction: async (callback: (trx: (table: string) => unknown) => Promise<unknown>) => {
        const trx = (table: string) => {
          let conditions: Record<string, unknown> = {};
          const query = {
            where: (next: Record<string, unknown>) => {
              conditions = next;
              return query;
            },
            forUpdate: () => query,
            first: async () => {
              if (table === 'companies') {
                return companyState === 'active' && conditions.active === true
                  ? { id: conditions.id }
                  : undefined;
              }
              if (table === 'company_memberships') {
                return membershipState === 'active' &&
                  conditions.active === true &&
                  conditions.user_id === 1 &&
                  conditions.company_id === effectiveCompanyId
                  ? { id: 10 }
                  : undefined;
              }
              return undefined;
            },
          };
          return query;
        };
        return callback(trx);
      },
    } as never);
    app.addHook('onRequest', async (request) => {
      if (role === 'system' || role === 'superadmin' || role === 'user') {
        request.auth = { userId: 1, role, companyId: effectiveCompanyId, groupPermissions: [] };
      }
    });
    const readActiveRelease = vi.fn(async () => activeRelease);
    await app.register(researchDuplicateCandidateRoutes, { readActiveRelease });
    return { app, readActiveRelease };
  }

  it('requires authentication and rechecks active company membership for human research roles', async () => {
    const anonymous = await createApp(release());
    const anonymousResponse = await anonymous.app.inject({
      method: 'GET',
      url: '/api/research/duplicate-candidates',
    });
    expect(anonymousResponse.statusCode).toBe(401);
    expect(anonymousResponse.headers['cache-control']).toBe('private, no-store');
    expect(anonymous.readActiveRelease).not.toHaveBeenCalled();
    await anonymous.app.close();

    const user = await createApp(release(), 'user', 12);
    const userResponse = await user.app.inject({
      method: 'GET',
      url: '/api/research/duplicate-candidates',
    });
    expect(userResponse.statusCode).toBe(200);
    expect(user.readActiveRelease).toHaveBeenCalledTimes(1);
    await user.app.close();

    for (const role of ['user', 'superadmin'] as const) {
      const inactiveMembership = await createApp(release(), role, 12, 'inactive');
      const inactiveMembershipResponse = await inactiveMembership.app.inject({
        method: 'GET',
        url: '/api/research/duplicate-candidates',
      });
      expect(inactiveMembershipResponse.statusCode).toBe(403);
      expect(inactiveMembership.readActiveRelease).not.toHaveBeenCalled();
      await inactiveMembership.app.close();
    }

    const inactiveCompany = await createApp(release(), 'user', 12, 'active', 'inactive');
    const inactiveCompanyResponse = await inactiveCompany.app.inject({
      method: 'GET',
      url: '/api/research/duplicate-candidates',
    });
    expect(inactiveCompanyResponse.statusCode).toBe(403);
    expect(inactiveCompany.readActiveRelease).not.toHaveBeenCalled();
    await inactiveCompany.app.close();

    const userWithoutCompany = await createApp(release(), 'user', null);
    const userWithoutCompanyResponse = await userWithoutCompany.app.inject({
      method: 'GET',
      url: '/api/research/duplicate-candidates',
    });
    expect(userWithoutCompanyResponse.statusCode).toBe(403);
    expect(userWithoutCompany.readActiveRelease).not.toHaveBeenCalled();
    await userWithoutCompany.app.close();

    const superadminWithoutCompany = await createApp(release(), 'superadmin', null);
    const superadminWithoutCompanyResponse = await superadminWithoutCompany.app.inject({
      method: 'GET',
      url: '/api/research/duplicate-candidates',
    });
    expect(superadminWithoutCompanyResponse.statusCode).toBe(403);
    expect(superadminWithoutCompany.readActiveRelease).not.toHaveBeenCalled();
    await superadminWithoutCompany.app.close();
  });

  it('returns only deterministic unresolved candidates from the active INTERNAL snapshot', async () => {
    const leftId = 'mw:assertion:duplicate-left';
    const rightId = 'mw:assertion:duplicate-right';
    const hiddenId = 'mw:assertion:duplicate-hidden';
    const releaseSnapshot = release([
      record(leftId, 'assertion', 'PUBLIC', assertion(leftId, 'PUBLIC_APPROVED')),
      record(rightId, 'assertion', 'INTERNAL', assertion(rightId)),
      record(hiddenId, 'assertion', 'RESTRICTED', assertion(hiddenId, 'RESTRICTED')),
    ]);
    const { app, readActiveRelease } = await createApp(releaseSnapshot, 'superadmin');
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/research/duplicate-candidates',
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(readActiveRelease).toHaveBeenCalledTimes(1);
      expect(response.json()).toMatchObject({
        success: true,
        data: {
          release_digest: digest,
          truncated: false,
          candidates: [
            {
              left_id: leftId,
              right_id: rightId,
              status: 'unresolved',
              kind: 'duplicate',
            },
          ],
        },
      });
      expect(response.body).not.toContain(hiddenId);
      expect(response.body).not.toContain('bounded synthetic claim');
    } finally {
      await app.close();
    }
  });

  it('produces byte-identical candidates when restricted assertions are added', async () => {
    const visible = release([
      record(
        'mw:assertion:stable-left',
        'assertion',
        'INTERNAL',
        assertion('mw:assertion:stable-left')
      ),
      record(
        'mw:assertion:stable-right',
        'assertion',
        'INTERNAL',
        assertion('mw:assertion:stable-right')
      ),
    ]);
    const withRestricted = release([
      ...visible.records,
      record(
        'mw:assertion:private-extra',
        'assertion',
        'RESTRICTED',
        assertion('mw:assertion:private-extra', 'RESTRICTED', 'secret assertion text')
      ),
    ]);
    const first = await createApp(visible, 'system');
    const second = await createApp(withRestricted, 'system');
    try {
      const firstResponse = await first.app.inject({
        method: 'GET',
        url: '/api/research/duplicate-candidates',
      });
      const secondResponse = await second.app.inject({
        method: 'GET',
        url: '/api/research/duplicate-candidates',
      });
      expect(firstResponse.json().data.candidates).toEqual(secondResponse.json().data.candidates);
      expect(secondResponse.body).not.toContain('secret assertion text');
    } finally {
      await first.app.close();
      await second.app.close();
    }
  });

  it('omits evidence attached to hidden assertions and remains independent of its IDs', async () => {
    const readableLeft = 'mw:assertion:evidence-left';
    const readableRight = 'mw:assertion:evidence-right';
    const privateAssertion = 'mw:assertion:private-parent';
    const commonSelector = {
      source_id: 'mw:source:tanzil-quran-text',
      edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
      locator: 'Q7:46',
      content_sha256: 'c'.repeat(64),
    };
    const base = [
      record(
        readableLeft,
        'assertion',
        'INTERNAL',
        assertion(readableLeft, 'INTERNAL', 'different claim alpha')
      ),
      record(
        readableRight,
        'assertion',
        'INTERNAL',
        assertion(readableRight, 'INTERNAL', 'different claim beta')
      ),
    ];
    const hiddenEvidence = record('mw:evidence:private-only', 'evidence', 'RESTRICTED', {
      id: 'mw:evidence:private-only',
      kind: 'Evidence',
      visibility: 'RESTRICTED',
      assertion_id: privateAssertion,
      direction: 'supporting',
      selector: commonSelector,
    });
    const appOne = await createApp(release(base), 'system');
    const appTwo = await createApp(release([...base, hiddenEvidence]), 'system');
    try {
      const one = await appOne.app.inject({
        method: 'GET',
        url: '/api/research/duplicate-candidates',
      });
      const two = await appTwo.app.inject({
        method: 'GET',
        url: '/api/research/duplicate-candidates',
      });
      expect(one.json().data.candidates).toEqual(two.json().data.candidates);
      expect(two.body).not.toContain('private-only');
    } finally {
      await appOne.app.close();
      await appTwo.app.close();
    }
  });

  it('truncates candidate and evidence output at fixed route limits', async () => {
    const assertions = Array.from({ length: 16 }, (_, index) => {
      const id = `mw:assertion:bulk-${String(index).padStart(2, '0')}`;
      return record(
        id,
        'assertion',
        'INTERNAL',
        assertion(id, 'INTERNAL', `shared claim ${index}`)
      );
    });
    const { app } = await createApp(release(assertions), 'system');
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/research/duplicate-candidates',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.candidates).toHaveLength(100);
      expect(response.json().data.truncated).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('drops a candidate rather than exceeding the evidence ID response budget', async () => {
    const leftId = 'mw:assertion:evidence-budget-left';
    const rightId = 'mw:assertion:evidence-budget-right';
    const selector = {
      source_id: 'mw:source:tanzil-quran-text',
      edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
      locator: 'Q7:46',
      content_sha256: 'e'.repeat(64),
    };
    const records = [
      record(leftId, 'assertion', 'INTERNAL', assertion(leftId)),
      record(rightId, 'assertion', 'INTERNAL', assertion(rightId)),
      ...[leftId, rightId].flatMap((assertionId, group) =>
        Array.from({ length: 251 }, (_, index) => {
          const id = `mw:evidence:budget-${group}-${String(index).padStart(3, '0')}`;
          return record(id, 'evidence', 'INTERNAL', {
            id,
            kind: 'Evidence',
            visibility: 'INTERNAL',
            assertion_id: assertionId,
            direction: 'supporting',
            selector,
          });
        })
      ),
    ];
    const { app } = await createApp(release(records), 'system');
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/research/duplicate-candidates',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.candidates).toEqual([]);
      expect(response.json().data.truncated).toBe(true);
      expect(response.body.length).toBeLessThan(2_000);
    } finally {
      await app.close();
    }
  });

  it('fails closed for oversized, malformed and unavailable releases', async () => {
    const malformed = release([
      record('mw:assertion:malformed', 'assertion', 'INTERNAL', {
        id: 'mw:assertion:malformed',
        kind: 'Wrong',
      }),
    ]);
    const oversized = release(
      Array.from({ length: 5_001 }, (_, index) => ({
        key: `mw:assertion:oversize-${index}`,
        kind: 'assertion' as const,
        visibility: 'INTERNAL' as const,
        content: assertion(`mw:assertion:oversize-${index}`),
        contentDigest: 'd'.repeat(64),
      }))
    );
    for (const snapshot of [malformed, oversized, null]) {
      const { app } = await createApp(snapshot, 'system');
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/api/research/duplicate-candidates',
        });
        expect(response.statusCode).toBe(503);
        expect(response.body).not.toContain('malformed');
      } finally {
        await app.close();
      }
    }
  });

  it('documents authenticated success and generic errors in OpenAPI', async () => {
    const app = Fastify();
    await app.register(swagger, {
      openapi: {
        info: { title: 'Test API', version: '1.0.0' },
        components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      },
    });
    await app.register(researchDuplicateCandidateRoutes, { readActiveRelease: async () => null });
    await app.ready();
    try {
      const operation = (
        app.swagger().paths as Record<
          string,
          { get: { security: unknown; responses: Record<string, unknown> } }
        >
      )['/api/research/duplicate-candidates']!.get;
      expect(operation.security).toEqual([{ bearerAuth: [] }]);
      expect(Object.keys(operation.responses).sort()).toEqual(['200', '401', '403', '503']);
    } finally {
      await app.close();
    }
  });
});
