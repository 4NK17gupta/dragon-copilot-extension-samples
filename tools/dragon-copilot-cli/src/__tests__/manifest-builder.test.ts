import { describe, expect, it } from '@jest/globals';
import { load } from 'js-yaml';
import {
  DEFAULT_OUTPUT_CONTENT_TYPE,
  DEFAULT_PAYLOAD_SCHEMA_VERSION,
  DRAFT_REPORT_CONTENT_TYPE,
  DRAFT_REPORT_OUTPUT_DEFAULTS,
  MANIFEST_DEFAULTS,
  OUTPUT_DEFAULTS_BY_TOOL_TYPE,
  PATIENT_INFORMATION_CONTENT_TYPE,
  REPORT_CONTENT_TYPE,
  buildManifest,
  buildManifestFromTemplate,
  buildTool,
  getTemplate,
  listTemplateSummaries,
  listTemplates,
  normalizeRelevanceFilteringCriteria,
  renderManifestYaml,
} from '../domains/radiologists/manifest/index.js';
import { validateDcrExtensionManifest } from '../shared/schema-validator.js';
import type { DcrExtensionManifest } from '../domains/radiologists/types.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

/**
 * The manifest core is shared verbatim with the Extensions Sandbox server, which
 * generates manifests from form input rather than prompts. These tests pin the
 * behaviour both surfaces depend on: schema-valid output, defaults applied, and
 * templates handed out as copies.
 */
describe('radiologists manifest builder', () => {
  it('builds a schema-valid manifest from collected answers', () => {
    const manifest = buildManifest({
      extension: {
        name: 'myRadiologistsExtension',
        description: 'A Dragon Copilot radiologists extension',
        version: '0.0.1',
        radiologistsExtensibilityApiVersion: '1.0.0',
      },
      auth: { tenantId: TENANT_ID },
      tools: [
        {
          name: 'myRadiologistsTool',
          description: 'Processes radiology reports',
          endpoint: 'https://api.example.com/radiologists/v1/process',
          inputTypes: [REPORT_CONTENT_TYPE, PATIENT_INFORMATION_CONTENT_TYPE],
          outputs: [{ name: 'qualityCheckResult', description: 'Quality check result' }],
        },
      ],
    });

    const result = validateDcrExtensionManifest(manifest);
    expect(result.errors).toHaveLength(0);
    expect(result.isValid).toBe(true);
  });

  it('derives input names, descriptions, and schema versions from content types', () => {
    const tool = buildTool({
      name: 'myRadiologistsTool',
      description: 'Processes radiology reports',
      endpoint: 'https://api.example.com/radiologists/v1/process',
      inputTypes: [REPORT_CONTENT_TYPE, PATIENT_INFORMATION_CONTENT_TYPE],
      outputs: [{ name: 'qualityCheckResult', description: 'Quality check result' }],
    });

    expect(tool.inputs).toEqual([
      {
        name: 'report',
        description: 'Radiology report from Dragon Copilot',
        'content-type': REPORT_CONTENT_TYPE,
        schemaVersion: DEFAULT_PAYLOAD_SCHEMA_VERSION,
      },
      {
        name: 'patientInformation',
        description: 'Patient demographic information from Dragon Copilot',
        'content-type': PATIENT_INFORMATION_CONTENT_TYPE,
        schemaVersion: DEFAULT_PAYLOAD_SCHEMA_VERSION,
      },
    ]);
  });

  it('applies tool type, capability, and output defaults', () => {
    const tool = buildTool({
      name: 'myRadiologistsTool',
      description: 'Processes radiology reports',
      endpoint: 'https://api.example.com/radiologists/v1/process',
      inputTypes: [REPORT_CONTENT_TYPE],
      outputs: [{ name: 'qualityCheckResult', description: 'Quality check result' }],
    });

    expect(tool.toolType).toBe('contractBased');
    expect(tool.capability).toBe('qualityCheck');
    expect(tool.outputs[0]).toEqual({
      name: 'qualityCheckResult',
      description: 'Quality check result',
      'content-type': DEFAULT_OUTPUT_CONTENT_TYPE,
      schemaVersion: DEFAULT_PAYLOAD_SCHEMA_VERSION,
    });
  });

  it('omits endpoint and inputs for partnerInitiated tools and defaults their capability and output', () => {
    const tool = buildTool({
      name: 'draftReportGenerator',
      description: 'Submits draft reports',
      toolType: 'partnerInitiated',
      endpoint: 'https://api.example.com/ignored',
      inputTypes: [REPORT_CONTENT_TYPE],
      outputs: [{ name: 'draftReport', description: 'Draft radiology report' }],
    });

    expect(tool).not.toHaveProperty('endpoint');
    expect(tool).not.toHaveProperty('inputs');
    expect(tool.capability).toBe('preDraftReportGeneration');
    expect(tool.outputs[0]?.['content-type']).toBe(DRAFT_REPORT_CONTENT_TYPE);

    const result = validateDcrExtensionManifest(
      buildManifest({
        extension: {
          name: 'myRadiologistsExtension',
          description: 'A Dragon Copilot radiologists extension',
          version: '0.0.1',
          radiologistsExtensibilityApiVersion: '1.0.0',
        },
        auth: { tenantId: TENANT_ID },
        tools: [
          {
            name: 'draftReportGenerator',
            description: 'Submits draft reports',
            toolType: 'partnerInitiated',
            outputs: [{ name: 'draftReport', description: 'Draft radiology report' }],
          },
        ],
      }),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.isValid).toBe(true);
  });

  it.each([
    ['endpoint', { inputTypes: [REPORT_CONTENT_TYPE] }],
    ['input types', { endpoint: 'https://api.example.com/radiologists/v1/process' }],
  ])('rejects a contractBased tool with no %s instead of inventing one', (_missing, fields) => {
    expect(() =>
      buildTool({
        name: 'myRadiologistsTool',
        description: 'Processes radiology reports',
        toolType: 'contractBased',
        outputs: [{ name: 'qualityCheckResult', description: 'Quality check result' }],
        ...fields,
      }),
    ).toThrow("contractBased tool 'myRadiologistsTool' requires an endpoint and input types.");
  });

  it('passes an empty endpoint and input list through for schema validation to report', () => {
    const tool = buildTool({
      name: 'myRadiologistsTool',
      description: 'Processes radiology reports',
      endpoint: '',
      inputTypes: [],
      outputs: [{ name: 'qualityCheckResult', description: 'Quality check result' }],
    });

    expect(tool.endpoint).toBe('');
    expect(tool.inputs).toEqual([]);
  });

  it('keeps relevance filtering criteria when supplied and omits it when empty', () => {
    const filtered = buildTool({
      name: 'myRadiologistsTool',
      description: 'Processes radiology reports',
      endpoint: 'https://api.example.com/radiologists/v1/process',
      inputTypes: [REPORT_CONTENT_TYPE],
      outputs: [{ name: 'qualityCheckResult', description: 'Quality check result' }],
      relevanceFilteringCriteria: { relevantBodyParts: ['CHEST'], relevantModalities: [] },
    });

    expect(filtered.relevanceFilteringCriteria).toEqual({ relevantBodyParts: ['CHEST'] });

    const unfiltered = buildTool({
      name: 'myRadiologistsTool',
      description: 'Processes radiology reports',
      endpoint: 'https://api.example.com/radiologists/v1/process',
      inputTypes: [REPORT_CONTENT_TYPE],
      outputs: [{ name: 'qualityCheckResult', description: 'Quality check result' }],
      relevanceFilteringCriteria: { relevantBodyParts: [], relevantModalities: [] },
    });

    expect('relevanceFilteringCriteria' in unfiltered).toBe(false);
    expect(normalizeRelevanceFilteringCriteria(null)).toBeUndefined();
  });

  it('builds a schema-valid manifest from the quality-check template', () => {
    const manifest = buildManifestFromTemplate('quality-check', { tenantId: TENANT_ID });

    expect(manifest.name).toBe('sampleQualityCheckExtension');
    expect(manifest.auth.tenantId).toBe(TENANT_ID);
    expect(validateDcrExtensionManifest(manifest).isValid).toBe(true);
  });

  it('hands out template copies so generated manifests cannot mutate the registry', () => {
    const first = buildManifestFromTemplate('quality-check', { tenantId: TENANT_ID });
    first.tools[0]!.name = 'mutatedToolName';
    first.tools[0]!.relevanceFilteringCriteria!.relevantBodyParts!.push('ABDOMEN');

    const second = buildManifestFromTemplate('quality-check', { tenantId: TENANT_ID });

    expect(second.tools[0]!.name).toBe('sampleQualityCheckTool');
    expect(second.tools[0]!.relevanceFilteringCriteria!.relevantBodyParts).toEqual(['CHEST']);
    expect(getTemplate('quality-check').tools[0]!.name).toBe('sampleQualityCheckTool');
  });

  it('reports unknown templates with the available names', () => {
    expect(() => buildManifestFromTemplate('does-not-exist', { tenantId: TENANT_ID })).toThrow(
      /Available templates: quality-check/,
    );
  });

  it('treats inherited object keys as unknown template names', () => {
    // Template names reach `getTemplate` from a request body in the Extensions
    // Sandbox, so a bare property lookup would let '__proto__' or 'constructor'
    // resolve to something that is not a template.
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(() => getTemplate(name)).toThrow(/Available templates: quality-check/);
      expect(() => buildManifestFromTemplate(name, { tenantId: TENANT_ID })).toThrow(
        /Available templates: quality-check/,
      );
    }
  });

  it('summarizes templates for selection UIs', () => {
    expect(listTemplates()).toEqual(['quality-check', 'pre-draft-report']);
    expect(listTemplateSummaries()).toEqual([
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
    ]);
  });

  it('builds a schema-valid partnerInitiated manifest from the pre-draft-report template', () => {
    const manifest = buildManifestFromTemplate('pre-draft-report', { tenantId: TENANT_ID });
    const tool = manifest.tools[0]!;

    expect(tool.toolType).toBe('partnerInitiated');
    expect(tool.capability).toBe('preDraftReportGeneration');
    expect(tool).not.toHaveProperty('endpoint');
    expect(tool).not.toHaveProperty('inputs');
    expect(tool.outputs).toEqual([
      {
        name: 'preDraftReportResult',
        description: 'Draft radiology report',
        'content-type': DRAFT_REPORT_CONTENT_TYPE,
        schemaVersion: DEFAULT_PAYLOAD_SCHEMA_VERSION,
      },
    ]);

    const result = validateDcrExtensionManifest(manifest);
    expect(result.errors).toHaveLength(0);
    expect(result.isValid).toBe(true);
  });

  it('renders YAML that round-trips back to the same manifest', () => {
    const manifest = buildManifestFromTemplate('quality-check', { tenantId: TENANT_ID });

    const rendered = renderManifestYaml(manifest);

    expect(rendered).toContain('name: sampleQualityCheckExtension');
    expect(load(rendered) as DcrExtensionManifest).toEqual(manifest);
  });

  it('exposes the defaults the CLI prompts and the sandbox wizard pre-fill', () => {
    expect(MANIFEST_DEFAULTS.extensionName).toBe('myRadiologistsExtension');
    expect(MANIFEST_DEFAULTS.radiologistsExtensibilityApiVersion).toBe('1.0.0');
    expect(MANIFEST_DEFAULTS.schemaVersion).toBe(DEFAULT_PAYLOAD_SCHEMA_VERSION);
  });

  it('offers output defaults per tool type that match the built-in templates', () => {
    expect(OUTPUT_DEFAULTS_BY_TOOL_TYPE).toEqual({
      contractBased: { name: MANIFEST_DEFAULTS.outputName, description: MANIFEST_DEFAULTS.outputDescription },
      partnerInitiated: DRAFT_REPORT_OUTPUT_DEFAULTS,
    });

    const draftOutput = getTemplate('pre-draft-report').tools[0]!.outputs[0]!;
    expect({ name: draftOutput.name, description: draftOutput.description }).toEqual(DRAFT_REPORT_OUTPUT_DEFAULTS);
  });
});
