/**
 * Answers a draft report submission the way Dragon Copilot's endpoint does, after routing:
 * the Content-Type check, then binding and validation, then the lookups that store the result.
 */
import { randomBytes } from 'node:crypto';
import type { ExtensionManifest } from '../../schemas/manifest.schema.js';
import type { SimulatedEnvironment, SubmissionReason, SubmissionStep } from '../../store/simulated-environment.js';
import { SUBMISSION_STEPS } from '../../store/simulated-environment.js';
import type { ValidationCheck } from '../validation.js';
import { bindDraftReportRequest } from './request-binder.js';

export interface SubmissionRequest {
  /** The customer tenant ID from the URL, decoded. */
  customerTenantId: string;
  /** The environment ID from the URL, decoded. */
  environmentId: string;
  contentType: string | undefined;
  body: Uint8Array;
}

export interface SubmissionResponse {
  status: number;
  /** The Content-Type header, when the response has a body. */
  contentType?: string;
  /** The response body; empty when there is none. */
  body: string;
  /** What happened, step by step, for the sandbox's Results tab. */
  checks: ValidationCheck[];
}

const CONTENT_TYPE_CHECK = 'Content-Type is JSON';
const VALID_REQUEST_CHECK = 'Request passes validation';
const STORED_CHECK = 'Draft report stored';

const STEP_CHECKS: Record<SubmissionStep, string> = {
  environment: 'Customer tenant and environment found',
  extension: 'Extension installed',
  tool: 'Tool declared',
  storedResult: 'Result not already stored',
  order: 'Order found',
};

const UTF8_CHARSETS = new Set(['utf-8']);
const UTF16_CHARSETS = new Set(['utf-16', 'utf-16le']);
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MEDIA_TYPE = new RegExp(`^\\s*(${TOKEN})/(${TOKEN})\\s*$`);

type ParsedContentType = { type: string; subtype: string; charset?: string } | 'missing' | 'invalid';

function parseContentType(header: string | undefined): ParsedContentType {
  if (header === undefined || header.trim() === '') {
    return 'missing';
  }
  const [mediaType, ...parameters] = header.split(';');
  const match = MEDIA_TYPE.exec(mediaType);
  if (!match) {
    return 'invalid';
  }
  let charset: string | undefined;
  for (const parameter of parameters) {
    const separator = parameter.indexOf('=');
    if (separator !== -1 && parameter.slice(0, separator).trim().toLowerCase() === 'charset') {
      charset = parameter.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1');
    }
  }
  return { type: match[1].toLowerCase(), subtype: match[2].toLowerCase(), charset };
}

function traceId(): string {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-00`;
}

function problem(status: 400 | 415, errors?: Record<string, string[]>): Pick<SubmissionResponse, 'status' | 'contentType' | 'body'> {
  const body = status === 400
    ? { type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1', title: 'One or more validation errors occurred.', status, errors, traceId: traceId() }
    : { type: 'https://tools.ietf.org/html/rfc9110#section-15.5.16', title: 'Unsupported Media Type', status, traceId: traceId() };
  return { status, contentType: 'application/problem+json; charset=utf-8', body: JSON.stringify(body) };
}

function reasonHint(reason: SubmissionReason, manifest: ExtensionManifest | null): string {
  switch (reason) {
    case 'EnvironmentNotFound':
      return 'The customer tenant and environment IDs in the URL are not the simulated environment\'s. Send to the URL shown in the Setup tab, or change the IDs there.';
    case 'ExtensionNotFound':
      return manifest
        ? `The installed extension is the loaded manifest, '${manifest.name}', and manifestName must match it, ignoring case. If you send Marketplace IDs, they must match the ones in the Setup tab. Unless you set them there, the extension is installed as a custom app, which never matches Marketplace IDs: remove them from the request, or turn on 'Extension purchased from Microsoft Marketplace' in the Setup tab and enter them.`
        : 'No manifest is loaded, so no extension is installed. Load your manifest first.';
    case 'MultipleExtensionsMatched':
      return 'More than one installed extension matches. Send the Marketplace IDs of the one you mean.';
    case 'ToolNotFound':
      return 'The loaded manifest declares no partnerInitiated tool named toolName, ignoring case, with the preDraftReportGeneration capability.';
    case 'ResultAlreadyStored':
      return 'A result with this draftReport.identifier is already stored. Send a new identifier, or clear stored results in the Setup tab.';
    case 'OrderNotFound':
      return 'No order in the simulated environment has this accession number. Add it to the orders in the Setup tab.';
    case 'MultipleOrdersMatched':
      return 'More than one order in the simulated environment has this accession number.';
  }
}

/**
 * Checks the Content-Type, which Dragon Copilot does before it reads the body.
 * @returns The 415 response when the Content-Type is turned away, otherwise the body's encoding.
 */
export function checkContentType(header: string | undefined): { rejection: SubmissionResponse } | { encoding: 'utf-8' | 'utf-16le' } {
  const contentType = parseContentType(header);
  const unsupported = (detail: string, body: Pick<SubmissionResponse, 'status' | 'contentType' | 'body'>) => ({
    rejection: { ...body, checks: [{ check: CONTENT_TYPE_CHECK, passed: false, error: `415 Unsupported Media Type. ${detail}` }] },
  });

  // A missing Content-Type gets a problem response; one that isn't JSON is turned away while routing,
  // with no body at all.
  if (contentType === 'missing') {
    return unsupported('The request has no Content-Type header. Send Content-Type: application/json.', problem(415));
  }
  if (contentType === 'invalid' || contentType.type !== 'application'
    || (contentType.subtype !== 'json' && !contentType.subtype.endsWith('+json'))) {
    return unsupported(`Content-Type '${header}' isn't JSON. Send Content-Type: application/json.`, { status: 415, body: '' });
  }
  const charset = contentType.charset?.toLowerCase();
  if (charset === undefined || UTF8_CHARSETS.has(charset)) {
    return { encoding: 'utf-8' };
  }
  if (UTF16_CHARSETS.has(charset)) {
    return { encoding: 'utf-16le' };
  }
  return unsupported(`Dragon Copilot reads UTF-8 and UTF-16 bodies, not charset '${contentType.charset}'.`, problem(415));
}

/**
 * Answers a submission that reached the endpoint: a POST to the submission route.
 * @param request The submission.
 * @param environment The simulated customer environment, which stores the result.
 * @param manifest The loaded manifest: the extension installed in the environment.
 */
export function handleSubmission(
  request: SubmissionRequest,
  environment: SimulatedEnvironment,
  manifest: ExtensionManifest | null,
): SubmissionResponse {
  const contentType = checkContentType(request.contentType);
  if ('rejection' in contentType) {
    return contentType.rejection;
  }
  const body = contentType.encoding === 'utf-16le'
    ? Buffer.from(new TextDecoder('utf-16le').decode(request.body), 'utf8')
    : request.body;

  const checks: ValidationCheck[] = [{ check: CONTENT_TYPE_CHECK, passed: true }];
  const { modelState, submission } = bindDraftReportRequest(request.customerTenantId, request.environmentId, body);
  if (!submission) {
    const errors = modelState.toErrors();
    for (const [key, messages] of Object.entries(errors)) {
      checks.push({ check: `errors[${JSON.stringify(key)}]`, passed: false, error: messages.join(' ') });
    }
    return { ...problem(400, errors), checks };
  }
  checks.push({ check: VALID_REQUEST_CHECK, passed: true });

  const outcome = environment.submit(submission, manifest);
  const failedStep = outcome.status === 200 ? undefined : outcome.step;
  for (const step of SUBMISSION_STEPS) {
    if (step === failedStep && outcome.status !== 200) {
      checks.push({ check: STEP_CHECKS[step], passed: false, error: `${outcome.status} ${outcome.reason}. ${reasonHint(outcome.reason, manifest)}` });
      return {
        status: outcome.status,
        contentType: 'application/json',
        body: JSON.stringify({ message: outcome.status === 404 ? 'Resource not found.' : 'Request could not be processed.', reason: outcome.reason }),
        checks,
      };
    }
    checks.push({ check: STEP_CHECKS[step], passed: true });
  }
  checks.push({ check: STORED_CHECK, passed: true });
  return { status: 200, body: '', checks };
}
