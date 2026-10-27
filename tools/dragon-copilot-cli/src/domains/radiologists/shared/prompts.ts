import { input, select, checkbox, confirm } from '@inquirer/prompts';
import type {
  Capability,
  DcrExtensionManifest,
  DcrOutput,
  RelevanceFilteringCriteria,
  ToolType
} from '../types.js';
import {
  BODY_PART_CHOICES,
  CAPABILITY_BY_TOOL_TYPE,
  CAPABILITY_CHOICES,
  DEFAULT_OUTPUT_CONTENT_TYPE,
  DEFAULT_TOOL_TYPE,
  DRAFT_REPORT_CONTENT_TYPE,
  DRAFT_REPORT_OUTPUT_DEFAULTS,
  INPUT_TYPE_CHOICES,
  MANIFEST_DEFAULTS,
  MODALITY_CHOICES,
  TOOL_TYPE_CHOICES,
  getDefaultOutputContentType,
  getInputDescription,
  getInputName
} from '../manifest/index.js';
import { validateFieldValue } from './schema-validator.js';

// Selectable values and content-type derivations are owned by the pure manifest
// core so the Extensions Sandbox wizard offers exactly the same options; they are
// re-exported here for existing callers.
export {
  BODY_PART_CHOICES,
  CAPABILITY_CHOICES,
  INPUT_TYPE_CHOICES,
  MODALITY_CHOICES,
  TOOL_TYPE_CHOICES,
  getInputDescription,
  getInputName
};

export interface ExtensionDetails {
  name: string;
  description: string;
  version: string;
  radiologistsExtensibilityApiVersion: string;
}

export interface ToolDetails {
  toolName: string;
  toolDescription: string;
  toolType: ToolType;
  capability: Capability;
  /** Set only for contractBased tools. */
  endpoint?: string | undefined;
  /** Set only for contractBased tools. */
  inputTypes?: string[] | undefined;
  outputs: DcrOutput[];
  relevanceFilteringCriteria?: RelevanceFilteringCriteria | undefined;
}

/**
 * Validates tool name input
 */
export function validateToolName(input: string, existingManifest?: DcrExtensionManifest | null): string | boolean {
  if (!input.trim()) return 'Tool name is required';
    if (!/^[a-z][a-zA-Z0-9]*$/.test(input)) {
        return 'Tool name must use camelCase (start with a lowercase letter, followed by letters and numbers)';
    }
  if (existingManifest?.tools.find(t => t.name === input)) {
    return 'Tool with this name already exists';
  }
  return true;
}

/**
 * Validates extension name input using schema validation
 */
export function validateExtensionName(input: string): string | boolean {
  return validateFieldValue(input, 'name', 'manifest');
}

/**
 * Validates URL input
 */
export function validateUrl(input: string): string | boolean {
  if (!input.trim()) return 'URL is required';
  try {
    new URL(input.trim());
    return true;
  } catch {
    return 'Must be a valid URL (e.g., https://example.com)';
  }
}

/**
 * Validates version format using schema validation
 */
export function validateVersion(input: string): string | boolean {
  return validateFieldValue(input, 'version', 'manifest');
}

/**
 * Validates the Radiologists Extensibility API version (x.y.z) the manifest was authored against.
 */
export function validateradiologistsExtensibilityApiVersion(input: string): string | boolean {
  return validateFieldValue(input, 'radiologistsExtensibilityApiVersion', 'manifest');
}

/**
 * Validates tenant ID input (GUID format)
 */
export function validateTenantId(input: string): string | boolean {
  const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!input.trim()) return 'Tenant ID is required';
  if (!guidPattern.test(input.trim())) return 'Tenant ID must be a valid GUID format (e.g., 12345678-1234-1234-1234-123456789abc)';
  return true;
}

/**
 * Prompts for extension details
 */
export async function promptExtensionDetails(defaults?: Partial<ExtensionDetails>): Promise<ExtensionDetails> {
  const name = await input({
    message: 'Extension name:',
    default: defaults?.name || MANIFEST_DEFAULTS.extensionName,
    validate: validateExtensionName
  });

  const description = await input({
    message: 'Extension description:',
    default: defaults?.description || MANIFEST_DEFAULTS.extensionDescription
  });

  const version = await input({
    message: 'Version:',
    default: defaults?.version || MANIFEST_DEFAULTS.version,
    validate: validateVersion
  });

  const radiologistsExtensibilityApiVersion = await input({
    message: 'Radiologists Extensibility API version this manifest was authored against:',
    default: defaults?.radiologistsExtensibilityApiVersion || MANIFEST_DEFAULTS.radiologistsExtensibilityApiVersion,
    validate: validateradiologistsExtensibilityApiVersion
  });

  return { name, description, version, radiologistsExtensibilityApiVersion };
}

/**
 * Prompts for authentication details
 */
export async function promptAuthDetails(defaults?: { tenantId?: string }): Promise<{ tenantId: string }> {
  console.log('Authentication configuration is required for Dragon Copilot extensions.');
  console.log('This is the Microsoft Entra tenant ID of your organization, the tenant that owns this extension, not a customer tenant.');

  const tenantId = await input({
    message: 'Microsoft Entra tenant ID:',
    default: defaults?.tenantId || '',
    validate: validateTenantId
  });

  return { tenantId };
}

/**
 * Prompts for tool details with configurable options
 */
export async function promptToolDetails(
  existingManifest?: DcrExtensionManifest | null,
  options?: {
    allowMultipleInputs?: boolean;
    defaults?: {
      toolName?: string;
      toolDescription?: string;
      endpoint?: string;
    };
  }
): Promise<ToolDetails> {
  const {
    allowMultipleInputs = true,
    defaults = {}
  } = options || {};

  const toolName = await input({
    message: 'Tool name:',
    ...(defaults.toolName ? { default: defaults.toolName } : {}),
    validate: (input: string) => validateToolName(input, existingManifest)
  });

  const toolDescription = await input({
    message: 'Tool description:',
    ...(defaults.toolDescription ? { default: defaults.toolDescription } : {})
  });

  const toolType = await select({
    message: 'Tool type:',
    choices: TOOL_TYPE_CHOICES,
    default: DEFAULT_TOOL_TYPE
  });

  // Each tool type delivers exactly one capability, so derive it instead of prompting.
  const capability = CAPABILITY_BY_TOOL_TYPE[toolType];
  const capabilityLabel = CAPABILITY_CHOICES.find((choice) => choice.value === capability)?.name ?? capability;
  console.log(`Capability: ${capabilityLabel} (determined by tool type)`);

  // partnerInitiated tools are never called by Dragon Copilot, so they declare no endpoint or inputs.
  let endpoint: string | undefined;
  let inputTypes: string[] | undefined;
  if (toolType === 'contractBased') {
    endpoint = await input({
      message: 'API endpoint:',
      ...(defaults.endpoint ? { default: defaults.endpoint } : {}),
      validate: validateUrl
    });

    inputTypes = await checkbox({
      message: allowMultipleInputs ? 'Select input data types:' : 'Select primary input data type:',
      choices: INPUT_TYPE_CHOICES,
      validate: (choices) => {
        if (choices.length === 0) return 'Please select at least one input type';
        if (!allowMultipleInputs && choices.length > 1) {
          return 'Please select only one input type';
        }
        return true;
      }
    });
  }

  const outputs = await promptOutputs(getDefaultOutputContentType(toolType));

  // Optionally prompt for relevance filtering criteria
  const addFiltering = await confirm({
    message: 'Add relevance filtering criteria (body parts & modalities)?',
    default: false
  });

  let relevanceFilteringCriteria: RelevanceFilteringCriteria | undefined;
  if (addFiltering) {
    relevanceFilteringCriteria = await promptRelevanceFilteringCriteria();
  }

  return { toolName, toolDescription, toolType, capability, endpoint, inputTypes, outputs, relevanceFilteringCriteria };
}

/**
 * Prompts for output details
 */
export async function promptOutputDetails(
  defaults?: { name?: string; description?: string; schemaVersion?: string },
  contentType: string = DEFAULT_OUTPUT_CONTENT_TYPE
): Promise<DcrOutput> {
  const isDraftReport = contentType === DRAFT_REPORT_CONTENT_TYPE;

  const name = await input({
    message: 'Output name:',
    default: defaults?.name || (isDraftReport ? DRAFT_REPORT_OUTPUT_DEFAULTS.name : MANIFEST_DEFAULTS.outputName)
  });

  const description = await input({
    message: 'Output description:',
    default: defaults?.description || (isDraftReport ? DRAFT_REPORT_OUTPUT_DEFAULTS.description : MANIFEST_DEFAULTS.outputDescription)
  });

  const schemaVersion = await input({
    message: 'Output payload schemaVersion (major.minor):',
    default: defaults?.schemaVersion || MANIFEST_DEFAULTS.schemaVersion
  });

  return {
    name,
    description,
    'content-type': contentType,
    schemaVersion
  };
}

/**
 * Prompts for relevance filtering criteria
 */
export async function promptRelevanceFilteringCriteria(): Promise<RelevanceFilteringCriteria> {
  console.log('\n Configuring relevance filtering criteria for your tool...');

  let relevantBodyParts: string[] = [];
  let relevantModalities: string[] = [];

  // At least one of body parts or modalities must be selected; both are individually optional.
  while (relevantBodyParts.length === 0 && relevantModalities.length === 0) {
    relevantBodyParts = await checkbox({
      message: 'Select relevant body parts:',
      choices: BODY_PART_CHOICES,
    });

    relevantModalities = await checkbox({
      message: 'Select relevant imaging modalities:',
      choices: MODALITY_CHOICES,
    });

    if (relevantBodyParts.length === 0 && relevantModalities.length === 0) {
      console.log('Select at least one body part or one modality.');
    }
  }

  const criteria: RelevanceFilteringCriteria = {};
  if (relevantBodyParts.length > 0) {
    criteria.relevantBodyParts = relevantBodyParts;
  }
  if (relevantModalities.length > 0) {
    criteria.relevantModalities = relevantModalities;
  }
  return criteria;
}

/**
 * Prompts for multiple outputs
 */
export async function promptOutputs(contentType: string = DEFAULT_OUTPUT_CONTENT_TYPE): Promise<DcrOutput[]> {
  const outputs: DcrOutput[] = [];

  console.log('\n Configuring outputs for your tool...');

  const firstOutput = await promptOutputDetails(undefined, contentType);
  outputs.push(firstOutput);

  let addMoreOutputs = await confirm({
    message: 'Add additional outputs?',
    default: false
  });

  while (addMoreOutputs) {
    const additionalOutput = await promptOutputDetails(undefined, contentType);
    outputs.push(additionalOutput);

    addMoreOutputs = await confirm({
      message: 'Add another output?',
      default: false
    });
  }

  return outputs;
}
