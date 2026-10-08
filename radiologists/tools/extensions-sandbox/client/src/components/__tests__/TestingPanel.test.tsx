import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { TestingPanel } from '../TestingPanel';

// Isolate selection logic from Fluent UI's browser-only popup and focus behavior.
vi.mock('@fluentui/react-components', async (importOriginal) => ({
  ...await importOriginal<typeof import('@fluentui/react-components')>(),
  Dropdown: ({ id, selectedOptions, onOptionSelect, children }: {
    id?: string;
    selectedOptions: string[];
    onOptionSelect: (event: unknown, data: { optionValue: string }) => void;
    children: ReactNode;
  }) => (
    <select
      id={id}
      value={selectedOptions[0] ?? ''}
      onChange={(event) => onOptionSelect(event, { optionValue: event.currentTarget.value })}
    >
      {children}
    </select>
  ),
  Option: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

const manifestInfo = {
  name: 'sample-extension',
  version: '0.0.1',
  toolCount: 1,
  capabilities: ['reportQuality'],
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Renders the panel and waits for manifest metadata fetches to settle, so the state
 * updates they trigger happen inside `act` rather than during an assertion.
 */
async function renderPanel(info = manifestInfo) {
  render(
    <FluentProvider theme={webLightTheme}>
      <TestingPanel manifestInfo={info} manifestRevision={0} />
    </FluentProvider>,
  );
  await waitFor(() => expect(fetchMock.mock.calls.filter(
    ([url]) => String(url).startsWith('/api/manifest/capabilities'),
  )).toHaveLength(2));
  await act(async () => {});
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/manifest/capabilities')) {
      return json([{ name: 'reportQuality', displayName: 'Report Quality', description: 'Quality checks', toolCount: 1 }]);
    }
    if (url.includes('/tools')) {
      return json([]);
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('TestingPanel pre-draft tool selection', () => {
  const fixture = JSON.parse(readFileSync(
    resolve(__dirname, '../../../../server/src/__tests__/fixtures/valid-manifest-partner-initiated.json'),
    'utf-8',
  ));
  const preDraftTools = [
    { name: fixture.tools[0].name, description: fixture.tools[0].description, inputs: [], outputs: [] },
    { name: 'secondPreDraftTool', description: 'Another pre-draft generator', inputs: [], outputs: [] },
  ];
  const capabilities = [
    { name: 'qualityCheck', displayName: 'Report Optimization', toolCount: 1 },
    { name: 'preDraftReportGeneration', displayName: 'Pre Draft Report Generation', toolCount: 2 },
  ];
  const info = { ...manifestInfo, toolCount: 3, capabilities: capabilities.map((cap) => cap.name) };

  beforeEach(() => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manifest/capabilities')) return json(capabilities);
      if (url.endsWith('/preDraftReportGeneration/tools')) return json(preDraftTools);
      if (url.endsWith('/qualityCheck/tools')) {
        return json([{ name: 'qualityCheckTool', description: 'Quality check', inputs: [], outputs: [] }]);
      }
      return json({});
    });
  });

  it('lists only tools supporting Pre Draft Report Generation and allows selecting any of them', async () => {
    await renderPanel(info);
    expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveValue('qualityCheckTool');

    fireEvent.change(screen.getByRole('combobox', { name: 'Capability' }), {
      target: { value: 'preDraftReportGeneration' },
    });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveValue(preDraftTools[0].name),
    );

    expect(within(screen.getByRole('combobox', { name: 'Tool' })).getAllByRole('option').map((option) => option.textContent)).toEqual(
      preDraftTools.map((tool) => tool.name),
    );
    expect(screen.queryByRole('option', { name: 'qualityCheckTool' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Tool' }), { target: { value: 'secondPreDraftTool' } });
    expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveValue('secondPreDraftTool');
    expect(screen.getByText('Another pre-draft generator')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Capability' }), { target: { value: 'qualityCheck' } });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveValue('qualityCheckTool'),
    );
  });

  it('selects the fixture tool for a manifest with only pre-draft report generation', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manifest/capabilities')) return json([capabilities[1]]);
      if (url.endsWith('/preDraftReportGeneration/tools')) return json([preDraftTools[0]]);
      return json({});
    });
    await renderPanel({ ...info, toolCount: 1, capabilities: ['preDraftReportGeneration'] });

    expect(screen.getByRole('combobox', { name: 'Capability' })).toHaveDisplayValue('Pre Draft Report Generation');
    expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveValue(fixture.tools[0].name);
  });

  it('ignores stale tool responses after switching capability', async () => {
    let resolvePreDraft!: (response: Response) => void;
    const pendingPreDraft = new Promise<Response>((resolve) => { resolvePreDraft = resolve; });
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith('/preDraftReportGeneration/tools') ? pendingPreDraft : normalFetch(input),
    );
    await renderPanel(info);

    fireEvent.change(screen.getByRole('combobox', { name: 'Capability' }), {
      target: { value: 'preDraftReportGeneration' },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/manifest/capabilities/preDraftReportGeneration/tools'));
    expect(screen.getByRole('combobox', { name: 'Tool' })).not.toHaveValue('qualityCheckTool');

    fireEvent.change(screen.getByRole('combobox', { name: 'Capability' }), { target: { value: 'qualityCheck' } });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveValue('qualityCheckTool'),
    );
    await act(async () => { resolvePreDraft(json(preDraftTools)); });

    expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveValue('qualityCheckTool');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TestingPanel tabs', () => {
  it('adds the Dragon Copilot Preview tab alongside the existing tabs', async () => {
    await renderPanel();

    expect(screen.getByRole('tab', { name: 'Setup' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Results' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Outputs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Dragon Copilot Preview' })).toBeInTheDocument();
  });

  it('shows the not-run Report optimization card before a tool has been run', async () => {
    await renderPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'Dragon Copilot Preview' }));

    expect(screen.getByText('Run smart impression to view suggestions.')).toBeInTheDocument();
  });

  it('leaves the raw JSON Results and Outputs tabs unchanged', async () => {
    await renderPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'Results' }));
    expect(screen.getByText('No results yet. Run a test from the Setup tab.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Outputs' }));
    expect(screen.getByText('No outputs yet. Run a test from the Setup tab.')).toBeInTheDocument();
  });

  it('shows a failed run in the preview instead of the not-run state', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manifest/capabilities')) {
        return json([{ name: 'reportQuality', displayName: 'Report Quality', description: 'Quality checks', toolCount: 1 }]);
      }
      if (url.includes('/tools')) {
        return json([{ name: 'sampleQualityCheckTool', description: '', inputs: [], outputs: [] }]);
      }
      if (url.endsWith('/api/manifest/execute')) {
        return new Response(JSON.stringify({ error: 'Could not reach the extension endpoint.' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return json({});
    });
    await renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'),
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Dragon Copilot Preview' }));

    expect(screen.getByText(/The run failed: Could not reach the extension endpoint\./)).toBeInTheDocument();
    expect(screen.queryByText('Run smart impression to view suggestions.')).toBeNull();
  });
});

describe('TestingPanel capability label', () => {
  it('shows the capability display name but sends the manifest value when running a tool', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manifest/capabilities')) {
        return json([
          {
            name: 'qualityCheck',
            displayName: 'Report Optimization',
            description: 'Report Optimization capability',
            toolCount: 1,
          },
        ]);
      }
      if (url.includes('/tools')) {
        return json([{ name: 'sampleQualityCheckTool', description: '', inputs: [], outputs: [] }]);
      }
      if (url.endsWith('/api/manifest/execute')) {
        return new Response(JSON.stringify({ error: 'Could not reach the extension endpoint.' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return json({});
    });
    await renderPanel();

    expect(screen.getByText('Report Optimization')).toBeInTheDocument();
    expect(screen.queryByText('qualityCheck')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true'),
    );

    const executeCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/manifest/execute'));
    expect(JSON.parse(String((executeCall?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      capability: 'qualityCheck',
    });
    expect(screen.getByText('Report Optimization')).toBeInTheDocument();
  });

  it('does not show the previous raw capability value when a new manifest has no capabilities', async () => {
    let capabilitiesResponse: unknown[] = [
      {
        name: 'qualityCheck',
        displayName: 'Report Optimization',
        description: 'Report Optimization capability',
        toolCount: 1,
      },
    ];
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manifest/capabilities')) {
        return json(capabilitiesResponse);
      }
      return json([]);
    });
    const { rerender } = render(
      <FluentProvider theme={webLightTheme}>
        <TestingPanel manifestInfo={manifestInfo} manifestRevision={0} />
      </FluentProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getByText('Report Optimization')).toBeInTheDocument();

    capabilitiesResponse = [];
    rerender(
      <FluentProvider theme={webLightTheme}>
        <TestingPanel
          manifestInfo={{ ...manifestInfo, name: 'other-extension', capabilities: [] }}
          manifestRevision={1}
        />
      </FluentProvider>,
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/manifest/capabilities')),
      ).toHaveLength(2),
    );
    await act(async () => {});

    expect(screen.getByText('other-extension')).toBeInTheDocument();
    expect(screen.queryByText('Report Optimization')).toBeNull();
    expect(screen.queryByText('qualityCheck')).toBeNull();
  });
});
