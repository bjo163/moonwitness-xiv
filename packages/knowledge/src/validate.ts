import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import knowledgeRecordSchema from '../schemas/knowledge-record.schema.json' with { type: 'json' };
import type {
  KnowledgeRecord,
  KnowledgeValidationIssue,
  KnowledgeValidationResult,
} from './types.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
formatsModule.default.default(ajv, { mode: 'full' });

const validateRecord = ajv.compile<KnowledgeRecord>(knowledgeRecordSchema);

function pointerForIssue(
  instancePath: string,
  keyword: string,
  params: Record<string, unknown>
): string {
  const parent = instancePath || '';
  if (keyword === 'required' && typeof params.missingProperty === 'string') {
    return `${parent}/${params.missingProperty.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  }
  if (keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') {
    return `${parent}/${params.additionalProperty.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  }
  return parent || '/';
}

export function validateKnowledgeRecord(value: unknown): KnowledgeValidationResult {
  if (validateRecord(value)) return { valid: true, issues: [] };

  const issues: KnowledgeValidationIssue[] = (validateRecord.errors ?? []).map((error) => ({
    path: pointerForIssue(error.instancePath, error.keyword, error.params),
    keyword: error.keyword,
    message: error.message ?? 'does not match the knowledge record contract',
  }));

  return { valid: false, issues };
}

export function isKnowledgeRecord(value: unknown): value is KnowledgeRecord {
  return validateRecord(value);
}
