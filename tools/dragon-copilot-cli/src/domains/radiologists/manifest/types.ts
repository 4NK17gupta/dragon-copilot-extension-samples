/**
 * Manifest data contracts for Dragon Copilot (radiologists) extensions.
 *
 * Part of the pure manifest core (`domains/radiologists/manifest/`): no prompts,
 * no filesystem access, no `process.exit`. The Extensions Sandbox syncs this
 * folder in verbatim (see `radiologists/tools/extensions-sandbox/server/scripts/sync-schemas.ts`)
 * so the sandbox's "Dragon Copilot CLI" wizard produces byte-identical manifests
 * to the CLI. Keep it free of CLI-only dependencies.
 */

/**
 * The interaction pattern a tool uses.
 * - `contractBased`: Dragon Copilot calls the partner's `endpoint` with the declared `inputs`.
 * - `partnerInitiated`: the partner submits results to Dragon Copilot; no endpoint is called and no inputs are sent.
 */
export type ToolType = 'contractBased' | 'partnerInitiated';

/**
 * The capability a tool provides. Each capability is delivered by exactly one tool type:
 * `qualityCheck` is `contractBased`, `preDraftReportGeneration` is `partnerInitiated`.
 */
export type Capability = 'qualityCheck' | 'preDraftReportGeneration';

export interface DcrExtensionManifest {
  name: string;
  description: string;
  version: string;
  radiologistsExtensibilityApiVersion: string;
  auth: AuthConfig;
  tools: DcrTool[];
}

export interface AuthConfig {
  tenantId: string;
}

export interface DcrTool {
  name: string;
  toolType: ToolType;
  capability: Capability;
  description: string;
  /** Required for contractBased tools; omitted for partnerInitiated tools, which are never called. */
  endpoint?: string;
  /** Required for contractBased tools; omitted for partnerInitiated tools, which receive no inputs. */
  inputs?: DcrInput[];
  outputs: DcrOutput[];
  relevanceFilteringCriteria?: RelevanceFilteringCriteria;
  configurationTemplate?: Record<string, any>;
}

export interface DcrInput {
  name: string;
  description: string;
  'content-type': string;
  schemaVersion: string;
  required?: boolean;
}

export interface DcrOutput {
  name: string;
  description: string;
  'content-type': string;
  schemaVersion: string;
}

export interface RelevanceFilteringCriteria {
  relevantBodyParts?: string[];
  relevantModalities?: string[];
}

export interface TemplateConfig {
  name: string;
  description: string;
  version: string;
  radiologistsExtensibilityApiVersion: string;
  tools: ToolTemplate[];
}

export interface ToolTemplate {
  name: string;
  toolType: ToolType;
  capability: Capability;
  description: string;
  /** Required for contractBased tools; omitted for partnerInitiated tools. */
  endpoint?: string;
  /** Required for contractBased tools; omitted for partnerInitiated tools. */
  inputs?: Array<{
    name: string;
    description: string;
    'content-type': string;
    schemaVersion: string;
    required?: boolean;
  }>;
  outputs: Array<{
    name: string;
    description: string;
    'content-type': string;
    schemaVersion: string;
  }>;
  relevanceFilteringCriteria?: RelevanceFilteringCriteria;
  configurationTemplate?: Record<string, any>;
}

/** A selectable option, shared by the CLI prompts and the sandbox wizard UI. */
export interface ManifestChoice<TValue extends string = string> {
  name: string;
  value: TValue;
}
