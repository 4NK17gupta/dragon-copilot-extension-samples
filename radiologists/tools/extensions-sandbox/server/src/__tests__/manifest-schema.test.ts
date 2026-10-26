import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { MAX_MANIFEST_VALUES, validateManifestDocument } from '../services/manifest-schema.js';

const fixturesDir = resolve(__dirname, 'fixtures');
const validManifestText = readFileSync(resolve(fixturesDir, 'valid-manifest-full-featured.json'), 'utf-8');

/** A few KB of YAML whose aliases expand to tools × inputs values once parsed. */
function aliasAmplifiedYaml(tools: number, inputs: number): string {
  const inputRefs = Array(inputs).fill('*input').join(', ');
  const toolRefs = Array(tools).fill('*tool').join(', ');
  return [
    'x-input: &input { name: in, description: d, content-type: not-a-content-type }',
    'x-tool: &tool',
    '  name: t',
    '  description: d',
    '  endpoint: https://api.example.com/v1/process',
    '  toolType: contractBased',
    '  capability: qualityCheck',
    `  inputs: [${inputRefs}]`,
    '  outputs: []',
    'name: amplified',
    'description: d',
    'version: 1.0.0',
    'auth: { tenantId: 12345678-1234-1234-1234-123456789abc }',
    `tools: [${toolRefs}]`,
  ].join('\n');
}

describe('validateManifestDocument value limit', () => {
  it('validates a normal manifest', () => {
    const result = validateManifestDocument(JSON.parse(validManifestText), validManifestText);

    expect(result.valid).toBe(true);
  });

  it('reports schema errors, not the size error, for a small invalid manifest', () => {
    const text = '{ "name": "Bad Name" }';
    const result = validateManifestDocument(JSON.parse(text), text);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.length).toBeGreaterThan(1);
    expect(result.errors.some((e) => e.message.includes('exceeds'))).toBe(false);
  });

  it('rejects a YAML manifest whose aliases expand past the limit without running the schema', () => {
    const text = aliasAmplifiedYaml(200, 200);
    expect(text.length).toBeLessThan(4096);

    const result = validateManifestDocument(yaml.load(text), text);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      path: '/',
      line: null,
      message: `/: manifest exceeds ${MAX_MANIFEST_VALUES} values`,
      severity: 'error',
    });
  });

  it('terminates on a cyclic object', () => {
    const cyclic: Record<string, unknown> = { name: 'cyclic' };
    cyclic.self = cyclic;

    const result = validateManifestDocument(cyclic, '');

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('exceeds');
  });
});

describe('validateManifestDocument tool name uniqueness', () => {
  const mixedText = readFileSync(resolve(fixturesDir, 'valid-manifest-mixed-tool-types.json'), 'utf-8');

  it('accepts distinct tool names across capabilities', () => {
    expect(validateManifestDocument(JSON.parse(mixedText), mixedText).valid).toBe(true);
  });

  it('rejects a tool name reused in another capability, pointing at the repeat', () => {
    const manifest = JSON.parse(mixedText);
    manifest.tools[1].name = manifest.tools[0].name;
    const text = yaml.dump(manifest);

    const result = validateManifestDocument(manifest, text);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toEqual([expect.objectContaining({
      path: '/tools/1/name',
      message: `/tools/1/name: tool name '${manifest.tools[0].name}' is used more than once`,
      severity: 'error',
    })]);
    const nameLines = text.split('\n').flatMap((line, index) => (line.includes(`name: ${manifest.tools[0].name}`) ? [index + 1] : []));
    expect(result.errors[0].line).toBe(nameLines[1]);
  });

  it('reports a repeated name alongside schema errors', () => {
    const manifest = JSON.parse(mixedText);
    manifest.tools[1].name = manifest.tools[0].name;
    manifest.version = 'not-a-version';

    const result = validateManifestDocument(manifest, JSON.stringify(manifest));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.map((error) => error.path)).toEqual(expect.arrayContaining(['/version', '/tools/1/name']));
  });
});
