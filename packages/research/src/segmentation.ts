/** Deterministic lexical spans over one exact passage string; this is not a morphological analyzer. */
export type TextSegmentKind = 'word' | 'number' | 'punctuation' | 'symbol' | 'whitespace';

export interface TextSegment {
  kind: TextSegmentKind;
  /** Half-open UTF-8 byte offsets into the exact input passage. */
  byte_start: number;
  byte_end: number;
  /** Half-open Unicode scalar offsets into the exact input passage. */
  scalar_start: number;
  scalar_end: number;
  text: string;
  /** Present only when explicitly requested; always derived from, never replaces, text. */
  normalized_text?: string;
  script: string;
  language: string;
}

const letter = /\p{L}/u;
const mark = /\p{M}/u;
const number = /\p{N}/u;
const whitespace = /\p{White_Space}/u;
const punctuation = /\p{P}/u;
const scriptPatterns: [string, RegExp][] = [
  ['Arab', /\p{Script=Arabic}/u],
  ['Hebr', /\p{Script=Hebrew}/u],
  ['Latn', /\p{Script=Latin}/u],
  ['Grek', /\p{Script=Greek}/u],
  ['Cyrl', /\p{Script=Cyrillic}/u],
  ['Deva', /\p{Script=Devanagari}/u],
  ['Hani', /\p{Script=Han}/u],
  ['Hira', /\p{Script=Hiragana}/u],
  ['Kana', /\p{Script=Katakana}/u],
  ['Thai', /\p{Script=Thai}/u],
];

function scalarScript(char: string): string {
  const explicit = scriptPatterns.find(([, pattern]) => pattern.test(char))?.[0];
  if (explicit) return explicit;
  if (/\p{Script=Inherited}/u.test(char)) return 'Zinh';
  if (/\p{Script=Common}/u.test(char)) return 'Zyyy';
  throw new RangeError(
    `Unsupported Unicode script for scalar U+${char.codePointAt(0)!.toString(16).toUpperCase()}`
  );
}

function pointsOf(input: string): { char: string; scalar: number; byte: number; width: number }[] {
  const points: { char: string; scalar: number; byte: number; width: number }[] = [];
  let byte = 0;
  for (let i = 0, scalar = 0; i < input.length; scalar++) {
    const first = input.charCodeAt(i);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = input.charCodeAt(i + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff))
        throw new TypeError('Input contains an unpaired UTF-16 surrogate');
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new TypeError('Input contains an unpaired UTF-16 surrogate');
    }
    const char = String.fromCodePoint(input.codePointAt(i)!);
    const width = char.length;
    points.push({ char, scalar, byte, width });
    byte += new TextEncoder().encode(char).length;
    i += width;
  }
  return points;
}

/** Segment words, numbers, punctuation, symbols and whitespace without changing source text. */
export function segmentText(
  input: string,
  options: { language: string; normalize?: 'NFC' | 'NFKC' }
): TextSegment[] {
  if (!options.language.trim()) throw new TypeError('language is required');
  const points = pointsOf(input);
  const result: TextSegment[] = [];
  let start = 0;
  while (start < points.length) {
    const first = points[start]!.char;
    const kind: TextSegmentKind = mark.test(first)
      ? 'symbol'
      : whitespace.test(first)
        ? 'whitespace'
        : letter.test(first) || mark.test(first)
          ? 'word'
          : number.test(first)
            ? 'number'
            : punctuation.test(first)
              ? 'punctuation'
              : 'symbol';
    const script = scalarScript(first);
    let end = start + 1;
    while (end < points.length) {
      const next = points[end]!.char;
      const nextKind = whitespace.test(next)
        ? 'whitespace'
        : letter.test(next) || mark.test(next)
          ? 'word'
          : number.test(next)
            ? 'number'
            : punctuation.test(next)
              ? 'punctuation'
              : 'symbol';
      const nextScript = scalarScript(next);
      const attachedMark = mark.test(next) && kind === 'word';
      const compatibleScript =
        kind === 'number' ||
        nextScript === script ||
        nextScript === 'Zyyy' ||
        nextScript === 'Zinh';
      if (nextKind !== kind || (!compatibleScript && !attachedMark)) break;
      end++;
    }
    const from = points[start]!;
    const last = points[end - 1]!;
    const text = points
      .slice(start, end)
      .map((point) => point.char)
      .join('');
    const effectiveScript = script;
    result.push({
      kind,
      byte_start: from.byte,
      byte_end: last.byte + new TextEncoder().encode(last.char).length,
      scalar_start: from.scalar,
      scalar_end: last.scalar + 1,
      text,
      ...(options.normalize ? { normalized_text: text.normalize(options.normalize) } : {}),
      script: effectiveScript,
      language: options.language,
    });
    start = end;
  }
  return result;
}
