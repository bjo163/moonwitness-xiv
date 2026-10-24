import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importQuranPassage, readQuranPassage } from '../src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const editionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
const locator = 'Q7:46';
const expectedSha256 = '6ff83b01099fb7992b5f7fa101cfab3d6556607ca6b1fe69d53cb76f97027760';

describe('checked-in Tanzil Q7:46 source slice', () => {
  it('retrieves the pinned edition and exact source bytes without a network dependency', async () => {
    const passage = await readQuranPassage({
      rootDirectory: repositoryRoot,
      editionId,
      locator,
    });
    const bytes = await readFile(
      path.join(
        repositoryRoot,
        'corpus/reference/sha256/6f/6ff83b01099fb7992b5f7fa101cfab3d6556607ca6b1fe69d53cb76f97027760'
      )
    );

    expect(passage.editionId).toBe(editionId);
    expect(passage.locator).toBe(locator);
    expect(passage.sha256).toBe(expectedSha256);
    expect(passage.originalBytes.byteLength).toBe(360);
    expect(passage.originalBytes).toEqual(bytes);
    expect(passage.text.length).toBeGreaterThan(0);
  });

  it('retains the required Tanzil notice and makes repeated local import a no-op', async () => {
    const notice = await readFile(
      path.join(repositoryRoot, 'corpus/reference/notices/tanzil-quran-text-v1.1-cc-by-3.0.txt'),
      'utf8'
    );
    const imported = await importQuranPassage({
      rootDirectory: repositoryRoot,
      editionId,
      locator,
      artifactStorePath: 'corpus/reference',
    });

    expect(notice).toContain('Copyright (C) 2007-2021 Tanzil Project');
    expect(notice).toContain('License: Creative Commons Attribution 3.0');
    expect(imported.artifact.sha256).toBe(expectedSha256);
    expect(imported.artifact.created).toBe(false);
  });
});
