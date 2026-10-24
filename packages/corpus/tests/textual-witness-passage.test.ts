import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readTextualWitnessPassage,
  readTextualWitnessPassageSnapshot,
} from '../src/textual-witness-passage.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const indexRelative = 'corpus/manifests/textual-witness-index.json';
const manifestRelative = 'corpus/manifests/webp-protestant-genesis-1-1.json';
const artifactRelative =
  'corpus/reference/sha256/ae/ae5c2799fad97b0e65334aa39be6193d487419f0d31713caaac58a47f6b4d8b1';
const request = {
  expressionId: 'mw:expression:webp-protestant',
  editionId: 'mw:edition:webp-protestant-2020-stable',
  locator: 'Genesis 1:1',
};
const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-textual-witness-'));
  roots.push(root);
  await mkdir(path.join(root, 'corpus/manifests'), { recursive: true });
  await mkdir(path.dirname(path.join(root, artifactRelative)), { recursive: true });
  await Promise.all(
    [indexRelative, manifestRelative, artifactRelative].map((relativePath) =>
      copyFile(path.join(repositoryRoot, relativePath), path.join(root, relativePath))
    )
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('offline textual witness passage retrieval', () => {
  it('returns the exact verified WEBP excerpt with distinct expression and edition identities', async () => {
    const root = await setup();
    const passage = await readTextualWitnessPassage({ rootDirectory: root, ...request });
    const sourceBytes = await readFile(path.join(root, artifactRelative));

    expect(passage).toMatchObject({
      sourceId: 'mw:source:ebible-webp-protestant',
      expressionId: request.expressionId,
      editionId: request.editionId,
      locale: 'en-US',
      locator: request.locator,
      sha256: 'ae5c2799fad97b0e65334aa39be6193d487419f0d31713caaac58a47f6b4d8b1',
    });
    expect(passage.expressionId).not.toBe(passage.editionId);
    expect(passage.originalBytes).toEqual(sourceBytes);
    expect(passage.text.endsWith('.')).toBe(true);
    expect(passage.attribution).toContain('“World English Bible” is an eBible.org trademark');
    expect(passage.attribution).toContain('does not imply eBible.org endorsement');
    expect(passage.attribution).toContain('do not label the changed text “World English Bible”');
    expect(passage.references).toContain('https://ebible.org/engwebp/GEN01.htm');
  });

  it('returns the exact validated manifest bytes only from the dedicated snapshot reader', async () => {
    const root = await setup();
    const snapshot = await readTextualWitnessPassageSnapshot({ rootDirectory: root, ...request });

    expect(snapshot.sourceArtifactId).toBe('mw:artifact:webp-protestant-genesis-1-1');
    expect(snapshot.sourceManifestBytes).toEqual(await readFile(path.join(root, manifestRelative)));
    expect(snapshot.passage).not.toHaveProperty('sourceManifestBytes');
    expect(snapshot.passage).not.toHaveProperty('source_manifest_bytes');
  });

  it('allows exact artifact storage only when the source manifest grants store', async () => {
    const root = await setup();
    const stored = await readTextualWitnessPassageSnapshot({
      rootDirectory: root,
      ...request,
      use: 'store',
    });
    expect(stored.sourceArtifactId).toBe('mw:artifact:webp-protestant-genesis-1-1');

    const filePath = path.join(root, manifestRelative);
    const manifest = JSON.parse(await readFile(filePath, 'utf8')) as {
      rights: { allowed_uses: string[] };
    };
    manifest.rights.allowed_uses = ['read_analyze', 'quote_excerpt', 'redistribute_full'];
    await writeFile(filePath, JSON.stringify(manifest));
    await expect(
      readTextualWitnessPassageSnapshot({ rootDirectory: root, ...request, use: 'store' })
    ).rejects.toThrow('rights do not permit requested use: store');
  });

  it('rejects unknown expression, edition, or locator tuples', async () => {
    const root = await setup();
    await expect(
      readTextualWitnessPassage({
        rootDirectory: root,
        ...request,
        expressionId: 'mw:expression:unknown',
      })
    ).rejects.toThrow('Unknown textual witness');
    await expect(
      readTextualWitnessPassage({ rootDirectory: root, ...request, locator: 'Genesis 1:2' })
    ).rejects.toThrow('Unknown textual witness');
  });

  it('fails closed when the manifest does not grant quote_excerpt', async () => {
    const root = await setup();
    const filePath = path.join(root, manifestRelative);
    const manifest = JSON.parse(await readFile(filePath, 'utf8')) as {
      rights: { allowed_uses: string[] };
    };
    manifest.rights.allowed_uses = ['redistribute_full'];
    await writeFile(filePath, JSON.stringify(manifest));

    await expect(readTextualWitnessPassage({ rootDirectory: root, ...request })).rejects.toThrow(
      'rights do not permit excerpt quotation'
    );
  });

  it('checks the explicitly requested read_analyze use against the local manifest', async () => {
    const root = await setup();
    const filePath = path.join(root, manifestRelative);
    const manifest = JSON.parse(await readFile(filePath, 'utf8')) as {
      rights: { allowed_uses: string[] };
    };
    manifest.rights.allowed_uses = ['redistribute_full'];
    await writeFile(filePath, JSON.stringify(manifest));

    await expect(
      readTextualWitnessPassage({ rootDirectory: root, ...request, use: 'read_analyze' })
    ).rejects.toThrow('rights do not permit requested use: read_analyze');
  });

  it('denies storage when the manifest omits the store grant', async () => {
    const root = await setup();
    const stored = await readTextualWitnessPassageSnapshot({
      rootDirectory: root,
      ...request,
      use: 'store',
    });
    expect(stored.sourceArtifactId).toBe('mw:artifact:webp-protestant-genesis-1-1');

    const filePath = path.join(root, manifestRelative);
    const manifest = JSON.parse(await readFile(filePath, 'utf8')) as {
      rights: { allowed_uses: string[] };
    };
    manifest.rights.allowed_uses = ['read_analyze', 'redistribute_full'];
    await writeFile(filePath, JSON.stringify(manifest));
    await expect(
      readTextualWitnessPassageSnapshot({ rootDirectory: root, ...request, use: 'store' })
    ).rejects.toThrow('rights do not permit requested use: store');
  });

  it('rejects traversal paths and corrupt bytes instead of returning unchecked text', async () => {
    const root = await setup();
    const indexFile = path.join(root, indexRelative);
    const index = JSON.parse(await readFile(indexFile, 'utf8')) as {
      entries: Array<{ artifact_path: string }>;
    };
    index.entries[0]!.artifact_path = '../outside';
    await writeFile(indexFile, JSON.stringify(index));
    await expect(readTextualWitnessPassage({ rootDirectory: root, ...request })).rejects.toThrow(
      'parent segments'
    );

    const freshRoot = await setup();
    await writeFile(path.join(freshRoot, artifactRelative), 'tampered text\n');
    await expect(
      readTextualWitnessPassage({ rootDirectory: freshRoot, ...request })
    ).rejects.toThrow('checksum or size mismatch');
  });
});
