import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jsonBodyParser } from '../middleware/json-body.js';
import { dragonCopilotApiRouter } from '../routes/dragon-copilot-api.js';
import { draftReportResultsRouter } from '../routes/draft-report-ai-results.js';
import {
  DEFAULT_VENDOR_NAME,
  DraftReportResultStore,
  MAX_ORDERS,
  MAX_SETTING_LENGTH,
  MAX_STORED_OUTPUT_LENGTH,
  MAX_STORED_RESULTS,
  type DraftReportResult,
} from '../store/draft-report-results.js';
import { sessionStore } from '../store/session.js';
import { simulatedEnvironment } from '../store/simulated-environment.js';
import type { ExtensionManifest } from '../schemas/manifest.schema.js';

function readJson(path: string) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf-8'));
}

const samples = '../../../../../partner-initiated/samples/';
const ingestExample = readJson(`${samples}PreDraftReportGeneration-Ingest-Request-Example.json`);
const retrieveExample = readJson(`${samples}PreDraftReportGeneration-Retrieve-Response-Example.json`);
const partnerManifest: ExtensionManifest = readJson('./fixtures/valid-manifest-partner-initiated.json');

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ENVIRONMENT_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_ENVIRONMENT_ID = '33333333-3333-3333-3333-333333333333';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function submissionPath(environmentId = ENVIRONMENT_ID): string {
  return `/api/v1/tenants/${TENANT_ID}/environments/${environmentId}/draft-report-ai-results`;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  // Same order as index.ts: both routers read their own bodies.
  app.use('/api/v1', dragonCopilotApiRouter);
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
  simulatedEnvironment.reset();
});

beforeEach(() => {
  sessionStore.clear();
  simulatedEnvironment.reset();
  // The example sends Marketplace IDs, so the extension is installed as purchased with them.
  simulatedEnvironment.setSettings({
    ...simulatedEnvironment.getSettings(),
    marketplace: { publisherId: ingestExample.publisherId, offerId: ingestExample.offerId, planId: ingestExample.planId },
  });
  sessionStore.setManifest(structuredClone(partnerManifest));
  // The endpoint answers only while the sandbox is listening.
  sessionStore.partnerRuns.start(partnerManifest.tools[0]);
});

/** A copy of the ingest example, optionally changed by `mutate`. */
function example(mutate?: (request: typeof ingestExample) => void): typeof ingestExample {
  const request = structuredClone(ingestExample);
  mutate?.(request);
  return request;
}

function submit(body: unknown, path = submissionPath()): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
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

function result(change: Partial<DraftReportResult> = {}): DraftReportResult {
  return {
    environmentId: ENVIRONMENT_ID,
    partnerTenantId: partnerManifest.auth.tenantId,
    extensionName: partnerManifest.name,
    toolName: partnerManifest.tools[0].name,
    identifier: 'draft',
    accessionNumber: 'ACC-0000001',
    aiModelVersion: '1.0.0',
    draftReport: {},
    ...change,
  };
}

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

  it('returns the draftReport as sent, with members the endpoint ignores, and the last of a repeated name', async () => {
    const { draftReport, ...rest } = ingestExample;
    const first = { ...draftReport, identifier: 'first-draft' };
    const last = { ...draftReport, identifier: 'last-draft', partnerNote: 'kept as sent' };
    const body = `${JSON.stringify(rest).slice(0, -1)},"draftReport":${JSON.stringify(first)},"DRAFTREPORT":${JSON.stringify(last)}}`;
    expect((await submit(body)).status).toBe(200);

    const [output] = (await retrieve('ACC-0000001')).capabilityExecutionResults.outputs;
    expect(JSON.parse(output.output).draftReport).toEqual(last);
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
    sessionStore.partnerRuns.start(other.tools[0]);
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

  it('keeps results and identifiers per environment', async () => {
    expect((await submit(ingestExample)).status).toBe(200);
    simulatedEnvironment.setSettings({ ...simulatedEnvironment.getSettings(), environmentId: OTHER_ENVIRONMENT_ID });
    expect((await retrieve('ACC-0000001')).capabilityExecutionResults.outputs).toEqual([]);

    // The identifier is stored in the first environment only, so this one accepts it.
    expect((await submit(ingestExample, submissionPath(OTHER_ENVIRONMENT_ID))).status).toBe(200);
    expect((await retrieve('ACC-0000001')).capabilityExecutionResults.outputs).toHaveLength(1);
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
      store.store(result({ identifier: `draft-${index}`, accessionNumber: `ACC-${index}` }));
    }
    expect(store.size).toBe(MAX_STORED_RESULTS);
    expect(store.retrieve(ENVIRONMENT_ID, 'ACC-0').capabilityExecutionResults.outputs).toEqual([]);
    expect(store.retrieve(ENVIRONMENT_ID, `ACC-${MAX_STORED_RESULTS}`).capabilityExecutionResults.outputs).toHaveLength(1);
  });

  it('drops the oldest results while their outputs are too large in total, but keeps the newest', () => {
    const store = new DraftReportResultStore();
    store.store(result({ identifier: 'small-draft', accessionNumber: 'ACC-1' }));
    store.store(result({ identifier: 'large-draft', accessionNumber: 'ACC-2', draftReport: { content: 'x'.repeat(MAX_STORED_OUTPUT_LENGTH) } }));
    expect(store.size).toBe(1);
    expect(store.retrieve(ENVIRONMENT_ID, 'ACC-1').capabilityExecutionResults.outputs).toEqual([]);
    expect(store.retrieve(ENVIRONMENT_ID, 'ACC-2').capabilityExecutionResults.outputs).toHaveLength(1);
    // Identifiers are kept separately, so the dropped draft still can't be sent again.
    expect(store.hasIdentifier(ENVIRONMENT_ID, 'small-draft')).toBe(true);
  });

  it('records nothing when a submission cannot be serialized', () => {
    const store = new DraftReportResultStore();
    expect(() => store.store(result({ identifier: 'unserializable-draft', draftReport: { size: 1n } }))).toThrow(TypeError);
    expect(store.hasIdentifier(ENVIRONMENT_ID, 'unserializable-draft')).toBe(false);
    expect(store.size).toBe(0);
  });
});

describe('Draft report sandbox settings', () => {
  it('matches submissions against the configured orders', async () => {
    const response = await putSettings({ orders: ['ACC-NEW'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ orders: ['ACC-NEW'] });
    expect(simulatedEnvironment.getSettings().orders).toEqual(['ACC-NEW']);

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
