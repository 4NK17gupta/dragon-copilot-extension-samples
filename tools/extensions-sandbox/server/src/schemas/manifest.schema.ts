import type { JSONSchemaType } from 'ajv';

export interface ManifestInput {
  name: string;
  description: string;
  'content-type': string;
}

export interface ManifestOutput {
  name: string;
  description: string;
  'content-type': string;
}

export interface ManifestTool {
  name: string;
  description: string;
  capability: string;
  endpoint: string;
  trigger?: string;
  inputs: ManifestInput[];
  outputs: ManifestOutput[];
}

export interface ManifestAuth {
  tenantId?: string;
}

export interface ExtensionManifest {
  name: string;
  description?: string;
  version: string;
  auth?: ManifestAuth;
  tools: ManifestTool[];
}

export const manifestSchema: JSONSchemaType<ExtensionManifest> = {
  type: 'object',
  required: ['name', 'version', 'tools'],
  properties: {
    name: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9-]*[a-z0-9]$',
    },
    description: {
      type: 'string',
      nullable: true,
    },
    version: {
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+$',
    },
    auth: {
      type: 'object',
      nullable: true,
      properties: {
        tenantId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
        },
      },
      required: [],
    },
    tools: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['name', 'description', 'capability', 'endpoint', 'inputs', 'outputs'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          capability: { type: 'string' },
          endpoint: { type: 'string', format: 'uri' },
          trigger: {
            type: 'string',
            enum: ['AutoRun', 'AdaptiveCardAction'],
            nullable: true,
          },
          inputs: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'description', 'content-type'],
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                'content-type': { type: 'string' },
              },
              additionalProperties: true,
            },
          },
          outputs: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'description', 'content-type'],
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                'content-type': { type: 'string' },
              },
              additionalProperties: true,
            },
          },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
};
