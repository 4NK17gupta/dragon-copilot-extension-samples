import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { TestingPanel } from '../TestingPanel';
import { formatReceivedTime } from '../captureText';
import type { CapturedRequest, ValidationCheck, ValidationResult } from '../../types/testing';

// Opening a real Fluent Dropdown in jsdom never yields to timers, which hangs the run.
// This stand-in keeps the combobox contract the tests rely on: label, shown text, disabled, options.
vi.mock('@fluentui/react-components', async (importOriginal) => {
  const { createContext, useContext, useState } = await import('react');
  type Select = (event: unknown, optionValue: string) => void;
  const DropdownContext = createContext<{ selected: string[]; select: Select } | null>(null);
  return {
    ...await importOriginal<typeof import('@fluentui/react-components')>(),
    Dropdown: ({ id, value, placeholder, disabled, selectedOptions = [], onOptionSelect, children }: {
      id?: string;
      value?: string;
      placeholder?: string;
      disabled?: boolean;
      selectedOptions?: string[];
      onOptionSelect?: (event: unknown, data: { optionValue: string; selectedOptions: string[] }) => void;
      children: ReactNode;
    }) => {
      const [open, setOpen] = useState(false);
      const select: Select = (event, optionValue) => {
        setOpen(false);
        onOptionSelect?.(event, { optionValue, selectedOptions: [optionValue] });
      };
      return (
        <DropdownContext.Provider value={{ selected: selectedOptions, select }}>
          <button type="button" role="combobox" id={id} aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>
            {value || placeholder}
          </button>
          {open && <div role="listbox">{children}</div>}
        </DropdownContext.Provider>
      );
    },
    Option: ({ value, children }: { value: string; children: ReactNode }) => {
      const dropdown = useContext(DropdownContext);
      return (
        <div role="option" aria-selected={dropdown?.selected.includes(value) ?? false} onClick={(event) => dropdown?.select(event, value)}>
          {children}
        </div>
      );
    },
  };
});

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

const stored = (sequence: number, rawBody: unknown = example) => capturedRequest(sequence, {
  status: 200,
  statusText: 'OK',
  rawBody,
  validation: validation([{ check: 'Draft report stored', passed: true }]),
});

/** The example ingest request with its impression section replaced. */
function exampleWithImpression(content: string, aiConfidence: number) {
  const body = JSON.parse(JSON.stringify(example));
  const sections = body.draftReport.reportContent.structuredReport.sections;
  sections[1] = { ...sections[1], content, aiConfidence };
  return body;
}

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

/** Clicks Run Test and waits until the header says the sandbox is listening. Returns the header's listener controls. */
async function startCapturing(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
  const header = await screen.findByRole('group', { name: 'Request listener' });
  await waitFor(() => expect(listenerStatus(header)).toHaveTextContent(/^Listening$/));
  return header;
}

function listenerStatus(container: HTMLElement): HTMLElement {
  return within(container).getByRole('status');
}

/** The listener controls in the panel header, shown only while the sandbox listens. */
function headerListener(): HTMLElement | null {
  return screen.queryByRole('group', { name: 'Request listener' });
}

function actionBar(): HTMLElement {
  return document.querySelector<HTMLElement>('.setup-tab .action-bar')!;
}

/** The badge next to Run Test on Setup. */
function setupBadge(): HTMLElement {
  return listenerStatus(actionBar());
}

function requestsPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Requests received' });
}

function requestsDropdown(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Requests received' });
}

/** What the Requests received panel announces, such as "2 requests received". */
function panelAnnouncement(): HTMLElement {
  return requestsPanel().querySelector<HTMLElement>('[aria-live="polite"]')!;
}

/** The panel's label for a request, for example "#1 · 10:00:01 AM · Draft Report Generation · 200 OK". */
function entryText(number: number, request: CapturedRequest, outcome: string): string {
  return `#${number} · ${formatReceivedTime(request.receivedAt)} · Draft Report Generation · ${outcome}`;
}

/** Picks a request from the Requests received panel. */
function pickRequest(number: number) {
  fireEvent.click(requestsDropdown());
  fireEvent.click(screen.getByRole('option', { name: new RegExp(`^#${number} ·`) }));
}

function expectEmptyPanel() {
  expect(requestsPanel().querySelector('.requests-panel-count')).toHaveTextContent(/^0$/);
  expect(panelAnnouncement()).toHaveTextContent(/^No requests yet$/);
  expect(requestsDropdown()).toHaveTextContent('No requests yet');
  expect(requestsDropdown()).toBeDisabled();
}

const simulatedEnvironment = {
  customerTenantId: '11111111-1111-1111-1111-111111111111',
  environmentId: '22222222-2222-2222-2222-222222222222',
  marketplace: null,
  orders: ['ACC-0000001'],
  submissionPath: callbackPath,
  storedResultCount: 0,
};

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
    if (url === '/api/simulated-environment/stored-results' && init?.method === 'DELETE') {
      return json(simulatedEnvironment);
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.startsWith(`${capturePath}?after=`)) return json(capture(Number(url.split('after=')[1])));
    if (url === '/api/simulated-environment') return json(simulatedEnvironment);
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

  it('listens from Run Test, shows it on Setup and in the header on every tab, and stops from the header', async () => {
    await renderPanel();
    expect(setupBadge()).toHaveTextContent(/^Not listening$/);
    expect(headerListener()).toBeNull();
    const runButton = screen.getByRole('button', { name: 'Run Test' });
    runButton.focus();
    const header = await startCapturing();

    expect(setupBadge()).toHaveTextContent(/^Listening$/);
    // Setup's badge announces the change, so the header's doesn't repeat it there.
    expect(listenerStatus(header)).toHaveAttribute('aria-live', 'off');
    expectEmptyPanel();
    expect(header).not.toHaveTextContent('/api/v1/');
    // The same button now stops listening, so it keeps focus.
    expect(runButton).toHaveTextContent('Stop listening');
    expect(runButton).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Authentication')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/execute'))).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: 'Results' }));
    expect(screen.getByText('No requests yet. Send one to the endpoint shown in the Setup tab.')).toBeInTheDocument();
    expect(listenerStatus(headerListener()!)).toHaveTextContent(/^Listening$/);
    expect(listenerStatus(headerListener()!)).not.toHaveAttribute('aria-live');
    fireEvent.click(screen.getByRole('tab', { name: 'Outputs' }));
    expect(listenerStatus(headerListener()!)).toHaveTextContent(/^Listening$/);
    fireEvent.click(screen.getByRole('tab', { name: 'Dragon Copilot Preview' }));
    expect(screen.getByText('No draft report received yet. Send a submission to the endpoint shown in the Setup tab.')).toBeInTheDocument();
    expect(listenerStatus(headerListener()!)).toHaveTextContent(/^Listening$/);

    // Hold the stop, to see the header while it's under way.
    let finishStop!: () => void;
    const serve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === capturePath && init?.method === 'DELETE') {
        await new Promise<void>((resolve) => { finishStop = resolve; });
      }
      return serve(input, init);
    });
    const stop = within(headerListener()!).getByRole('button', { name: 'Stop listening' });
    stop.focus();
    fireEvent.click(stop);
    await waitFor(() => expect(listenerStatus(headerListener()!)).toHaveTextContent(/^Stopping…$/));
    expect(stop).toHaveAttribute('aria-disabled', 'true');
    expect(stop).toHaveFocus();
    await act(async () => { finishStop(); });
    fetchMock.mockImplementation(serve);

    await waitFor(() => expect(headerListener()).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(capturePath, expect.objectContaining({ method: 'DELETE' }));
    expect(screen.getByRole('tab', { name: 'Dragon Copilot Preview' })).toHaveFocus();
    expect(screen.getByText(
      'No draft report received yet. Click Run Test, then send a submission to the endpoint shown in the Setup tab.',
    )).toBeInTheDocument();
    expectEmptyPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    expect(setupBadge()).toHaveTextContent(/^Not listening$/);

    await startCapturing();
    expect(setupBadge()).toHaveTextContent(/^Listening$/);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/partner-initiated/start'))).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Reset Inputs' }));
    await waitFor(() => expect(headerListener()).toBeNull());
    expect(setupBadge()).toHaveTextContent(/^Not listening$/);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2);
  });

  it.each([true, false])('shows a captured request (valid=%s): its checks, the request and the response', async (valid) => {
    captured = [valid ? stored(1) : rejected(1)];
    const receivedAt = formatReceivedTime(captured[0].receivedAt);
    await renderPanel();
    const header = await startCapturing();
    await nextPoll();

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('heading', { name: 'Validation Results' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Validation checks' })).toHaveTextContent(valid ? 'PASS' : 'FAIL');
    expect(screen.getByText(valid
      ? 'All 1 checks passed — the draft report was stored.'
      : '1 of 1 checks failed — 400 Bad Request.')).toBeInTheDocument();
    if (!valid) expect(screen.getByRole('alert')).toHaveTextContent('Missing required field reportContent');
    expect(screen.getByText('Received').nextElementSibling).toHaveTextContent(receivedAt);
    expect(listenerStatus(header)).toHaveTextContent(/^Listening$/);
    expect(requestsDropdown()).toHaveTextContent(entryText(1, captured[0], valid ? '200 OK' : '400 Bad Request'));
    expect(panelAnnouncement()).toHaveTextContent(/^1 request received$/);
    expect(requestsPanel().querySelector('.requests-panel-count')).toHaveTextContent(/^1$/);

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

  it('selects each new request without leaving the tab in use, and stops listening when an earlier one is picked', async () => {
    captured = [stored(1)];
    await renderPanel();
    await startCapturing();
    await nextPoll();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'));

    // Later requests are selected as they arrive, but the tab in use stays.
    fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    captured = [...captured, alreadyStored(2)];
    await nextPoll();
    await waitFor(() => expect(requestsDropdown()).toHaveTextContent(entryText(2, captured[1], '409 ResultAlreadyStored')));
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true');
    expect(panelAnnouncement()).toHaveTextContent(/^2 requests received$/);
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }));
    expect(screen.getByText('1 of 2 checks failed — 409 ResultAlreadyStored.')).toBeInTheDocument();

    captured = [...captured, stored(3)];
    await nextPoll();
    await waitFor(() => expect(requestsDropdown()).toHaveTextContent(entryText(3, captured[2], '200 OK')));
    expect(screen.getByText('Received').nextElementSibling).toHaveTextContent(formatReceivedTime(captured[2].receivedAt));

    fireEvent.click(requestsDropdown());
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      entryText(3, captured[2], '200 OK'),
      entryText(2, captured[1], '409 ResultAlreadyStored'),
      entryText(1, captured[0], '200 OK'),
    ]);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(options[2]);

    // Picking an earlier request stops listening so it stays on screen. It neither re-runs nor clears the list.
    await waitFor(() => expect(headerListener()).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(capturePath, expect.objectContaining({ method: 'DELETE' }));
    expect(requestsDropdown()).toHaveTextContent(entryText(1, captured[0], '200 OK'));
    expect(panelAnnouncement()).toHaveTextContent(/^3 requests received$/);
    expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('All 1 checks passed — the draft report was stored.')).toBeInTheDocument();
    expect(screen.getByText('Received').nextElementSibling).toHaveTextContent(formatReceivedTime(captured[0].receivedAt));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/partner-initiated/start'))).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Back to Setup' }));
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true');
    expect(setupBadge()).toHaveTextContent(/^Not listening$/);
    expect(screen.getByRole('button', { name: 'Run Test' })).toBeEnabled();
  });

  it('shows the Requests received panel between the heading and the tabs, on every tab', async () => {
    captured = [stored(1)];
    await renderPanel();
    await startCapturing();
    await nextPoll();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'));

    const panel = requestsPanel();
    const follows = (first: Node, second: Node) =>
      (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(screen.getByRole('heading', { name: 'Testing' }), panel)).toBe(true);
    expect(follows(panel, screen.getByRole('tablist'))).toBe(true);
    for (const tab of ['Setup', 'Results', 'Outputs', 'Dragon Copilot Preview']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      expect(requestsPanel()).toBeVisible();
      expect(requestsDropdown()).toHaveTextContent(entryText(1, captured[0], '200 OK'));
    }
  });

  it('empties the panel and the tabs on Clear stored results, and keeps listening', async () => {
    captured = [stored(1), alreadyStored(2)];
    await renderPanel();
    const header = await startCapturing();
    await nextPoll();
    await waitFor(() => expect(panelAnnouncement()).toHaveTextContent(/^2 requests received$/));

    fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    fireEvent.click(await screen.findByText('Clear stored results'));
    await waitFor(() => expectEmptyPanel());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/simulated-environment/stored-results',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(listenerStatus(header)).toHaveTextContent(/^Listening$/);
    expect(setupBadge()).toHaveTextContent(/^Listening$/);
    expect(screen.queryByText('Clear stored results')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }));
    expect(screen.getByText('No requests yet. Send one to the endpoint shown in the Setup tab.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Outputs' }));
    expect(screen.queryByRole('heading', { name: 'Received Request Payload' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Dragon Copilot Preview' }));
    expect(screen.getByText('No draft report received yet. Send a submission to the endpoint shown in the Setup tab.')).toBeInTheDocument();

    // Cleared requests don't come back, and numbering starts again.
    captured = [...captured, stored(3)];
    await nextPoll();
    await waitFor(() => expect(requestsDropdown()).toHaveTextContent(entryText(1, captured[2], '200 OK')));
    expect(panelAnnouncement()).toHaveTextContent(/^1 request received$/);
    expect(screen.getByRole('region', { name: 'AI draft' })).toBeInTheDocument();
  });

  it('switches Setup to the capability and tool of the request picked in the panel', async () => {
    const serve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/manifest/capabilities')) {
        return json([
          { name: 'preDraftReportGeneration', displayName: 'Draft Report Generation', toolCount: 1 },
          { name: 'qualityCheck', displayName: 'Report Optimization', toolCount: 1 },
        ]);
      }
      if (url.endsWith('/capabilities/qualityCheck/tools')) {
        return json([{
          name: 'qualityCheckTool', toolType: 'contractBased', description: 'Quality check',
          endpoint: 'https://example.com/v1/process', inputs: [], outputs: [],
        }]);
      }
      return serve(input, init);
    });
    captured = [stored(1)];
    await renderPanel();
    await startCapturing();
    await nextPoll();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'));

    fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Capability' }));
    fireEvent.click(screen.getByRole('option', { name: 'Report Optimization' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveTextContent('qualityCheckTool'));
    // Another tool stops listening, and a contract-based tool has no listener badge.
    await waitFor(() => expect(headerListener()).toBeNull());
    expect(within(actionBar()).queryByRole('status')).toBeNull();
    // A manual Setup change keeps the list but stops showing its request.
    expect(requestsDropdown()).toHaveTextContent('Select a request');
    expect(panelAnnouncement()).toHaveTextContent(/^1 request received$/);

    pickRequest(1);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveTextContent(toolName));
    expect(setupBadge()).toHaveTextContent(/^Not listening$/);
    expect(screen.getByRole('combobox', { name: 'Capability' })).toHaveTextContent('Draft Report Generation');
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true');
    expect(requestsDropdown()).toHaveTextContent(entryText(1, captured[0], '200 OK'));
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }));
    expect(screen.getByText('All 1 checks passed — the draft report was stored.')).toBeInTheDocument();
  });

  it('previews the draft of the request picked in the panel', async () => {
    captured = [
      stored(1, exampleWithImpression('First impression.', 0.8)),
      stored(2, exampleWithImpression('Second impression.', 0.6)),
    ];
    await renderPanel();
    await startCapturing();
    await nextPoll();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'));

    fireEvent.click(screen.getByRole('tab', { name: 'Dragon Copilot Preview' }));
    let draft = screen.getByRole('region', { name: 'AI draft' });
    expect(within(draft).getByText('Second impression.')).toBeVisible();
    expect(within(draft).getByText('Confidence 60%')).toBeVisible();

    pickRequest(1);
    expect(screen.getByRole('tab', { name: 'Dragon Copilot Preview' })).toHaveAttribute('aria-selected', 'true');
    draft = screen.getByRole('region', { name: 'AI draft' });
    expect(within(draft).getByText('First impression.')).toBeVisible();
    expect(within(draft).getByText('Confidence 80%')).toBeVisible();
    expect(within(draft).queryByText('Second impression.')).toBeNull();
  });

  it('shows and copies the warning on a check that passed', async () => {
    const warning = "draftReport.aiSystemInfo.version 'v1' isn't a semantic version in major.minor.patch form, such as 1.0.0.";
    captured = [capturedRequest(1, {
      status: 200,
      statusText: 'OK',
      validation: validation([
        { check: 'Request passes validation', passed: true, warning },
        { check: 'Draft report stored', passed: true },
      ]),
    })];
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderPanel();
    await startCapturing();
    await nextPoll();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'));

    expect(screen.getByText('All 2 checks passed — the draft report was stored.')).toBeInTheDocument();
    const checks = screen.getByRole('list', { name: 'Validation checks' });
    expect(within(checks).getByRole('note')).toHaveTextContent(warning);
    expect(within(checks).queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy Results' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain(`  ✓ Request passes validation — PASS\n    Warning: ${warning}\n  ✓ Draft report stored — PASS`);
  });

  it('shows a failure to start capturing', async () => {
    const serve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => String(input).endsWith('/partner-initiated/start')
      ? json({ error: 'Listener unavailable' }, 500)
      : serve(input, init));
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start listening. Listener unavailable');
    expect(headerListener()).toBeNull();
    expect(setupBadge()).toHaveTextContent(/^Not listening$/);
    expect(screen.getByRole('button', { name: 'Run Test' })).toBeEnabled();
    fireEvent.click(screen.getByRole('tab', { name: 'Dragon Copilot Preview' }));
    expect(screen.getByRole('status')).toHaveTextContent('Listener unavailable');
    expect(screen.queryByRole('region', { name: 'AI draft' })).toBeNull();
  });

  it('shows that listening stopped when the sandbox ends the capture', async () => {
    await renderPanel();
    await startCapturing();
    const serve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => String(input).startsWith(`${capturePath}?`)
      ? json({ error: 'The run has stopped or was replaced.' }, 404)
      : serve(input, init));
    await nextPoll();

    expect(await screen.findByRole('alert')).toHaveTextContent('Stopped listening. The run has stopped or was replaced.');
    await waitFor(() => expect(headerListener()).toBeNull());
    expect(setupBadge()).toHaveTextContent(/^Not listening$/);
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
    expect(within(actionBar()).queryByRole('status')).toBeNull();
    expectEmptyPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'));
    expect(panelAnnouncement()).toHaveTextContent(/^1 request received$/);
    expect(requestsDropdown()).toHaveTextContent(/^#1 · .+ · Report Optimization · 200 OK$/);
    expect(headerListener()).toBeNull();

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

describe('TestingPanel Run Test history', () => {
  const qualityCheckTool = {
    name: 'qualityCheckTool', toolType: 'contractBased', description: 'Quality check',
    endpoint: 'https://example.com/v1/process',
    inputs: [{ name: 'reportText', contentType: 'text/plain', required: false }],
    outputs: [],
  };
  /** The Report Optimization tools the manifest declares. */
  let qualityTools: unknown[];
  let extensionReachable: boolean;
  /** Resolves when /execute may answer, so a test can hold a run open. */
  let executeGate: Promise<void>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    qualityTools = [qualityCheckTool];
    extensionReachable = true;
    executeGate = Promise.resolve();
    const serve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/manifest/capabilities')) {
        return json([
          { name: 'qualityCheck', displayName: 'Report Optimization', toolCount: 1 },
          { name: 'preDraftReportGeneration', displayName: 'Draft Report Generation', toolCount: 1 },
        ]);
      }
      if (url.endsWith('/capabilities/qualityCheck/tools')) return json(qualityTools);
      if (url === '/api/manifest/execute') {
        await executeGate;
        if (!extensionReachable) {
          return json({ error: 'Could not reach the extension.', cause: 'DNS resolution failed', endpoint: qualityCheckTool.endpoint }, 502);
        }
        return json({
          status: 200,
          statusText: 'OK',
          sentRequest: { reportText: JSON.parse(String(init?.body)).inputs.reportText },
          processResponse: { success: true, payload: { qualityCheckResult: { recommendations: [] } } },
          validation: { ...validation([{ check: 'Response matches schema', passed: true }]), toolName: 'qualityCheckTool' },
        });
      }
      return serve(input, init);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const executeCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/manifest/execute').length;
  const reportText = () => screen.getByPlaceholderText('Enter Report Text');

  /** Runs Report Optimization from Setup with the given report text. */
  async function runQualityCheck(text: string) {
    fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    fireEvent.change(await screen.findByPlaceholderText('Enter Report Text'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'));
  }

  async function switchCapability(label: string, tool: string) {
    fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Capability' }));
    fireEvent.click(screen.getByRole('option', { name: label }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveTextContent(tool));
    // Let the tool change's effects run, as a browser does before the next click.
    await act(async () => {});
  }

  /** The panel's entries, newest first. */
  function panelOptions(): string[] {
    fireEvent.click(requestsDropdown());
    const options = screen.getAllByRole('option').map((option) => option.textContent ?? '');
    fireEvent.click(requestsDropdown());
    return options;
  }

  it('lists Run Test results with partner submissions, numbered together, across Setup changes', async () => {
    captured = [stored(1)];
    await renderPanel();
    await runQualityCheck('First report');
    expect(panelAnnouncement()).toHaveTextContent(/^1 request received$/);
    expect(requestsDropdown()).toHaveTextContent(/^#1 · .+ · Report Optimization · 200 OK$/);

    extensionReachable = false;
    await runQualityCheck('Second report');
    expect(requestsDropdown()).toHaveTextContent(/^#2 · .+ · Report Optimization · 502 DNS resolution failed$/);

    await switchCapability('Draft Report Generation', toolName);
    expect(requestsDropdown()).toHaveTextContent('Select a request');
    expect(panelAnnouncement()).toHaveTextContent(/^2 requests received$/);

    await startCapturing();
    await nextPoll();
    await waitFor(() => expect(requestsDropdown()).toHaveTextContent(entryText(3, captured[0], '200 OK')));
    expect(panelAnnouncement()).toHaveTextContent(/^3 requests received$/);
    const options = panelOptions();
    expect(options).toHaveLength(3);
    expect(options[0]).toBe(entryText(3, captured[0], '200 OK'));
    expect(options[1]).toMatch(/^#2 · .+ · Report Optimization · 502 DNS resolution failed$/);
    expect(options[2]).toMatch(/^#1 · .+ · Report Optimization · 200 OK$/);
  });

  it('switches Setup to the picked run and restores its inputs, without re-running it or changing tab', async () => {
    captured = [stored(1)];
    await renderPanel();
    await runQualityCheck('First report');
    await runQualityCheck('Second report');
    await switchCapability('Draft Report Generation', toolName);
    await startCapturing();
    await nextPoll();
    await waitFor(() => expect(panelAnnouncement()).toHaveTextContent(/^3 requests received$/));

    fireEvent.click(screen.getByRole('tab', { name: 'Outputs' }));
    pickRequest(1);
    expect(await screen.findByText(/"reportText": "First report"/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Outputs' })).toHaveAttribute('aria-selected', 'true');
    expect(requestsDropdown()).toHaveTextContent(/^#1 · .+ · Report Optimization · 200 OK$/);
    expect(panelAnnouncement()).toHaveTextContent(/^3 requests received$/);

    fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Capability' })).toHaveTextContent('Report Optimization'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveTextContent('qualityCheckTool'));
    await waitFor(() => expect(reportText()).toHaveValue('First report'));
    expect(executeCalls()).toBe(2);

    fireEvent.click(screen.getByRole('tab', { name: 'Results' }));
    expect(screen.getByText('All 1 checks passed — response matches the expected schema.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-run Execution' })).toBeEnabled();
    fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    expect(reportText()).toHaveValue('First report');

    // On the same tool, only the inputs change.
    pickRequest(2);
    expect(reportText()).toHaveValue('Second report');
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true');

    // A partner submission switches Setup back to its draft tool.
    pickRequest(3);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveTextContent(toolName));
    expect(screen.getByRole('combobox', { name: 'Capability' })).toHaveTextContent('Draft Report Generation');
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }));
    expect(screen.getByText('All 1 checks passed — the draft report was stored.')).toBeInTheDocument();
    expect(executeCalls()).toBe(2);
  });

  it('shows a picked run whose tool is gone from the manifest, leaving Setup as it is', async () => {
    await renderPanel();
    await runQualityCheck('First report');
    await switchCapability('Draft Report Generation', toolName);
    qualityTools = [];
    const toolFetches = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/qualityCheck/tools')).length;
    const fetchesBefore = toolFetches();

    pickRequest(1);
    await waitFor(() => expect(toolFetches()).toBe(fetchesBefore + 1));
    await act(async () => {});
    expect(screen.getByRole('combobox', { name: 'Capability' })).toHaveTextContent('Draft Report Generation');
    expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveTextContent(toolName);
    expect(requestsDropdown()).toHaveTextContent(/^#1 · .+ · Report Optimization · 200 OK$/);

    fireEvent.click(screen.getByRole('tab', { name: 'Results' }));
    expect(screen.getByText('All 1 checks passed — response matches the expected schema.')).toBeInTheDocument();
    expect(screen.getByText('qualityCheckTool')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-run Execution' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Dragon Copilot Preview' }));
    expect(screen.getByRole('heading', { name: 'Report optimization (0)' })).toBeInTheDocument();
  });

  it('empties the panel of Run Test results on Clear stored results', async () => {
    await renderPanel();
    await runQualityCheck('First report');
    await switchCapability('Draft Report Generation', toolName);

    fireEvent.click(await screen.findByText('Clear stored results'));
    await waitFor(() => expectEmptyPanel());

    // Numbering starts again.
    await switchCapability('Report Optimization', 'qualityCheckTool');
    await runQualityCheck('Second report');
    expect(requestsDropdown()).toHaveTextContent(/^#1 · .+ · Report Optimization · 200 OK$/);
  });

  it('keeps the newest 50 entries', async () => {
    await renderPanel();
    await runQualityCheck('Report');
    for (let run = 2; run <= 51; run++) {
      fireEvent.click(screen.getByRole('button', { name: 'Re-run Execution' }));
      await waitFor(() => expect(requestsDropdown()).toHaveTextContent(new RegExp(`^#${run} ·`)));
    }

    expect(panelAnnouncement()).toHaveTextContent(/^50 requests received$/);
    const options = panelOptions();
    expect(options).toHaveLength(50);
    expect(options[0]).toMatch(/^#51 ·/);
    expect(options[49]).toMatch(/^#2 ·/);
  }, 60_000);

  it('leaves out a run that was still going when the manifest changed', async () => {
    let finishRun!: () => void;
    executeGate = new Promise((resolve) => { finishRun = resolve; });
    const panel = (revision: number) => (
      <FluentProvider theme={webLightTheme}>
        <TestingPanel manifestInfo={info} manifestRevision={revision} />
      </FluentProvider>
    );
    const { rerender } = render(panel(0));
    fireEvent.change(await screen.findByPlaceholderText('Enter Report Text'), { target: { value: 'First report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
    await waitFor(() => expect(executeCalls()).toBe(1));

    rerender(panel(1));
    finishRun();
    await screen.findByRole('button', { name: 'Run Test' });
    expectEmptyPanel();
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true');
  });
});
