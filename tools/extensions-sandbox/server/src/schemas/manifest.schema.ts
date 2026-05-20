export interface ManifestInput {
  name: string;
  description: string;
  'content-type': string;
  required?: boolean;
  config?: Record<string, unknown>;
}

export interface ManifestOutput {
  name: string;
  description: string;
  'content-type': string;
}

export interface ManifestTool {
  name: string;
  toolType: string;
  description: string;
  capability: string;
  endpoint: string;
  inputs: ManifestInput[];
  outputs: ManifestOutput[];
  relevanceFilteringCriteria?: Record<string, unknown>;
  configurationTemplate?: Record<string, unknown>;
}

export interface ManifestAuth {
  tenantId: string;
}

export interface ExtensionManifest {
  name: string;
  description: string;
  version: string;
  auth: ManifestAuth;
  tools: ManifestTool[];
}

