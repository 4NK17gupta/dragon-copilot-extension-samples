import { Router, json, type Request, type Response } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { sessionStore } from '../store/session.js';
import { MAX_ORDERS, MAX_SETTING_LENGTH, type DraftReportSettings } from '../store/draft-report-results.js';
import { DRAFT_REPORT_CONTENT_TYPE, validateIngestRequest, validationResult } from '../services/partner-validation.js';
import type { ValidationCheck, ValidationResult } from '../services/validation.js';
import { createLogger } from '../utils/logger.js';
import { exceedsDepthLimit } from '../utils/value-limit.js';

const log = createLogger('draft-report-ingest');

/**
 * The production-shaped draft report submission route. Mount at `/api/v1`, before the
 * global JSON parser: parse failures belong to the submission's response and must
 * never reach the global error logger, which could print the clinical body.
 */
export const draftReportIngestRouter = Router();

/** Sandbox-only retrieve simulation and settings. Mount at `/api/draft-report-ai-results`. */
export const draftReportResultsRouter = Router();

export const INGEST_ROUTE = '/tenants/:tenantId/environments/:environmentId/draft-report-ai-results';
export const CORRELATION_ID_HEADER = 'x-ms-correlation-id';

const MAX_CORRELATION_ID_LENGTH = 128;
const PRINTABLE_ASCII = /^[!-~]+$/;
const CORRELATION_ID_EXCLUDED = /[",;\\]/;
const TOOL_NAME_PATTERN = /^[a-z][a-zA-Z0-9]{0,127}$/;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
const ROUTE_PARAMETERS = ['tenantId', 'environmentId'] as const;

/** Dragon Copilot's JSON reader (System.Text.Json) rejects deeper nesting. */
export const MAX_JSON_DEPTH = 64;

const PROBLEM_TYPES = {
  400: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
  413: 'https://tools.ietf.org/html/rfc9110#section-15.5.14',
  415: 'https://tools.ietf.org/html/rfc9110#section-15.5.16',
  500: 'https://tools.ietf.org/html/rfc9110#section-15.6.1',
} as const;

type ProblemStatus = keyof typeof PROBLEM_TYPES;
type Reason = 'ExtensionNotFound' | 'ToolNotFound' | 'ResultAlreadyStored' | 'OrderNotFound' | 'MultipleOrdersMatched';

/** Added to every response by the sandbox. Dragon Copilot itself returns no such member. */
export interface SandboxDiagnostics {
  stored: boolean;
  processingTimeMs: number;
  validation: ValidationResult;
}

/** The members of a schema-valid ingest request that the route reads. */
interface IngestRequest {
  manifestName: string;
  toolName: string;
  publisherId?: string;
  offerId?: string;
  planId?: string;
  draftReport: {
    identifier: string;
    aiSystemInfo: { version: string };
    imagingStudy: { accessionNumber: string };
  };
}

// inflate: false rejects compressed bodies (415) instead of decompressing them; see
// middleware/json-body.ts (GHSA-27r3-jxmh-p828). The media type is checked first.
const parseJson = json({ type: () => true, strict: false, limit: '1mb', inflate: false, verify: rejectBlankBody });

/** body-parser's error `type` for an empty or whitespace-only body. */
const BLANK_BODY_ERROR = 'sandbox.body.blank';

/**
 * body-parser reads an empty body as `{}` and fails to parse a whitespace-only one, but
 * Dragon Copilot reports both as missing, so they are flagged before parsing.
 */
function rejectBlankBody(_req: IncomingMessage, _res: ServerResponse, body: Buffer): void {
  if (body.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d)) {
    throw Object.assign(new Error('Request body is blank.'), { type: BLANK_BODY_ERROR });
  }
}

function resolveCorrelationId(req: Request): string {
  // Echo a usable correlation ID, otherwise generate one, so every response carries one.
  const value = req.get(CORRELATION_ID_HEADER)?.trim();
  return value && value.length <= MAX_CORRELATION_ID_LENGTH && PRINTABLE_ASCII.test(value) && !CORRELATION_ID_EXCLUDED.test(value)
    ? value
    : randomUUID().replaceAll('-', '');
}

function hasMarketplaceIds(request: IngestRequest): boolean {
  return request.publisherId !== undefined || request.offerId !== undefined || request.planId !== undefined;
}

draftReportIngestRouter.all(INGEST_ROUTE, (req, res, next) => {
  res.set(CORRELATION_ID_HEADER, resolveCorrelationId(req));
  next();
});

draftReportIngestRouter.post(INGEST_ROUTE, (req: Request<{ tenantId: string; environmentId: string }>, res: Response) => {
  const started = performance.now();
  const checks: ValidationCheck[] = [];
  let toolName = 'unknown';

  const diagnostics = (stored: boolean): SandboxDiagnostics => {
    const validation = validationResult(toolName, DRAFT_REPORT_CONTENT_TYPE, checks);
    sessionStore.addValidationResult(validation);
    return { stored, processingTimeMs: Math.round((performance.now() - started) * 100) / 100, validation };
  };

  const problem = (status: ProblemStatus, title: string, errors?: Record<string, string[]>): void => {
    log.info(`Draft report submission rejected with ${status}.`);
    res.status(status).type('application/problem+json').json({
      type: PROBLEM_TYPES[status],
      title,
      status,
      ...(errors && { errors }),
      traceId: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-00`,
      sandbox: diagnostics(false),
    });
  };

  const unreadable = (status: 400 | 413 | 415, title: string, error: string): void => {
    checks.push({ check: 'Request body is supported JSON', passed: false, error });
    problem(status, title, status === 400 ? { '/': [error] } : undefined);
  };

  // Dragon Copilot uses one message per status, so the reason is what tells the cases apart.
  const reject = (status: 404 | 409, reason: Reason, check: string, error: string): void => {
    checks.push({ check, passed: false, error });
    log.info(`Draft report submission rejected with ${status} ${reason}.`);
    res.status(status).json({
      message: status === 404 ? 'Resource not found.' : 'Request could not be processed.',
      reason,
      sandbox: diagnostics(false),
    });
  };

  const mediaType = req.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    unreadable(415, 'Unsupported Media Type', 'Content-Type must be application/json.');
    return;
  }

  const handleBody = (error?: { type?: string }): void => {
    if (error && error.type !== BLANK_BODY_ERROR) {
      switch (error.type) {
        case 'entity.parse.failed':
          unreadable(400, 'One or more validation errors occurred.', 'Request body is not valid JSON.');
          return;
        case 'entity.too.large':
          unreadable(413, 'Content Too Large', 'Request body exceeds the 1 MB limit.');
          return;
        case 'charset.unsupported':
        case 'encoding.unsupported':
          unreadable(415, 'Unsupported Media Type', 'Request body uses an unsupported charset or content encoding.');
          return;
        default:
          // Do not forward body-parser error details (which can include PHI).
          unreadable(400, 'One or more validation errors occurred.', 'Request body could not be read.');
          return;
      }
    }

    const body: unknown = error ? undefined : req.body;
    if (exceedsDepthLimit(body, MAX_JSON_DEPTH)) {
      unreadable(400, 'One or more validation errors occurred.', `Request body is nested more than ${MAX_JSON_DEPTH} levels deep.`);
      return;
    }

    // Names the tool in the session's validation report even when the body is invalid.
    const bodyToolName: unknown = (body as { toolName?: unknown } | null)?.toolName;
    if (typeof bodyToolName === 'string' && TOOL_NAME_PATTERN.test(bodyToolName)) {
      toolName = bodyToolName;
    }

    const errors: Record<string, string[]> = {};
    for (const name of ROUTE_PARAMETERS) {
      const value = req.params[name];
      if (!GUID_PATTERN.test(value) || value === EMPTY_GUID) {
        const message = `${name} must be a valid non-empty GUID.`;
        checks.push({ check: `Route ${name} is a non-empty GUID`, passed: false, error: message });
        errors[name] = [message];
      }
    }

    if (body === undefined) {
      const message = 'A non-empty request body is required.';
      checks.push({ check: 'Request body is supported JSON', passed: false, error: message });
      errors['/'] = [message];
    } else {
      let schemaChecks: ValidationCheck[];
      try {
        schemaChecks = validateIngestRequest(body);
      } catch {
        checks.push({
          check: 'Ingest request schema',
          passed: false,
          error: 'Ingest request schema could not be loaded or compiled. Run the schema sync/build step.',
        });
        problem(500, 'An error occurred while processing your request.');
        return;
      }
      checks.push(...schemaChecks);
      for (const check of schemaChecks.filter((candidate) => !candidate.passed)) {
        const key = check.path ?? '/';
        (errors[key] ??= []).push(check.error ?? 'Request does not match the schema.');
      }
    }

    if (Object.keys(errors).length > 0) {
      problem(400, 'One or more validation errors occurred.', errors);
      return;
    }

    // Resolved in Dragon Copilot's order: extension, tool, stored result, then order. The
    // sandbox simulates one environment, so any non-empty GUIDs in the route identify it.
    const request = body as IngestRequest;
    const manifest = sessionStore.getManifest();
    const manifestName = request.manifestName.trim();
    const extensionCheck = 'Extension matches the loaded manifest';
    if (!manifest || manifest.name.toLowerCase() !== manifestName.toLowerCase()) {
      reject(404, 'ExtensionNotFound', extensionCheck, manifest
        ? `manifestName '${manifestName}' does not match the loaded manifest's name '${manifest.name}'.`
        : 'No manifest is loaded. Upload the manifest that declares this tool first.');
      return;
    }
    checks.push(hasMarketplaceIds(request)
      ? {
        check: extensionCheck,
        passed: true,
        warning: 'publisherId, offerId and planId are not matched by the sandbox. Dragon Copilot matches them against the offer and plan the customer purchased, and never matches a custom app.',
      }
      : { check: extensionCheck, passed: true });

    const requestedTool = request.toolName.trim();
    const tool = manifest.tools.find((candidate) => candidate.name.toLowerCase() === requestedTool.toLowerCase());
    const toolCheck = 'Tool is a partnerInitiated preDraftReportGeneration tool';
    if (!tool || tool.toolType !== 'partnerInitiated' || tool.capability !== 'preDraftReportGeneration') {
      reject(404, 'ToolNotFound', toolCheck, tool
        ? `Tool '${tool.name}' is ${tool.toolType} with the ${tool.capability} capability. Only partnerInitiated tools with the preDraftReportGeneration capability submit draft reports.`
        : `Manifest '${manifest.name}' declares no tool named '${requestedTool}'.`);
      return;
    }
    toolName = tool.name;
    checks.push({ check: toolCheck, passed: true });

    const store = sessionStore.draftReports;
    const { draftReport } = request;
    const identifierCheck = 'draftReport.identifier is not already stored';
    if (store.hasIdentifier(draftReport.identifier)) {
      reject(409, 'ResultAlreadyStored', identifierCheck,
        'A result with this draftReport.identifier is already stored. To replace a draft, submit it again with a new identifier.');
      return;
    }
    checks.push({ check: identifierCheck, passed: true });

    const { accessionNumber } = draftReport.imagingStudy;
    const orders = store.countOrders(accessionNumber);
    const orderCheck = 'Accession number matches exactly one order';
    if (orders !== 1) {
      if (orders === 0) {
        reject(404, 'OrderNotFound', orderCheck,
          'No order in the simulated environment has this accession number. Add it to the sandbox orders with PUT /api/draft-report-ai-results/settings.');
      } else {
        reject(409, 'MultipleOrdersMatched', orderCheck,
          `${orders} orders in the simulated environment have this accession number.`);
      }
      return;
    }
    checks.push({ check: orderCheck, passed: true });

    store.store({
      // Dragon Copilot takes this from the access token's tenant, which must equal the
      // manifest's auth.tenantId for the extension to match.
      partnerTenantId: manifest.auth.tenantId,
      extensionName: manifest.name,
      toolName: tool.name,
      identifier: draftReport.identifier,
      accessionNumber,
      aiModelVersion: draftReport.aiSystemInfo.version,
      draftReport,
    });
    log.info('Draft report submission stored.');
    res.status(200).json({ sandbox: diagnostics(true) });
  };

  parseJson(req, res, (error?: { type?: string }) => {
    // body-parser calls back from a stream event, outside Express's error handling, so
    // anything thrown here would stop the server. Answer 500 instead.
    try {
      handleBody(error);
    } catch (unexpected) {
      // Only the error's name is logged; its message could quote the clinical body.
      log.error(`Draft report submission failed unexpectedly (${unexpected instanceof Error ? unexpected.name : typeof unexpected}).`);
      if (!res.headersSent) {
        checks.push({
          check: 'Submission processed',
          passed: false,
          error: 'The sandbox failed to process the submission. See the server log.',
        });
        problem(500, 'An error occurred while processing your request.');
      }
    }
  });
});

draftReportIngestRouter.all(INGEST_ROUTE, (_req, res) => {
  res.set('Allow', 'POST').sendStatus(405);
});

/**
 * GET /api/draft-report-ai-results?accessionNumber=...
 * Returns every stored result for the accession number, from any extension, shaped as
 * Dragon Copilot's retrieve response. The accession number is a query parameter so the
 * request logger, which logs only the path, never records it.
 */
draftReportResultsRouter.get('/', (req, res) => {
  const { accessionNumber } = req.query;
  if (typeof accessionNumber !== 'string' || !accessionNumber.trim()) {
    res.status(400).json({ error: 'accessionNumber query parameter is required.' });
    return;
  }
  res.json(sessionStore.draftReports.retrieve(accessionNumber));
});

/** DELETE /api/draft-report-ai-results — forgets every stored result and identifier. */
draftReportResultsRouter.delete('/', (_req, res) => {
  sessionStore.draftReports.clearResults();
  res.sendStatus(204);
});

/** GET /api/draft-report-ai-results/settings — the simulated environment's settings. */
draftReportResultsRouter.get('/settings', (_req, res) => {
  res.json(sessionStore.draftReports.getSettings());
});

/** PUT /api/draft-report-ai-results/settings — updates `vendorName` and/or `orders`. */
draftReportResultsRouter.put('/settings', (req, res) => {
  const update = parseSettings(req.body);
  if (typeof update === 'string') {
    res.status(400).json({ error: update });
    return;
  }
  res.json(sessionStore.draftReports.updateSettings(update));
});

function isSettingValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_SETTING_LENGTH;
}

function parseSettings(body: unknown): Partial<DraftReportSettings> | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'Body must be a JSON object.';
  }
  if (Object.keys(body).some((key) => key !== 'vendorName' && key !== 'orders')) {
    return 'Only vendorName and orders can be set.';
  }
  const { vendorName, orders } = body as Record<string, unknown>;
  const update: Partial<DraftReportSettings> = {};
  if (vendorName !== undefined) {
    if (!isSettingValue(vendorName)) {
      return `vendorName must be a non-blank string of at most ${MAX_SETTING_LENGTH} characters.`;
    }
    update.vendorName = vendorName;
  }
  if (orders !== undefined) {
    if (!Array.isArray(orders) || orders.length > MAX_ORDERS || !orders.every(isSettingValue)) {
      return `orders must be an array of at most ${MAX_ORDERS} accession numbers, each a non-blank string of at most ${MAX_SETTING_LENGTH} characters.`;
    }
    update.orders = orders;
  }
  return update;
}
