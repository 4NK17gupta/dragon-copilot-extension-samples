import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jsonBodyParser } from '../middleware/json-body.js';
import { manifestRouter } from '../routes/manifest.js';
import { partnerInitiatedCallbackRouter } from '../routes/partner-initiated.js';
import { sessionStore } from '../store/session.js';
import type { ExtensionManifest, ManifestOutput } from '../schemas/manifest.schema.js';
import type { PartnerRun } from '../store/partner-run.js';
import {
  MAX_FULL_ERROR_LIST_VALUES, MAX_LISTED_SCHEMA_ERRORS, validatePartnerOutput,
} from '../services/partner-validation.js';

const fixture: ExtensionManifest = JSON.parse(readFileSync(
  new URL('./fixtures/valid-manifest-partner-initiated.json', import.meta.url), 'utf-8',
));
const ingestExample = JSON.parse(readFileSync(
  new URL('../../../../../partner-initiated/samples/PreDraftReportGeneration-Ingest-Request-Example.json', import.meta.url), 'utf-8',
));
const validOutput = ingestExample.draftReport;
let server: Server;
let baseUrl: string;
let manifest: ExtensionManifest;
const runsPath = '/api/manifest/partner-initiated';

beforeAll(async () => {
  const app = express();
  // Keep the same order as index.ts; otherwise malformed callbacks bypass the run.
  app.use('/api/partnerInitiated', partnerInitiatedCallbackRouter);
  app.use(jsonBodyParser);
  app.use('/api/manifest', manifestRouter);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sessionStore.clear();
});

beforeEach(() => {
  sessionStore.clear();
  manifest = structuredClone(fixture);
  sessionStore.setManifest(manifest);
});

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function startRequest(): Promise<Response> {
  return post(`${runsPath}/start`, {
    capability: manifest.tools[0].capability, tool: manifest.tools[0].name,
  });
}

async function start(): Promise<PartnerRun> {
  const response = await startRequest();
  expect(response.status).toBe(201);
  return response.json();
}

async function poll(run: PartnerRun): Promise<PartnerRun> {
  const response = await fetch(`${baseUrl}${runsPath}/${run.runId}`);
  expect(response.status).toBe(200);
  return response.json();
}

describe('Partner-initiated listener', () => {
  it('arms an encoded callback using the manifest tenant and tool, then polls waiting', async () => {
    const run = await start();
    expect(run).toEqual({
      runId: expect.any(String), status: 'waiting',
      callbackPath: `/api/partnerInitiated/${manifest.auth.tenantId}/${manifest.tools[0].name}`,
    });
    expect(await poll(run)).toEqual(run);
  });

  it('validates the actual sample raw draftReport and retains it for polling', async () => {
    const run = await start();
    const response = await post(run.callbackPath, validOutput);
    expect(response.status).toBe(200);
    expect((await response.json()).validation.valid).toBe(true);
    const completed = await poll(run);
    expect(completed.status).toBe('completed');
    expect(completed.result).toMatchObject({
      status: 200, statusText: 'OK', rawBody: validOutput,
      validation: { valid: true, toolName: manifest.tools[0].name, summary: { passed: 1, failed: 0 } },
    });
    expect(sessionStore.getValidationResults()).toEqual([completed.result?.validation]);
  });

  it('rejects an invalid output property with its raw payload path', async () => {
    const run = await start();
    const response = await post(run.callbackPath, { ...validOutput, identifier: 42 });
    expect(response.status).toBe(422);
    const completed = await poll(run);
    expect(completed.result).toMatchObject({
      status: 422, statusText: 'Unprocessable Entity',
      validation: { valid: false, checks: expect.arrayContaining([expect.objectContaining({ path: '/identifier', passed: false })]) },
    });
  });

  it.each([
    ['named output envelope', { preDraftReportResult: validOutput }],
    ['array', [validOutput]],
    ['null', null],
    ['primitive', 7],
  ])('rejects %s instead of a raw output object', async (_label, body) => {
    const run = await start();
    expect((await post(run.callbackPath, body)).status).toBe(422);
    expect((await poll(run)).result?.validation.valid).toBe(false);
  });

  it('accepts the full ingest request envelope and validates both the envelope and its draftReport', async () => {
    const run = await start();
    const response = await post(run.callbackPath, ingestExample);
    expect(response.status).toBe(200);
    const completed = await poll(run);
    expect(completed.result).toMatchObject({ status: 200, rawBody: ingestExample, validation: { valid: true } });
    expect(completed.result?.validation.checks.map((check) => check.check)).toEqual([
      'Ingest request envelope',
      'Envelope manifestName matches the loaded manifest',
      'Envelope toolName matches the loaded manifest',
      expect.stringContaining("Output 'preDraftReportResult'"),
    ]);
  });

  it.each([
    ['manifestName', { manifestName: 'otherExtension' }, `Must be '${fixture.name}'.`],
    ['toolName', { toolName: 'otherTool' }, `Must be '${fixture.tools[0].name}'.`],
  ])('rejects an envelope whose %s does not match the armed tool', async (property, override, error) => {
    const run = await start();
    expect((await post(run.callbackPath, { ...ingestExample, ...override })).status).toBe(422);
    expect((await poll(run)).result?.validation.checks).toContainEqual({
      check: `Envelope ${property} matches the loaded manifest`, passed: false, path: `/${property}`, error,
    });
  });

  it('reports envelope schema errors and draftReport errors at their paths in the body', async () => {
    const run = await start();
    const { offerId: _offerId, ...envelope } = ingestExample;
    const body = { ...envelope, extra: true, draftReport: { ...validOutput, identifier: 42 } };
    expect((await post(run.callbackPath, body)).status).toBe(422);
    const failed = (await poll(run)).result?.validation.checks.filter((check) => !check.passed);
    expect(failed?.map((check) => check.path)).toEqual(expect.arrayContaining(['/extra', '/', '/draftReport/identifier']));
    expect(failed?.some((check) => check.check.startsWith('Output') && check.path === '/identifier')).toBe(false);
  });

  it('reports a missing draftReport once, from the envelope schema', async () => {
    const run = await start();
    const { draftReport: _omitted, ...envelope } = ingestExample;
    expect((await post(run.callbackPath, envelope)).status).toBe(422);
    const failed = (await poll(run)).result?.validation.checks.filter((check) => !check.passed);
    expect(failed).toEqual([{
      check: 'Ingest request envelope', passed: false, path: '/draftReport', error: "must have required property 'draftReport'",
    }]);
  });

  it(`lists at most ${MAX_LISTED_SCHEMA_ERRORS} schema errors and counts the rest`, () => {
    const body = structuredClone(validOutput);
    body.reportContent.structuredReport.sections = Array.from({ length: 500 }, () => ({}));
    const { checks } = validatePartnerOutput({ tool: manifest.tools[0], manifestName: manifest.name }, body);
    expect(checks).toHaveLength(MAX_LISTED_SCHEMA_ERRORS + 1);
    expect(checks.at(-1)).toMatchObject({ check: 'Schema errors listed', passed: false, error: expect.stringMatching(/^\d+ more schema error/) });
  });

  it('lists only the first error for a body too large to collect every error, and stays fast', async () => {
    const body = structuredClone(validOutput);
    body.reportContent.structuredReport.sections = Array.from({ length: 200_000 }, () => ({}));
    expect(JSON.stringify(body).length).toBeLessThan(1024 * 1024);
    const run = await start();
    const started = Date.now();
    expect((await post(run.callbackPath, body)).status).toBe(422);
    expect(Date.now() - started).toBeLessThan(3000);
    const { checks } = (await poll(run)).result!.validation;
    expect(checks).toHaveLength(2);
    expect(checks[1]).toMatchObject({
      check: 'Schema errors listed', error: expect.stringContaining(`more than ${MAX_FULL_ERROR_LIST_VALUES} values`),
    });
  });

  it('still passes a valid body that is too large to collect every error', () => {
    const body = structuredClone(validOutput);
    const [section] = body.reportContent.structuredReport.sections;
    body.reportContent.structuredReport.sections = Array.from({ length: MAX_FULL_ERROR_LIST_VALUES }, () => section);
    expect(validatePartnerOutput({ tool: manifest.tools[0], manifestName: manifest.name }, body).valid).toBe(true);
  });

  it.each([
    ['unsupported version', { schemaVersion: '9.0' }],
    ['missing version', { schemaVersion: undefined }],
    ['unknown content type', { 'content-type': 'application/unknown+json' }],
  ])('fails closed for %s', async (_label, declaration) => {
    Object.assign(manifest.tools[0].outputs[0], declaration);
    const run = await start();
    expect((await post(run.callbackPath, validOutput)).status).toBe(422);
    expect((await poll(run)).result?.validation.checks[0].error).toContain('No schema registered');
  });

  it('validates every output declaration rather than only the first', async () => {
    manifest.tools[0].outputs.push({ ...manifest.tools[0].outputs[0], name: 'secondOutput', schemaVersion: '2.0' });
    const run = await start();
    expect((await post(run.callbackPath, validOutput)).status).toBe(422);
    expect((await poll(run)).result?.validation.summary).toEqual({ passed: 1, failed: 1 });
    expect((await poll(run)).result?.validation.checks[1].check).toContain('secondOutput');
    expect(sessionStore.getValidationResults()).toEqual([(await poll(run)).result?.validation]);
  });

  it('validates repeated supported declarations and rejects a missing output schema list', () => {
    const tool = structuredClone(manifest.tools[0]);
    tool.outputs.push({ ...tool.outputs[0], name: 'secondOutput' });
    expect(validatePartnerOutput({ tool, manifestName: manifest.name }, validOutput).summary).toEqual({ passed: 2, failed: 0 });
    tool.outputs = [];
    expect(validatePartnerOutput({ tool, manifestName: manifest.name }, validOutput).valid).toBe(false);
  });

  it('does not use the quality-check contract validator as a fallback', async () => {
    manifest.tools[0].outputs[0] = {
      ...manifest.tools[0].outputs[0], 'content-type': 'application/vnd.ms-dragon.rad.quality-check-result+json',
    } satisfies ManifestOutput;
    const run = await start();
    expect((await post(run.callbackPath, { recommendations: [] })).status).toBe(422);
  });

  it('rejects start without a manifest', async () => {
    sessionStore.clear();
    expect((await startRequest()).status).toBe(400);
  });

  it('rejects contract tools without arming a listener', async () => {
    manifest.tools = [{
      ...manifest.tools[0], toolType: 'contractBased', capability: 'qualityCheck',
      endpoint: 'http://localhost:5000/v1/process', inputs: [],
    }];
    expect((await startRequest()).status).toBe(400);
  });

  it('rejects missing selections and a mismatched capability', async () => {
    expect((await post(`${runsPath}/start`, {})).status).toBe(400);
    expect((await post(`${runsPath}/start`, { capability: 'qualityCheck', tool: manifest.tools[0].name })).status).toBe(404);
  });

  it('rejects unarmed and mismatched callbacks without consuming a matching run', async () => {
    const path = `/api/partnerInitiated/${manifest.auth.tenantId}/${manifest.tools[0].name}`;
    expect((await post(path, validOutput)).status).toBe(404);
    const run = await start();
    expect((await post(`/api/partnerInitiated/wrong/${manifest.tools[0].name}`, validOutput)).status).toBe(404);
    expect((await post(`/api/partnerInitiated/${manifest.auth.tenantId}/wrong`, validOutput)).status).toBe(404);
    expect((await poll(run)).status).toBe('waiting');
    expect((await post(path, validOutput)).status).toBe(200);
  });

  it('cancels waiting runs and makes deletion idempotent', async () => {
    const run = await start();
    for (let i = 0; i < 2; i++) {
      expect((await fetch(`${baseUrl}${runsPath}/${run.runId}`, { method: 'DELETE' })).status).toBe(204);
    }
    expect((await fetch(`${baseUrl}${runsPath}/${run.runId}`)).status).toBe(404);
    expect((await post(run.callbackPath, validOutput)).status).toBe(404);
  });

  it('replaces runs and ignores stale cancellation', async () => {
    const oldRun = await start();
    const currentRun = await start();
    expect(currentRun.runId).not.toBe(oldRun.runId);
    expect((await fetch(`${baseUrl}${runsPath}/${oldRun.runId}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}${runsPath}/${oldRun.runId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await poll(currentRun)).status).toBe('waiting');
  });

  it.each(['waiting', 'completed'])('invalidates a %s run when the manifest changes', async (status) => {
    const run = await start();
    if (status === 'completed') await post(run.callbackPath, validOutput);
    sessionStore.setManifest(structuredClone(fixture));
    expect((await fetch(`${baseUrl}${runsPath}/${run.runId}`)).status).toBe(404);
    expect((await post(run.callbackPath, validOutput)).status).toBe(404);
  });

  it('clears the listener with the session', async () => {
    const run = await start();
    sessionStore.clear();
    expect((await post(run.callbackPath, validOutput)).status).toBe(404);
  });

  it('snapshots declarations at start instead of retaining mutable manifest references', async () => {
    const run = await start();
    manifest.tools[0].outputs[0].schemaVersion = 'unsupported';
    expect((await post(run.callbackPath, validOutput)).status).toBe(200);
  });

  it('consumes only the first request and does not overwrite a completed result', async () => {
    const run = await start();
    const responses = await Promise.all([
      post(run.callbackPath, validOutput), post(run.callbackPath, validOutput),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const completed = await poll(run);
    expect((await post(run.callbackPath, { identifier: 'bad' })).status).toBe(409);
    expect(await poll(run)).toEqual(completed);
    expect(sessionStore.getValidationResults()).toEqual([completed.result?.validation]);
  });

  it('completes malformed JSON as a failure rather than hanging or logging body-parser errors', async () => {
    const run = await start();
    const response = await fetch(`${baseUrl}${run.callbackPath}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"identifier":',
    });
    expect(response.status).toBe(400);
    expect((await poll(run)).result).toMatchObject({
      status: 400, rawBody: '{"identifier":', validation: { valid: false },
    });
    expect((await post(run.callbackPath, validOutput)).status).toBe(409);
    expect(sessionStore.getValidationResults()).toEqual([(await poll(run)).result?.validation]);
  });

  it.each(['duplicate', 'cancel', 'replace', 'manifest change'])(
    'protects a partially received malformed HTTP request against %s',
    async (action) => {
      const run = await start();
      const arrived = once(server, 'request');
      const request = httpRequest(`${baseUrl}${run.callbackPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength('{"identifier":}') },
      });
      const responseStatus = new Promise<number>((resolve, reject) => {
        request.once('error', reject);
        request.once('response', (response) => {
          response.once('error', reject);
          response.resume();
          response.once('end', () => resolve(response.statusCode!));
        });
      });
      request.write('{"identifier":');
      await arrived;
      let replacement: PartnerRun | undefined;
      try {
        if (action === 'duplicate') {
          expect((await post(run.callbackPath, validOutput)).status).toBe(409);
          expect((await poll(run)).status).toBe('waiting');
        } else if (action === 'cancel') {
          expect((await fetch(`${baseUrl}${runsPath}/${run.runId}`, { method: 'DELETE' })).status).toBe(204);
        } else if (action === 'replace') {
          replacement = await start();
        } else {
          sessionStore.setManifest(structuredClone(fixture));
        }
      } finally {
        request.end('}');
      }
      expect(await responseStatus).toBe(action === 'duplicate' ? 400 : 409);
      if (action === 'duplicate') {
        const completed = await poll(run);
        expect(completed.result).toMatchObject({ status: 400, rawBody: '{"identifier":}', validation: { valid: false } });
        expect(sessionStore.getValidationResults()).toEqual([completed.result?.validation]);
      } else {
        expect(sessionStore.getValidationResults()).toEqual([]);
        expect((await fetch(`${baseUrl}${runsPath}/${run.runId}`)).status).toBe(404);
      }
      if (replacement) expect((await poll(replacement)).status).toBe('waiting');
    },
  );

  it('completes an unsupported media type with 415', async () => {
    const run = await start();
    const response = await fetch(`${baseUrl}${run.callbackPath}`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(validOutput),
    });
    expect(response.status).toBe(415);
    expect((await poll(run)).result).toMatchObject({ status: 415, validation: { valid: false } });
  });

  // Trailing bytes after a gzip body crash body-parser < 2.4.0 when it inflates (GHSA-27r3-jxmh-p828).
  const compressedBody = (body: unknown) => Buffer.concat([gzipSync(JSON.stringify(body)), Buffer.from('trailing')]);

  it('completes a compressed callback with 415 without inflating it', async () => {
    const run = await start();
    const response = await fetch(`${baseUrl}${run.callbackPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: compressedBody(validOutput),
    });
    expect(response.status).toBe(415);
    expect((await poll(run)).result).toMatchObject({ status: 415, rawBody: null, validation: { valid: false } });
  });

  it('rejects a compressed body on the other routes with 415 and keeps serving', async () => {
    const response = await fetch(`${baseUrl}${runsPath}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: compressedBody({ capability: manifest.tools[0].capability, tool: manifest.tools[0].name }),
    });
    expect(response.status).toBe(415);
    expect((await poll(await start())).status).toBe('waiting');
  });

  it('supports the vendor JSON media type', async () => {
    const run = await start();
    const response = await fetch(`${baseUrl}${run.callbackPath}`, {
      method: 'POST',
      headers: { 'Content-Type': manifest.tools[0].outputs[0]['content-type'] },
      body: JSON.stringify(validOutput),
    });
    expect(response.status).toBe(200);
  });

  it('bounds request size and retains a failed completion for oversized JSON', async () => {
    const run = await start();
    const response = await post(run.callbackPath, { identifier: 'x'.repeat(1024 * 1024) });
    expect(response.status).toBe(413);
    expect((await poll(run)).result).toMatchObject({ status: 413, rawBody: null, validation: { valid: false } });
  });

  it('does not let an in-flight claim overwrite a replacement run', async () => {
    const oldRun = await start();
    const claim = sessionStore.partnerRuns.claim(manifest.auth.tenantId, manifest.tools[0].name);
    expect(typeof claim).toBe('object');
    expect(sessionStore.partnerRuns.claim(manifest.auth.tenantId, manifest.tools[0].name)).toBe(409);
    const currentRun = await start();
    expect(sessionStore.partnerRuns.complete(oldRun.runId, {
      status: 200, statusText: 'OK', rawBody: validOutput,
      validation: validatePartnerOutput({ tool: manifest.tools[0], manifestName: manifest.name }, validOutput),
    })).toBe(false);
    expect((await poll(currentRun)).status).toBe('waiting');
  });
});
