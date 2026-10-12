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
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = join(__dirname, '..', 'schemas', 'radiologists');
const PARTNER_INITIATED_SCHEMAS_DIR = join(SCHEMAS_DIR, 'partner-initiated');

export const MANIFEST_SCHEMA_PATH = join(SCHEMAS_DIR, 'radiologists-extension-manifest-schema.json');
export const OPENAPI_SPEC_PATH = join(SCHEMAS_DIR, 'radiologists-extensibility-api.yaml');
export const DRAFT_REPORT_SCHEMA_PATH = join(PARTNER_INITIATED_SCHEMAS_DIR, 'draft-report-schema.json');
export const DRAFT_REPORT_INGEST_REQUEST_SCHEMA_PATH = join(
  PARTNER_INITIATED_SCHEMAS_DIR,
  'draft-report-ingest-request-schema.json',
);
