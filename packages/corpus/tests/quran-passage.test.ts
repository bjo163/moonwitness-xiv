import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importQuranPassage, readQuranPassage, readQuranPassageSnapshot } from '../src/index.js';

const roots: string[] = [];
const editionId = 'mw:edition:test-quran-v1';
const sourceManifestPath = 'corpus/manifests/test-source.json';

async function setup(options: { rightsState?: string; allowedUses?: string[] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-quran-passage-'));
  roots.push(root);
  await mkdir(path.join(root, 'corpus/manifests'), { recursive: true });
  await mkdir(path.join(root, 'corpus/reference/sha256'), { recursive: true });
  await mkdir(path.join(root, 'corpus/imported'), { recursive: true });
  const sourceBytes = Buffer.from('7|46|نص آية تجريبي\n', 'utf8');
  const sha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const artifactPath = `corpus/reference/sha256/${sha256.slice(0, 2)}/${sha256}`;
  await mkdir(path.dirname(path.join(root, artifactPath)), { recursive: true });
  await writeFile(path.join(root, artifactPath), sourceBytes);
  const manifest = {
    schema_version: 1,
    source_id: 'mw:source:test-quran',
    edition_id: editionId,
    locale: 'ar',
    references: ['https://example.test/source', 'https://example.test/license'],
    artifact: {
      representation: 'source_bytes',
      media_type: 'text/plain; charset=utf-8',
      sha256,
      byte_length: sourceBytes.byteLength,
      retrieved_at: '2026-10-16T00:00:00Z',
    },
    rights: {
      state: options.rightsState ?? 'permitted',
      allowed_uses: options.allowedUses ?? [
        'read_analyze',
        'store',
        'quote_excerpt',
        'redistribute_full',
      ],
      reviewer: 'synthetic-test-owner',
      decision_date: '2026-10-16',
      evidence_ref: 'synthetic-test-policy',
      scope: 'Synthetic test fixture only',
    },
    attribution: {
      text: 'Synthetic fixture attribution',
      display_locations: ['synthetic test output'],
    },
    complaint_process_owner: 'synthetic-test-owner',
    publication: { mode: 'source_bytes', release_ref: 'synthetic-test-release' },
  };
  await writeFile(path.join(root, sourceManifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  const index = {
    format: 'moonwitness-quran-passage-index/v1',
    entries: [
      {
        edition_id: editionId,
        locator: 'Q7:46',
        source_manifest_path: sourceManifestPath,
        artifact_path: artifactPath,
        sha256,
      },
    ],
  };
  await writeFile(
    path.join(root, 'corpus/manifests/quran-passage-index.json'),
    `${JSON.stringify(index, null, 2)}\n`
  );
  return { root, sourceBytes, artifactPath, sha256 };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Qur’an passage retrieval and local import', () => {
  it('retrieves the exact source line and verse text by edition and locator', async () => {
    const { root, sourceBytes, sha256 } = await setup();
    const passage = await readQuranPassage({ rootDirectory: root, editionId, locator: 'Q7:46' });

    expect(passage.text).toBe('نص آية تجريبي');
    expect(passage.originalBytes).toEqual(sourceBytes);
    expect(passage.sha256).toBe(sha256);
    expect(passage.attribution).toBe('Synthetic fixture attribution');
  });

  it('returns the exact validated manifest bytes through the dedicated snapshot reader only', async () => {
    const { root } = await setup();
    const snapshot = await readQuranPassageSnapshot({
      rootDirectory: root,
      editionId,
      locator: 'Q7:46',
    });

    expect(snapshot.sourceManifestBytes).toEqual(
      await readFile(path.join(root, sourceManifestPath))
    );
    expect(snapshot.passage).not.toHaveProperty('sourceManifestBytes');
    expect(snapshot.passage).not.toHaveProperty('source_manifest_bytes');
    expect(snapshot.sourceId).toBe('mw:source:test-quran');
  });

  it('rejects unknown editions and passage locators', async () => {
    const { root } = await setup();
    await expect(
      readQuranPassage({ rootDirectory: root, editionId: 'mw:edition:unknown', locator: 'Q7:46' })
    ).rejects.toThrow('Unknown Quran edition/passage');
    await expect(
      readQuranPassage({ rootDirectory: root, editionId, locator: 'Q7:47' })
    ).rejects.toThrow('Unknown Quran edition/passage');
  });

  it('fails closed when source rights are unknown or do not permit storage', async () => {
    const unknown = await setup({ rightsState: 'unknown' });
    await expect(
      readQuranPassage({ rootDirectory: unknown.root, editionId, locator: 'Q7:46' })
    ).rejects.toThrow('source manifest is invalid or missing rights evidence');

    const noStore = await setup({ allowedUses: ['read_analyze', 'redistribute_full'] });
    await expect(
      importQuranPassage({
        rootDirectory: noStore.root,
        editionId,
        locator: 'Q7:46',
        artifactStorePath: 'corpus/imported',
      })
    ).rejects.toThrow('rights do not permit requested use: store');
  });

  it('rejects missing or checksum-mismatched passage bytes', async () => {
    const { root, artifactPath } = await setup();
    await writeFile(path.join(root, artifactPath), 'tampered\n');
    await expect(
      readQuranPassage({ rootDirectory: root, editionId, locator: 'Q7:46' })
    ).rejects.toThrow('checksum or size mismatch');

    await rm(path.join(root, artifactPath));
    await expect(
      readQuranPassage({ rootDirectory: root, editionId, locator: 'Q7:46' })
    ).rejects.toThrow();
  });

  it('imports exact source bytes idempotently into the local content-addressed store', async () => {
    const { root, sourceBytes, sha256 } = await setup();
    const request = {
      rootDirectory: root,
      editionId,
      locator: 'Q7:46',
      artifactStorePath: 'corpus/imported',
    };
    const first = await importQuranPassage(request);
    const second = await importQuranPassage(request);

    expect(first.passage.originalBytes).toEqual(sourceBytes);
    expect(first.artifact).toMatchObject({ sha256, bytes: sourceBytes.byteLength, created: true });
    expect(second.artifact).toMatchObject({
      sha256,
      bytes: sourceBytes.byteLength,
      created: false,
    });
    await expect(
      readFile(path.join(root, 'corpus/imported', first.artifact.relativePath))
    ).resolves.toEqual(sourceBytes);
  });
});
