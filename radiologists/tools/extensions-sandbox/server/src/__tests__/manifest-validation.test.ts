import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import yaml from 'js-yaml';
import { MANIFEST_SCHEMA_PATH } from '../utils/schema-path.js';

const manifestJsonSchema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, 'utf-8'));

const ajv = new Ajv({ allErrors: true, verbose: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(manifestJsonSchema);

const fixturesDir = resolve(__dirname, 'fixtures');
const validManifestSimple = JSON.parse(readFileSync(resolve(fixturesDir, 'valid-manifest-simple.json'), 'utf-8'));
const validManifestFullFeatured = JSON.parse(readFileSync(resolve(fixturesDir, 'valid-manifest-full-featured.json'), 'utf-8'));
const validManifestPartnerInitiated = JSON.parse(readFileSync(resolve(fixturesDir, 'valid-manifest-partner-initiated.json'), 'utf-8'));

function buildPartnerInitiatedManifest() {
  return structuredClone(validManifestPartnerInitiated);
}
const validManifestMixedToolTypes = JSON.parse(
  readFileSync(resolve(fixturesDir, 'valid-manifest-mixed-tool-types.json'), 'utf-8'),
);

// server/src/__tests__ -> radiologists/
const RADIOLOGISTS_DIR = resolve(__dirname, '..', '..', '..', '..', '..');

describe('Manifest Schema Validation', () => {
  it('accepts a partnerInitiated tool without an endpoint or inputs', () => {
    expect(validate(buildPartnerInitiatedManifest())).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('accepts contractBased and partnerInitiated tools in the same manifest', () => {
    const manifest = buildPartnerInitiatedManifest();
    manifest.tools.push(...validManifestSimple.tools);
    expect(validate(manifest)).toBe(true);
  });

  it.each(['endpoint', 'inputs'])('still requires %s for contractBased tools', (field) => {
    const manifest = structuredClone(validManifestSimple);
    delete manifest.tools[0][field];
    expect(validate(manifest)).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: 'required', params: { missingProperty: field } }),
    ]));
  });

  it.each(['toolType', 'capability', 'outputs'])('requires %s for partnerInitiated tools', (field) => {
    const manifest = buildPartnerInitiatedManifest();
    delete manifest.tools[0][field];
    expect(validate(manifest)).toBe(false);
  });

  it('rejects an empty partnerInitiated output list', () => {
    const manifest = buildPartnerInitiatedManifest();
    manifest.tools[0].outputs = [];
    expect(validate(manifest)).toBe(false);
  });

  it('rejects qualityCheck capability for partnerInitiated tools', () => {
    const manifest = buildPartnerInitiatedManifest();
    manifest.tools[0].capability = 'qualityCheck';
    expect(validate(manifest)).toBe(false);
  });

  it('rejects quality-check output for partnerInitiated tools', () => {
    const manifest = buildPartnerInitiatedManifest();
    manifest.tools[0].outputs[0]['content-type'] = 'application/vnd.ms-dragon.rad.quality-check-result+json';
    expect(validate(manifest)).toBe(false);
  });

  it('rejects pre-draft capability and output for contractBased tools', () => {
    const manifest = buildPartnerInitiatedManifest();
    manifest.tools[0] = { ...validManifestSimple.tools[0], ...manifest.tools[0], toolType: 'contractBased' };
    expect(validate(manifest)).toBe(false);
  });

  it('keeps the pre-draft ingest request out of manifest inputs', () => {
    const manifest = structuredClone(validManifestSimple);
    manifest.tools[0].inputs[0]['content-type'] = 'application/vnd.ms-dragon.rad.pre-draft-report-ingest-request+json';
    expect(validate(manifest)).toBe(false);
  });

  it('should validate a conforming radiology extension manifest as valid', () => {
    const isValid = validate(validManifestSimple);

    if (!isValid) {
      console.error('Validation errors:', JSON.stringify(validate.errors, null, 2));
    }

    expect(isValid).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('should reject a manifest missing required tool fields', () => {
    const manifest = {
      name: 'bad-extension',
      description: 'Missing toolType and capability',
      version: '1.0.0',
      auth: {
        tenantId: '12345678-1234-1234-1234-123456789abc',
      },
      tools: [
        {
          name: 'incomplete-tool',
          description: 'Tool without toolType/capability',
          endpoint: 'https://api.example.com/v1/process',
          inputs: [
            {
              name: 'report',
              description: 'Report input',
              'content-type': 'application/vnd.ms-dragon.rad.report+json',
            },
          ],
          outputs: [
            {
              name: 'result',
              description: 'Result output',
              'content-type': 'application/vnd.ms-dragon.rad.quality-check-result+json',
            },
          ],
        },
      ],
    };

    const isValid = validate(manifest);
    expect(isValid).toBe(false);
    expect(validate.errors).not.toBeNull();
    // Verify errors reference the missing fields
    const errorMessages = validate.errors!.map((e) => e.params);
    expect(errorMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ missingProperty: 'toolType' }),
        expect.objectContaining({ missingProperty: 'capability' }),
      ]),
    );
  });

  it('should reject an invalid content-type', () => {
    const manifest = {
      name: 'bad-content-type',
      description: 'Uses invalid content-type',
      version: '1.0.0',
      auth: {
        tenantId: '12345678-1234-1234-1234-123456789abc',
      },
      tools: [
        {
          name: 'bad-tool',
          toolType: 'contractBased',
          capability: 'qualityCheck',
          description: 'Tool with bad content-type',
          endpoint: 'https://api.example.com/v1/process',
          inputs: [
            {
              name: 'note',
              description: 'Note input',
              'content-type': 'application/vnd.ms-dragon.dsp.note+json',
            },
          ],
          outputs: [
            {
              name: 'result',
              description: 'Result',
              'content-type': 'application/vnd.ms-dragon.rad.quality-check-result+json',
            },
          ],
        },
      ],
    };

    const isValid = validate(manifest);
    expect(isValid).toBe(false);
  });

  it('should validate optional fields like configurationTemplate and input config', () => {
    const isValid = validate(validManifestFullFeatured);

    if (!isValid) {
      console.error('Validation errors:', JSON.stringify(validate.errors, null, 2));
    }

    expect(isValid).toBe(true);
    expect(validate.errors).toBeNull();
  });

  describe('partnerInitiated tools', () => {
    function partnerInitiatedManifest(toolOverrides: Record<string, unknown> = {}) {
      return {
        name: 'partnerInitiatedExtension',
        description: 'Submits pre-draft reports to Dragon Copilot',
        version: '1.0.0',
        radiologistsExtensibilityApiVersion: '0.1.0',
        auth: { tenantId: '12345678-1234-1234-1234-123456789abc' },
        tools: [
          {
            name: 'preDraftTool',
            toolType: 'partnerInitiated',
            capability: 'preDraftReportGeneration',
            description: 'Generates a draft report before the radiologist opens the study',
            outputs: [
              {
                name: 'draftReport',
                description: 'Draft report',
                'content-type': 'application/vnd.ms-dragon.rad.draft-report+json',
                schemaVersion: '1.0',
              },
            ],
            ...toolOverrides,
          },
        ],
      };
    }

    it('accepts a partnerInitiated tool without endpoint or inputs', () => {
      const isValid = validate(partnerInitiatedManifest());

      if (!isValid) {
        console.error('Validation errors:', JSON.stringify(validate.errors, null, 2));
      }

      expect(isValid).toBe(true);
    });

    it('rejects a partnerInitiated tool paired with the qualityCheck capability', () => {
      expect(validate(partnerInitiatedManifest({ capability: 'qualityCheck' }))).toBe(false);
      expect(validate.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            instancePath: '/tools/0/capability',
            keyword: 'const',
            params: { allowedValue: 'preDraftReportGeneration' },
          }),
        ]),
      );
    });

    it('rejects a contractBased tool paired with the preDraftReportGeneration capability', () => {
      const isValid = validate(
        partnerInitiatedManifest({
          toolType: 'contractBased',
          capability: 'preDraftReportGeneration',
          endpoint: 'https://api.example.com/v1/process',
          inputs: [
            {
              name: 'report',
              description: 'Report input',
              'content-type': 'application/vnd.ms-dragon.rad.report+json',
              schemaVersion: '1.0',
            },
          ],
        }),
      );

      expect(isValid).toBe(false);
      expect(validate.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            instancePath: '/tools/0/capability',
            keyword: 'const',
            params: { allowedValue: 'qualityCheck' },
          }),
        ]),
      );
    });

    it.each([
      ['endpoint', 'https://api.example.com/v1/process'],
      [
        'inputs',
        [
          {
            name: 'report',
            description: 'Report input',
            'content-type': 'application/vnd.ms-dragon.rad.report+json',
            schemaVersion: '1.0',
          },
        ],
      ],
    ])('rejects a partnerInitiated tool that declares %s', (property, value) => {
      expect(validate(partnerInitiatedManifest({ [property]: value }))).toBe(false);
      expect(validate.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ instancePath: `/tools/0/${property}`, keyword: 'false schema' }),
        ]),
      );
    });

    it('still requires endpoint and inputs on a contractBased tool', () => {
      const isValid = validate(
        partnerInitiatedManifest({
          toolType: 'contractBased',
          capability: 'qualityCheck',
          outputs: [
            {
              name: 'result',
              description: 'Result',
              'content-type': 'application/vnd.ms-dragon.rad.quality-check-result+json',
              schemaVersion: '1.0',
            },
          ],
        }),
      );

      expect(isValid).toBe(false);
      expect(validate.errors!.map((e) => e.params)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ missingProperty: 'endpoint' }),
          expect.objectContaining({ missingProperty: 'inputs' }),
        ]),
      );
    });

    it.each([
      ['endpoint', { inputs: [{ name: 'report', description: 'Report input', 'content-type': 'application/vnd.ms-dragon.rad.report+json', schemaVersion: '1.0' }] }],
      ['inputs', { endpoint: 'https://api.example.com/v1/process' }],
    ])('requires %s on a contractBased tool even when the other is present', (missing, present) => {
      const isValid = validate(
        partnerInitiatedManifest({
          toolType: 'contractBased',
          capability: 'qualityCheck',
          ...present,
          outputs: [
            {
              name: 'result',
              description: 'Result',
              'content-type': 'application/vnd.ms-dragon.rad.quality-check-result+json',
              schemaVersion: '1.0',
            },
          ],
        }),
      );

      expect(isValid).toBe(false);
      const missingProperties = validate.errors!
        .filter((e) => e.keyword === 'required')
        .map((e) => (e.params as { missingProperty: string }).missingProperty);
      expect(missingProperties).toEqual([missing]);
    });
  });

  describe('AI Draft sample fixtures', () => {
    const fixtures = [
      {
        fixture: 'valid-manifest-partner-initiated.json',
        manifest: validManifestPartnerInitiated,
        source: resolve(RADIOLOGISTS_DIR, 'src', 'samples', 'PartnerInitiated', 'extension.yaml'),
      },
      {
        fixture: 'valid-manifest-mixed-tool-types.json',
        manifest: validManifestMixedToolTypes,
        source: resolve(RADIOLOGISTS_DIR, 'manifest', 'extension.yaml'),
      },
    ];

    it.each(fixtures)('validates $fixture against the manifest schema', ({ manifest }) => {
      const isValid = validate(manifest);

      if (!isValid) {
        console.error('Validation errors:', JSON.stringify(validate.errors, null, 2));
      }

      expect(isValid).toBe(true);
      expect(validate.errors).toBeNull();
    });

    it.each(fixtures)('keeps $fixture in step with the sample manifest it is derived from', ({ manifest, source }) => {
      expect(manifest).toEqual(yaml.load(readFileSync(source, 'utf-8')));
    });

    it('declares a single partnerInitiated preDraftReportGeneration tool with no endpoint or inputs keys', () => {
      expect(validManifestPartnerInitiated.tools).toHaveLength(1);
      const [tool] = validManifestPartnerInitiated.tools;

      expect(tool).toMatchObject({ toolType: 'partnerInitiated', capability: 'preDraftReportGeneration' });
      expect(Object.keys(tool)).not.toContain('endpoint');
      expect(Object.keys(tool)).not.toContain('inputs');
      expect(tool.outputs.map((output: Record<string, string>) => output['content-type'])).toEqual([
        'application/vnd.ms-dragon.rad.draft-report+json',
      ]);
    });

    it('declares both a contractBased and a partnerInitiated tool in the mixed fixture', () => {
      const tools = validManifestMixedToolTypes.tools as Array<Record<string, unknown>>;

      expect(tools.map(({ name, toolType, capability }) => ({ name, toolType, capability }))).toEqual([
        { name: 'sampleQualityCheckTool', toolType: 'contractBased', capability: 'qualityCheck' },
        { name: 'preDraftReportGeneratorTool', toolType: 'partnerInitiated', capability: 'preDraftReportGeneration' },
      ]);

      const [contractBased, partnerInitiated] = tools;
      expect(Object.keys(contractBased)).toEqual(expect.arrayContaining(['endpoint', 'inputs']));
      expect(Object.keys(partnerInitiated)).not.toContain('endpoint');
      expect(Object.keys(partnerInitiated)).not.toContain('inputs');
    });
  });
});
