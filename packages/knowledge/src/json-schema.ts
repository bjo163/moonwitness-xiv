import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import type { KnowledgeValidationIssue, KnowledgeValidationResult } from './types.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
formatsModule.default.default(ajv, { mode: 'full' });

type JsonSchemaValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonSchemaValue[]
  | { readonly [key: string]: JsonSchemaValue };

/** JSON Schema 2020-12 contract; keeps AJV's permissive internal type out of public APIs. */
export type JsonSchemaContract = boolean | { readonly [key: string]: JsonSchemaValue };

interface SchemaValidationError {
  instancePath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

interface SchemaValidationFunction {
  (value: unknown): boolean;
  errors?: SchemaValidationError[] | null;
}

// AJV's compile signature uses a permissive schema type. Contain that
// compatibility cast here while keeping this module's exported contract typed.
const compileSchema = ajv.compile.bind(ajv) as (
  schema: JsonSchemaContract
) => SchemaValidationFunction;

function pointerForIssue(
  instancePath: string,
  keyword: string,
  params: Record<string, unknown>
): string {
  if (keyword === 'required' && typeof params.missingProperty === 'string') {
    return `${instancePath}/${params.missingProperty.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  }
  if (keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') {
    return `${instancePath}/${params.additionalProperty.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  }
  return instancePath || '/';
}

/** Compile a JSON Schema 2020-12 contract into the shared validation result shape. */
export function createJsonSchemaValidator(
  schema: JsonSchemaContract,
  fallbackMessage = 'does not match the JSON Schema contract'
): (value: unknown) => KnowledgeValidationResult {
  const validate = compileSchema(schema);
  return (value) => {
    if (validate(value)) return { valid: true, issues: [] };
    const issues: KnowledgeValidationIssue[] = (validate.errors ?? []).map((error) => ({
      path: pointerForIssue(error.instancePath, error.keyword, error.params),
      keyword: error.keyword,
      message: error.message ?? fallbackMessage,
    }));
    return { valid: false, issues };
  };
}
