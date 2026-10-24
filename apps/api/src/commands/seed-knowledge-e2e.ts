import path from 'node:path';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readQuranPassage } from '@moonwitness/corpus';
import { manifest as authManifest } from '@moonwitness/auth';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as requestManifest } from '@moonwitness/orm-request';
import { manifest as workflowManifest } from '@moonwitness/orm-workflow';
import {
  activateResearchGraphRelease,
  createResearchGraphRelease,
  readActiveResearchGraphRelease,
  type ResearchGraphRecordInput,
} from '@moonwitness/orm-knowledge';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { manifest as knowledgeManifest } from '@moonwitness/orm-knowledge';
import { config } from '../config/env.js';
import { createDatabase } from '../database/knex.js';

const sourceId = 'mw:source:tanzil-quran-text';
const editionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
const scopeId = 'mw:concept:e2e-live-knowledge-scope';
const assertionId = 'mw:assertion:e2e-live-knowledge';
const evidenceId = 'mw:evidence:e2e-live-knowledge';
const relationId = 'mw:relation:e2e-live-knowledge';
const subjectId = 'mw:entity:e2e-live-knowledge-subject';
const objectId = 'mw:entity:e2e-live-knowledge-object';
const claim = 'Synthetic local PostgreSQL Board E2E assertion.';
const locator = 'Q7:46';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesPublicMetadataRecord(
  value: unknown,
  id: string,
  recordKind: 'source' | 'expression',
  contentKind: 'Artifact' | 'Edition'
): boolean {
  if (
    !isRecord(value) ||
    value.key !== id ||
    value.kind !== recordKind ||
    value.visibility !== 'PUBLIC'
  ) {
    return false;
  }
  const content = value.content;
  return (
    isRecord(content) &&
    Object.keys(content).length === 3 &&
    content.id === id &&
    content.kind === contentKind &&
    content.visibility === 'PUBLIC_APPROVED'
  );
}

function assertIsE2eDatabase(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL test URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  const loopback =
    hostname === 'localhost' ||
    hostname === '::1' ||
    (isIP(hostname) === 4 && Number(hostname.split('.')[0]) === 127);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!loopback || !/(?:^|[_-])(?:test|e2e|ci)(?:$|[_-])/iu.test(databaseName)) {
    throw new Error(
      'Knowledge E2E fixture refused: DATABASE_URL must target a loopback test/e2e/ci database.'
    );
  }
}

function fixtureRecords(contentSha256: string): ResearchGraphRecordInput[] {
  return [
    {
      key: scopeId,
      kind: 'node',
      visibility: 'INTERNAL',
      content: {
        id: scopeId,
        kind: 'Concept',
        identity_class: 'ConceptIdentity',
        visibility: 'INTERNAL',
      },
    },
    ...([subjectId, objectId] as const).map((id) => ({
      key: id,
      kind: 'node' as const,
      visibility: 'INTERNAL' as const,
      content: {
        id,
        kind: 'Entity' as const,
        identity_class: 'Entity' as const,
        visibility: 'INTERNAL' as const,
      },
    })),
    {
      key: assertionId,
      kind: 'assertion',
      visibility: 'INTERNAL',
      content: {
        id: assertionId,
        kind: 'Assertion',
        schema_version: 1,
        lifecycle: 'candidate',
        created_at: '2026-10-17T00:00:00.000Z',
        updated_at: '2026-10-17T00:00:00.000Z',
        origin_ref: 'fixture://board-e2e/knowledge-search/001',
        visibility: 'INTERNAL',
        content_revision: 1,
        claim,
        polarity: 'positive',
        scope: { kind: 'research_context', reference_id: scopeId },
        context: { mode: 'analysis', reference_id: scopeId },
        epistemic_status: 'hypothesized',
        review_status: 'pending',
      },
    },
    {
      key: evidenceId,
      kind: 'evidence',
      visibility: 'INTERNAL',
      content: {
        id: evidenceId,
        kind: 'Evidence',
        visibility: 'INTERNAL',
        assertion_id: assertionId,
        direction: 'supporting',
        selector: {
          source_id: sourceId,
          edition_id: editionId,
          locator,
          content_sha256: contentSha256,
        },
      },
    },
    relationFixtureRecord(),
  ];
}

function relationFixtureRecord(): ResearchGraphRecordInput {
  return {
    key: relationId,
    kind: 'relation',
    visibility: 'INTERNAL',
    content: {
      id: relationId,
      kind: 'ResearchRelation',
      schema_version: 1,
      lifecycle: 'candidate',
      created_at: '2026-10-18T00:00:00.000Z',
      updated_at: '2026-10-18T00:00:00.000Z',
      origin_ref: 'fixture://board-e2e/knowledge-search/relation-001',
      content_revision: 1,
      visibility: 'INTERNAL',
      predicate: 'related_to',
      subject_id: subjectId,
      object_id: objectId,
      scope: { kind: 'research_context', reference_id: scopeId },
      supporting_evidence_ids: [evidenceId],
      counterevidence_ids: [],
      alternative_relation_ids: [],
      epistemic_status: 'unreviewed',
      review_status: 'pending',
    },
  };
}

async function seed(): Promise<{ status: 'seeded' | 'already-present'; releaseDigest: string }> {
  const connectionString = config.db.connection;
  assertIsE2eDatabase(connectionString);

  const passage = await readQuranPassage({
    rootDirectory: repositoryRoot,
    editionId,
    locator,
    use: 'read_analyze',
  });
  const db = createDatabase();
  try {
    await installAddons(db, [
      baseManifest,
      authManifest,
      jobsManifest,
      notificationManifest,
      workflowManifest,
      requestManifest,
      knowledgeManifest,
    ]);
    return await db.transaction(async (trx) => {
      const active = await readActiveResearchGraphRelease(trx, 'research');
      const existingAssertion = active?.records.find((record) => record.key === assertionId);
      if (existingAssertion) {
        if (!active) throw new Error('The active research release is unavailable.');
        const existingSource = active.records.find((record) => record.key === sourceId);
        const existingEdition = active.records.find((record) => record.key === editionId);
        const recordsByKey = new Map(active.records.map((record) => [record.key, record]));
        const fixtureMatches = fixtureRecords(passage.sha256).every((expected) => {
          const actual = recordsByKey.get(expected.key);
          return (
            actual !== undefined &&
            actual.kind === expected.kind &&
            actual.visibility === expected.visibility &&
            isDeepStrictEqual(actual.content, expected.content)
          );
        });
        if (
          !fixtureMatches ||
          !matchesPublicMetadataRecord(existingSource, sourceId, 'source', 'Artifact') ||
          !matchesPublicMetadataRecord(existingEdition, editionId, 'expression', 'Edition')
        ) {
          throw new Error('An existing knowledge E2E fixture has conflicting content.');
        }
        return { status: 'already-present', releaseDigest: active.releaseDigest };
      }

      const reservedIds = new Set([
        scopeId,
        assertionId,
        evidenceId,
        relationId,
        subjectId,
        objectId,
      ]);
      if (active?.records.some((record) => reservedIds.has(record.key))) {
        throw new Error('A partial knowledge E2E fixture already exists in the active release.');
      }
      const records: ResearchGraphRecordInput[] =
        active?.records.map(({ key, kind, visibility, content }) => ({
          key,
          kind,
          visibility,
          content,
        })) ?? [];
      const keys = new Set(records.map((record) => record.key));
      const existingSource = records.find((record) => record.key === sourceId);
      const existingEdition = records.find((record) => record.key === editionId);
      if (
        (existingSource &&
          !matchesPublicMetadataRecord(existingSource, sourceId, 'source', 'Artifact')) ||
        (existingEdition &&
          !matchesPublicMetadataRecord(existingEdition, editionId, 'expression', 'Edition'))
      ) {
        throw new Error('A knowledge E2E source or edition record has conflicting content.');
      }
      if (!keys.has(sourceId)) {
        records.push({
          key: sourceId,
          kind: 'source',
          visibility: 'PUBLIC',
          content: { id: sourceId, kind: 'Artifact', visibility: 'PUBLIC_APPROVED' },
        });
      }
      if (!keys.has(editionId)) {
        records.push({
          key: editionId,
          kind: 'expression',
          visibility: 'PUBLIC',
          content: { id: editionId, kind: 'Edition', visibility: 'PUBLIC_APPROVED' },
        });
      }
      records.push(...fixtureRecords(passage.sha256));

      const release = await createResearchGraphRelease(trx, {
        corpusKey: 'research',
        schemaVersion: 'research-graph/v1',
        previousReleaseDigest: active?.releaseDigest ?? null,
        records,
      });
      await activateResearchGraphRelease(trx, {
        corpusKey: 'research',
        releaseDigest: release.releaseDigest,
        expectedCurrentReleaseDigest: active?.releaseDigest ?? null,
        activatedAt: '2026-10-17T00:00:00.000Z',
      });
      return { status: 'seeded', releaseDigest: release.releaseDigest };
    });
  } finally {
    await db.destroy();
  }
}

seed()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })
  .catch(() => {
    process.stderr.write('Failed to seed the isolated knowledge E2E fixture.\n');
    process.exitCode = 1;
  });
