import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LocalRetrievalError,
  retrieveLocalPassageChunk,
  type LocalPassageResolver,
  type ResolvedCanonicalPassage,
  type RetrievalVisibility,
} from '../src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const artifactPath = path.join(
  repositoryRoot,
  'corpus/reference/sha256/6f/6ff83b01099fb7992b5f7fa101cfab3d6556607ca6b1fe69d53cb76f97027760'
);
const manifestPath = 'corpus/manifests/tanzil-quran-text-v1.1-uthmani-q7-46.json';
const approvedAttribution =
  'Tanzil Quran Text. Copyright (C) 2007-2021 Tanzil Project. License: Creative Commons Attribution 3.0 (CC BY 3.0). Source: https://tanzil.net/ . This Q7:46 line is reproduced verbatim without modification. See https://tanzil.net/docs/Text_License and https://creativecommons.org/licenses/by/3.0/ .';

async function approvedQuranPassage(): Promise<ResolvedCanonicalPassage> {
  const bytes = await readFile(artifactPath);
  const sourceManifestBytes = await readFile(
    path.join(repositoryRoot, manifestPath.replaceAll('/', path.sep))
  );
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\n$/u, '');
  const separator = line.indexOf('|', line.indexOf('|') + 1);
  return {
    reference: {
      sourceId: 'mw:source:tanzil-quran-text',
      editionId: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
      locator: 'Q7:46',
      sourceSha256,
    },
    text: line.slice(separator + 1),
    visibility: 'PUBLIC_APPROVED',
    sourceManifestPath: manifestPath,
    artifactBytes: bytes,
    sourceManifestBytes,
  };
}

function resolverFor(passage: ResolvedCanonicalPassage, canRead = true): LocalPassageResolver {
  return {
    resolve: async () => passage,
    canRead: () => canRead,
  };
}

describe('local passage retrieval projection', () => {
  it('returns exact canonical citation identity and excerpt-relative byte/scalar span', async () => {
    const passage = await approvedQuranPassage();
    const firstScalar = Array.from(passage.text)[0];
    if (!firstScalar) throw new Error('approved source passage is empty');
    const firstByteLength = Buffer.byteLength(firstScalar, 'utf8');
    const result = await retrieveLocalPassageChunk(
      {
        reference: passage.reference,
        byteStart: firstByteLength,
        byteEnd: firstByteLength + Buffer.byteLength(Array.from(passage.text)[1] ?? '', 'utf8'),
      },
      resolverFor(passage)
    );

    expect(result.text).toBe(Array.from(passage.text)[1]);
    expect(result.citation).toEqual({
      ...passage.reference,
      sourceManifestPath: manifestPath,
      attribution: approvedAttribution,
    });
    expect(result.visibility).toBe('PUBLIC_APPROVED');
    expect(result.sourceSpan).toEqual({
      basis: 'resolved_passage_text',
      byteStart: firstByteLength,
      byteEnd: firstByteLength + Buffer.byteLength(Array.from(passage.text)[1] ?? '', 'utf8'),
      scalarStart: 1,
      scalarEnd: 2,
    });
  });

  it.each<RetrievalVisibility>(['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'CHILD_SENSITIVE'])(
    'denies %s content even when a caller access hook would allow it',
    async (visibility) => {
      const passage = await approvedQuranPassage();
      const restricted: ResolvedCanonicalPassage = {
        ...passage,
        text: `synthetic ${visibility} test content`,
        visibility,
      };
      await expect(
        retrieveLocalPassageChunk({ reference: restricted.reference }, resolverFor(restricted))
      ).rejects.toBeInstanceOf(LocalRetrievalError);
    }
  );

  it('denies public content when the authority hook denies access', async () => {
    const passage = await approvedQuranPassage();
    await expect(
      retrieveLocalPassageChunk({ reference: passage.reference }, resolverFor(passage, false))
    ).rejects.toBeInstanceOf(LocalRetrievalError);
  });

  it('fails closed on missing or mismatched source references and invalid byte boundaries', async () => {
    const passage = await approvedQuranPassage();
    const resolver = resolverFor(passage);
    await expect(
      retrieveLocalPassageChunk({ reference: { ...passage.reference, locator: 'Q7:47' } }, resolver)
    ).rejects.toBeInstanceOf(LocalRetrievalError);
    await expect(
      retrieveLocalPassageChunk(
        { reference: { ...passage.reference, sourceSha256: 'bad' } },
        resolver
      )
    ).rejects.toBeInstanceOf(LocalRetrievalError);
    await expect(
      retrieveLocalPassageChunk({ reference: passage.reference, byteStart: 1 }, resolver)
    ).rejects.toBeInstanceOf(LocalRetrievalError);
  });

  it('rejects Q7:47 even when the resolver returns a matching reference', async () => {
    const passage = await approvedQuranPassage();
    const otherLocator: ResolvedCanonicalPassage = {
      ...passage,
      reference: { ...passage.reference, locator: 'Q7:47' },
    };
    await expect(
      retrieveLocalPassageChunk({ reference: otherLocator.reference }, resolverFor(otherLocator))
    ).rejects.toBeInstanceOf(LocalRetrievalError);
  });

  it('fails closed when the resolver returns a malformed reference', async () => {
    const passage = await approvedQuranPassage();
    const malformed: ResolvedCanonicalPassage = { ...passage, reference: null as never };
    await expect(
      retrieveLocalPassageChunk({ reference: passage.reference }, resolverFor(malformed))
    ).rejects.toBeInstanceOf(LocalRetrievalError);
  });

  it('returns only the vetted snapshot if the access hook mutates its resolver object', async () => {
    const passage = await approvedQuranPassage();
    const expectedText = passage.text;
    const expectedReference = { ...passage.reference };
    const mutatingResolver: LocalPassageResolver = {
      resolve: async () => passage,
      canRead: async () => {
        const mutable = passage as unknown as {
          text: string;
          visibility: RetrievalVisibility;
          reference: { locator: string };
        };
        mutable.text = 'synthetic altered text';
        mutable.visibility = 'RESTRICTED';
        mutable.reference.locator = 'Q7:47';
        return true;
      },
    };

    const result = await retrieveLocalPassageChunk(
      { reference: passage.reference },
      mutatingResolver
    );
    expect(result.text).toBe(expectedText);
    expect(result.citation).toMatchObject(expectedReference);
    expect(result.visibility).toBe('PUBLIC_APPROVED');
  });

  it('rejects altered text or artifact bytes even when the approved hash is claimed', async () => {
    const passage = await approvedQuranPassage();
    await expect(
      retrieveLocalPassageChunk(
        { reference: passage.reference },
        resolverFor({ ...passage, text: `${passage.text} altered` })
      )
    ).rejects.toBeInstanceOf(LocalRetrievalError);

    const changedArtifact = Uint8Array.from(passage.artifactBytes);
    changedArtifact[0] = changedArtifact[0]! ^ 1;
    await expect(
      retrieveLocalPassageChunk(
        { reference: passage.reference },
        resolverFor({ ...passage, artifactBytes: changedArtifact })
      )
    ).rejects.toBeInstanceOf(LocalRetrievalError);
  });

  it('rejects invalid manifest path, content, attribution, and restricted source labels', async () => {
    const passage = await approvedQuranPassage();
    await expect(
      retrieveLocalPassageChunk(
        { reference: passage.reference },
        resolverFor({ ...passage, sourceManifestPath: 'corpus/other.json' })
      )
    ).rejects.toBeInstanceOf(LocalRetrievalError);

    const brokenManifest = Uint8Array.from(passage.sourceManifestBytes);
    brokenManifest[0] = brokenManifest[0]! ^ 1;
    await expect(
      retrieveLocalPassageChunk(
        { reference: passage.reference },
        resolverFor({ ...passage, sourceManifestBytes: brokenManifest })
      )
    ).rejects.toBeInstanceOf(LocalRetrievalError);

    const alteredAttribution = new TextEncoder().encode(
      new TextDecoder()
        .decode(passage.sourceManifestBytes)
        .replace('Tanzil Quran Text.', 'Other text.')
    );
    await expect(
      retrieveLocalPassageChunk(
        { reference: passage.reference },
        resolverFor({ ...passage, sourceManifestBytes: alteredAttribution })
      )
    ).rejects.toBeInstanceOf(LocalRetrievalError);

    const restricted: ResolvedCanonicalPassage = { ...passage, visibility: 'RESTRICTED' };
    await expect(
      retrieveLocalPassageChunk({ reference: passage.reference }, resolverFor(restricted))
    ).rejects.toBeInstanceOf(LocalRetrievalError);
  });
});
