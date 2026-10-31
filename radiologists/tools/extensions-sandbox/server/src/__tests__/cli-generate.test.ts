import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import yaml from 'js-yaml';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cliRouter } from '../routes/cli.js';
import { manifestRouter } from '../routes/manifest.js';
import { sessionStore } from '../store/session.js';
import type { ExtensionManifest } from '../schemas/manifest.schema.js';

/**
 * Covers the Manifest Editor's "Generate Manifest" button: the sandbox runs the
 * CLI's manifest generation in-process (the synced core under `src/cli/radiologists`)
 * and hands back YAML the editor can load and validate.
 *
 * The guarantees pinned here are that generated YAML is schema-valid, that bad
 * wizard input is reported instead of silently producing a broken manifest, and
 * that repeated template generation stays independent.
 */

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const REPORT_CONTENT_TYPE = 'application/vnd.ms-dragon.rad.report+json';
const PATIENT_INFORMATION_CONTENT_TYPE = 'application/vnd.ms-dragon.rad.patient-information+json';

let server: Server;
let baseUrl = '';

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli', cliRouter);
  // Mounted so generated manifests can be loaded the way the editor loads them.
  app.use('/api/manifest', manifestRouter);
  server = await listen(app);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  // fetch keeps connections alive, so close() alone would never resolve.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function generate(body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/cli/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function customRequest(overrides: Record<string, unknown> = {}) {
  return {
    domain: 'radiologists',
    mode: 'custom',
    tenantId: TENANT_ID,
    extension: {
      name: 'myRadiologistsExtension',
      description: 'A Dragon Copilot radiologists extension',
      version: '0.0.1',
      radiologistsExtensibilityApiVersion: '1.0.0',
    },
    tool: {
      name: 'myRadiologistsTool',
      description: 'Processes radiology reports and imaging data',
      endpoint: 'https://api.example.com/radiologists/v1/process',
      inputTypes: [REPORT_CONTENT_TYPE, PATIENT_INFORMATION_CONTENT_TYPE],
      outputs: [{ name: 'qualityCheckResult', description: 'Quality check result', schemaVersion: '1.0' }],
    },
    ...overrides,
  };
}

describe('GET /api/cli/options', () => {
  it('describes the templates, choices, and defaults the wizard renders', async () => {
    const response = await fetch(`${baseUrl}/api/cli/options`);
    const options = await response.json();

    expect(response.status).toBe(200);
    expect(options.domain).toBe('radiologists');
    expect(options.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'quality-check', toolCount: 1, toolTypes: ['contractBased'] }),
        expect.objectContaining({ id: 'pre-draft-report', toolCount: 1, toolTypes: ['partnerInitiated'] }),
      ]),
    );
    expect(options.inputTypes.map((choice: { value: string }) => choice.value)).toEqual([
      REPORT_CONTENT_TYPE,
      PATIENT_INFORMATION_CONTENT_TYPE,
    ]);
    expect(options.capabilities).toEqual([
      { name: 'Report Optimization', value: 'qualityCheck' },
      { name: 'Draft Report Generation', value: 'preDraftReportGeneration' },
    ]);
    expect(options.toolTypes).toEqual([
      { name: 'Contract Based', value: 'contractBased' },
      { name: 'Partner Initiated', value: 'partnerInitiated' },
    ]);
    expect(options.capabilityByToolType).toEqual({
      contractBased: 'qualityCheck',
      partnerInitiated: 'preDraftReportGeneration',
    });
    expect(options.outputDefaultsByToolType).toEqual({
      contractBased: { name: 'qualityCheckResult', description: 'Report optimization result' },
      partnerInitiated: { name: 'preDraftReportResult', description: 'Draft radiology report' },
    });
    expect(options.bodyParts.length).toBeGreaterThan(0);
    expect(options.modalities.length).toBeGreaterThan(0);
    expect(options.defaults.extensionName).toBe('myRadiologistsExtension');
  });
});

describe('POST /api/cli/generate (template mode)', () => {
  it('returns schema-valid YAML for a built-in template', async () => {
    const { status, body } = await generate({
      domain: 'radiologists',
      mode: 'template',
      template: 'quality-check',
      tenantId: TENANT_ID,
    });

    expect(status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.manifest).toEqual({
      name: 'sampleQualityCheckExtension',
      version: '0.0.1',
      toolCount: 1,
      capabilities: ['qualityCheck'],
    });

    const manifest = yaml.load(body.yaml) as ExtensionManifest;
    expect(manifest.auth.tenantId).toBe(TENANT_ID);
    expect(manifest.tools[0].endpoint).toBe('https://publisher.example.com/quality-check');
  });

  it('returns schema-valid YAML for the partnerInitiated pre-draft-report template', async () => {
    const { status, body } = await generate({
      domain: 'radiologists',
      mode: 'template',
      template: 'pre-draft-report',
      tenantId: TENANT_ID,
    });

    expect(status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.manifest).toEqual({
      name: 'sampleRadiologyExtension',
      version: '0.0.1',
      toolCount: 1,
      capabilities: ['preDraftReportGeneration'],
    });

    const manifest = yaml.load(body.yaml) as ExtensionManifest;
    const tool = manifest.tools[0];
    expect(tool.toolType).toBe('partnerInitiated');
    expect(tool).not.toHaveProperty('endpoint');
    expect(tool).not.toHaveProperty('inputs');
    expect(tool.outputs[0]['content-type']).toBe('application/vnd.ms-dragon.rad.draft-report+json');
  });

  it('does not leak state between generations from the same template', async () => {
    const first = await generate({ mode: 'template', template: 'quality-check', tenantId: TENANT_ID });
    const second = await generate({
      mode: 'template',
      template: 'quality-check',
      tenantId: '00000000-0000-0000-0000-000000000002',
    });

    expect(yaml.load(first.body.yaml)).toEqual({
      ...(yaml.load(second.body.yaml) as ExtensionManifest),
      auth: { tenantId: TENANT_ID },
    });
  });

  it('rejects an unknown template and lists the valid ones', async () => {
    const { status, body } = await generate({ mode: 'template', template: 'not-a-template', tenantId: TENANT_ID });

    expect(status).toBe(400);
    expect(body.generated).toBe(false);
    expect(body.message).toContain('quality-check');
  });

  it('rejects inherited object keys as template names', async () => {
    for (const template of ['__proto__', 'constructor', 'toString']) {
      const { status, body } = await generate({ mode: 'template', template, tenantId: TENANT_ID });

      expect(status).toBe(400);
      expect(body.generated).toBe(false);
      expect(body.yaml).toBeUndefined();
      expect(body.message).toContain('quality-check');
    }
  });

  it('rejects a request with no template selected', async () => {
    const { status, body } = await generate({ mode: 'template', tenantId: TENANT_ID });

    expect(status).toBe(400);
    expect(body.message).toContain('template is required');
  });
});

describe('POST /api/cli/generate (custom mode)', () => {
  it('assembles inputs, outputs, and defaults from the wizard answers', async () => {
    const { status, body } = await generate(customRequest());

    expect(status).toBe(200);
    expect(body.valid).toBe(true);

    const manifest = yaml.load(body.yaml) as ExtensionManifest;
    expect(manifest.name).toBe('myRadiologistsExtension');
    expect(manifest.tools[0].toolType).toBe('contractBased');
    expect(manifest.tools[0].capability).toBe('qualityCheck');
    expect(manifest.tools[0].inputs!.map((input) => input.name)).toEqual(['report', 'patientInformation']);
    expect(manifest.tools[0].outputs[0]['content-type']).toBe(
      'application/vnd.ms-dragon.rad.quality-check-result+json',
    );
    // Left unset by the wizard, so the tool is always considered.
    expect(manifest.tools[0].relevanceFilteringCriteria).toBeUndefined();
  });

  it('omits endpoint and inputs for a partnerInitiated tool and defaults its capability and output', async () => {
    const { status, body } = await generate(
      customRequest({ tool: { ...customRequest().tool, toolType: 'partnerInitiated' } }),
    );

    expect(status).toBe(200);
    expect(body.valid).toBe(true);

    const tool = (yaml.load(body.yaml) as ExtensionManifest).tools[0];
    expect(tool.toolType).toBe('partnerInitiated');
    expect(tool.capability).toBe('preDraftReportGeneration');
    expect(tool.endpoint).toBeUndefined();
    expect(tool.inputs).toBeUndefined();
    expect(tool.outputs[0]['content-type']).toBe('application/vnd.ms-dragon.rad.draft-report+json');
  });

  it('includes relevance filtering criteria when the user selects them', async () => {
    const { body } = await generate(
      customRequest({
        tool: {
          ...customRequest().tool,
          relevanceFilteringCriteria: { relevantBodyParts: ['CHEST'], relevantModalities: ['CT', 'MR'] },
        },
      }),
    );

    const manifest = yaml.load(body.yaml) as ExtensionManifest;
    expect(manifest.tools[0].relevanceFilteringCriteria).toEqual({
      relevantBodyParts: ['CHEST'],
      relevantModalities: ['CT', 'MR'],
    });
  });

  it('omits relevance filtering criteria when nothing was selected', async () => {
    const { body } = await generate(
      customRequest({
        tool: {
          ...customRequest().tool,
          relevanceFilteringCriteria: { relevantBodyParts: [], relevantModalities: [] },
        },
      }),
    );

    expect(body.yaml).not.toContain('relevanceFilteringCriteria');
  });

  it('reports schema violations against the generated YAML instead of returning a broken manifest', async () => {
    const { status, body } = await generate(
      customRequest({ extension: { ...customRequest().extension, name: 'not-camel-case' } }),
    );

    expect(status).toBe(422);
    expect(body.generated).toBe(true);
    expect(body.valid).toBe(false);
    // The YAML still comes back so the editor can show the problem in context.
    expect(body.yaml).toContain('not-camel-case');
    const nameError = body.errors.find((error: { path: string }) => error.path === '/name');
    expect(nameError).toBeDefined();
    expect(nameError.line).toBe(1);
    expect(nameError.hint).toContain('camelCase');
  });

  it('reports an unselected input type as a schema error', async () => {
    const { status, body } = await generate(
      customRequest({ tool: { ...customRequest().tool, inputTypes: [] } }),
    );

    expect(status).toBe(422);
    expect(body.errors.some((error: { path: string }) => error.path === '/tools/0/inputs')).toBe(true);
  });

  it('rejects a request with no tenant ID', async () => {
    const { status, body } = await generate(customRequest({ tenantId: '' }));

    expect(status).toBe(400);
    expect(body.generated).toBe(false);
    expect(body.message).toContain('tenant ID is required');
  });

  it('rejects a request with no tool', async () => {
    const { status, body } = await generate({ mode: 'custom', tenantId: TENANT_ID });

    expect(status).toBe(400);
    expect(body.message).toContain('tool definition is required');
  });

  it('rejects a request with no outputs', async () => {
    const { status, body } = await generate(
      customRequest({ tool: { ...customRequest().tool, outputs: [] } }),
    );

    expect(status).toBe(400);
    expect(body.message).toContain('output is required');
  });

  it('falls back to the CLI defaults for fields the caller left blank', async () => {
    const { status, body } = await generate(
      customRequest({
        extension: { name: 'myRadiologistsExtension', description: '', version: '', radiologistsExtensibilityApiVersion: '' },
        tool: { ...customRequest().tool, outputs: [{ name: 'qualityCheckResult', description: 'Quality check result', schemaVersion: '' }] },
      }),
    );

    expect(status).toBe(200);
    expect(body.valid).toBe(true);

    // A blank field means "not supplied", exactly as submitting an empty CLI
    // prompt accepts the offered default.
    const manifest = yaml.load(body.yaml) as ExtensionManifest;
    expect(manifest.description).toBe('A Dragon Copilot radiologists extension');
    expect(manifest.version).toBe('0.0.1');
    expect(manifest.radiologistsExtensibilityApiVersion).toBe('1.0.0');
    expect(manifest.tools[0].outputs[0].schemaVersion).toBe('1.0');
  });

  it('rejects a malformed output entry without leaking an internal error', async () => {
    const { status, body } = await generate(
      customRequest({ tool: { ...customRequest().tool, outputs: [null] } }),
    );

    expect(status).toBe(400);
    expect(body.generated).toBe(false);
    expect(body.message).toContain('Each output must be an object');
    // A TypeError message here would mean an internal fault was reported as a
    // client error with implementation detail attached.
    expect(body.message).not.toContain('Cannot read properties');
  });

  it.each([
    ['toolType', "Unknown toolType 'bogus' for the tool. Expected one of: contractBased, partnerInitiated."],
    ['capability', "Unknown capability 'bogus' for the tool. Expected one of: qualityCheck, preDraftReportGeneration."],
  ])('rejects an unknown %s rather than passing it to the manifest core', async (field, message) => {
    const { status, body } = await generate(customRequest({ tool: { ...customRequest().tool, [field]: 'bogus' } }));

    expect(status).toBe(400);
    expect(body.generated).toBe(false);
    expect(body.yaml).toBeUndefined();
    expect(body.message).toBe(message);
  });
});

describe('POST /api/cli/generate (unsupported domain)', () => {
  it('rejects domains the sandbox cannot validate', async () => {
    const { status, body } = await generate({ domain: 'physician', mode: 'template', template: 'quality-check' });

    expect(status).toBe(400);
    expect(body.message).toContain('radiologists');
  });
});

describe('POST /api/cli/generate (mode)', () => {
  it('defaults to template mode when the mode is omitted', async () => {
    const { status, body } = await generate({ template: 'quality-check', tenantId: TENANT_ID });

    expect(status).toBe(200);
    expect(body.valid).toBe(true);
  });

  it.each([['custon'], [99]])('rejects the unsupported mode %j', async (mode) => {
    const { status, body } = await generate({ mode, template: 'quality-check', tenantId: TENANT_ID });

    expect(status).toBe(400);
    expect(body.generated).toBe(false);
    expect(body.yaml).toBeUndefined();
    expect(body.message).toBe('mode must be "template" or "custom".');
  });
});

function partnerInitiatedTool(overrides: Record<string, unknown> = {}) {
  return {
    name: 'myDraftReportTool',
    description: 'Generates a draft radiology report',
    toolType: 'partnerInitiated',
    outputs: [{ name: 'preDraftReportResult', description: 'Draft radiology report', schemaVersion: '1.0' }],
    ...overrides,
  };
}

function multiToolRequest(tools: unknown) {
  const request: Record<string, unknown> = customRequest();
  delete request.tool;
  return { ...request, tools };
}

describe('POST /api/cli/generate (custom mode, tools[])', () => {
  it('generates a schema-valid manifest that mixes Contract Based and Partner Initiated tools', async () => {
    const { status, body } = await generate(multiToolRequest([customRequest().tool, partnerInitiatedTool()]));

    expect(status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.manifest.toolCount).toBe(2);

    const [contractBased, partnerInitiated] = (yaml.load(body.yaml) as ExtensionManifest).tools;
    expect(contractBased).toMatchObject({ toolType: 'contractBased', capability: 'qualityCheck' });
    expect(contractBased.endpoint).toBe('https://api.example.com/radiologists/v1/process');
    expect(partnerInitiated).toMatchObject({ toolType: 'partnerInitiated', capability: 'preDraftReportGeneration' });
    expect(partnerInitiated.endpoint).toBeUndefined();
    expect(partnerInitiated.inputs).toBeUndefined();
    expect(partnerInitiated.outputs[0]['content-type']).toBe('application/vnd.ms-dragon.rad.draft-report+json');
  });

  it('accepts a Partner Initiated tool sent without an endpoint or input types', async () => {
    const { status, body } = await generate(multiToolRequest([partnerInitiatedTool()]));

    expect(status).toBe(200);
    expect(body.valid).toBe(true);
  });

  it('rejects duplicate tool names', async () => {
    const { status, body } = await generate(
      multiToolRequest([customRequest().tool, partnerInitiatedTool({ name: 'myRadiologistsTool' })]),
    );

    expect(status).toBe(400);
    expect(body.generated).toBe(false);
    expect(body.message).toContain("'myRadiologistsTool' is used more than once");
  });

  it('rejects a request that sends both tool and tools', async () => {
    const { status, body } = await generate({ ...customRequest(), tools: [partnerInitiatedTool()] });

    expect(status).toBe(400);
    expect(body.message).toBe('Provide either "tool" or "tools", not both.');
  });

  it.each([[[]], ['not-an-array']])('rejects tools set to %j', async (tools) => {
    const { status, body } = await generate(multiToolRequest(tools));

    expect(status).toBe(400);
    expect(body.message).toContain('tool definition is required');
  });

  it('rejects a tools entry that is not an object', async () => {
    const { status, body } = await generate(multiToolRequest([customRequest().tool, null]));

    expect(status).toBe(400);
    expect(body.message).toContain('Each tool must be an object');
  });

  it('names the tool whose outputs are missing', async () => {
    const { status, body } = await generate(
      multiToolRequest([customRequest().tool, partnerInitiatedTool({ outputs: [] })]),
    );

    expect(status).toBe(400);
    expect(body.message).toBe('At least one output is required for tool 2.');
  });

  it.each([['toolType'], ['capability']])('names the tool whose %s is unknown', async (field) => {
    const { status, body } = await generate(
      multiToolRequest([customRequest().tool, partnerInitiatedTool({ [field]: 'bogus' })]),
    );

    expect(status).toBe(400);
    expect(body.generated).toBe(false);
    expect(body.message).toContain(`Unknown ${field} 'bogus' for tool 2.`);
  });
});

// Pinned from the generator before multi-tool support was added: the wizard's
// existing Quality Check output must not change.
const CUSTOM_CONTRACT_BASED_YAML = [
  'name: myRadiologistsExtension',
  'description: A Dragon Copilot radiologists extension',
  'version: 0.0.1',
  'radiologistsExtensibilityApiVersion: 1.0.0',
  'auth:',
  `  tenantId: ${TENANT_ID}`,
  'tools:',
  '  - name: myRadiologistsTool',
  '    toolType: contractBased',
  '    capability: qualityCheck',
  '    description: Processes radiology reports and imaging data',
  '    endpoint: https://api.example.com/radiologists/v1/process',
  '    inputs:',
  '      - name: report',
  '        description: Radiology report from Dragon Copilot',
  `        content-type: ${REPORT_CONTENT_TYPE}`,
  "        schemaVersion: '1.0'",
  '      - name: patientInformation',
  '        description: Patient demographic information from Dragon Copilot',
  `        content-type: ${PATIENT_INFORMATION_CONTENT_TYPE}`,
  "        schemaVersion: '1.0'",
  '    outputs:',
  '      - name: qualityCheckResult',
  '        description: Quality check result',
  '        content-type: application/vnd.ms-dragon.rad.quality-check-result+json',
  "        schemaVersion: '1.0'",
  '',
].join('\n');

const QUALITY_CHECK_TEMPLATE_YAML = [
  'name: sampleQualityCheckExtension',
  'description: Extension to provide radiology report optimization',
  'version: 0.0.1',
  'radiologistsExtensibilityApiVersion: 1.0.0',
  'auth:',
  `  tenantId: ${TENANT_ID}`,
  'tools:',
  '  - name: sampleQualityCheckTool',
  '    toolType: contractBased',
  '    capability: qualityCheck',
  '    description: Tool to optimize a radiology report',
  '    endpoint: https://publisher.example.com/quality-check',
  '    inputs:',
  '      - name: report',
  '        description: Radiology report from Dragon Copilot',
  `        content-type: ${REPORT_CONTENT_TYPE}`,
  "        schemaVersion: '1.0'",
  '      - name: patientInformation',
  '        description: Patient demographic information from Dragon Copilot',
  `        content-type: ${PATIENT_INFORMATION_CONTENT_TYPE}`,
  "        schemaVersion: '1.0'",
  '    outputs:',
  '      - name: qualityCheckResult',
  '        description: Report optimization findings and score',
  '        content-type: application/vnd.ms-dragon.rad.quality-check-result+json',
  "        schemaVersion: '1.0'",
  '    relevanceFilteringCriteria:',
  '      relevantBodyParts:',
  '        - CHEST',
  '      relevantModalities:',
  '        - CT',
  '',
].join('\n');

const PRE_DRAFT_REPORT_TEMPLATE_YAML = [
  'name: sampleRadiologyExtension',
  'description: Extension to provide draft radiology report generation',
  'version: 0.0.1',
  'radiologistsExtensibilityApiVersion: 1.0.0',
  'auth:',
  `  tenantId: ${TENANT_ID}`,
  'tools:',
  '  - name: preDraftReportGeneratorTool',
  '    toolType: partnerInitiated',
  '    capability: preDraftReportGeneration',
  '    description: Tool to generate a draft radiology report',
  '    outputs:',
  '      - name: preDraftReportResult',
  '        description: Draft radiology report',
  '        content-type: application/vnd.ms-dragon.rad.draft-report+json',
  "        schemaVersion: '1.0'",
  '    relevanceFilteringCriteria:',
  '      relevantBodyParts:',
  '        - CHEST',
  '      relevantModalities:',
  '        - CT',
  '',
].join('\n');

describe('POST /api/cli/generate (unchanged output)', () => {
  it('generates byte-identical YAML for a single tool sent as tool or as tools[]', async () => {
    const legacy = await generate(customRequest());
    const list = await generate(multiToolRequest([customRequest().tool]));

    expect(legacy.status).toBe(200);
    expect(legacy.body.yaml).toBe(CUSTOM_CONTRACT_BASED_YAML);
    expect(list.body.yaml).toBe(CUSTOM_CONTRACT_BASED_YAML);
  });

  it.each([
    ['quality-check', QUALITY_CHECK_TEMPLATE_YAML],
    ['pre-draft-report', PRE_DRAFT_REPORT_TEMPLATE_YAML],
  ])('generates the %s template unchanged', async (template, expected) => {
    const { status, body } = await generate({ mode: 'template', template, tenantId: TENANT_ID });

    expect(status).toBe(200);
    expect(body.yaml).toBe(expected);
  });
});

describe('Generated manifest loaded into the editor', () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  it('validates a mixed manifest and exposes both capabilities for testing', async () => {
    const generated = await generate(multiToolRequest([customRequest().tool, partnerInitiatedTool()]));
    expect(generated.status).toBe(200);

    const validate = await fetch(`${baseUrl}/api/manifest/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: generated.body.yaml }),
    });
    const validation = await validate.json();
    expect(validate.status).toBe(200);
    expect(validation.valid).toBe(true);

    const capabilities = await (await fetch(`${baseUrl}/api/manifest/capabilities`)).json();
    expect(capabilities.map((capability: { name: string }) => capability.name).sort()).toEqual([
      'preDraftReportGeneration',
      'qualityCheck',
    ]);
  });

  it('accepts a generated Partner Initiated manifest through the upload route', async () => {
    const generated = await generate(multiToolRequest([partnerInitiatedTool()]));
    expect(generated.status).toBe(200);

    const form = new FormData();
    form.append('manifest', new Blob([generated.body.yaml], { type: 'application/x-yaml' }), 'manifest.yaml');
    const upload = await fetch(`${baseUrl}/api/manifest/upload`, { method: 'POST', body: form });
    expect(upload.status).toBe(200);
    expect((await upload.json()).valid).toBe(true);

    const capabilities = await (await fetch(`${baseUrl}/api/manifest/capabilities`)).json();
    expect(capabilities.map((capability: { name: string }) => capability.name)).toEqual(['preDraftReportGeneration']);
  });
});
