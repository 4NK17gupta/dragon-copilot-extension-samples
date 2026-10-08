import { readFileSync } from 'node:fs';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { ManifestTool } from '../schemas/manifest.schema.js';
import type { ValidationCheck, ValidationResult } from './validation.js';

const schemaRegistry = new Map([
  ['application/vnd.ms-dragon.rad.pre-draft-report+json', new Map([
    ['1.0', new URL('../schemas/radiologists/pre-draft-report-schema.json', import.meta.url)],
  ])],
]);
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validators = new Map<string, ValidateFunction>();

export function partnerValidationResult(tool: ManifestTool, checks: ValidationCheck[]): ValidationResult {
  const failed = checks.filter((check) => !check.passed).length;
  return {
    valid: failed === 0,
    toolName: tool.name,
    outputContentType: [...new Set(tool.outputs.map((output) => output['content-type']))].join(', ') || 'none',
    checks,
    summary: { passed: checks.length - failed, failed },
    timestamp: new Date().toISOString(),
  };
}

/** Each declaration describes the raw body, not a named envelope member. */
export function validatePartnerOutput(tool: ManifestTool, rawBody: unknown): ValidationResult {
  const checks: ValidationCheck[] = [];
  if (!tool.outputs.length) {
    checks.push({ check: 'Output schemas declared', passed: false, error: 'The tool declares no output schemas.' });
  }

  for (const output of tool.outputs) {
    const contentType = output['content-type'];
    const label = `Output '${output.name}' (${contentType}, schemaVersion ${output.schemaVersion})`;
    const schemaUrl = schemaRegistry.get(contentType)?.get(output.schemaVersion);
    if (!schemaUrl) {
      checks.push({
        check: label,
        passed: false,
        error: 'No schema registered for this output content-type and schemaVersion.',
      });
      continue;
    }

    let validate = validators.get(schemaUrl.href);
    if (!validate) {
      try {
        const schema = JSON.parse(readFileSync(schemaUrl, 'utf-8'));
        if (schema['x-ms-schema-version'] !== output.schemaVersion) {
          checks.push({ check: label, passed: false, error: 'Registered schema version does not match the declaration.' });
          continue;
        }
        validate = ajv.compile(schema);
        validators.set(schemaUrl.href, validate);
      } catch {
        checks.push({ check: label, passed: false, error: 'Output schema could not be loaded or compiled. Run the schema sync/build step.' });
        continue;
      }
    }

    if (validate(rawBody)) {
      checks.push({ check: label, passed: true });
    } else {
      for (const error of validate.errors ?? []) {
        const missing = error.keyword === 'required' ? `/${error.params.missingProperty}` : '';
        checks.push({
          check: label,
          passed: false,
          path: `${error.instancePath}${missing}` || '/',
          error: error.message ?? 'Payload does not match the output schema.',
        });
      }
    }
  }
  return partnerValidationResult(tool, checks);
}
