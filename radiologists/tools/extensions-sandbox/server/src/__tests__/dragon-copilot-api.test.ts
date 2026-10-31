import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jsonBodyParser } from '../middleware/json-body.js';
import { manifestRouter } from '../routes/manifest.js';
import { dragonCopilotApiRouter } from '../routes/dragon-copilot-api.js';
import { simulatedEnvironmentRouter } from '../routes/simulated-environment.js';
import { ModelState } from '../services/draft-report-submission/model-state.js';
import { sessionStore } from '../store/session.js';
import { simulatedEnvironment } from '../store/simulated-environment.js';
import type { ExtensionManifest } from '../schemas/manifest.schema.js';
import type { CaptureResponse } from '../routes/partner-initiated.js';
import { MAX_CAPTURED_REQUESTS, type PartnerRunResult } from '../store/partner-run.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ENVIRONMENT = '22222222-2222-2222-2222-222222222222';
const submissionPath = (tenant = TENANT, environment = ENVIRONMENT) =>
  `/api/v1/tenants/${tenant}/environments/${environment}/draft-report-ai-results`;
const BODY_REQUIRED = { draftReportRequestDto: ['The draftReportRequestDto field is required.'] };
const runsPath = '/api/manifest/partner-initiated';

const fixture: ExtensionManifest = JSON.parse(readFileSync(
  new URL('./fixtures/valid-manifest-partner-initiated.json', import.meta.url), 'utf-8',
));
const mixedFixture: ExtensionManifest = JSON.parse(readFileSync(
  new URL('./fixtures/valid-manifest-mixed-tool-types.json', import.meta.url), 'utf-8',
));
const example = JSON.parse(readFileSync(
  new URL('../../../../../partner-initiated/samples/PreDraftReportGeneration-Ingest-Request-Example.json', import.meta.url), 'utf-8',
));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  // Same order as index.ts: the simulated API reads the raw body before the JSON parser.
  app.use('/api/v1', dragonCopilotApiRouter);
  app.use(jsonBodyParser);
  app.use('/api/manifest', manifestRouter);
  app.use('/api/simulated-environment', simulatedEnvironmentRouter);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sessionStore.clear();
  simulatedEnvironment.reset();
});

/** Loads a manifest and opens a capture for its partnerInitiated tool, as Run Test does. */
function loadAndCapture(manifest: ExtensionManifest): void {
  sessionStore.setManifest(structuredClone(manifest));
  const tool = manifest.tools.find((candidate) => candidate.toolType === 'partnerInitiated')!;
  sessionStore.partnerRuns.start(tool);
}

beforeEach(() => {
  sessionStore.clear();
  simulatedEnvironment.reset();
  // Most tests send the bundled example as it is, so the extension is purchased with its Marketplace IDs.
  simulatedEnvironment.setSettings({
    ...simulatedEnvironment.getSettings(),
    marketplace: { publisherId: example.publisherId, offerId: example.offerId, planId: example.planId },
  });
  loadAndCapture(fixture);
});

function withExample(change: (body: any) => void): unknown {
  const body = structuredClone(example);
  change(body);
  return body;
}

function submit(
  body: unknown = example,
  options: { path?: string; contentType?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (contentType !== null) headers['Content-Type'] = contentType;
  return fetch(`${baseUrl}${options.path ?? submissionPath()}`, {
    method: 'POST',
    headers,
    body: new Uint8Array(Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))),
  });
}

async function errorsOf(response: Response): Promise<Record<string, string[]>> {
  expect(response.status).toBe(400);
  expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
  const problem = await response.json();
  expect(Object.keys(problem)).toEqual(['type', 'title', 'status', 'errors', 'traceId']);
  expect(problem).toMatchObject({
    type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
    title: 'One or more validation errors occurred.',
    status: 400,
  });
  expect(problem.traceId).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
  return problem.errors;
}

async function expectReason(response: Response, status: 404 | 409, reason: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.json()).toEqual({
    message: status === 404 ? 'Resource not found.' : 'Request could not be processed.',
    reason,
  });
}

async function expectStored(response: Response): Promise<void> {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBeNull();
  expect(await response.text()).toBe('');
}

function putEnvironment(settings: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/simulated-environment`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...simulatedEnvironment.getSettings(), ...settings }),
  });
}

function startRequest(body: unknown = { capability: fixture.tools[0].capability, tool: fixture.tools[0].name }): Promise<Response> {
  return fetch(`${baseUrl}${runsPath}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function start(): Promise<CaptureResponse> {
  const response = await startRequest();
  expect(response.status).toBe(201);
  return response.json();
}

async function poll(run: CaptureResponse, after?: number): Promise<CaptureResponse> {
  const response = await fetch(`${baseUrl}${runsPath}/${run.runId}${after === undefined ? '' : `?after=${after}`}`);
  expect(response.status).toBe(200);
  return response.json();
}

function stop(run: CaptureResponse): Promise<Response> {
  return fetch(`${baseUrl}${runsPath}/${run.runId}`, { method: 'DELETE' });
}

async function expectNotCapturing(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect(response.headers.get('x-ms-correlation-id')).toMatch(/^[0-9a-f]{32}$/);
  expect(await response.json()).toEqual({
    message: "The sandbox isn't listening for requests. Click Run Test in the sandbox, then send again.",
  });
}

describe('Simulated Dragon Copilot endpoint: answers', () => {
  it('stores a valid submission and answers 200 with no body', async () => {
    await expectStored(await submit());
    expect(simulatedEnvironment.storedResultCount).toBe(1);
  });

  it('answers ResultAlreadyStored for an identifier sent again, until stored results are cleared', async () => {
    await expectStored(await submit());
    await expectReason(await submit(), 409, 'ResultAlreadyStored');
    await fetch(`${baseUrl}/api/simulated-environment/stored-results`, { method: 'DELETE' });
    await expectStored(await submit());
  });

  it('answers OrderNotFound for an accession number with no order', async () => {
    await expectReason(
      await submit(withExample((body) => { body.draftReport.imagingStudy.accessionNumber = 'ACC-DOES-NOT-EXIST'; })),
      404, 'OrderNotFound',
    );
  });

  it('answers MultipleOrdersMatched when two orders have the accession number', async () => {
    expect((await putEnvironment({ orders: ['ACC-0000001', 'ACC-0000001'] })).status).toBe(200);
    await expectReason(await submit(), 409, 'MultipleOrdersMatched');
  });

  it('answers EnvironmentNotFound for another environment', async () => {
    await expectReason(
      await submit(example, { path: submissionPath(TENANT, '33333333-3333-3333-3333-333333333333') }),
      404, 'EnvironmentNotFound',
    );
  });

  it('answers ExtensionNotFound when manifestName is not the loaded manifest', async () => {
    await expectReason(await submit(withExample((body) => { body.manifestName = 'someOtherExtension'; })), 404, 'ExtensionNotFound');
  });

  it('matches Marketplace IDs to the installation, and never to a custom app', async () => {
    const otherIds = withExample((body) => Object.assign(body, { publisherId: 'p', offerId: 'o', planId: 'q' }));
    await expectReason(await submit(otherIds), 404, 'ExtensionNotFound');

    expect((await putEnvironment({ marketplace: null })).status).toBe(200);
    await expectReason(await submit(), 404, 'ExtensionNotFound');
    // Without Marketplace IDs, the extension is matched by name alone.
    await expectStored(await submit(withExample((body) => {
      delete body.publisherId;
      delete body.offerId;
      delete body.planId;
    })));
  });

  it('installs the extension as a custom app by default, so the bundled example\'s placeholder Marketplace IDs never match', async () => {
    simulatedEnvironment.reset();
    await expectReason(await submit(), 404, 'ExtensionNotFound');
    const { runId } = sessionStore.partnerRuns.active()!;
    expect(sessionStore.partnerRuns.get(runId)!.requests[0].validation.checks.at(-1)).toMatchObject({
      check: 'Extension installed',
      passed: false,
      error: expect.stringContaining("remove them from the request, or turn on 'Extension purchased from Microsoft Marketplace'"),
    });

    await expectStored(await submit(withExample((body) => {
      delete body.publisherId;
      delete body.offerId;
      delete body.planId;
    })));
  });

  it('answers ToolNotFound for an undeclared tool, or a tool that is not partnerInitiated', async () => {
    await expectReason(await submit(withExample((body) => { body.toolName = 'toolThatIsNotInstalled'; })), 404, 'ToolNotFound');
    loadAndCapture(mixedFixture);
    const contractBased = mixedFixture.tools.find((tool) => tool.toolType === 'contractBased')!;
    await expectReason(await submit(withExample((body) => { body.toolName = contractBased.name; })), 404, 'ToolNotFound');
  });

  it('matches the manifest and tool names ignoring case', async () => {
    await expectStored(await submit(withExample((body) => {
      body.manifestName = 'sampleRADIOLOGYExtension';
      body.toolName = 'preDraftReportGENERATORTool';
    })));
  });

  it('checks the tool before the stored result and the order', async () => {
    await expectReason(
      await submit(withExample((body) => {
        body.toolName = 'toolThatIsNotInstalled';
        body.draftReport.imagingStudy.accessionNumber = 'ACC-DOES-NOT-EXIST';
      })),
      404, 'ToolNotFound',
    );
  });
});

describe('Simulated Dragon Copilot endpoint: validation', () => {
  it('reports a missing required property when its object closes, without the other rules', async () => {
    expect(await errorsOf(await submit(withExample((body) => {
      delete body.manifestName;
      body.draftReport.reportContent.structuredReport.sections[0].aiConfidence = 1.5;
    })))).toEqual({
      $: ["JSON deserialization for type 'DraftReportIngestRequest' was missing required properties including: 'manifestName'."],
      ...BODY_REQUIRED,
    });

    expect(await errorsOf(await submit(withExample((body) => { delete body.draftReport.imagingStudy.accessionNumber; })))).toEqual({
      ...BODY_REQUIRED,
      '$.draftReport.imagingStudy': ["JSON deserialization for type 'ImagingStudy' was missing required properties including: 'accessionNumber'."],
    });
  });

  it('names request types by their short names, not Dragon Copilot\'s internal .NET names', async () => {
    const sections = '$.draftReport.reportContent.structuredReport.sections';
    const converted = async (change: (body: any) => void, key: string) => {
      const errors = await errorsOf(await submit(withExample(change)));
      return errors[key][0].replace(/ Path: .*$/, '');
    };

    expect(await converted((body) => { body.draftReport = []; }, '$.draftReport'))
      .toBe('The JSON value could not be converted to DraftReport.');
    expect(await converted((body) => { body.draftReport.reportContent.structuredReport.sections = {}; }, sections))
      .toBe('The JSON value could not be converted to System.Collections.Generic.IReadOnlyCollection`1[Section].');
    expect(await converted((body) => { body.draftReport.imagingStudy.bodyParts = 'Lung'; }, '$.draftReport.imagingStudy.bodyParts'))
      .toBe('The JSON value could not be converted to System.Collections.Generic.IReadOnlyCollection`1[System.String].');
    expect((await errorsOf(await submit('[]'))).$[0]).toMatch(/^The JSON value could not be converted to DraftReportIngestRequest\. /);
  });

  it('reports a required value that is null by its .NET property path', async () => {
    expect(await errorsOf(await submit(withExample((body) => { body.draftReport.imagingStudy.accessionNumber = null; })))).toEqual({
      'DraftReport.ImagingStudy.AccessionNumber': ['The AccessionNumber field is required.'],
    });
  });

  it('reports a value of the wrong type with its path, line and byte position', async () => {
    expect(await errorsOf(await submit('{\n  "manifestName": 5\n}'))).toEqual({
      ...BODY_REQUIRED,
      '$.manifestName': ['The JSON value could not be converted to System.String. Path: $.manifestName | LineNumber: 1 | BytePositionInLine: 19.'],
    });
  });

  it('reports a syntax error with Dragon Copilot\'s message and position', async () => {
    expect(await errorsOf(await submit('{\n  "draftReport": {\n    "identifier": x\n  }\n}'))).toEqual({
      ...BODY_REQUIRED,
      '$.draftReport.identifier': ["'x' is an invalid start of a value. Path: $.draftReport.identifier | LineNumber: 2 | BytePositionInLine: 18."],
    });
  });

  it('reads numbers written as strings, as Dragon Copilot does', async () => {
    await expectStored(await submit(withExample((body) => {
      const [section] = body.draftReport.reportContent.structuredReport.sections;
      section.aiConfidence = '0.9';
      section.sectionOrder = '1';
      body.draftReport.qualityMetrics.imageQualityScore = '0.5';
    })));
  });

  it('rejects the numbers Dragon Copilot rejects', async () => {
    const sectionPath = '$.draftReport.reportContent.structuredReport.sections[0]';
    const integerWithFraction = JSON.stringify(example).replace('"sectionOrder":1', '"sectionOrder":1.0');
    expect(Object.keys(await errorsOf(await submit(integerWithFraction)))).toContain(`${sectionPath}.sectionOrder`);

    const padded = await errorsOf(await submit(withExample((body) => {
      body.draftReport.reportContent.structuredReport.sections[0].aiConfidence = ' 0.9';
    })));
    expect(padded[`${sectionPath}.aiConfidence`][0]).toMatch(/^The JSON value could not be converted to System\.Double\. Path: /);

    expect(await errorsOf(await submit(withExample((body) => {
      body.draftReport.reportContent.structuredReport.sections[0].aiConfidence = 'NaN';
    })))).toEqual({
      'DraftReport.ReportContent.StructuredReport.Sections[0].AiConfidence': ['The field AiConfidence must be between 0 and 1.'],
    });
  });

  it('trims names and Marketplace IDs, and accepts an empty version', async () => {
    await expectStored(await submit(withExample((body) => {
      body.manifestName = '  sampleRadiologyExtension  ';
      body.publisherId = ' 101 ';
      body.version = '';
    })));
  });

  it('reports an empty body and a body of null the same way', async () => {
    const empty = { '': ['A non-empty request body is required.'], ...BODY_REQUIRED };
    expect(await errorsOf(await submit(''))).toEqual(empty);
    expect(await errorsOf(await submit('null'))).toEqual(empty);
  });

  it('checks the route IDs after trimming them', async () => {
    expect(await errorsOf(await submit(example, { path: submissionPath('not-a-guid') }))).toEqual({
      tenantId: ['tenantId must be a valid non-empty GUID.'],
    });
    await expectStored(await submit(example, { path: submissionPath(`%20${TENANT}%20`) }));
  });

  it('lists errors in the order Dragon Copilot does', async () => {
    const sections = 'DraftReport.ReportContent.StructuredReport.Sections[0]';
    const errors = await errorsOf(await submit(withExample((body) => {
      const { structuredReport } = body.draftReport.reportContent;
      structuredReport.format = 'html';
      Object.assign(structuredReport.sections[0], { name: 'Impression', aiConfidence: 1.5, sectionOrder: 0 });
    })));
    expect(Object.entries(errors)).toEqual([
      ['DraftReport.ReportContent.StructuredReport.Format', ['The Format field does not equal any of the values specified in AllowedValuesAttribute.']],
      [`${sections}.Name`, ["The field Name must match the regular expression '^[a-z][a-z_]*$'."]],
      [`${sections}.AiConfidence`, ['The field AiConfidence must be between 0 and 1.']],
      [`${sections}.SectionOrder`, ['The field SectionOrder must be between 1 and 2147483647.']],
    ]);

    const marketplace = await errorsOf(await submit(withExample((body) => Object.assign(body, { publisherId: '', offerId: '', planId: '' }))));
    expect(Object.keys(marketplace)).toEqual(['PlanId', 'OfferId', 'PublisherId']);
  });

  it('checks that Marketplace IDs come together only when everything else is valid', async () => {
    expect(await errorsOf(await submit(withExample((body) => { delete body.planId; })))).toEqual({
      MarketplaceExtensionIdentifiers: ['PublisherId, OfferId and PlanId must be supplied together or omitted together.'],
    });
    expect(await errorsOf(await submit(withExample((body) => {
      delete body.planId;
      body.manifestName = 'Sample-Extension';
    })))).toEqual({
      ManifestName: ['The ManifestName must be camelCase and contain only letters and digits.'],
    });
  });

  it('ignores unknown properties and matches property names ignoring case', async () => {
    const pascalCase = (value: unknown): unknown => Array.isArray(value)
      ? value.map(pascalCase)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key[0].toUpperCase() + key.slice(1), pascalCase(item)]))
        : value;
    await expectStored(await submit({ ...(pascalCase(example) as object), extra: { nested: [1, null] } }));
  });

  it('uses the last of two properties with the same name', async () => {
    const valid = JSON.stringify(example);
    await expectStored(await submit(`{"MANIFESTNAME":"Bad-Name",${valid.slice(1)}`));
    simulatedEnvironment.clearStoredResults();
    expect(await errorsOf(await submit(`${valid.slice(0, -1)},"manifestName":"Bad-Name"}`))).toEqual({
      ManifestName: ['The ManifestName must be camelCase and contain only letters and digits.'],
    });
  });

  it('reads at most 32 levels of nesting', async () => {
    const valid = JSON.stringify(example);
    const nested = (depth: number) => `${valid.slice(0, -1)},"deep":${'['.repeat(depth)}${']'.repeat(depth)}}`;
    await expectStored(await submit(nested(31)));
    const errors = await errorsOf(await submit(nested(32)));
    expect(errors['$.deep'][0]).toMatch(/^The maximum configured depth of 32 has been exceeded\. Cannot read next JSON array\. Path: \$\.deep \| /);
  });
});

describe('Simulated Dragon Copilot endpoint: HTTP', () => {
  it('answers 415 with no body when the Content-Type is not JSON', async () => {
    const response = await submit(example, { contentType: 'text/plain' });
    expect(response.status).toBe(415);
    expect(response.headers.get('content-type')).toBeNull();
    expect(await response.text()).toBe('');
  });

  it('answers 415 with a problem when the Content-Type is missing or its charset is not supported', async () => {
    for (const contentType of [null, 'application/json; charset=us-ascii']) {
      const response = await submit(example, { contentType });
      expect(response.status).toBe(415);
      expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
      expect(await response.json()).toMatchObject({
        type: 'https://tools.ietf.org/html/rfc9110#section-15.5.16', title: 'Unsupported Media Type', status: 415,
      });
    }
  });

  it('reads JSON media types with a +json suffix, and UTF-16 bodies', async () => {
    await expectStored(await submit(example, { contentType: 'application/vnd.test+json' }));
    simulatedEnvironment.clearStoredResults();
    await expectStored(await submit(Buffer.from(JSON.stringify(example), 'utf16le'), { contentType: 'application/json; charset=utf-16' }));
  });

  it('does not decompress a compressed body', async () => {
    const response = await submit(gzipSync(JSON.stringify(example)), { headers: { 'Content-Encoding': 'gzip' } });
    expect(await errorsOf(response)).toEqual({
      $: ["'0x1F' is an invalid start of a value. Path: $ | LineNumber: 0 | BytePositionInLine: 0."],
      ...BODY_REQUIRED,
    });
  });

  it('answers 405 with Allow: POST for other methods', async () => {
    const response = await fetch(`${baseUrl}${submissionPath()}`);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(await response.text()).toBe('');
  });

  it('answers 404 with no body for an unknown path, with a correlation ID', async () => {
    const response = await submit(example, { path: '/api/v1/draft-report-ai-results' });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(response.headers.get('x-ms-correlation-id')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('echoes a usable correlation ID and replaces an unusable one', async () => {
    const echoed = await submit(example, { headers: { 'x-ms-correlation-id': 'my-correlation-id' } });
    expect(echoed.headers.get('x-ms-correlation-id')).toBe('my-correlation-id');
    const replaced = await submit(example, { headers: { 'x-ms-correlation-id': 'has,a,comma' } });
    expect(replaced.headers.get('x-ms-correlation-id')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('answers 413 for a body over 30,000,000 bytes without reading it', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${baseUrl}${submissionPath()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '30000001' },
      });
      request.on('error', reject);
      request.on('response', (response) => {
        response.resume();
        resolve(response.statusCode!);
        request.destroy();
      });
      request.write('{');
    });
    expect(status).toBe(413);
  });
});

describe('Run Test for partnerInitiated tools', () => {
  const answered: PartnerRunResult = {
    path: submissionPath(), status: 200, statusText: 'OK', headers: {}, rawBody: example,
    validation: { valid: true, toolName: 'x', outputContentType: 'x', checks: [], summary: { passed: 0, failed: 0 }, timestamp: '' },
  };

  it('opens a capture whose path follows the simulated environment', async () => {
    const run = await start();
    expect(run).toEqual({ runId: expect.any(String), status: 'capturing', count: 0, requests: [], callbackPath: submissionPath() });
    expect(await poll(run)).toEqual(run);

    expect((await putEnvironment({ environmentId: '33333333-3333-3333-3333-333333333333' })).status).toBe(200);
    expect((await poll(run)).callbackPath).toBe(submissionPath(TENANT, '33333333-3333-3333-3333-333333333333'));
    // A request to the old path is recorded with the path it was sent to.
    await expectReason(await submit(), 404, 'EnvironmentNotFound');
    expect((await poll(run)).requests[0]).toMatchObject({ path: submissionPath(), status: 404 });
  });

  it('records the exchange and every step that passed', async () => {
    const run = await start();
    await expectStored(await submit(example, { headers: { 'x-ms-correlation-id': 'run-1' } }));
    const { count, requests: [request] } = await poll(run);
    expect(count).toBe(1);
    expect(request).toMatchObject({
      sequence: 1,
      path: submissionPath(),
      status: 200,
      statusText: 'OK',
      headers: { 'x-ms-correlation-id': 'run-1' },
      rawBody: example,
      validation: { valid: true, toolName: fixture.tools[0].name, summary: { passed: 8, failed: 0 } },
    });
    expect(Date.parse(request.receivedAt)).not.toBeNaN();
    expect(request.responseBody).toBeUndefined();
    expect(request.validation.checks.map((check) => check.check)).toEqual([
      'Content-Type is JSON', 'Request passes validation', 'Customer tenant and environment found',
      'Extension installed', 'Tool declared', 'Result not already stored', 'Order found', 'Draft report stored',
    ]);
    expect(sessionStore.getValidationResults()).toEqual([request.validation]);
  });

  it('records a rejected submission with a failed check for each error key', async () => {
    const run = await start();
    await submit(withExample((body) => { body.draftReport.imagingStudy.accessionNumber = null; }));
    const [request] = (await poll(run)).requests;
    expect(request).toMatchObject({
      status: 400,
      statusText: 'Bad Request',
      headers: { 'content-type': 'application/problem+json; charset=utf-8' },
      responseBody: { errors: { 'DraftReport.ImagingStudy.AccessionNumber': ['The AccessionNumber field is required.'] } },
      validation: { valid: false, summary: { passed: 1, failed: 1 } },
    });
    expect(request.validation.checks[1]).toEqual({
      check: 'errors["DraftReport.ImagingStudy.AccessionNumber"]', passed: false, error: 'The AccessionNumber field is required.',
    });
  });

  it('records the step a valid submission failed at, with its reason', async () => {
    const run = await start();
    await submit(withExample((body) => { body.draftReport.imagingStudy.accessionNumber = 'ACC-DOES-NOT-EXIST'; }));
    const { checks } = (await poll(run)).requests[0].validation;
    expect(checks.at(-1)).toMatchObject({ check: 'Order found', passed: false, error: expect.stringMatching(/^404 OrderNotFound\. /) });
    expect(checks.slice(0, -1).every((check) => check.passed)).toBe(true);
  });

  it('records a submission the endpoint turned away before reading it', async () => {
    const run = await start();
    await submit(example, { contentType: 'text/plain' });
    expect((await poll(run)).requests[0]).toMatchObject({
      status: 415, rawBody: example, validation: { valid: false, checks: [{ check: 'Content-Type is JSON', passed: false }] },
    });
  });

  it('records every request, so sending an identifier again shows its 409', async () => {
    const run = await start();
    await expectStored(await submit());
    await expectReason(await submit(), 409, 'ResultAlreadyStored');
    const capture = await poll(run);
    expect(capture.count).toBe(2);
    expect(capture.requests.map(({ sequence, status }) => [sequence, status])).toEqual([[1, 200], [2, 409]]);
    expect(capture.requests[1].validation.checks.at(-1)).toMatchObject({
      check: 'Result not already stored', passed: false, error: expect.stringMatching(/^409 ResultAlreadyStored\. /),
    });
    expect((await poll(run, 1)).requests.map((request) => request.sequence)).toEqual([2]);
    expect((await poll(run, 2)).requests).toEqual([]);
    expect(sessionStore.getValidationResults()).toHaveLength(2);
  });

  it('records requests sent together once each', async () => {
    const run = await start();
    const second = withExample((body) => { body.draftReport.identifier = 'second'; });
    const responses = await Promise.all([submit(), submit(second)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const capture = await poll(run);
    expect(capture.count).toBe(2);
    expect(capture.requests.map((request) => request.sequence)).toEqual([1, 2]);
    expect(capture.requests.map((request) => (request.rawBody as any).draftReport.identifier).sort())
      .toEqual([example.draftReport.identifier, 'second'].sort());
  });

  it(`keeps the last ${MAX_CAPTURED_REQUESTS} requests and counts them all`, async () => {
    const run = await start();
    for (let index = 0; index < MAX_CAPTURED_REQUESTS + 2; index++) {
      sessionStore.partnerRuns.record(run.runId, answered);
    }
    const capture = await poll(run);
    expect(capture.count).toBe(MAX_CAPTURED_REQUESTS + 2);
    expect(capture.requests.map((request) => request.sequence))
      .toEqual(Array.from({ length: MAX_CAPTURED_REQUESTS }, (_, index) => index + 3));
    expect((await poll(run, MAX_CAPTURED_REQUESTS + 1)).requests.map((request) => request.sequence))
      .toEqual([MAX_CAPTURED_REQUESTS + 2]);
  });

  it('rejects an after that is not a whole number of 0 or more', async () => {
    const run = await start();
    for (const after of ['-1', '1.5', 'x']) {
      const response = await fetch(`${baseUrl}${runsPath}/${run.runId}?after=${after}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'after must be a whole number of 0 or more.' });
    }
  });

  it('answers 503 when no capture is open, without checking or storing the request', async () => {
    sessionStore.partnerRuns.clear();
    await expectNotCapturing(await submit());
    await expectNotCapturing(await submit('{', { contentType: 'text/plain' }));
    expect(sessionStore.getValidationResults()).toEqual([]);
    // The turned-away request wasn't stored, so the same one is stored now.
    await start();
    await expectStored(await submit());
  });

  it('rejects a start without a manifest, for a contractBased tool, or without a matching tool', async () => {
    sessionStore.setManifest(structuredClone(mixedFixture));
    const contractBased = mixedFixture.tools.find((tool) => tool.toolType === 'contractBased')!;
    const partnerInitiated = mixedFixture.tools.find((tool) => tool.toolType === 'partnerInitiated')!;
    const response = await startRequest({ capability: contractBased.capability, tool: contractBased.name });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Only partnerInitiated tools can listen for requests.' });
    expect((await startRequest({})).status).toBe(400);
    expect((await startRequest({ capability: contractBased.capability, tool: partnerInitiated.name })).status).toBe(404);
    sessionStore.clear();
    expect((await startRequest()).status).toBe(400);
  });

  it('stops a capture, and stopping it again is harmless', async () => {
    const run = await start();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await stop(run)).status).toBe(204);
    }
    const response = await fetch(`${baseUrl}${runsPath}/${run.runId}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'The run has stopped or was replaced.' });
    await expectNotCapturing(await submit());
    expect(sessionStore.getValidationResults()).toEqual([]);
  });

  it('replaces a capture, and ignores stopping the old one', async () => {
    const oldRun = await start();
    const currentRun = await start();
    expect(currentRun.runId).not.toBe(oldRun.runId);
    expect((await fetch(`${baseUrl}${runsPath}/${oldRun.runId}`)).status).toBe(404);
    expect((await stop(oldRun)).status).toBe(204);
    await expectStored(await submit());
    expect((await poll(currentRun)).count).toBe(1);
  });

  it.each(['manifest change', 'session clear'])('stops the capture on a %s', async (action) => {
    const run = await start();
    if (action === 'manifest change') sessionStore.setManifest(structuredClone(fixture));
    else sessionStore.clear();
    expect((await fetch(`${baseUrl}${runsPath}/${run.runId}`)).status).toBe(404);
    await expectNotCapturing(await submit());
  });

  it('does not record a request still being answered when its capture stops or is replaced', async () => {
    const oldRun = await start();
    const currentRun = await start();
    expect(sessionStore.partnerRuns.record(oldRun.runId, answered)).toBeNull();
    expect((await poll(currentRun)).count).toBe(0);
    expect((await stop(currentRun)).status).toBe(204);
    expect(sessionStore.partnerRuns.record(currentRun.runId, answered)).toBeNull();
  });

  it('turns away a compressed body on the sandbox\'s own routes and keeps serving', async () => {
    const response = await fetch(`${baseUrl}${runsPath}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      // Trailing bytes after a gzip body crash body-parser < 2.4.0 when it inflates (GHSA-27r3-jxmh-p828).
      body: Buffer.concat([gzipSync(JSON.stringify({ capability: fixture.tools[0].capability, tool: fixture.tools[0].name })), Buffer.from('trailing')]),
    });
    expect(response.status).toBe(415);
    expect((await poll(await start())).status).toBe('capturing');
  });
});

describe('Simulated environment settings', () => {
  it('start with the default tenant, environment and order, with the extension installed as a custom app', async () => {
    simulatedEnvironment.reset();
    const response = await fetch(`${baseUrl}/api/simulated-environment`);
    expect(await response.json()).toEqual({
      customerTenantId: TENANT,
      environmentId: ENVIRONMENT,
      marketplace: null,
      orders: ['ACC-0000001'],
      submissionPath: submissionPath(),
      storedResultCount: 0,
    });
  });

  it.each([
    ['a customer tenant ID that is not a GUID', { customerTenantId: 'tenant' }],
    ['an empty environment GUID', { environmentId: '00000000-0000-0000-0000-000000000000' }],
    ['an incomplete set of Marketplace IDs', { marketplace: { publisherId: '101', offerId: '202' } }],
    ['orders that are not a list', { orders: 'ACC-0000001' }],
    ['an empty accession number', { orders: ['ACC-0000001', ' '] }],
  ])('reject %s', async (_label, change) => {
    const response = await putEnvironment(change);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual(expect.any(String));
    expect(simulatedEnvironment.getSettings().customerTenantId).toBe(TENANT);
  });

  it('apply to the endpoint straight away', async () => {
    const environmentId = '33333333-3333-3333-3333-333333333333';
    const response = await putEnvironment({ environmentId: ` ${environmentId} `, orders: [' ACC-0000002 '] });
    expect(await response.json()).toMatchObject({ environmentId, orders: ['ACC-0000002'], submissionPath: submissionPath(TENANT, environmentId) });

    await expectReason(await submit(), 404, 'EnvironmentNotFound');
    await expectStored(await submit(
      withExample((body) => { body.draftReport.imagingStudy.accessionNumber = 'ACC-0000002'; }),
      { path: submissionPath(TENANT, environmentId) },
    ));
  });

  it('count and clear stored results', async () => {
    await expectStored(await submit());
    expect((await (await fetch(`${baseUrl}/api/simulated-environment`)).json()).storedResultCount).toBe(1);
    const cleared = await fetch(`${baseUrl}/api/simulated-environment/stored-results`, { method: 'DELETE' });
    expect((await cleared.json()).storedResultCount).toBe(0);
  });

  it('lose their stored results, but keep their values, on Reset Session', async () => {
    expect((await putEnvironment({ orders: ['ACC-0000001', 'ACC-0000002'] })).status).toBe(200);
    await expectStored(await submit());
    expect(simulatedEnvironment.storedResultCount).toBe(1);

    expect((await fetch(`${baseUrl}/api/manifest`, { method: 'DELETE' })).status).toBe(200);
    expect(simulatedEnvironment.storedResultCount).toBe(0);
    expect(simulatedEnvironment.getSettings().orders).toEqual(['ACC-0000001', 'ACC-0000002']);
  });
});

describe('ModelState', () => {
  it('lists keys breadth first, siblings by length and then by name', () => {
    const modelState = new ModelState();
    for (const key of ['PublisherId', 'ManifestName', 'DraftReport.Identifier', 'Version', 'ToolName']) {
      modelState.add(key, key);
    }
    expect(Object.keys(modelState.toErrors())).toEqual(['Version', 'ToolName', 'PublisherId', 'ManifestName', 'DraftReport.Identifier']);
  });

  it('keeps an empty segment on its parent and merges keys that differ only in case', () => {
    const modelState = new ModelState();
    modelState.add('draftReportRequestDto', 'a');
    modelState.add('$.', 'b');
    modelState.add('Name', 'c');
    modelState.add('NAME', 'd');
    expect(Object.entries(modelState.toErrors())).toEqual([['$.', ['b']], ['Name', ['c', 'd']], ['draftReportRequestDto', ['a']]]);
  });
});
