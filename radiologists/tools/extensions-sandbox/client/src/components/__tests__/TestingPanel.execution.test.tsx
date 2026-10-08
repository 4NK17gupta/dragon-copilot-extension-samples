import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { TestingPanel } from '../TestingPanel';

const fixture = JSON.parse(readFileSync(
  resolve(__dirname, '../../../../server/src/__tests__/fixtures/valid-manifest-partner-initiated.json'),
  'utf-8',
));
const toolName: string = fixture.tools[0].name;
const info = { name: fixture.name, version: fixture.version, toolCount: 1, capabilities: ['preDraftReportGeneration'] };
const callbackPath = `/api/partnerInitiated/${fixture.auth.tenantId}/${toolName}`;
const waiting = { runId: 'partner-test', status: 'waiting', callbackPath };
let listenerStatus: unknown;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function renderPanel() {
  render(
    <FluentProvider theme={webLightTheme}>
      <TestingPanel manifestInfo={info} manifestRevision={0} />
    </FluentProvider>,
  );
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/tools'))).toBe(true));
  await act(async () => {});
}

beforeEach(() => {
  listenerStatus = waiting;
  fetchMock = vi.fn(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/manifest/capabilities')) {
      return json([{ name: 'preDraftReportGeneration', displayName: 'Pre Draft Report Generation', toolCount: 1 }]);
    }
    if (url.endsWith('/tools')) {
      return json([{ name: toolName, toolType: 'partnerInitiated', description: 'Pre-draft generator', inputs: [], outputs: [] }]);
    }
    if (url.endsWith('/partner-initiated/start')) return json(waiting);
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/partner-initiated/partner-test')) return json(listenerStatus);
    return json(null);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { cleanup(); });
  vi.unstubAllGlobals();
});

describe('TestingPanel partner-initiated execution', () => {
  it('shows the listening URL and can cancel without invoking the contract-based endpoint', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));

    expect(await screen.findByText(/Waiting for a POST request on/)).toHaveTextContent(
      new URL(callbackPath, window.location.origin).href,
    );
    expect(screen.getByText('Send the raw output payload as JSON, without an ingest envelope.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run Test' })).toBeDisabled();
    expect(screen.queryByText('Authentication')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/execute'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Listening' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run Test' })).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledWith('/api/manifest/partner-initiated/partner-test', expect.objectContaining({
      method: 'DELETE',
    }));
    expect(screen.queryByText(/Waiting for a POST request on/)).toBeNull();
  });

  it.each([true, false])('displays received request validation (valid=%s) and raw output', async (valid) => {
    listenerStatus = {
      ...waiting,
      status: 'completed',
      result: {
        status: valid ? 200 : 422,
        statusText: valid ? 'OK' : 'Unprocessable Entity',
        rawBody: { identifier: 'received-report' },
        validation: {
          valid,
          toolName,
          outputContentType: 'application/vnd.ms-dragon.rad.pre-draft-report+json',
          checks: [{
            check: 'Declared output schema',
            passed: valid,
            ...(valid ? {} : { error: 'Missing required field reportContent' }),
          }],
          summary: { passed: valid ? 1 : 0, failed: valid ? 0 : 1 },
          timestamp: '2026-10-08T00:00:00Z',
        },
      },
    };
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('heading', { name: 'Validation Results' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Validation checks' })).toHaveTextContent(valid ? 'PASS' : 'FAIL');
    if (!valid) expect(screen.getByRole('alert')).toHaveTextContent('Missing required field reportContent');
    expect(screen.queryByText(/Waiting for a POST request on/)).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Outputs' }));
    expect(screen.getByRole('heading', { name: 'Received Request Payload' })).toBeInTheDocument();
    expect(screen.getByText(/"identifier": "received-report"/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Response Payload' })).toBeNull();
  });

  it('cancels listening when Reset Inputs is clicked', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
    await screen.findByText(/Waiting for a POST request on/);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Inputs' }));
    await waitFor(() => expect(screen.queryByText(/Waiting for a POST request on/)).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/manifest/partner-initiated/partner-test', expect.objectContaining({
      method: 'DELETE',
    }));
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
  });
});
