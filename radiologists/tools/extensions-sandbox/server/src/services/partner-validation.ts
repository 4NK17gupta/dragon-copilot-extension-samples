import { readFileSync } from 'node:fs';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { ManifestTool } from '../schemas/manifest.schema.js';
import type { ValidationCheck, ValidationResult } from './validation.js';
import { DRAFT_REPORT_INGEST_REQUEST_SCHEMA_PATH, DRAFT_REPORT_SCHEMA_PATH } from '../utils/schema-path.js';
import { exceedsValueLimit } from '../utils/value-limit.js';

export const DRAFT_REPORT_CONTENT_TYPE = 'application/vnd.ms-dragon.rad.draft-report+json';

const schemaRegistry = new Map([
  [DRAFT_REPORT_CONTENT_TYPE, new Map([
    ['1.0', DRAFT_REPORT_SCHEMA_PATH],
  ])],
]);

/** How the ingest request schema refers to the draft report schema in its `draftReport` member. */
const INGEST_DRAFT_REPORT_REF = 'draft-report-schema.json';

/**
 * Bodies with more values (objects, arrays and scalars) than this get only the
 * first error per schema. Collecting every error slows down quadratically as
 * errors pile up, so doing it for an arbitrary callback body would let one
 * request tie up the server. A real draft report has a few hundred values.
 */
export const MAX_FULL_ERROR_LIST_VALUES = 2_000;

/** Most schema errors listed for one request; the remainder is counted in a single check. */
export const MAX_LISTED_SCHEMA_ERRORS = 100;

/** Ingest request properties; a draft report has none of them at its top level. */
const ENVELOPE_PROPERTIES = ['draftReport', 'manifestName', 'toolName'];

interface SchemaValidators {
  /** Stops at the first error, so its cost stays linear in the size of the body. */
  firstError: ValidateFunction;
  /** Collects every error; only run on bodies within MAX_FULL_ERROR_LIST_VALUES. */
  allErrors: ValidateFunction;
}

const firstErrorAjv = new Ajv({ strict: false });
const allErrorsAjv = new Ajv({ allErrors: true, strict: false });
addFormats(firstErrorAjv);
addFormats(allErrorsAjv);
const outputValidators = new Map<string, SchemaValidators>();
let envelopeValidators: SchemaValidators | undefined;
let ingestRequestValidators: SchemaValidators | undefined;

function compile(schema: object): SchemaValidators {
  return { firstError: firstErrorAjv.compile(schema), allErrors: allErrorsAjv.compile(schema) };
}

/** The tool a listener was armed for, and the name of the manifest that declared it. */
export interface PartnerTarget {
  tool: ManifestTool;
  manifestName: string;
}

function formatList(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function schemaErrorMessage(error: ErrorObject): string {
  if (error.keyword === 'dependencies') {
    // Ajv's default ("must have properties offerId, planId when property publisherId is
    // present") doesn't say the properties belong together, which is the rule to fix.
    const params = error.params as { property: string; missingProperty: string; deps: string };
    const group = [params.property, ...params.deps.split(', ')];
    return `'${params.property}' requires '${params.missingProperty}': ${formatList(group)} must be supplied together or omitted together.`;
  }
  return error.message ?? 'Payload does not match the schema.';
}

/** Builds the check list for one request and bounds the number of schema errors in it. */
class CheckCollector {
  readonly checks: ValidationCheck[] = [];
  private listedErrors = 0;
  private unlistedErrors = 0;
  private firstErrorsOnly = false;

  constructor(private readonly listAllErrors: boolean) {}

  add(check: ValidationCheck): void {
    this.checks.push(check);
  }

  validate(label: string, validators: SchemaValidators, data: unknown, pathPrefix: string): void {
    if (validators.firstError(data)) {
      this.add({ check: label, passed: true });
      return;
    }
    let errors: ErrorObject[];
    if (this.listAllErrors) {
      validators.allErrors(data);
      errors = validators.allErrors.errors ?? [];
    } else {
      errors = validators.firstError.errors ?? [];
      this.firstErrorsOnly = true;
    }
    for (const error of errors) {
      if (this.listedErrors >= MAX_LISTED_SCHEMA_ERRORS) {
        this.unlistedErrors++;
        continue;
      }
      this.listedErrors++;
      const params = error.params as Record<string, unknown>;
      const property = error.keyword === 'required' ? params.missingProperty
        : error.keyword === 'additionalProperties' ? params.additionalProperty
        : undefined;
      this.add({
        check: label,
        passed: false,
        path: `${pathPrefix}${error.instancePath}${property === undefined ? '' : `/${property}`}` || '/',
        error: schemaErrorMessage(error),
      });
    }
  }

  finish(): ValidationCheck[] {
    if (this.firstErrorsOnly) {
      this.add({
        check: 'Schema errors listed',
        passed: false,
        error: `Only the first error per schema is listed because the body has more than ${MAX_FULL_ERROR_LIST_VALUES} values. Fix it and resend to see the next one.`,
      });
    }
    if (this.unlistedErrors > 0) {
      this.add({
        check: 'Schema errors listed',
        passed: false,
        error: `${this.unlistedErrors} more schema error(s) not listed. Only the first ${MAX_LISTED_SCHEMA_ERRORS} are shown.`,
      });
    }
    return this.checks;
  }
}

export function validationResult(toolName: string, outputContentType: string, checks: ValidationCheck[]): ValidationResult {
  const failed = checks.filter((check) => !check.passed).length;
  return {
    valid: failed === 0,
    toolName,
    outputContentType,
    checks,
    summary: { passed: checks.length - failed, failed },
    timestamp: new Date().toISOString(),
  };
}

export function partnerValidationResult(tool: ManifestTool, checks: ValidationCheck[]): ValidationResult {
  const contentTypes = [...new Set(tool.outputs.map((output) => output['content-type']))].join(', ');
  return validationResult(tool.name, contentTypes || 'none', checks);
}

function getIngestRequestValidators(): SchemaValidators {
  if (!ingestRequestValidators) {
    const draftReportSchema = JSON.parse(readFileSync(DRAFT_REPORT_SCHEMA_PATH, 'utf-8'));
    const requestSchema = JSON.parse(readFileSync(DRAFT_REPORT_INGEST_REQUEST_SCHEMA_PATH, 'utf-8'));
    // Dedicated instances, so registering the draft report schema under the name the
    // request schema refers to it by can't clash with the output validators.
    const compileRequest = (allErrors: boolean): ValidateFunction => {
      const ajv = new Ajv({ allErrors, strict: false });
      addFormats(ajv);
      ajv.addSchema(draftReportSchema, INGEST_DRAFT_REPORT_REF);
      return ajv.compile(requestSchema);
    };
    ingestRequestValidators = { firstError: compileRequest(false), allErrors: compileRequest(true) };
  }
  return ingestRequestValidators;
}

/**
 * Compiles the ingest request schemas now rather than on the first submission. Compiling
 * takes seconds and blocks the event loop. Throws if the schemas can't be loaded.
 */
export function preloadIngestRequestSchemas(): void {
  getIngestRequestValidators();
}

/**
 * Validates a whole draft report ingest request, `draftReport` included, against the
 * published ingest request schema, as Dragon Copilot does before it looks anything up.
 * Errors are bounded as for callback bodies. Throws if the schemas can't be loaded.
 */
export function validateIngestRequest(body: unknown): ValidationCheck[] {
  const validators = getIngestRequestValidators();
  const checks = new CheckCollector(!exceedsValueLimit(body, MAX_FULL_ERROR_LIST_VALUES));
  checks.validate('Ingest request schema', validators, body, '');
  return checks.finish();
}

function isEnvelope(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    && ENVELOPE_PROPERTIES.some((property) => Object.hasOwn(body, property));
}

function getEnvelopeValidators(): SchemaValidators {
  if (!envelopeValidators) {
    const schema = JSON.parse(readFileSync(DRAFT_REPORT_INGEST_REQUEST_SCHEMA_PATH, 'utf-8'));
    // The draft report is checked against the tool's output declarations instead,
    // exactly as a raw body would be, so its errors are not reported twice.
    schema.properties.draftReport = {};
    envelopeValidators = compile(schema);
  }
  return envelopeValidators;
}

function validateEnvelope(body: Record<string, unknown>, target: PartnerTarget, checks: CheckCollector): void {
  const label = 'Ingest request envelope';
  let validators: SchemaValidators | undefined;
  try {
    validators = getEnvelopeValidators();
  } catch {
    checks.add({ check: label, passed: false, error: 'Ingest request schema could not be loaded or compiled. Run the schema sync/build step.' });
  }
  if (validators) {
    checks.validate(label, validators, body, '');
  }

  const expected = [['manifestName', target.manifestName], ['toolName', target.tool.name]] as const;
  for (const [property, value] of expected) {
    // A missing or non-string value is already reported by the envelope schema.
    if (typeof body[property] !== 'string') continue;
    const check = `Envelope ${property} matches the loaded manifest`;
    checks.add(body[property] === value
      ? { check, passed: true }
      : { check, passed: false, path: `/${property}`, error: `Must be '${value}'.` });
  }
}

/**
 * Validates a partner's callback body. The body is either the raw output (for a
 * draft report, the `draftReport` object) or the full ingest request envelope
 * that wraps it: an object with any envelope property is treated as an envelope,
 * whose own fields are validated before its `draftReport`. Each output
 * declaration describes the raw output, not a named member of an envelope.
 */
export function validatePartnerOutput(target: PartnerTarget, rawBody: unknown): ValidationResult {
  const { tool } = target;
  const checks = new CheckCollector(!exceedsValueLimit(rawBody, MAX_FULL_ERROR_LIST_VALUES));

  let output = rawBody;
  let outputPath = '';
  if (isEnvelope(rawBody)) {
    validateEnvelope(rawBody, target, checks);
    if (!Object.hasOwn(rawBody, 'draftReport')) {
      return partnerValidationResult(tool, checks.finish());
    }
    output = rawBody.draftReport;
    outputPath = '/draftReport';
  }

  if (!tool.outputs.length) {
    checks.add({ check: 'Output schemas declared', passed: false, error: 'The tool declares no output schemas.' });
  }

  for (const declaration of tool.outputs) {
    const contentType = declaration['content-type'];
    const label = `Output '${declaration.name}' (${contentType}, schemaVersion ${declaration.schemaVersion})`;
    const schemaPath = schemaRegistry.get(contentType)?.get(declaration.schemaVersion);
    if (!schemaPath) {
      checks.add({
        check: label,
        passed: false,
        error: 'No schema registered for this output content-type and schemaVersion.',
      });
      continue;
    }

    let validators = outputValidators.get(schemaPath);
    if (!validators) {
      try {
        const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
        if (schema['x-ms-schema-version'] !== declaration.schemaVersion) {
          checks.add({ check: label, passed: false, error: 'Registered schema version does not match the declaration.' });
          continue;
        }
        validators = compile(schema);
        outputValidators.set(schemaPath, validators);
      } catch {
        checks.add({ check: label, passed: false, error: 'Output schema could not be loaded or compiled. Run the schema sync/build step.' });
        continue;
      }
    }

    checks.validate(label, validators, output, outputPath);
  }
  return partnerValidationResult(tool, checks.finish());
}
