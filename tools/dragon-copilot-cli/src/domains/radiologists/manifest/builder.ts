/**
 * Pure manifest assembly for Dragon Copilot (radiologists) extensions.
 *
 * These functions turn already-collected answers into a manifest object and its
 * YAML rendering. They never prompt, read, write, or exit — collecting the
 * answers is the caller's job (interactive prompts in the CLI, an HTML form in
 * the Extensions Sandbox), which is what lets both surfaces emit identical
 * manifests. Part of the pure manifest core — see `./types.ts`.
 */
import { dump } from 'js-yaml';
import type {
  Capability,
  DcrExtensionManifest,
  DcrInput,
  DcrOutput,
  DcrTool,
  RelevanceFilteringCriteria,
  ToolType,
} from './types.js';
import {
  CAPABILITY_BY_TOOL_TYPE,
  DEFAULT_OUTPUT_CONTENT_TYPE,
  DEFAULT_PAYLOAD_SCHEMA_VERSION,
  DEFAULT_TOOL_TYPE,
  DRAFT_REPORT_CONTENT_TYPE,
  getInputDescription,
  getInputName,
} from './choices.js';
import { getTemplate } from './templates.js';


export interface ExtensionInput {
  name: string;
  description: string;
  version: string;
  radiologistsExtensibilityApiVersion: string;
}

export interface OutputInput {
  name: string;
  description: string;
  /** Defaults to `DEFAULT_PAYLOAD_SCHEMA_VERSION`. */
  schemaVersion?: string | undefined;
  /** Defaults to the tool type's output media type (see `getDefaultOutputContentType`). */
  'content-type'?: string | undefined;
}

export interface ToolInput {
  name: string;
  description: string;
  /** Required for `contractBased` tools; ignored for `partnerInitiated` tools. */
  endpoint?: string | undefined;
  /**
   * Input media types; names and descriptions are derived from them.
   * Required for `contractBased` tools; ignored for `partnerInitiated` tools.
   */
  inputTypes?: string[] | undefined;
  outputs: OutputInput[];
  /** Defaults to `DEFAULT_TOOL_TYPE`. */
  toolType?: ToolType | undefined;
  /** Defaults to the capability paired with the tool type (see `CAPABILITY_BY_TOOL_TYPE`). */
  capability?: Capability | undefined;
  relevanceFilteringCriteria?: RelevanceFilteringCriteria | null | undefined;
  configurationTemplate?: Record<string, any> | undefined;
}

export interface ManifestInput {
  extension: ExtensionInput;
  auth: { tenantId: string };
  tools: ToolInput[];
}

/**
 * Expands input media types into full input definitions.
 */
export function buildInputs(contentTypes: string[]): DcrInput[] {
  return contentTypes.map((contentType, index) => ({
    name: getInputName(contentType, index),
    description: getInputDescription(contentType),
    'content-type': contentType,
    schemaVersion: DEFAULT_PAYLOAD_SCHEMA_VERSION,
  }));
}

/**
 * The output media type a tool of the given type produces by default.
 */
export function getDefaultOutputContentType(toolType: ToolType = DEFAULT_TOOL_TYPE): string {
  return toolType === 'partnerInitiated' ? DRAFT_REPORT_CONTENT_TYPE : DEFAULT_OUTPUT_CONTENT_TYPE;
}

/**
 * Fills in the output content type and schema version defaults.
 */
export function buildOutputs(
  outputs: OutputInput[],
  defaultContentType: string = DEFAULT_OUTPUT_CONTENT_TYPE,
): DcrOutput[] {
  return outputs.map((output) => ({
    name: output.name,
    description: output.description,
    'content-type': output['content-type'] ?? defaultContentType,
    schemaVersion: output.schemaVersion ?? DEFAULT_PAYLOAD_SCHEMA_VERSION,
  }));
}

/**
 * Drops empty relevance filtering criteria so the manifest omits the property
 * entirely rather than emitting an empty object (the schema treats an absent
 * `relevanceFilteringCriteria` as "always consider this tool").
 */
export function normalizeRelevanceFilteringCriteria(
  criteria?: RelevanceFilteringCriteria | null,
): RelevanceFilteringCriteria | undefined {
  if (!criteria) return undefined;

  const normalized: RelevanceFilteringCriteria = {};
  if (criteria.relevantBodyParts && criteria.relevantBodyParts.length > 0) {
    normalized.relevantBodyParts = [...criteria.relevantBodyParts];
  }
  if (criteria.relevantModalities && criteria.relevantModalities.length > 0) {
    normalized.relevantModalities = [...criteria.relevantModalities];
  }

  return normalized.relevantBodyParts || normalized.relevantModalities ? normalized : undefined;
}

/**
 * Assembles a single tool definition.
 *
 * `endpoint` and `inputs` are emitted only for `contractBased` tools — the
 * schema requires them there and `partnerInitiated` tools are never called.
 * Values are passed through unvalidated (an empty endpoint or input list is
 * left for schema validation to report), but omitting them entirely for a
 * `contractBased` tool is a caller bug.
 *
 * @throws if a `contractBased` tool has no `endpoint` or `inputTypes`.
 */
export function buildTool(tool: ToolInput): DcrTool {
  const toolType = tool.toolType ?? DEFAULT_TOOL_TYPE;

  let callTarget: Pick<DcrTool, 'endpoint' | 'inputs'> = {};
  if (toolType === 'contractBased') {
    if (tool.endpoint === undefined || tool.inputTypes === undefined) {
      throw new Error(`contractBased tool '${tool.name}' requires an endpoint and input types.`);
    }
    callTarget = { endpoint: tool.endpoint, inputs: buildInputs(tool.inputTypes) };
  }

  const built: DcrTool = {
    name: tool.name,
    toolType,
    capability: tool.capability ?? CAPABILITY_BY_TOOL_TYPE[toolType],
    description: tool.description,
    ...callTarget,
    outputs: buildOutputs(tool.outputs, getDefaultOutputContentType(toolType)),
  };

  const criteria = normalizeRelevanceFilteringCriteria(tool.relevanceFilteringCriteria);
  if (criteria) {
    built.relevanceFilteringCriteria = criteria;
  }
  if (tool.configurationTemplate) {
    built.configurationTemplate = tool.configurationTemplate;
  }

  return built;
}

/**
 * Assembles a complete manifest from collected answers.
 */
export function buildManifest(input: ManifestInput): DcrExtensionManifest {
  return {
    name: input.extension.name,
    description: input.extension.description,
    version: input.extension.version,
    radiologistsExtensibilityApiVersion: input.extension.radiologistsExtensibilityApiVersion,
    auth: { tenantId: input.auth.tenantId },
    tools: input.tools.map((tool) => buildTool(tool)),
  };
}

/**
 * Assembles a manifest from a built-in template, supplying the tenant the
 * template cannot know about.
 *
 * @throws if the template name is unknown.
 */
export function buildManifestFromTemplate(
  templateName: string,
  auth: { tenantId: string },
): DcrExtensionManifest {
  const template = getTemplate(templateName);

  return {
    name: template.name,
    description: template.description,
    version: template.version,
    radiologistsExtensibilityApiVersion: template.radiologistsExtensibilityApiVersion,
    auth: { tenantId: auth.tenantId },
    // `getTemplate` already returns a deep copy, so these tools are safe to hand out.
    tools: template.tools as DcrTool[],
  };
}

/**
 * Renders a manifest as the YAML written to `extension.yaml`.
 */
export function renderManifestYaml(manifest: DcrExtensionManifest): string {
  return dump(manifest, { lineWidth: -1 });
}
