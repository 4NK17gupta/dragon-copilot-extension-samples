import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jsonBodyParser } from '../middleware/json-body.js';
import {
  CORRELATION_ID_HEADER, MAX_JSON_DEPTH, draftReportIngestRouter, draftReportResultsRouter,
} from '../routes/draft-report-ai-results.js';
import {
  DEFAULT_VENDOR_NAME, DraftReportResultStore, MAX_ORDERS, MAX_SETTING_LENGTH, MAX_STORED_RESULTS,
} from '../store/draft-report-results.js';
import { sessionStore } from '../store/session.js';
import type { ExtensionManifest } from '../schemas/manifest.schema.js';

function readJson(path: string) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf-8'));
}

const samples = '../../../../../partner-initiated/samples/';
const ingestExample = readJson(`${samples}PreDraftReportGeneration-Ingest-Request-Example.json`);
const retrieveExample = readJson(`${samples}PreDraftReportGeneration-Retrieve-Response-Example.json`);
const partnerManifest: ExtensionManifest = readJson('./fixtures/valid-manifest-partner-initiated.json');
const mixedManifest: ExtensionManifest = readJson('./fixtures/valid-manifest-mixed-tool-types.json');

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ENVIRONMENT_ID = '22222222-2222-2222-2222-222222222222';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function ingestPath(tenantId = TENANT_ID, environmentId = ENVIRONMENT_ID): string {
  return `/api/v1/tenants/${tenantId}/environments/${environmentId}/draft-report-ai-results`;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  // Keep the same order as index.ts: both routers parse their own bodies.
  app.use('/api/v1', draftReportIngestRouter);
  app.use('/api/draft-report-ai-results', draftReportResultsRouter);
  app.use(jsonBodyParser);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sessionStore.clear();
  sessionStore.draftReports.clearResults();
  sessionStore.draftReports.resetSettings();
});

beforeEach(() => {
  sessionStore.clear();
  sessionStore.draftReports.clearResults();
  sessionStore.draftReports.resetSettings();
  sessionStore.setManifest(structuredClone(partnerManifest));
});

/** A copy of the ingest example, optionally changed by `mutate`. */
function example(mutate?: (request: typeof ingestExample) => void): typeof ingestExample {
  const request = structuredClone(ingestExample);
  mutate?.(request);
  return request;
}

function submit(body: unknown, init: { path?: string; headers?: Record<string, string>; raw?: string } = {}): Promise<Response> {
  return fetch(`${baseUrl}${init.path ?? ingestPath()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    body: init.raw ?? JSON.stringify(body),
  });
}

async function retrieve(accessionNumber: string) {
  const response = await fetch(`${baseUrl}/api/draft-report-ai-results?accessionNumber=${encodeURIComponent(accessionNumber)}`);
  expect(response.status).toBe(200);
  return response.json();
}

function putSettings(settings: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/draft-report-ai-results/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
}

describe('Draft report ingest route', () => {
  it('stores the Ingest example with 200 and reports its validity and processing time, then rejects a re-post with 409', async () => {
    const stored = await submit(ingestExample);
    expect(stored.status).toBe(200);
    const { sandbox } = await stored.json();
    expect(sandbox.stored).toBe(true);
    expect(sandbox.validation).toMatchObject({ valid: true, toolName: 'preDraftReportGeneratorTool' });
    expect(sandbox.processingTimeMs).toBeGreaterThanOrEqual(0);

    const repeated = await submit(ingestExample);
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({
      message: 'Request could not be processed.',
      reason: 'ResultAlreadyStored',
      sandbox: { stored: false, validation: { valid: false } },
    });
  });

  it.each([
    ['an unknown', 'ACC-UNKNOWN', 404, 'Resource not found.', 'OrderNotFound'],
    ['an ambiguous', 'ACC-AMBIGUOUS', 409, 'Request could not be processed.', 'MultipleOrdersMatched'],
  ])('rejects %s accession number', async (_label, accessionNumber, status, message, reason) => {
    const response = await submit(example((request) => {
      request.draftReport.imagingStudy.accessionNumber = accessionNumber;
    }));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ message, reason });
    expect((await retrieve(accessionNumber)).capabilityExecutionResults.outputs).toEqual([]);
  });

  it('rejects publisherId without offerId and planId with 400, naming the dependency', async () => {
    const response = await submit(example((request) => {
      delete request.offerId;
      delete request.planId;
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    const body = await response.json();
    expect(body).toMatchObject({ title: 'One or more validation errors occurred.', status: 400 });
    expect(body.errors['/']).toContain(
      "'publisherId' requires 'offerId': publisherId, offerId and planId must be supplied together or omitted together.",
    );
    expect(body.sandbox).toMatchObject({ stored: false, validation: { valid: false } });
  });

  it('accepts an extension without Marketplace IDs, and warns that the sandbox does not match them when sent', async () => {
    const response = await submit(example((request) => {
      delete request.publisherId;
      delete request.offerId;
      delete request.planId;
    }));
    expect(response.status).toBe(200);
    const extensionCheck = (checks: { check: string; warning?: string }[]) =>
      checks.find((check) => check.check === 'Extension matches the loaded manifest');
    expect(extensionCheck((await response.json()).sandbox.validation.checks)?.warning).toBeUndefined();

    const withIds = await submit(example((request) => {
      request.draftReport.identifier = 'with-marketplace-ids';
      request.draftReport.imagingStudy.accessionNumber = 'ACC-0000002';
    }));
    expect(withIds.status).toBe(200);
    expect(extensionCheck((await withIds.json()).sandbox.validation.checks)?.warning).toMatch(/not matched by the sandbox/);
  });

  it.each([
    ['a malformed manifestName', '/manifestName', (request: typeof ingestExample) => { request.manifestName = 'Not A Manifest Name'; }],
    ['a malformed toolName', '/toolName', (request: typeof ingestExample) => { request.toolName = 'pre-draft'; }],
    ['a version not in x.y.z form', '/version', (request: typeof ingestExample) => { request.version = '1.0'; }],
    ['an undeclared property', '/extra', (request: typeof ingestExample) => { request.extra = true; }],
    ['no draftReport', '/draftReport', (request: typeof ingestExample) => { delete request.draftReport; }],
    ['an invalid draftReport', '/draftReport/identifier', (request: typeof ingestExample) => { request.draftReport.identifier = 42; }],
  ])('rejects %s with 400', async (_label, path, mutate) => {
    const response = await submit(example(mutate));
    expect(response.status).toBe(400);
    expect(Object.keys((await response.json()).errors)).toContain(path);
  });

  it('rejects route IDs that are not non-empty GUIDs with 400', async () => {
    const response = await submit(ingestExample, { path: ingestPath('not-a-guid', '00000000-0000-0000-0000-000000000000') });
    expect(response.status).toBe(400);
    expect((await response.json()).errors).toMatchObject({
      tenantId: ['tenantId must be a valid non-empty GUID.'],
      environmentId: ['environmentId must be a valid non-empty GUID.'],
    });
  });

  it.each([
    ['another manifest name', () => {}, (request: typeof ingestExample) => { request.manifestName = 'otherExtension'; }],
    ['no loaded manifest', () => sessionStore.clear(), () => {}],
  ])('rejects %s with 404 ExtensionNotFound', async (_label, arrange, mutate) => {
    arrange();
    const response = await submit(example(mutate));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: 'Resource not found.', reason: 'ExtensionNotFound' });
  });

  it.each([
    ['an undeclared tool', 'otherTool', /declares no tool named 'otherTool'/],
    ['a contractBased tool', 'sampleQualityCheckTool', /is contractBased with the qualityCheck capability/],
  ])('rejects %s with 404 ToolNotFound', async (_label, toolName, error) => {
    sessionStore.setManifest(structuredClone(mixedManifest));
    const response = await submit(example((request) => { request.toolName = toolName; }));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toMatchObject({ message: 'Resource not found.', reason: 'ToolNotFound' });
    expect(body.sandbox.validation.checks.find((check: { passed: boolean }) => !check.passed).error).toMatch(error);
  });

  it('matches manifestName and toolName case-insensitively and stores the declared names', async () => {
    const response = await submit(example((request) => {
      request.manifestName = 'sampleradiologyextension';
      request.toolName = 'predraftreportgeneratortool';
    }));
    expect(response.status).toBe(200);
    const [stored] = (await retrieve('ACC-0000001')).capabilityExecutionResults.outputs;
    expect(JSON.parse(stored.output)).toMatchObject({
      extensionName: 'sampleRadiologyExtension', toolName: 'preDraftReportGeneratorTool',
    });
  });

  it('prefers the tool named exactly over one whose name differs only in case', async () => {
    const manifest = structuredClone(mixedManifest);
    const [qualityCheckTool, partnerTool] = manifest.tools;
    qualityCheckTool.name = partnerTool.name.toLowerCase();
    sessionStore.setManifest(manifest);
    expect((await submit(ingestExample)).status).toBe(200);
  });

  it('records every submission in the session validation results', async () => {
    await submit(ingestExample);
    await submit(ingestExample);
    expect(sessionStore.getValidationResults().map((result) => result.valid)).toEqual([true, false]);
  });

  it.each([
    ['a non-JSON content type', 415, { 'Content-Type': 'text/plain' }, '{}'],
    ['a vendor JSON content type', 415, { 'Content-Type': 'application/vnd.example+json' }, '{}'],
    ['a compressed body', 415, { 'Content-Encoding': 'gzip' }, '{}'],
    ['malformed JSON', 400, {}, '{"manifestName":'],
    ['a body over 1 MB', 413, {}, JSON.stringify({ padding: 'x'.repeat(1_100_000) })],
  ])('rejects %s with %i', async (_label, status, headers, raw) => {
    const response = await submit(undefined, { headers, raw });
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect((await response.json()).sandbox.stored).toBe(false);
  });

  it.each([
    ['an empty', ''],
    ['a whitespace-only', ' \r\n\t'],
  ])('reports %s body as missing with 400, as Dragon Copilot does', async (_label, raw) => {
    const response = await submit(undefined, { raw });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect((await response.json()).errors).toEqual({ '/': ['A non-empty request body is required.'] });
  });

  /** The Ingest example with `arrays` nested arrays added inside `draftReport`, two levels down. */
  const nestedBody = (arrays: number): string => JSON.stringify(ingestExample)
    .replace('"draftReport":{', `"draftReport":{"extra":${'['.repeat(arrays)}${']'.repeat(arrays)},`);

  it(`accepts JSON nested ${MAX_JSON_DEPTH} levels deep and rejects one level more with 400`, async () => {
    const tooDeep = await submit(undefined, { raw: nestedBody(MAX_JSON_DEPTH - 1) });
    expect(tooDeep.status).toBe(400);
    expect((await tooDeep.json()).errors).toEqual({ '/': [`Request body is nested more than ${MAX_JSON_DEPTH} levels deep.`] });

    // The rejected submission's identifier was not recorded, so it can be resent.
    expect((await submit(undefined, { raw: nestedBody(MAX_JSON_DEPTH - 2) })).status).toBe(200);
  });

  it('rejects a body nested 100,000 levels deep with 400 and keeps serving', async () => {
    expect((await submit(undefined, { raw: nestedBody(100_000) })).status).toBe(400);
    expect((await submit(ingestExample)).status).toBe(200);
  });

  it('answers 500 instead of stopping the server when processing throws', async () => {
    const store = vi.spyOn(sessionStore.draftReports, 'store').mockImplementation(() => {
      throw new Error('Simulated failure');
    });
    try {
      const response = await submit(ingestExample);
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toMatch(/^application\/problem\+json/);
      expect((await response.json()).sandbox.stored).toBe(false);
    } finally {
      store.mockRestore();
    }
    expect((await submit(ingestExample)).status).toBe(200);
  });

  it('echoes a usable x-ms-correlation-id and generates one otherwise', async () => {
    const echoed = await submit(ingestExample, { headers: { [CORRELATION_ID_HEADER]: 'partner-request-42' } });
    expect(echoed.headers.get(CORRELATION_ID_HEADER)).toBe('partner-request-42');

    for (const unusable of ['has,comma', 'x'.repeat(129)]) {
      const generated = await submit(ingestExample, { headers: { [CORRELATION_ID_HEADER]: unusable } });
      expect(generated.headers.get(CORRELATION_ID_HEADER)).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('answers other methods with 405 and Allow: POST', async () => {
    const response = await fetch(`${baseUrl}${ingestPath()}`);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(response.headers.get(CORRELATION_ID_HEADER)).toBeTruthy();
  });
});

describe('Draft report retrieve simulation', () => {
  it('returns a submitted draft in the Retrieve example shape (round trip)', async () => {
    expect((await submit(ingestExample)).status).toBe(200);

    const retrieved = await retrieve('ACC-0000001');
    expect(retrieved.capabilityExecutionId).toMatch(UUID);
    const [output] = retrieved.capabilityExecutionResults.outputs;
    const [expected] = retrieveExample.capabilityExecutionResults.outputs;
    expect(retrieved.capabilityExecutionResults.outputs).toHaveLength(1);
    expect(output.alias).toBe('DraftReport');
    expect(typeof output.output).toBe('string');
    const decoded = JSON.parse(output.output);
    expect(Object.keys(decoded)).toEqual(['partnerTenantId', 'extensionName', 'toolName', 'draftReport']);
    expect(decoded).toEqual(JSON.parse(expected.output));
    expect(output.aiModelsInformation).toEqual(expected.aiModelsInformation);
  });

  it('maps aiModelsInformation from the configured vendor, the tool name and aiSystemInfo.version', async () => {
    expect((await putSettings({ vendorName: 'Contoso Imaging' })).status).toBe(200);
    await submit(example((request) => { request.draftReport.aiSystemInfo.version = '2.0.1'; }));

    const [output] = (await retrieve('ACC-0000001')).capabilityExecutionResults.outputs;
    expect(output.aiModelsInformation).toEqual([{
      vendorName: 'Contoso Imaging', aiModelName: 'preDraftReportGeneratorTool', aiModelVersion: '2.0.1',
    }]);
  });

  it('keeps the vendor name a result was stored with when the setting changes', async () => {
    await submit(ingestExample);
    expect((await putSettings({ vendorName: 'Contoso Imaging' })).status).toBe(200);

    const [output] = (await retrieve('ACC-0000001')).capabilityExecutionResults.outputs;
    expect(output.aiModelsInformation[0].vendorName).toBe(DEFAULT_VENDOR_NAME);
  });

  it('returns the submissions of two extensions for the same accession number', async () => {
    expect((await submit(ingestExample)).status).toBe(200);

    const other = structuredClone(partnerManifest);
    other.name = 'otherRadiologyExtension';
    other.tools[0].name = 'otherDraftTool';
    sessionStore.setManifest(other);
    const response = await submit(example((request) => {
      request.manifestName = 'otherRadiologyExtension';
      request.toolName = 'otherDraftTool';
      request.draftReport.identifier = 'other-extension-draft';
    }));
    expect(response.status).toBe(200);

    const outputs = (await retrieve('ACC-0000001')).capabilityExecutionResults.outputs;
    expect(outputs.map((output: { output: string }) => JSON.parse(output.output).extensionName))
      .toEqual(['sampleRadiologyExtension', 'otherRadiologyExtension']);
    expect(outputs.map((output: { aiModelsInformation: { aiModelName: string }[] }) => output.aiModelsInformation[0].aiModelName))
      .toEqual(['preDraftReportGeneratorTool', 'otherDraftTool']);
  });

  it('keeps one draft per tool and accession number, replacing it with a newer submission', async () => {
    await submit(ingestExample);
    await submit(example((request) => { request.draftReport.identifier = 'replacement-draft'; }));

    const outputs = (await retrieve('ACC-0000001')).capabilityExecutionResults.outputs;
    expect(outputs).toHaveLength(1);
    expect(JSON.parse(outputs[0].output).draftReport.identifier).toBe('replacement-draft');
  });

  it('returns an empty collection, not 404, for an accession number with no stored result', async () => {
    const retrieved = await retrieve('ACC-0000002');
    expect(retrieved.capabilityExecutionId).toMatch(UUID);
    expect(retrieved.capabilityExecutionResults).toEqual({ outputs: [] });
  });

  it('requires an accession number', async () => {
    expect((await fetch(`${baseUrl}/api/draft-report-ai-results`)).status).toBe(400);
  });

  it('forgets stored results and identifiers on DELETE', async () => {
    await submit(ingestExample);
    expect((await fetch(`${baseUrl}/api/draft-report-ai-results`, { method: 'DELETE' })).status).toBe(204);
    expect((await retrieve('ACC-0000001')).capabilityExecutionResults.outputs).toEqual([]);
    expect((await submit(ingestExample)).status).toBe(200);
  });

  it(`keeps at most ${MAX_STORED_RESULTS} results, dropping the oldest`, () => {
    const store = new DraftReportResultStore();
    for (let index = 0; index <= MAX_STORED_RESULTS; index++) {
      store.store({
        partnerTenantId: partnerManifest.auth.tenantId,
        extensionName: partnerManifest.name,
        toolName: partnerManifest.tools[0].name,
        identifier: `draft-${index}`,
        accessionNumber: `ACC-${index}`,
        aiModelVersion: '1.0.0',
        draftReport: {},
      });
    }
    expect(store.size).toBe(MAX_STORED_RESULTS);
    expect(store.retrieve('ACC-0').capabilityExecutionResults.outputs).toEqual([]);
    expect(store.retrieve(`ACC-${MAX_STORED_RESULTS}`).capabilityExecutionResults.outputs).toHaveLength(1);
  });

  it('records nothing when a submission cannot be serialized', () => {
    const store = new DraftReportResultStore();
    expect(() => store.store({
      partnerTenantId: partnerManifest.auth.tenantId,
      extensionName: partnerManifest.name,
      toolName: partnerManifest.tools[0].name,
      identifier: 'unserializable-draft',
      accessionNumber: 'ACC-0000001',
      aiModelVersion: '1.0.0',
      draftReport: { size: 1n },
    })).toThrow(TypeError);
    expect(store.hasIdentifier('unserializable-draft')).toBe(false);
    expect(store.size).toBe(0);
  });
});

describe('Draft report sandbox settings', () => {
  it('matches submissions against the configured orders', async () => {
    const response = await putSettings({ orders: ['ACC-NEW'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ orders: ['ACC-NEW'] });

    expect((await submit(ingestExample)).status).toBe(404);
    const accepted = await submit(example((request) => { request.draftReport.imagingStudy.accessionNumber = 'ACC-NEW'; }));
    expect(accepted.status).toBe(200);
  });

  it(`accepts ${MAX_ORDERS} orders of ${MAX_SETTING_LENGTH} characters, beyond the global 100 KB body limit`, async () => {
    const orders = Array.from({ length: MAX_ORDERS }, (_, index) => String(index).padStart(MAX_SETTING_LENGTH, 'A'));
    const response = await putSettings({ orders });
    expect(response.status).toBe(200);
    expect((await response.json()).orders).toEqual(orders);
  });

  it.each([
    ['an unknown setting', { colour: 'blue' }],
    ['a blank vendorName', { vendorName: ' ' }],
    ['orders that are not strings', { orders: [1] }],
    ['orders that are not an array', { orders: 'ACC-0000001' }],
  ])('rejects %s with 400', async (_label, settings) => {
    expect((await putSettings(settings)).status).toBe(400);
  });
});
