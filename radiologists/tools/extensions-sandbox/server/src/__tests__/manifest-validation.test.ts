import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { MANIFEST_SCHEMA_PATH } from '../utils/schema-path.js';

const manifestJsonSchema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, 'utf-8'));

const ajv = new Ajv({ allErrors: true, verbose: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(manifestJsonSchema);

const fixturesDir = resolve(__dirname, 'fixtures');
const validManifestSimple = JSON.parse(readFileSync(resolve(fixturesDir, 'valid-manifest-simple.json'), 'utf-8'));
const validManifestFullFeatured = JSON.parse(readFileSync(resolve(fixturesDir, 'valid-manifest-full-featured.json'), 'utf-8'));

describe('Manifest Schema Validation', () => {
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
});
