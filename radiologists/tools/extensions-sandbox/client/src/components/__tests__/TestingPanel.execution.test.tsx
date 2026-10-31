import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { TestingPanel } from '../TestingPanel';
import { formatReceivedTime } from '../captureText';
import type { CapturedRequest, ValidationCheck, ValidationResult } from '../../types/testing';

const fixture = JSON.parse(readFileSync(
  resolve(__dirname, '../../../../server/src/__tests__/fixtures/valid-manifest-partner-initiated.json'),
  'utf-8',
));
const toolName: string = fixture.tools[0].name;
const info = { name: fixture.name, version: fixture.version, toolCount: 1, capabilities: ['preDraftReportGeneration'] };
const callbackPath = '/api/v1/tenants/11111111-1111-1111-1111-111111111111/environments/22222222-2222-2222-2222-222222222222/draft-report-ai-results';
const callbackUrl = new URL(callbackPath, window.location.origin).href;
const capturePath = '/api/manifest/partner-initiated/partner-test';
const example = JSON.parse(readFileSync(
  resolve(__dirname, '../../../../../../partner-initiated/samples/PreDraftReportGeneration-Ingest-Request-Example.json'),
  'utf-8',
));
/** The requests the sandbox has captured so far. */
let captured: CapturedRequest[];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function capture(after = 0) {
  return {
    runId: 'partner-test',
    status: 'capturing',
    callbackPath,
    count: captured.length,
    requests: captured.filter((request) => request.sequence > after),
  };
}

function validation(checks: ValidationCheck[]): ValidationResult {
  const failed = checks.filter((check) => !check.passed).length;
  return {
    valid: failed === 0,
    toolName,
    outputContentType: 'application/vnd.ms-dragon.rad.draft-report+json',
    checks,
    summary: { passed: checks.length - failed, failed },
    timestamp: '2026-10-08T00:00:00Z',
  };
}

function capturedRequest(
  sequence: number,
  fields: Partial<CapturedRequest> & Pick<CapturedRequest, 'status' | 'statusText' | 'validation'>,
): CapturedRequest {
  return {
    sequence,
    receivedAt: new Date(Date.UTC(2026, 9, 8, 10, 0, sequence)).toISOString(),
    path: callbackPath,
    headers: { 'x-ms-correlation-id': `run-${sequence}` },
    rawBody: example,
    ...fields,
  };
}

const stored = (sequence: number) => capturedRequest(sequence, {
  status: 200,
  statusText: 'OK',
  validation: validation([{ check: 'Draft report stored', passed: true }]),
});

const rejected = (sequence: number) => capturedRequest(sequence, {
  status: 400,
  statusText: 'Bad Request',
  rawBody: { identifier: 'received-report' },
  responseBody: { status: 400, errors: { $: ['Missing required field reportContent'] } },
  validation: validation([{ check: 'errors["$"]', passed: false, error: 'Missing required field reportContent' }]),
});

const alreadyStored = (sequence: number) => capturedRequest(sequence, {
  status: 409,
  statusText: 'Conflict',
  responseBody: { message: 'Request could not be processed.', reason: 'ResultAlreadyStored' },
  validation: validation([
    { check: 'Content-Type is JSON', passed: true },
    { check: 'Result not already stored', passed: false, error: '409 ResultAlreadyStored. A result with this identifier is stored.' },
  ]),
});

async function renderPanel() {
  render(
    <FluentProvider theme={webLightTheme}>
      <TestingPanel manifestInfo={info} manifestRevision={0} />
    </FluentProvider>,
  );
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/tools'))).toBe(true));
  await act(async () => {});
}

/** Lets the sandbox poll the capture once. */
async function nextPoll() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
}

async function startCapturing(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
  const bar = await screen.findByRole('region', { name: 'Request listener' });
  await waitFor(() => expect(barStatus(bar)).toHaveTextContent(/^Listening/));
  return bar;
}

function barStatus(bar: HTMLElement): HTMLElement {
  return within(bar).getByRole('status');
}

beforeEach(() => {
  // Tabster needs layout measurements to identify focusable elements; jsdom has no layout.
  vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1024, 768));
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
    return this.parentElement;
  });
  captured = [];
  fetchMock = vi.fn(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/manifest/capabilities')) {
      return json([{ name: 'preDraftReportGeneration', displayName: 'Draft Report Generation', toolCount: 1 }]);
    }
    if (url.endsWith('/tools')) {
      return json([{ name: toolName, toolType: 'partnerInitiated', description: 'Draft generator', inputs: [], outputs: [] }]);
    }
    if (url.endsWith('/partner-initiated/start')) return json(capture(), 201);
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.startsWith(`${capturePath}?after=`)) return json(capture(Number(url.split('after=')[1])));
    return json(null);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { cleanup(); });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TestingPanel partner-initiated capture', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the empty AI draft before a partner-initiated tool has run', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Dragon Copilot Preview' }));

    expect(screen.getByRole('heading', { name: 'AI draft' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'No draft report received yet. Click Run Test, then send a submission to the endpoint shown in the Setup tab.',
    );
  });

  it('listens from Run Test, shows its state on every tab, and stops from the bar', async () => {
    await renderPanel();
    const runButton = screen.getByRole('button', { name: 'Run Test' });
    runButton.focus();
    const bar = await startCapturing();

    expect(barStatus(bar)).toHaveTextContent('Listening. No requests received yet.');
    expect(bar).toHaveTextContent('Requests 0 Showing —');
    expect(bar).not.toHaveTextContent('/api/v1/');
    // The same button now stops listening, so it keeps focus.
    expect(runButton).toHaveTextContent('Stop listening');
    expect(runButton).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Authentication')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/execute'))).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: 'Results' }));
    expect(screen.getByText('No requests yet. Send one to the endpoint shown in the Setup tab.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Dragon Copilot Preview' }));
    expect(screen.getByText('No draft report received yet. Send a submission to the endpoint shown in the Setup tab.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Outputs' }));
    fireEvent.click(within(bar).getByRole('button', { name: 'Stop listening' }));
    await waitFor(() => expect(barStatus(bar)).toHaveTextContent('Stopped listening. The endpoint answers 503 until you click Run Test.'));
    expect(within(bar).getByText('The endpoint answers 503 until you click Run Test.', { selector: 'p' })).toBeInTheDocument();
    expect(bar).toHaveTextContent('Requests 0 Showing —');
    expect(fetchMock).toHaveBeenCalledWith(capturePath, expect.objectContaining({ method: 'DELETE' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Dragon Copilot Preview' }));
    expect(screen.getByText(
      'No draft report received yet. Click Run Test, then send a submission to the endpoint shown in the Setup tab.',
    )).toBeInTheDocument();

    fireEvent.click(within(bar).getByRole('button', { name: 'Run Test' }));
    await waitFor(() => expect(barStatus(bar)).toHaveTextContent('Listening. No requests received yet.'));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/partner-initiated/start'))).toHaveLength(2);

    fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset Inputs' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Request listener' })).toBeNull());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2);
  });

  it.each([true, false])('shows a captured request (valid=%s): its checks, the request and the response', async (valid) => {
    captured = [valid ? stored(1) : rejected(1)];
    const receivedAt = formatReceivedTime(captured[0].receivedAt);
    await renderPanel();
    const bar = await startCapturing();
    await nextPoll();

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('heading', { name: 'Validation Results' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Validation checks' })).toHaveTextContent(valid ? 'PASS' : 'FAIL');
    expect(screen.getByText(valid
      ? 'All 1 checks passed — the draft report was stored.'
      : '1 of 1 checks failed — 400 Bad Request.')).toBeInTheDocument();
    if (!valid) expect(screen.getByRole('alert')).toHaveTextContent('Missing required field reportContent');
    expect(screen.getByText('Received').nextElementSibling).toHaveTextContent(receivedAt);
    expect(barStatus(bar)).toHaveTextContent('Listening. 1 request received.');
    expect(bar).toHaveTextContent(`Requests 1 Showing #1 ${valid ? '200 OK' : '400 Bad Request'} ${receivedAt} Latest`);

    fireEvent.click(screen.getByRole('tab', { name: 'Outputs' }));
    expect(screen.getByRole('heading', { name: 'Received Request Payload' })).toBeInTheDocument();
    expect(screen.getByText(`POST ${callbackUrl}`, { selector: '.request-method-badge' })).toBeInTheDocument();
    expect(screen.getByText(valid ? new RegExp(example.draftReport.identifier) : /"identifier": "received-report"/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Response Payload' })).toBeNull();
    const response = screen.getByRole('heading', { name: 'Endpoint Response' }).nextElementSibling;
    expect(response).toHaveTextContent(valid ? 'HTTP 200 OK' : 'HTTP 400 Bad Request');
    expect(response).toHaveTextContent('x-ms-correlation-id: run-1');
    expect(response).toHaveTextContent(valid ? '(no body)' : '"errors"');

    fireEvent.click(screen.getByRole('tab', { name: 'Dragon Copilot Preview' }));
    const preview = document.querySelector<HTMLElement>('.preview-tab')!;
    if (valid) {
      expect(screen.getByRole('heading', { name: 'AI draft' })).toBeVisible();
      expect(screen.getByText('No acute cardiopulmonary abnormality.')).toBeVisible();
      expect(screen.getByText('Third-party generated content')).toBeVisible();
    } else {
      expect(within(preview).getByRole('status')).toHaveTextContent('HTTP 400');
      expect(screen.queryByRole('region', { name: 'AI draft' })).toBeNull();
    }
  });

  it('follows new requests until an older one is picked, without leaving the tab in use', async () => {
    captured = [stored(1)];
    await renderPanel();
    const bar = await startCapturing();
    await nextPoll();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'));

    captured = [...captured, alreadyStored(2)];
    await nextPoll();
    expect(await screen.findByText('1 of 2 checks failed — 409 ResultAlreadyStored.')).toBeInTheDocument();
    expect(barStatus(bar)).toHaveTextContent('Listening. 2 requests received.');
    expect(bar).toHaveTextContent(
      `Requests 2 Showing #2 409 ResultAlreadyStored ${formatReceivedTime(captured[1].receivedAt)} Latest`,
    );
    const list = screen.getByRole('region', { name: 'Requests received' });
    let items = within(list).getAllByRole('button');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('#2');
    expect(items[0]).toHaveTextContent('409 ResultAlreadyStored');
    expect(items[0]).toHaveAttribute('aria-current', 'true');
    expect(items[1]).toHaveTextContent('#1');
    expect(items[1]).toHaveTextContent('200 OK');

    fireEvent.click(items[1]);
    expect(screen.getByText('All 1 checks passed — the draft report was stored.')).toBeInTheDocument();
    items = within(list).getAllByRole('button');
    expect(items[1]).toHaveAttribute('aria-current', 'true');
    expect(items[0]).not.toHaveAttribute('aria-current');
    expect(bar).toHaveTextContent(`Showing #1 200 OK ${formatReceivedTime(captured[0].receivedAt)} Show latest`);

    // A request picked in Results stays on screen when new requests arrive.
    fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    captured = [...captured, stored(3)];
    await nextPoll();
    await waitFor(() => expect(barStatus(bar)).toHaveTextContent('Listening. 3 requests received.'));
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true');
    expect(bar).toHaveTextContent('Requests 3 Showing #1 200 OK');

    fireEvent.click(within(bar).getByRole('button', { name: 'Show latest' }));
    expect(bar).toHaveTextContent(`Showing #3 200 OK ${formatReceivedTime(captured[2].receivedAt)} Latest`);
    captured = [...captured, alreadyStored(4)];
    await nextPoll();
    await waitFor(() => expect(bar).toHaveTextContent('Showing #4 409 ResultAlreadyStored'));
    expect(bar).toHaveTextContent('Latest');

    fireEvent.click(within(bar).getByRole('button', { name: 'Stop listening' }));
    await waitFor(() => expect(barStatus(bar)).toHaveTextContent('Stopped listening. The endpoint answers 503 until you click Run Test.'));
    expect(within(bar).getByText('The endpoint answers 503 until you click Run Test.', { selector: 'p' })).toBeInTheDocument();
    expect(bar).toHaveTextContent('Requests 4 Showing #4 409 ResultAlreadyStored');
  });

  it('shows a failure to start capturing', async () => {
    const serve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => String(input).endsWith('/partner-initiated/start')
      ? json({ error: 'Listener unavailable' }, 500)
      : serve(input, init));
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start listening. Listener unavailable');
    expect(screen.queryByRole('region', { name: 'Request listener' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Run Test' })).toBeEnabled();
    fireEvent.click(screen.getByRole('tab', { name: 'Dragon Copilot Preview' }));
    expect(screen.getByRole('status')).toHaveTextContent('Listener unavailable');
    expect(screen.queryByRole('region', { name: 'AI draft' })).toBeNull();
  });

  it('shows that capturing stopped when the sandbox ends the capture', async () => {
    await renderPanel();
    const bar = await startCapturing();
    const serve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => String(input).startsWith(`${capturePath}?`)
      ? json({ error: 'The run has stopped or was replaced.' }, 404)
      : serve(input, init));
    await nextPoll();

    expect(await screen.findByRole('alert')).toHaveTextContent('Stopped listening. The run has stopped or was replaced.');
    expect(barStatus(bar)).toHaveTextContent('Stopped listening. The endpoint answers 503 until you click Run Test.');
  });
});

describe('TestingPanel contract-based execution regression', () => {
  it('keeps posting inputs to the existing execute endpoint and displaying its response', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/manifest/capabilities')) {
        return json([{ name: 'qualityCheck', displayName: 'Report Optimization', toolCount: 1 }]);
      }
      if (url.endsWith('/tools')) {
        return json([{
          name: 'qualityCheckTool', toolType: 'contractBased', description: 'Quality check',
          endpoint: 'https://example.com/v1/process', inputs: [], outputs: [],
        }]);
      }
      if (url.endsWith('/execute')) {
        return json({
          status: 200,
          statusText: 'OK',
          sentRequest: { sessionData: { correlation_id: 'example' } },
          processResponse: { success: true, payload: { qualityCheckResult: { recommendations: [] } } },
        });
      }
      return json(null);
    });
    await renderPanel();
    expect(screen.getByText('Authentication')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'));

    expect(fetchMock).toHaveBeenCalledWith('/api/manifest/execute', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ capability: 'qualityCheck', tool: 'qualityCheckTool', inputs: {} }),
    }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('partner-initiated'))).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: 'Outputs' }));
    expect(screen.getByRole('heading', { name: 'Request Payload' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Response Payload' })).toBeInTheDocument();
    expect(screen.getByText(/"qualityCheckResult"/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Dragon Copilot Preview' }));
    expect(screen.getByRole('heading', { name: 'Report optimization (0)' })).toBeInTheDocument();
    expect(screen.queryByText('Work in progress')).toBeNull();
  });
});
