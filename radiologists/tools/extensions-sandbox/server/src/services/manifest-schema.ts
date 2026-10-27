import { readFileSync } from 'node:fs';
import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import type { ExtensionManifest } from '../schemas/manifest.schema.js';
import { buildDetailedErrors } from '../utils/validation-hints.js';
import { mapPathsToLines } from '../utils/source-mapper.js';
import { MANIFEST_SCHEMA_PATH } from '../utils/schema-path.js';
import { exceedsValueLimit } from '../utils/value-limit.js';

/**
 * Compiled validators for the Dragon Copilot (radiologists) manifest schema,
 * shared by every surface that accepts a manifest — upload, paste-and-validate,
 * and CLI wizard generation — so all of them report failures identically.
 */
const manifestJsonSchema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, 'utf-8'));

const firstErrorAjv = new Ajv({ verbose: true, strict: false });
const allErrorsAjv = new Ajv({ allErrors: true, verbose: true, strict: false });
addFormats(firstErrorAjv);
addFormats(allErrorsAjv);
/** Stops at the first error, so its cost stays linear in the size of the manifest. */
const validateFirstError = firstErrorAjv.compile(manifestJsonSchema);
/** Collects every error; only run on manifests within MAX_MANIFEST_VALUES_FOR_ALL_ERRORS. */
const validateAllErrors = allErrorsAjv.compile(manifestJsonSchema);

export type DetailedValidationError = ReturnType<typeof buildDetailedErrors>[number];

/**
 * Upper bound on the values (objects, arrays and scalars) in a manifest we will
 * validate. YAML aliases can expand a file of a few KB into hundreds of
 * thousands of values, so the byte limits on uploads and request bodies alone
 * do not bound the schema walk. Real manifests contain well under a hundred values.
 */
export const MAX_MANIFEST_VALUES = 10_000;

/**
 * Manifests with more values than this get only the first schema error.
 * Collecting every error slows down sharply as errors pile up, so doing it for
 * an arbitrary upload would let one request tie up the server.
 */
export const MAX_MANIFEST_VALUES_FOR_ALL_ERRORS = 2_000;

/** Most errors listed for one manifest; the remainder is counted in a single entry. */
export const MAX_LISTED_MANIFEST_ERRORS = 100;

/**
 * Errors get line numbers only for sources within both of these limits.
 * Finding the line for each error rescans the source, so the cost grows with
 * errors × source size. Real manifests are a few KB and a few hundred lines.
 */
export const MAX_LINE_MAPPED_SOURCE_LENGTH = 50_000;
export const MAX_LINE_MAPPED_SOURCE_LINES = 2_000;

export type ManifestValidationResult =
  | { valid: true; manifest: ExtensionManifest }
  | { valid: false; errors: DetailedValidationError[] };

/** Compact manifest description returned to the client after a successful validation. */
export interface ManifestSummary {
  name: string;
  version: string;
  toolCount: number;
  capabilities: string[];
}

/**
 * Validates a parsed manifest against the schema, resolving each failure to a
 * line in `sourceText` and an actionable hint. The work is bounded: at most
 * MAX_LISTED_MANIFEST_ERRORS errors are listed, every schema error is collected
 * only for manifests within MAX_MANIFEST_VALUES_FOR_ALL_ERRORS values, and line
 * numbers are resolved only for sources within the MAX_LINE_MAPPED_SOURCE_* limits.
 *
 * @param parsed Manifest already parsed from JSON or YAML.
 * @param sourceText The JSON/YAML the manifest was parsed from, used for line numbers.
 */
export function validateManifestDocument(parsed: unknown, sourceText: string): ManifestValidationResult {
  if (exceedsValueLimit(parsed, MAX_MANIFEST_VALUES)) {
    return {
      valid: false,
      errors: [
        {
          path: '/',
          line: null,
          message: `/: manifest exceeds ${MAX_MANIFEST_VALUES} values`,
          detail: `The manifest contains more than ${MAX_MANIFEST_VALUES} values (objects, arrays and fields), so it was not validated.`,
          hint: 'Reduce the number of tools, inputs and outputs. If the file uses YAML anchors and aliases (&name / *name), write the content out explicitly instead.',
          severity: 'error',
        },
      ],
    };
  }

  const schemaValid = validateFirstError(parsed);
  const duplicates = findDuplicateToolNames(parsed);
  if (schemaValid && duplicates.length === 0) {
    return { valid: true, manifest: parsed as ExtensionManifest };
  }

  const firstErrorOnly = !schemaValid && exceedsValueLimit(parsed, MAX_MANIFEST_VALUES_FOR_ALL_ERRORS);
  let schemaErrors: ErrorObject[] = [];
  if (firstErrorOnly) {
    schemaErrors = validateFirstError.errors ?? [];
  } else if (!schemaValid) {
    validateAllErrors(parsed);
    schemaErrors = validateAllErrors.errors ?? [];
  }

  const rawErrors = schemaErrors.slice(0, MAX_LISTED_MANIFEST_ERRORS);
  const listedDuplicates = duplicates.slice(0, MAX_LISTED_MANIFEST_ERRORS - rawErrors.length);
  const unlistedErrors = schemaErrors.length + duplicates.length - rawErrors.length - listedDuplicates.length;

  // Compute precise target paths for line resolution.
  // For 'required' errors, AJV points to the parent — extend to the missing property.
  // For 'additionalProperties', extend to the extra property.
  const targetPaths = rawErrors.map((err) => {
    const base = err.instancePath || '/';
    const params = err.params as Record<string, unknown>;
    if (err.keyword === 'required' && params.missingProperty) {
      const sep = base === '/' ? '' : '/';
      return `${base}${sep}${params.missingProperty}`;
    }
    if (err.keyword === 'additionalProperties' && params.additionalProperty) {
      const sep = base === '/' ? '' : '/';
      return `${base}${sep}${params.additionalProperty}`;
    }
    return base;
  });

  const lineMappable = sourceText.length <= MAX_LINE_MAPPED_SOURCE_LENGTH
    && !lineCountExceeds(sourceText, MAX_LINE_MAPPED_SOURCE_LINES);
  const lineMap = lineMappable
    ? mapPathsToLines(sourceText, [...targetPaths, ...listedDuplicates.map(({ path }) => path)])
    : new Map<string, number | undefined>();

  const errors: DetailedValidationError[] = [
    ...buildDetailedErrors(rawErrors, lineMap, targetPaths),
    ...listedDuplicates.map(({ path, name }) => ({
      path,
      line: lineMap.get(path) ?? null,
      message: `${path}: tool name '${name}' is used more than once`,
      detail: `Tool name '${name}' is used more than once. Each tool needs a unique name, across all capabilities.`,
      hint: 'Rename one of the tools. Tools are identified by name, so a repeated name is ambiguous.',
      severity: 'error' as const,
    })),
  ];
  if (firstErrorOnly) {
    errors.push({
      path: '/',
      line: null,
      message: '/: only the first schema error is listed',
      detail: `Only the first schema error is listed because the manifest has more than ${MAX_MANIFEST_VALUES_FOR_ALL_ERRORS} values.`,
      hint: 'Fix the error above and validate again to see the next one.',
      severity: 'error',
    });
  }
  if (unlistedErrors > 0) {
    errors.push({
      path: '/',
      line: null,
      message: `/: ${unlistedErrors} more error(s) not listed`,
      detail: `${unlistedErrors} more error(s) not listed. Only the first ${MAX_LISTED_MANIFEST_ERRORS} are shown.`,
      hint: 'Fix the errors above and validate again to see the rest.',
      severity: 'error',
    });
  }
  return { valid: false, errors };
}

/** Whether `text` has more than `limit` lines, counted without splitting the whole text. */
function lineCountExceeds(text: string, limit: number): boolean {
  let lines = 1;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    if (++lines > limit) {
      return true;
    }
  }
  return false;
}

/**
 * Tool names must be unique across all capabilities, which JSON Schema cannot
 * express. The CLI and the manifest wizard enforce the same rule; without it,
 * lookups by name can pick a different tool than the one being executed.
 * Returns each repeated name after its first use, with its `/tools/N/name` path.
 */
function findDuplicateToolNames(parsed: unknown): { path: string; name: string }[] {
  const tools = (parsed as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  const seen = new Set<string>();
  const duplicates: { path: string; name: string }[] = [];
  tools.forEach((tool: unknown, index) => {
    const name = (tool as { name?: unknown } | null)?.name;
    if (typeof name !== 'string') {
      return;
    }
    if (seen.has(name)) {
      duplicates.push({ path: `/tools/${index}/name`, name });
    }
    seen.add(name);
  });
  return duplicates;
}

/**
 * Summarizes a validated manifest for the client.
 */
export function summarizeManifest(manifest: ExtensionManifest): ManifestSummary {
  return {
    name: manifest.name,
    version: manifest.version,
    toolCount: manifest.tools.length,
    capabilities: [...new Set(manifest.tools.map((tool) => tool.capability))],
  };
}

/**
 * Human-readable confirmation used in successful validation responses.
 */
export function describeManifest(summary: ManifestSummary): string {
  return `Manifest is valid. ${summary.toolCount} tool(s) found across ${summary.capabilities.length} capability(ies).`;
}
