import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const schemaPath = resolve(__dirname, '..', 'schemas', 'extension-manifest.json');
const manifestJsonSchema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

const ajv = new Ajv({ allErrors: true, verbose: true });
addFormats(ajv);
const validate = ajv.compile(manifestJsonSchema);

describe('Manifest Schema Validation', () => {
  it('should validate the Python sample extension manifest as valid', () => {
    const manifestPath = resolve(
      __dirname,
      '..', '..', '..', '..', '..', // up to repo root
      'physician', 'src', 'samples', 'DragonCopilot', 'Workflow',
      'pythonSampleExtension', 'extension.yaml'
    );

    const fileContent = readFileSync(manifestPath, 'utf-8');
    const manifest = yaml.load(fileContent);

    const isValid = validate(manifest);

    if (!isValid) {
      console.error('Validation errors:', JSON.stringify(validate.errors, null, 2));
    }

    expect(isValid).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
