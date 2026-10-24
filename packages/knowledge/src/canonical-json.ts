import { createHash } from 'node:crypto';

function quote(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Lone Unicode surrogate');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('Lone Unicode surrogate');
    }
  }
  return JSON.stringify(value);
}

/** RFC 8785 serialization of JSON values; never invokes getters or toJSON. */
export function canonicalizeJson(value: unknown): string {
  const active = new Set<object>();
  const serialize = (input: unknown): string => {
    if (input === null) return 'null';
    if (typeof input === 'string') return quote(input);
    if (typeof input === 'boolean') return input ? 'true' : 'false';
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new TypeError('Non-finite JSON number');
      return JSON.stringify(input);
    }
    if (typeof input !== 'object') throw new TypeError('Unsupported JSON value');
    if (active.has(input)) throw new TypeError('Cyclic JSON value');
    if (Array.isArray(input) && Object.getPrototypeOf(input) !== Array.prototype) {
      throw new TypeError('JSON arrays must use the standard array prototype');
    }
    if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
      throw new TypeError('JSON objects must have a plain or null prototype');
    }
    if (Object.getOwnPropertySymbols(input).length)
      throw new TypeError('JSON cannot contain symbols');
    active.add(input);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const readValue = (key: string): unknown => {
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError('JSON requires enumerable data properties');
        }
        const item: unknown = descriptor.value;
        return item;
      };
      if (Array.isArray(input)) {
        if (Object.keys(descriptors).length !== input.length + 1) {
          throw new TypeError('JSON arrays cannot contain holes or extra properties');
        }
        return `[${Array.from({ length: input.length }, (_, index) => serialize(readValue(String(index)))).join(',')}]`;
      }
      // Default JS sorting compares UTF-16 code units, as required by JCS.
      return `{${Object.keys(descriptors)
        .sort()
        .map((key) => `${quote(key)}:${serialize(readValue(key))}`)
        .join(',')}}`;
    } finally {
      active.delete(input);
    }
  };
  return serialize(value);
}

/** Parse JSON without silently accepting duplicate keys or non-I-JSON values. */
export function parseCanonicalJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const stack: Array<{ keys?: Set<string>; expectsKey: boolean }> = [];
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }

    if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        index += text[index] === '\\' ? 2 : 1;
      }
      index += 1;

      const current = stack.at(-1);
      if (current?.keys && current.expectsKey) {
        const key: unknown = JSON.parse(text.slice(start, index));
        if (typeof key !== 'string') throw new TypeError('Invalid JSON property name');
        if (current.keys.has(key)) throw new TypeError(`Duplicate JSON property: ${key}`);
        current.keys.add(key);
      }
      continue;
    }

    const current = stack.at(-1);
    if (character === '{') stack.push({ keys: new Set(), expectsKey: true });
    else if (character === '[') stack.push({ expectsKey: false });
    else if (character === '}' || character === ']') stack.pop();
    else if (character === ',' && current?.keys) current.expectsKey = true;
    else if (character === ':' && current) current.expectsKey = false;
    index += 1;
  }
  canonicalizeJson(value);
  return value;
}

export function hashCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}

export interface KnowledgeSnapshotInput {
  records: readonly unknown[];
  aliases: readonly unknown[];
  sourceArtifacts: readonly unknown[];
  provenance?: unknown;
}

/** File names and collection order are not part of dataset content identity. */
export function createKnowledgeSnapshot(input: KnowledgeSnapshotInput) {
  const digests = (values: readonly unknown[]): string[] => values.map(hashCanonicalJson).sort();
  const manifest = {
    format: 'moonwitness-knowledge-snapshot/v1',
    canonicalization: 'RFC8785',
    hashAlgorithm: 'sha256',
    records: digests(input.records),
    aliases: digests(input.aliases),
    sourceArtifacts: digests(input.sourceArtifacts),
    provenance: input.provenance === undefined ? null : hashCanonicalJson(input.provenance),
  };
  return { ...manifest, sha256: hashCanonicalJson(manifest) };
}
