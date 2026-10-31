import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import type { ManifestTool } from '../schemas/manifest.schema.js';
import { checkContentType, handleSubmission, type SubmissionResponse } from '../services/draft-report-submission/submission-endpoint.js';
import type { ValidationCheck, ValidationResult } from '../services/validation.js';
import { sessionStore } from '../store/session.js';
import { simulatedEnvironment } from '../store/simulated-environment.js';

/** The largest body Dragon Copilot reads: ASP.NET Core's default limit. */
const MAX_BODY_BYTES = 30_000_000;

/** The largest request body the Outputs tab shows. */
const MAX_SHOWN_BODY_BYTES = 1_000_000;

const CORRELATION_ID_HEADER = 'x-ms-correlation-id';
const MAX_CORRELATION_ID_LENGTH = 128;

/**
 * A local stand-in for Dragon Copilot's API: `POST /api/v1/tenants/{customerTenantId}/environments/
 * {environmentId}/draft-report-ai-results` answers as Dragon Copilot does, apart from authentication,
 * while the sandbox is capturing requests (Run Test). Otherwise it answers 503.
 * Mount it before any body parser; it reads the raw body itself.
 */
export const dragonCopilotApiRouter = Router();

const NOT_CAPTURING_MESSAGE = "The sandbox isn't listening for requests. Click Run Test in the sandbox, then send again.";

/** Echoes a usable correlation ID, or generates one, so every response carries one. */
function resolveCorrelationId(value: string | undefined): string {
  const candidate = value?.trim() ?? '';
  const usable = candidate.length > 0
    && candidate.length <= MAX_CORRELATION_ID_LENGTH
    && [...candidate].every((character) => character >= '!' && character <= '~' && !'",;\\'.includes(character));
  return usable ? candidate : randomUUID().replaceAll('-', '');
}

/** Reads the body, or returns null when it is over the limit. */
async function readBody(req: Request): Promise<Buffer | null> {
  if (Number(req.get('content-length')) > MAX_BODY_BYTES) {
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function parsedOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The request body as the Outputs tab shows it. */
function shownRequestBody(body: Buffer | null, contentType: string | undefined): unknown {
  if (body === null) {
    return `(more than ${MAX_BODY_BYTES} bytes)`;
  }
  if (body.length === 0) {
    return undefined;
  }
  if (body.length > MAX_SHOWN_BODY_BYTES) {
    return `(${body.length} bytes, too large to show)`;
  }
  const text = /charset\s*=\s*"?utf-16/i.test(contentType ?? '')
    ? new TextDecoder('utf-16le').decode(body)
    : new TextDecoder('utf-8').decode(body);
  return parsedOrText(text);
}

function submissionValidationResult(tool: ManifestTool, checks: ValidationCheck[]): ValidationResult {
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

function send(res: Response, response: SubmissionResponse): void {
  res.status(response.status);
  if (response.contentType) {
    res.setHeader('Content-Type', response.contentType);
  }
  res.end(response.body);
}

/** Records the exchange in the capture, so the sandbox shows it. */
function record(capture: { runId: string; tool: ManifestTool }, req: Request, res: Response, body: Buffer | null, response: SubmissionResponse): void {
  const validation = submissionValidationResult(capture.tool, response.checks);
  const headers: Record<string, string> = {};
  for (const name of ['content-type', CORRELATION_ID_HEADER]) {
    const value = res.getHeader(name);
    if (value !== undefined) {
      headers[name] = String(value);
    }
  }
  const recorded = sessionStore.partnerRuns.record(capture.runId, {
    path: req.originalUrl,
    status: response.status,
    statusText: STATUS_CODES[response.status] ?? '',
    headers,
    rawBody: shownRequestBody(body, req.get('content-type')),
    responseBody: response.body ? parsedOrText(response.body) : undefined,
    validation,
  });
  if (recorded) {
    sessionStore.addValidationResult(validation);
  }
}

dragonCopilotApiRouter.use((req, res, next) => {
  res.setHeader(CORRELATION_ID_HEADER, resolveCorrelationId(req.get(CORRELATION_ID_HEADER)));
  next();
});

dragonCopilotApiRouter
  .route('/tenants/:customerTenantId/environments/:environmentId/draft-report-ai-results')
  .post(async (req, res) => {
    // Note the capture as the request arrives: one that arrives after Stop is turned away, and one
    // still being answered when the capture stops or is replaced isn't recorded.
    const capture = sessionStore.partnerRuns.active();
    if (!capture) {
      res.status(503).json({ message: NOT_CAPTURING_MESSAGE });
      return;
    }
    const body = await readBody(req);

    let response: SubmissionResponse;
    if (body === null) {
      const contentType = checkContentType(req.get('content-type'));
      response = 'rejection' in contentType ? contentType.rejection : {
        status: 413,
        body: '',
        checks: [{ check: 'Request body size', passed: false, error: `413 Payload Too Large. The body is over ${MAX_BODY_BYTES} bytes.` }],
      };
      // The rest of the body is never read, so don't reuse the connection.
      res.setHeader('Connection', 'close');
    } else {
      response = handleSubmission(
        {
          customerTenantId: req.params.customerTenantId,
          environmentId: req.params.environmentId,
          contentType: req.get('content-type'),
          body,
        },
        simulatedEnvironment,
        sessionStore.getManifest(),
      );
    }

    send(res, response);
    record(capture, req, res, body, response);
  })
  .all((_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).end();
  });

// As in Dragon Copilot, any other path gets 404 with no body.
dragonCopilotApiRouter.use((_req, res) => {
  res.status(404).end();
});
