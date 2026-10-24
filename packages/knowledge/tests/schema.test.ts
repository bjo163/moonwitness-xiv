import { describe, expect, it } from 'vitest';
import schema from '../schemas/knowledge-record.schema.json' with { type: 'json' };

describe('published knowledge record schema', () => {
  it('uses JSON Schema Draft 2020-12 and requires an explicit visibility', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.required).toContain('visibility');
    expect(schema.additionalProperties).toBe(false);
  });
});
