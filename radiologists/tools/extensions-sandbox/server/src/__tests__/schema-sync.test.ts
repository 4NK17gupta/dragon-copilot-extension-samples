import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import yaml from 'js-yaml';
import {
  DRAFT_REPORT_INGEST_REQUEST_EXAMPLE_PATH,
  DRAFT_REPORT_INGEST_REQUEST_EXAMPLE_SOURCE,
  DRAFT_REPORT_INGEST_REQUEST_SCHEMA_PATH,
  DRAFT_REPORT_RETRIEVE_RESPONSE_EXAMPLE_PATH,
  DRAFT_REPORT_RETRIEVE_RESPONSE_EXAMPLE_SOURCE,
  DRAFT_REPORT_SCHEMA_PATH,
  MANIFEST_SCHEMA_PATH,
  OPENAPI_SPEC_PATH,
} from '../utils/schema-path.js';

/**
 * Divergence guard: the sandbox owns neither the contracts it validates against
 * nor the manifest-generation code behind `/api/cli/generate`. All of them are
 * synced in by `scripts/sync-schemas.ts` (run automatically before dev/build/test)
 * from the locations that do own them. These tests fail if a synced copy drifts
 * from its authoritative source, catching a stale or hand-edited copy.
 */

// server/src/__tests__ -> repo root -> tools/dragon-copilot-cli/src/schemas/radiologists
const CLI_SCHEMA_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'tools',
  'dragon-copilot-cli',
  'src',
  'schemas',
  'radiologists',
  'radiologists-extension-manifest-schema.json',
);

// server/src/__tests__ -> radiologists/extensibility-api/radiologists-extensibility-api.yaml
const RADIOLOGISTS_SPEC_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'extensibility-api',
  'radiologists-extensibility-api.yaml',
);

// server/src/__tests__ -> repo root -> tools/dragon-copilot-cli/src/domains/radiologists/manifest
const CLI_MANIFEST_LIB_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'tools',
  'dragon-copilot-cli',
  'src',
  'domains',
  'radiologists',
  'manifest',
);

// server/src/__tests__ -> radiologists/partner-initiated
const RADIOLOGISTS_PARTNER_INITIATED_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'partner-initiated',
);

// server/src/__tests__ -> repo root
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');

// server/src/__tests__ -> server/src/cli/radiologists
const SANDBOX_MANIFEST_LIB_PATH = resolve(__dirname, '..', 'cli', 'radiologists');

/** Line endings differ between checkouts, so compare content rather than bytes. */
function readNormalized(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
}

describe('Manifest schema sync', () => {
  it('has a synced manifest schema present in the sandbox', () => {
    expect(existsSync(MANIFEST_SCHEMA_PATH)).toBe(true);
  });

  it('matches the CLI authoritative source (no drift)', () => {
    expect(existsSync(CLI_SCHEMA_PATH)).toBe(true);

    const sandboxSchema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, 'utf-8'));
    const cliSchema = JSON.parse(readFileSync(CLI_SCHEMA_PATH, 'utf-8'));

    expect(sandboxSchema).toEqual(cliSchema);
  });
});

describe('OpenAPI spec sync', () => {
  it('has a synced OpenAPI spec present in the sandbox', () => {
    expect(existsSync(OPENAPI_SPEC_PATH)).toBe(true);
  });

  it('matches the radiologists authoritative source (no drift)', () => {
    expect(existsSync(RADIOLOGISTS_SPEC_PATH)).toBe(true);

    // Compared as parsed documents rather than raw text so that a difference in
    // trailing newline or line endings is not reported as a contract drift.
    const sandboxSpec = yaml.load(readFileSync(OPENAPI_SPEC_PATH, 'utf-8'));
    const radiologistsSpec = yaml.load(readFileSync(RADIOLOGISTS_SPEC_PATH, 'utf-8'));

    expect(sandboxSpec).toEqual(radiologistsSpec);
  });
});

describe('CLI manifest core sync', () => {
  it('has the synced manifest core present in the sandbox', () => {
    expect(existsSync(SANDBOX_MANIFEST_LIB_PATH)).toBe(true);
    expect(readdirSync(SANDBOX_MANIFEST_LIB_PATH).length).toBeGreaterThan(0);
  });

  it('mirrors every file from the CLI authoritative source (no drift)', () => {
    expect(existsSync(CLI_MANIFEST_LIB_PATH)).toBe(true);

    const cliFiles = readdirSync(CLI_MANIFEST_LIB_PATH).filter((file) => file.endsWith('.ts')).sort();
    const sandboxFiles = readdirSync(SANDBOX_MANIFEST_LIB_PATH).filter((file) => file.endsWith('.ts')).sort();

    expect(sandboxFiles).toEqual(cliFiles);

    for (const file of cliFiles) {
      expect(readNormalized(resolve(SANDBOX_MANIFEST_LIB_PATH, file))).toBe(
        readNormalized(resolve(CLI_MANIFEST_LIB_PATH, file)),
      );
    }
  });

  it('keeps the synced core free of CLI-only dependencies', () => {
    // Anything beyond js-yaml (prompts, chalk, fs-extra, node:fs, …) would not
    // resolve in the sandbox server and would break its build.
    const forbidden = /from '(?!\.\/|js-yaml')/;

    for (const file of readdirSync(SANDBOX_MANIFEST_LIB_PATH).filter((name) => name.endsWith('.ts'))) {
      const source = readNormalized(resolve(SANDBOX_MANIFEST_LIB_PATH, file));
      expect(source, `${file} imports a dependency the sandbox cannot resolve`).not.toMatch(forbidden);
    }
  });
});

describe('Partner-initiated schema sync', () => {
  const syncedSchemaPaths = [DRAFT_REPORT_SCHEMA_PATH, DRAFT_REPORT_INGEST_REQUEST_SCHEMA_PATH];

  it('packages draft report schema version 1.0', () => {
    const schema = JSON.parse(readFileSync(DRAFT_REPORT_SCHEMA_PATH, 'utf-8'));
    expect(schema['x-ms-schema-version']).toBe('1.0');
  });

  it.each(syncedSchemaPaths)('has %s synced into the sandbox', (sandboxPath) => {
    expect(existsSync(sandboxPath)).toBe(true);
  });

  it.each(syncedSchemaPaths)('matches the radiologists authoritative source for %s (no drift)', (sandboxPath) => {
    const sourcePath = resolve(RADIOLOGISTS_PARTNER_INITIATED_PATH, basename(sandboxPath));
    expect(existsSync(sourcePath)).toBe(true);

    const sandboxSchema = JSON.parse(readFileSync(sandboxPath, 'utf-8'));
    const radiologistsSchema = JSON.parse(readFileSync(sourcePath, 'utf-8'));

    expect(sandboxSchema).toEqual(radiologistsSchema);
  });

  it('mirrors every top-level JSON schema from the radiologists source', () => {
    const sourceFiles = readdirSync(RADIOLOGISTS_PARTNER_INITIATED_PATH).filter((file) => file.endsWith('.json')).sort();
    const sandboxFiles = readdirSync(dirname(DRAFT_REPORT_SCHEMA_PATH)).filter((file) => file.endsWith('.json')).sort();

    expect(sandboxFiles).toEqual(sourceFiles);
  });
});

describe('Partner-initiated example payload sync', () => {
  const examples = [
    { sandboxPath: DRAFT_REPORT_INGEST_REQUEST_EXAMPLE_PATH, source: DRAFT_REPORT_INGEST_REQUEST_EXAMPLE_SOURCE },
    { sandboxPath: DRAFT_REPORT_RETRIEVE_RESPONSE_EXAMPLE_PATH, source: DRAFT_REPORT_RETRIEVE_RESPONSE_EXAMPLE_SOURCE },
  ];

  it.each(examples)('has $source synced into the sandbox', ({ sandboxPath }) => {
    expect(existsSync(sandboxPath)).toBe(true);
  });

  it.each(examples)('records an existing in-repo source path for $source', ({ sandboxPath, source }) => {
    expect(source).toMatch(/^radiologists\/partner-initiated\/samples\/[^/]+\.json$/);
    expect(basename(source)).toBe(basename(sandboxPath));
    expect(existsSync(resolve(REPO_ROOT, source))).toBe(true);
  });

  it.each(examples)('is byte-identical to $source (no drift)', ({ sandboxPath, source }) => {
    const sandboxBytes = readFileSync(sandboxPath);
    const sourceBytes = readFileSync(resolve(REPO_ROOT, source));

    expect(sandboxBytes.equals(sourceBytes)).toBe(true);
  });

  it('mirrors every example payload from the radiologists source', () => {
    const sourceDir = resolve(RADIOLOGISTS_PARTNER_INITIATED_PATH, 'samples');
    const sourceFiles = readdirSync(sourceDir).filter((file) => file.endsWith('.json')).sort();
    const sandboxFiles = readdirSync(dirname(DRAFT_REPORT_INGEST_REQUEST_EXAMPLE_PATH))
      .filter((file) => file.endsWith('.json'))
      .sort();

    expect(sandboxFiles).toEqual(sourceFiles);
  });

  describe('conforms to the synced draft report schemas', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    // The ingest request schema references the draft report schema by its file name.
    ajv.addSchema(JSON.parse(readFileSync(DRAFT_REPORT_SCHEMA_PATH, 'utf-8')), basename(DRAFT_REPORT_SCHEMA_PATH));

    it('validates the ingest request example against the ingest request schema', () => {
      const validate = ajv.compile(JSON.parse(readFileSync(DRAFT_REPORT_INGEST_REQUEST_SCHEMA_PATH, 'utf-8')));
      const isValid = validate(JSON.parse(readFileSync(DRAFT_REPORT_INGEST_REQUEST_EXAMPLE_PATH, 'utf-8')));

      expect(validate.errors).toBeNull();
      expect(isValid).toBe(true);
    });

    it('returns a draft report in the retrieve response example that matches the draft report schema', () => {
      const validate = ajv.getSchema(basename(DRAFT_REPORT_SCHEMA_PATH))!;
      const response = JSON.parse(readFileSync(DRAFT_REPORT_RETRIEVE_RESPONSE_EXAMPLE_PATH, 'utf-8'));
      const [{ output }] = response.capabilityExecutionResults.outputs;
      const isValid = validate(JSON.parse(output).draftReport);

      expect(validate.errors).toBeNull();
      expect(isValid).toBe(true);
    });
  });
});
