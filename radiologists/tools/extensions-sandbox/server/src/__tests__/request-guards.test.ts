import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { localRequestGuard } from '../middleware/local-request-guard.js';
import { globalErrorHandler } from '../middleware/error-handler.js';
import { canSendBearerToken } from '../services/extension-client.js';

const PHI = 'Jane Doe MRN 0012345';

let server: Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(localRequestGuard);
  app.use(express.json({ limit: '1kb', inflate: false }));
  app.all('/echo', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/explode', () => {
    throw Object.assign(new Error('boom'), { body: PHI });
  });
  app.use(globalErrorHandler);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let consoleOutput: () => string;

beforeEach(() => {
  const spies = (['log', 'warn', 'error'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}));
  consoleOutput = () => spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n');
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** node:http rather than fetch, because fetch does not allow setting the Host header. */
function send(options: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path ?? '/echo',
      headers: options.headers,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body }));
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

describe('localRequestGuard – Host header', () => {
  it.each(['localhost:4000', 'LOCALHOST', '127.0.0.1:4000', '[::1]:4000'])(
    'allows Host %s',
    async (host) => {
      expect((await send({ headers: { host } })).status).toBe(200);
    },
  );

  it.each([
    'attacker.example:4000',
    'attacker.example',
    'localhost.attacker.example',
    'attacker@localhost',
    '127.0.0.1.nip.io:4000',
  ])('rejects Host %s, as a DNS-rebinding page would send', async (host) => {
    const response = await send({ headers: { host } });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body).error).toBe('Requests must be addressed to localhost.');
  });
});

describe('localRequestGuard – Origin header', () => {
  const post = (origin?: string) => send({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: '{}',
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
    'allows a POST from the local page %s',
    async (origin) => {
      expect((await post(origin)).status).toBe(200);
    },
  );

  it('allows a POST with no Origin, as curl and the C# sample send', async () => {
    expect((await post()).status).toBe(200);
  });

  it.each(['http://attacker.example', 'null', 'http://localhost.attacker.example:3000'])(
    'rejects a POST from %s',
    async (origin) => {
      const response = await post(origin);

      expect(response.status).toBe(403);
      expect(JSON.parse(response.body).error).toBe('Cross-site requests are not allowed.');
    },
  );

  it('leaves GET to CORS, which already stops a foreign page reading the response', async () => {
    expect((await send({ headers: { origin: 'http://attacker.example' } })).status).toBe(200);
  });
});

describe('globalErrorHandler', () => {
  it('returns 400 for malformed JSON without logging the body', async () => {
    const response = await send({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"patient":"${PHI}"`,
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'Request body is not valid JSON.' });
    expect(consoleOutput()).toContain('entity.parse.failed');
    expect(consoleOutput()).not.toContain(PHI);
  });

  it('returns 413 for an oversized body without logging it', async () => {
    const response = await send({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patient: PHI, padding: 'x'.repeat(2048) }),
    });

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: 'Request body is too large.' });
    expect(consoleOutput()).not.toContain(PHI);
  });

  it('returns 415 for a compressed body', async () => {
    const response = await send({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: '{}',
    });

    expect(response.status).toBe(415);
    expect(JSON.parse(response.body)).toEqual({ error: 'Request body uses an unsupported content encoding.' });
  });

  it('returns 500 for an unexpected error and logs its stack but not its properties', async () => {
    const response = await send({
      method: 'POST',
      path: '/explode',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: 'Internal server error' });
    expect(consoleOutput()).toContain('boom');
    expect(consoleOutput()).not.toContain(PHI);
  });
});

describe('canSendBearerToken', () => {
  it.each([
    'https://extension.example/v1/process',
    'http://localhost:5080/v1/process',
    'http://127.0.0.1:5080/v1/process',
    'http://[::1]:5080/v1/process',
  ])('allows %s', (endpoint) => {
    expect(canSendBearerToken(endpoint)).toBe(true);
  });

  it.each([
    'http://extension.example/v1/process',
    'http://localhost.attacker.example/v1/process',
    'ftp://localhost/v1/process',
    'not-a-url',
  ])('rejects %s', (endpoint) => {
    expect(canSendBearerToken(endpoint)).toBe(false);
  });
});
