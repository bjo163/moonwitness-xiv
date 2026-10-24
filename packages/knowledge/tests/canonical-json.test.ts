import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  canonicalizeJson,
  hashCanonicalJson,
  parseCanonicalJson,
  createKnowledgeSnapshot,
} from '../src/canonical-json.js';

describe('RFC 8785 canonical JSON', () => {
  it.each([
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
  ])('matches RFC 8785 Appendix B number vector %s', (hex, expected) => {
    expect(canonicalizeJson(Buffer.from(hex, 'hex').readDoubleBE(0))).toBe(expected);
  });
  it('uses ECMAScript numeric serialization and preserves array order', () => {
    expect(canonicalizeJson({ numbers: [333333333.3333333, 1e30, 4.5, 2e-3, 1e-27, -0] })).toBe(
      '{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0]}'
    );
  });

  it('sorts UTF-16 property names recursively, including numeric-looking keys', () => {
    expect(canonicalizeJson({ '\ue000': 1, '😀': 2, '\r': 3, '€': 4, '1': 5 })).toBe(
      '{"\\r":3,"1":5,"€":4,"😀":2,"":1}'
    );
    expect(canonicalizeJson({ 2: { z: 1, a: 2 }, 10: 3 })).toBe('{"10":3,"2":{"a":2,"z":1}}');
  });

  it('escapes control characters and does not normalize Unicode', () => {
    expect(canonicalizeJson('\u000f\n"\\')).toBe('"\\u000f\\n\\"\\\\"');
    expect(hashCanonicalJson('é')).not.toBe(hashCanonicalJson('e\u0301'));
  });

  it.each([NaN, Infinity, -Infinity, undefined, 1n, Symbol('x'), () => 1, '\ud800', '\udfff'])(
    'rejects non-JSON values and invalid Unicode %s',
    (value) => {
      expect(() => canonicalizeJson(value)).toThrow(TypeError);
    }
  );

  it('rejects cycles, sparse arrays and getters without invoking user code', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow('Cyclic');
    expect(() => canonicalizeJson(new Array(2))).toThrow();
    expect(() => canonicalizeJson(new Date())).toThrow();
    let invoked = false;
    const value = Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        invoked = true;
        return 1;
      },
    });
    expect(() => canonicalizeJson(value)).toThrow();
    expect(invoked).toBe(false);
    const customArray: unknown[] = [];
    Object.setPrototypeOf(customArray, Object.create(Array.prototype));
    expect(() => canonicalizeJson(customArray)).toThrow(/standard array prototype/u);
  });

  it('rejects duplicate decoded names, even in nested objects and escaped spellings', () => {
    expect(() => parseCanonicalJson('{"a":1,"\\u0061":2}')).toThrow('Duplicate');
    expect(() => parseCanonicalJson('[{"x":1,"x":2}]')).toThrow('Duplicate');
    expect(parseCanonicalJson('{"x":{"a":1},"y":{"a":2}}')).toEqual({ x: { a: 1 }, y: { a: 2 } });
    expect(() => parseCanonicalJson('{"value":1e400}')).toThrow('Non-finite');
  });

  it('scans long escaped strings without regex backtracking', () => {
    const value = '"'.repeat(20_000);
    expect(parseCanonicalJson(JSON.stringify(value))).toBe(value);
  });

  it('hashes equal content identically while meaningful changes alter the digest', () => {
    expect(hashCanonicalJson({ z: 2, a: 1 })).toBe(hashCanonicalJson({ a: 1, z: 2 }));
    expect(hashCanonicalJson({ a: 1 })).not.toBe(hashCanonicalJson({ a: 2 }));
    expect(hashCanonicalJson(null)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('builds a content-only manifest with order-independent collection hashes', () => {
    const first = createKnowledgeSnapshot({
      records: [{ z: 2, a: 1 }, { id: 'x' }],
      aliases: [],
      sourceArtifacts: [],
    });
    const second = createKnowledgeSnapshot({
      records: [{ id: 'x' }, { a: 1, z: 2 }],
      aliases: [],
      sourceArtifacts: [],
    });
    expect(first).toEqual(second);
    const { sha256, ...manifest } = first;
    expect(sha256).toBe(hashCanonicalJson(manifest));
    expect(
      createKnowledgeSnapshot({ records: [{ a: 2 }], aliases: [], sourceArtifacts: [] }).sha256
    ).not.toBe(sha256);
  });
});
