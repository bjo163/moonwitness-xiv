import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { segmentText } from '../src/segmentation.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('deterministic text segmentation', () => {
  it('segments approved Q7:46 source bytes transiently with verified manifest provenance and full coverage', async () => {
    const locator = 'Q7:46';
    const editionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
    const expectedSha256 = '6ff83b01099fb7992b5f7fa101cfab3d6556607ca6b1fe69d53cb76f97027760';
    const artifactPath = path.join(
      repositoryRoot,
      'corpus/reference/sha256/6f/6ff83b01099fb7992b5f7fa101cfab3d6556607ca6b1fe69d53cb76f97027760'
    );
    const [bytes, passageIndex, editionManifest] = await Promise.all([
      readFile(artifactPath),
      readFile(path.join(repositoryRoot, 'corpus/manifests/quran-passage-index.json'), 'utf8').then(
        (raw) =>
          JSON.parse(raw) as {
            entries: {
              edition_id: string;
              locator: string;
              artifact_path: string;
              sha256: string;
            }[];
          }
      ),
      readFile(
        path.join(repositoryRoot, 'corpus/manifests/tanzil-quran-text-v1.1-uthmani-q7-46.json'),
        'utf8'
      ).then(
        (raw) =>
          JSON.parse(raw) as {
            edition_id: string;
            artifact: { sha256: string; byte_length: number };
          }
      ),
    ]);
    const sourceLine = bytes.toString('utf8');
    const entry = passageIndex.entries.find(
      (candidate) => candidate.edition_id === editionId && candidate.locator === locator
    );
    expect(entry).toEqual({
      edition_id: editionId,
      locator,
      source_manifest_path: 'corpus/manifests/tanzil-quran-text-v1.1-uthmani-q7-46.json',
      artifact_path:
        'corpus/reference/sha256/6f/6ff83b01099fb7992b5f7fa101cfab3d6556607ca6b1fe69d53cb76f97027760',
      sha256: expectedSha256,
    });
    expect(editionManifest).toMatchObject({
      edition_id: editionId,
      artifact: { sha256: expectedSha256, byte_length: 360 },
    });
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedSha256);
    expect(bytes.byteLength).toBe(editionManifest.artifact.byte_length);
    expect(sourceLine).toBe(
      '7|46|وَبَيْنَهُمَا حِجَابٌۭ ۚ وَعَلَى ٱلْأَعْرَافِ رِجَالٌۭ يَعْرِفُونَ كُلًّۢا بِسِيمَىٰهُمْ ۚ وَنَادَوْا۟ أَصْحَـٰبَ ٱلْجَنَّةِ أَن سَلَـٰمٌ عَلَيْكُمْ ۚ لَمْ يَدْخُلُوهَا وَهُمْ يَطْمَعُونَ\n'
    );
    expect(sourceLine.startsWith('7|46|')).toBe(true);
    expect(sourceLine.endsWith('\n')).toBe(true);
    const source = sourceLine.slice('7|46|'.length, -1);
    const passageBytes = Buffer.from(source, 'utf8');
    const segments = segmentText(source, { language: 'ar' });
    expect(segments.map(({ text }) => text).join('')).toBe(source);
    expect(segments[0]).toMatchObject({ byte_start: 0, scalar_start: 0 });
    expect(segments.at(-1)?.byte_end).toBe(passageBytes.byteLength);
    expect(segments.at(-1)?.scalar_end).toBe([...source].length);
    let nextByte = 0;
    let nextScalar = 0;
    for (const segment of segments) {
      expect(segment.byte_start).toBe(nextByte);
      expect(segment.scalar_start).toBe(nextScalar);
      expect(passageBytes.subarray(segment.byte_start, segment.byte_end).toString('utf8')).toBe(
        segment.text
      );
      expect([...source].slice(segment.scalar_start, segment.scalar_end).join('')).toBe(
        segment.text
      );
      nextByte = segment.byte_end;
      nextScalar = segment.scalar_end;
    }
    expect(nextByte).toBe(passageBytes.byteLength);
    expect(nextScalar).toBe([...source].length);
  });

  it('returns exact source text and half-open byte/scalar spans across mixed scripts', () => {
    const source = 'Mary مَرْيَم १२٣!';
    const segments = segmentText(source, { language: 'mul' });
    expect(segments.map(({ kind, text }) => [kind, text])).toEqual([
      ['word', 'Mary'],
      ['whitespace', ' '],
      ['word', 'مَرْيَم'],
      ['whitespace', ' '],
      ['number', '१२٣'],
      ['punctuation', '!'],
    ]);
    for (const segment of segments) {
      expect(
        Buffer.from(source).subarray(segment.byte_start, segment.byte_end).toString('utf8')
      ).toBe(segment.text);
      expect([...source].slice(segment.scalar_start, segment.scalar_end).join('')).toBe(
        segment.text
      );
    }
    expect(segments[0]).toMatchObject({ script: 'Latn', scalar_start: 0, scalar_end: 4 });
    expect(segments[2]).toMatchObject({ script: 'Arab', scalar_start: 5, scalar_end: 12 });
  });

  it('keeps combining marks attached and makes normalization an optional derivative', () => {
    const decomposed = 'e\u0301';
    const raw = segmentText(decomposed, { language: 'fr' });
    const normalized = segmentText(decomposed, { language: 'fr', normalize: 'NFC' });
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ text: decomposed, scalar_start: 0, scalar_end: 2 });
    expect(raw[0]).not.toHaveProperty('normalized_text');
    expect(normalized[0]).toMatchObject({ text: decomposed, normalized_text: 'é' });
    expect(normalized[0]).toMatchObject({ script: 'Latn' });
    expect(
      segmentText('\u0301e', { language: 'en' }).map(({ kind, text }) => [kind, text])
    ).toEqual([
      ['symbol', '\u0301'],
      ['word', 'e'],
    ]);
  });

  it('labels Common and inherited marks, and rejects unsupported scripts explicitly', () => {
    const segments = segmentText('A!\u0301', { language: 'en' });
    expect(segments.map(({ kind, text, script }) => [kind, text, script])).toEqual([
      ['word', 'A', 'Latn'],
      ['punctuation', '!', 'Zyyy'],
      ['symbol', '\u0301', 'Zinh'],
    ]);
    expect(segmentText('\u06D6', { language: 'ar' })[0]).toMatchObject({
      kind: 'symbol',
      text: '\u06D6',
      script: 'Arab',
    });
    expect(segmentText('\u064E', { language: 'ar' })[0]).toMatchObject({ script: 'Zinh' });
    for (const unsupported of ['მზე', 'Հայ', 'አማ', '\u058A']) {
      expect(() => segmentText(unsupported, { language: 'und' })).toThrow(
        'Unsupported Unicode script'
      );
    }
    expect(segmentText('漢𰀀', { language: 'zh' }).map((span) => span.script)).toEqual(['Hani']);
  });

  it('keeps punctuation and whitespace as spans and does not claim morphology', () => {
    const result = segmentText('قُلْ، word-word 12.5', { language: 'ar' });
    expect(result.map(({ kind, text }) => [kind, text])).toEqual([
      ['word', 'قُلْ'],
      ['punctuation', '،'],
      ['whitespace', ' '],
      ['word', 'word'],
      ['punctuation', '-'],
      ['word', 'word'],
      ['whitespace', ' '],
      ['number', '12'],
      ['punctuation', '.'],
      ['number', '5'],
    ]);
    expect(result.every((span) => !('lemma' in span) && !('morphemes' in span))).toBe(true);
  });

  it('rejects unpaired UTF-16 surrogates and missing language metadata', () => {
    expect(() => segmentText('\ud800', { language: 'en' })).toThrow('unpaired UTF-16 surrogate');
    expect(() => segmentText('ok', { language: ' ' })).toThrow('language is required');
  });
});
