import { describe, it, expect, beforeEach } from 'vitest';
import { sessionStore } from '../store/session.js';
import type { ExtensionManifest } from '../schemas/manifest.schema.js';

/**
 * Unit tests for the capabilities parsing logic.
 * Tests the grouping algorithm that powers GET /api/manifest/capabilities.
 */

function parseCapabilities(manifest: ExtensionManifest) {
  const capabilityMap = new Map<string, { description: string; toolCount: number }>();
  for (const tool of manifest.tools) {
    const existing = capabilityMap.get(tool.capability);
    if (existing) {
      existing.toolCount += 1;
    } else {
      capabilityMap.set(tool.capability, {
        description: `${tool.capability.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()).trim()} capability`,
        toolCount: 1,
      });
    }
  }

  return Array.from(capabilityMap.entries()).map(([name, data]) => ({
    name,
    description: data.description,
    toolCount: data.toolCount,
  }));
}

const baseTool = {
  toolType: 'contractBased' as const,
  endpoint: 'https://api.example.com/v1/process',
  inputs: [
    {
      name: 'report',
      description: 'Report',
      'content-type': 'application/vnd.ms-dragon.dsp.rad.report+json' as const,
    },
  ],
  outputs: [
    {
      name: 'result',
      description: 'Result',
      'content-type': 'application/vnd.ms-dragon.dsp.rad.quality-result+json' as const,
    },
  ],
};

describe('Capabilities Parser', () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  it('should group tools by capability and return correct tool counts', () => {
    const manifest: ExtensionManifest = {
      name: 'test-extension',
      description: 'Test',
      version: '0.0.1',
      auth: { tenantId: '00000000-0000-0000-0000-000000000000' },
      tools: [
        { ...baseTool, name: 'tool-1', capability: 'reportGeneration', description: 'Generates report' },
        { ...baseTool, name: 'tool-2', capability: 'qualityCheck', description: 'Clinical quality' },
        { ...baseTool, name: 'tool-3', capability: 'qualityCheck', description: 'Billing quality' },
      ],
    };

    const capabilities = parseCapabilities(manifest);

    expect(capabilities).toHaveLength(2);
    expect(capabilities).toEqual([
      { name: 'reportGeneration', description: 'Report Generation capability', toolCount: 1 },
      { name: 'qualityCheck', description: 'Quality Check capability', toolCount: 2 },
    ]);
  });

  it('should return empty array for manifest with no tools', () => {
    const manifest: ExtensionManifest = {
      name: 'empty-extension',
      description: 'No tools',
      version: '0.0.1',
      auth: { tenantId: '00000000-0000-0000-0000-000000000000' },
      tools: [],
    };

    const capabilities = parseCapabilities(manifest);
    expect(capabilities).toEqual([]);
  });

  it('should handle a single tool with one capability', () => {
    const manifest: ExtensionManifest = {
      name: 'single-tool',
      description: 'One tool only',
      version: '1.0.0',
      auth: { tenantId: '00000000-0000-0000-0000-000000000000' },
      tools: [
        { ...baseTool, name: 'only-tool', capability: 'reportGeneration', description: 'The only tool' },
      ],
    };

    const capabilities = parseCapabilities(manifest);

    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]).toEqual({
      name: 'reportGeneration',
      description: 'Report Generation capability',
      toolCount: 1,
    });
  });

  it('should store and retrieve manifest from session store', () => {
    const manifest: ExtensionManifest = {
      name: 'session-test',
      description: 'Session test',
      version: '0.0.1',
      auth: { tenantId: '00000000-0000-0000-0000-000000000000' },
      tools: [
        { ...baseTool, name: 'tool-a', capability: 'qualityCheck', description: 'Quality A' },
      ],
    };

    expect(sessionStore.getManifest()).toBeNull();
    sessionStore.setManifest(manifest);
    expect(sessionStore.getManifest()).toEqual(manifest);
  });
});
