import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Resolved paths to the Dragon Copilot (radiologists) schemas.
 * Shared across route handlers, tests, and build scripts to avoid duplicating path resolution logic.
 *
 * NOTE: the sandbox owns none of these contracts. All are synced into this folder at
 * dev/build/test time by `scripts/sync-schemas.ts` and are git-ignored locally, so the
 * upstream copy holds the single source of truth in each case:
 * - `radiologists-extension-manifest-schema.json` is owned by `tools/dragon-copilot-cli`.
 * - `radiologists-extensibility-api.yaml` is owned by `radiologists/`, and will be replaced
 *   with an internal package reference once `diag-radex-extension-service` publishes its
 *   authoritative version.
 * - `partner-initiated/*.json` (draft report payload schemas for `partnerInitiated` tools)
 *   are owned by `radiologists/partner-initiated/`.
 * - `partner-initiated/samples/*.json` (example ingest request / retrieve response payloads)
 *   are owned by `radiologists/partner-initiated/samples/`; the `*_SOURCE` constants record
 *   each one's repo-relative source path.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = join(__dirname, '..', 'schemas', 'radiologists');
const PARTNER_INITIATED_SCHEMAS_DIR = join(SCHEMAS_DIR, 'partner-initiated');
const PARTNER_INITIATED_SAMPLES_DIR = join(PARTNER_INITIATED_SCHEMAS_DIR, 'samples');

export const MANIFEST_SCHEMA_PATH = join(SCHEMAS_DIR, 'radiologists-extension-manifest-schema.json');
export const OPENAPI_SPEC_PATH = join(SCHEMAS_DIR, 'radiologists-extensibility-api.yaml');
export const DRAFT_REPORT_SCHEMA_PATH = join(PARTNER_INITIATED_SCHEMAS_DIR, 'draft-report-schema.json');
export const DRAFT_REPORT_INGEST_REQUEST_SCHEMA_PATH = join(
  PARTNER_INITIATED_SCHEMAS_DIR,
  'draft-report-ingest-request-schema.json',
);

export const DRAFT_REPORT_INGEST_REQUEST_EXAMPLE_SOURCE =
  'radiologists/partner-initiated/samples/PreDraftReportGeneration-Ingest-Request-Example.json';
export const DRAFT_REPORT_RETRIEVE_RESPONSE_EXAMPLE_SOURCE =
  'radiologists/partner-initiated/samples/PreDraftReportGeneration-Retrieve-Response-Example.json';
export const DRAFT_REPORT_INGEST_REQUEST_EXAMPLE_PATH = join(
  PARTNER_INITIATED_SAMPLES_DIR,
  'PreDraftReportGeneration-Ingest-Request-Example.json',
);
export const DRAFT_REPORT_RETRIEVE_RESPONSE_EXAMPLE_PATH = join(
  PARTNER_INITIATED_SAMPLES_DIR,
  'PreDraftReportGeneration-Retrieve-Response-Example.json',
);
