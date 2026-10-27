import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { CliWizardDialog } from '../CliWizardDialog';

const REPORT_CONTENT_TYPE = 'application/vnd.ms-dragon.rad.report+json';
const PATIENT_INFORMATION_CONTENT_TYPE = 'application/vnd.ms-dragon.rad.patient-information+json';
const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const AUTH_NOTE = 'Auth not supported for now for partner initiated flows';

// Mirrors GET /api/cli/options, which is sourced from the CLI's manifest core.
const OPTIONS = {
  domain: 'radiologists',
  templates: [
    {
      id: 'quality-check',
      name: 'sampleQualityCheckExtension',
      description: 'Extension to provide radiology report optimization',
      version: '0.0.1',
      toolCount: 1,
      toolTypes: ['contractBased'],
    },
    {
      id: 'pre-draft-report',
      name: 'sampleRadiologyExtension',
      description: 'Extension to provide draft radiology report generation',
      version: '0.0.1',
      toolCount: 1,
      toolTypes: ['partnerInitiated'],
    },
  ],
  inputTypes: [
    { name: 'Radiology Report', value: REPORT_CONTENT_TYPE },
    { name: 'Patient Information', value: PATIENT_INFORMATION_CONTENT_TYPE },
  ],
  toolTypes: [
    { name: 'Contract Based', value: 'contractBased' },
    { name: 'Partner Initiated', value: 'partnerInitiated' },
  ],
  capabilities: [
    { name: 'Report Optimization', value: 'qualityCheck' },
    { name: 'Draft Report Generation', value: 'preDraftReportGeneration' },
  ],
  capabilityByToolType: { contractBased: 'qualityCheck', partnerInitiated: 'preDraftReportGeneration' },
  outputDefaultsByToolType: {
    contractBased: { name: 'qualityCheckResult', description: 'Report optimization result' },
    partnerInitiated: { name: 'preDraftReportResult', description: 'Draft radiology report' },
  },
  bodyParts: [{ name: 'Chest', value: 'CHEST' }],
  modalities: [{ name: 'CT - Computed Tomography', value: 'CT' }],
  outputContentType: 'application/vnd.ms-dragon.rad.quality-check-result+json',
  defaults: {
    extensionName: 'myRadiologistsExtension',
    extensionDescription: 'A Dragon Copilot radiologists extension',
    version: '0.0.1',
    radiologistsExtensibilityApiVersion: '1.0.0',
    toolName: 'myRadiologistsTool',
    toolDescription: 'Processes radiology reports and imaging data',
    endpoint: 'https://api.example.com/radiologists/v1/process',
    outputName: 'qualityCheckResult',
    outputDescription: 'Report optimization result',
    schemaVersion: '1.0',
  },
};

let fetchMock: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
let onGenerated: Mock<(yaml: string) => void>;
let onOpenChange: Mock<(open: boolean) => void>;
let options: typeof OPTIONS;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function openWizard() {
  render(
    <FluentProvider theme={webLightTheme}>
      <CliWizardDialog open onOpenChange={onOpenChange} onGenerated={onGenerated} />
    </FluentProvider>,
  );
  await screen.findByRole('textbox', { name: /^Azure Entra ID tenant ID/ });
}

function enterTenantId() {
  fireEvent.change(screen.getByRole('textbox', { name: /^Azure Entra ID tenant ID/ }), {
    target: { value: TENANT_ID },
  });
}

function startCustom() {
  fireEvent.click(screen.getByRole('radio', { name: 'My own values' }));
}

function toolGroup(name: string) {
  return screen.getByRole('group', { name });
}

function chooseToolType(group: HTMLElement, label: 'Contract Based' | 'Partner Initiated') {
  fireEvent.click(within(group).getByRole('radio', { name: label }));
}

function generateButton() {
  return screen.getByRole('button', { name: 'Generate manifest' });
}

function generateRequests() {
  return fetchMock.mock.calls
    .filter(([input]) => String(input).endsWith('/api/cli/generate'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

beforeEach(() => {
  options = OPTIONS;
  onGenerated = vi.fn<(yaml: string) => void>();
  onOpenChange = vi.fn<(open: boolean) => void>();
  fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
    const url = String(input);
    if (url.endsWith('/api/cli/options')) return json(options);
    if (url.endsWith('/api/cli/generate')) return json({ generated: true, valid: true, yaml: 'name: generated\n' });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('CliWizardDialog (custom mode)', () => {
  it('hides the endpoint and inputs for a Partner Initiated tool and offers its output defaults', async () => {
    await openWizard();
    startCustom();
    const tool = toolGroup('Tool');

    expect(within(tool).getByRole('textbox', { name: /^API endpoint/ })).toBeInTheDocument();
    // Field wraps the input type checkboxes, so their accessible names are merged; count them instead.
    expect(within(tool).getAllByRole('checkbox')).toHaveLength(OPTIONS.inputTypes.length);
    expect(within(tool).getByRole('textbox', { name: /^Capability/ })).toHaveValue('Report Optimization');
    expect(within(tool).getByRole('textbox', { name: /^Output name/ })).toHaveValue('qualityCheckResult');
    expect(screen.queryByText(AUTH_NOTE)).not.toBeInTheDocument();
    expect(within(tool).queryByText(/declarative and not currently enforced/)).not.toBeInTheDocument();

    chooseToolType(tool, 'Partner Initiated');

    expect(within(tool).queryByRole('textbox', { name: /^API endpoint/ })).not.toBeInTheDocument();
    expect(within(tool).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(tool).getByRole('textbox', { name: /^Capability/ })).toHaveValue('Draft Report Generation');
    expect(within(tool).getByRole('textbox', { name: /^Output name/ })).toHaveValue('preDraftReportResult');
    expect(within(tool).getByRole('textbox', { name: /^Output description/ })).toHaveValue('Draft radiology report');
    expect(within(tool).getByText(/declarative and not currently enforced/)).toBeInTheDocument();
    // The auth note lives in the Testing panel's Setup tab, not the wizard.
    expect(screen.queryByText(AUTH_NOTE)).not.toBeInTheDocument();

    chooseToolType(tool, 'Contract Based');

    expect(within(tool).getByRole('textbox', { name: /^API endpoint/ })).toBeInTheDocument();
    expect(within(tool).getByRole('textbox', { name: /^Output name/ })).toHaveValue('qualityCheckResult');
  });

  it('keeps output values the user already edited when the tool type changes', async () => {
    await openWizard();
    startCustom();
    const tool = toolGroup('Tool');

    fireEvent.change(within(tool).getByRole('textbox', { name: /^Output name/ }), { target: { value: 'myResult' } });
    chooseToolType(tool, 'Partner Initiated');

    expect(within(tool).getByRole('textbox', { name: /^Output name/ })).toHaveValue('myResult');
    // Not edited, so it still follows the tool type.
    expect(within(tool).getByRole('textbox', { name: /^Output description/ })).toHaveValue('Draft radiology report');
  });

  it('requires an endpoint only for Contract Based tools', async () => {
    await openWizard();
    startCustom();
    enterTenantId();
    const tool = toolGroup('Tool');

    expect(generateButton()).toBeEnabled();

    fireEvent.change(within(tool).getByRole('textbox', { name: /^API endpoint/ }), { target: { value: '' } });
    expect(generateButton()).toBeDisabled();

    chooseToolType(tool, 'Partner Initiated');
    expect(generateButton()).toBeEnabled();
  });

  it('sends every tool, with an endpoint and inputs only for Contract Based tools', async () => {
    await openWizard();
    startCustom();
    enterTenantId();

    fireEvent.click(screen.getByRole('button', { name: 'Add another tool' }));
    chooseToolType(toolGroup('Tool 2'), 'Partner Initiated');
    fireEvent.click(generateButton());

    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith('name: generated\n'));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    const [request] = generateRequests();
    expect(request.mode).toBe('custom');
    expect(request.tenantId).toBe(TENANT_ID);
    expect(request.tool).toBeUndefined();
    expect(request.tools).toEqual([
      {
        name: 'myRadiologistsTool',
        description: 'Processes radiology reports and imaging data',
        toolType: 'contractBased',
        endpoint: 'https://api.example.com/radiologists/v1/process',
        inputTypes: [REPORT_CONTENT_TYPE, PATIENT_INFORMATION_CONTENT_TYPE],
        outputs: [{ name: 'qualityCheckResult', description: 'Report optimization result', schemaVersion: '1.0' }],
        relevanceFilteringCriteria: { relevantBodyParts: [], relevantModalities: [] },
      },
      {
        name: 'myRadiologistsTool2',
        description: 'Processes radiology reports and imaging data',
        toolType: 'partnerInitiated',
        outputs: [{ name: 'preDraftReportResult', description: 'Draft radiology report', schemaVersion: '1.0' }],
        relevanceFilteringCriteria: { relevantBodyParts: [], relevantModalities: [] },
      },
    ]);
  });

  it('blocks generation while two tools share a name, and lets the extra tool be removed', async () => {
    await openWizard();
    startCustom();
    enterTenantId();

    expect(screen.queryByRole('button', { name: /^Remove tool/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add another tool' }));

    const second = toolGroup('Tool 2');
    fireEvent.change(within(second).getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'myRadiologistsTool' },
    });

    expect(screen.getAllByText('Tool names must be unique.')).toHaveLength(2);
    expect(generateButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove tool 2' }));

    expect(screen.queryByRole('group', { name: 'Tool 2' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Tool' })).toBeInTheDocument();
    expect(screen.queryByText('Tool names must be unique.')).not.toBeInTheDocument();
    expect(generateButton()).toBeEnabled();
  });

  it.each([
    ['the last tool', 'Remove tool 2'],
    ['the first tool', 'Remove tool 1'],
  ])('moves focus to the next Name field after removing %s', async (_label, removeButton) => {
    await openWizard();
    startCustom();

    fireEvent.click(screen.getByRole('button', { name: 'Add another tool' }));
    fireEvent.click(screen.getByRole('button', { name: removeButton }));

    const remainingName = within(toolGroup('Tool')).getByRole('textbox', { name: /^Name/ });
    await waitFor(() => expect(remainingName).toHaveFocus());
  });
});

// The wizard starts on the first template. Opening Fluent's Dropdown popup
// inside a Dialog does not settle under jsdom, so these tests choose the
// template by ordering the options instead.
describe('CliWizardDialog (template mode)', () => {
  it('generates from a template with Partner Initiated tools without showing the auth note', async () => {
    options = { ...OPTIONS, templates: [...OPTIONS.templates].reverse() };
    await openWizard();
    enterTenantId();

    expect(screen.getByRole('combobox', { name: /^Template/ })).toHaveTextContent(
      'Extension to provide draft radiology report generation',
    );
    expect(screen.queryByText(AUTH_NOTE)).not.toBeInTheDocument();

    fireEvent.click(generateButton());
    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith('name: generated\n'));
    expect(generateRequests()).toEqual([
      {
        domain: 'radiologists',
        mode: 'template',
        template: 'pre-draft-report',
        tenantId: TENANT_ID,
      },
    ]);
  });
});
