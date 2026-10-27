import { Router } from 'express';
import {
  BODY_PART_CHOICES,
  CAPABILITY_BY_TOOL_TYPE,
  CAPABILITY_CHOICES,
  DEFAULT_OUTPUT_CONTENT_TYPE,
  INPUT_TYPE_CHOICES,
  MANIFEST_DEFAULTS,
  MODALITY_CHOICES,
  OUTPUT_DEFAULTS_BY_TOOL_TYPE,
  OUTPUT_TYPE_CHOICES,
  TOOL_TYPE_CHOICES,
  buildManifest,
  buildManifestFromTemplate,
  listTemplateSummaries,
  renderManifestYaml,
} from '../cli/radiologists/index.js';
import type {
  Capability,
  DcrExtensionManifest,
  RelevanceFilteringCriteria,
  ToolInput,
  ToolType,
} from '../cli/radiologists/index.js';
import { describeManifest, summarizeManifest, validateManifestDocument } from '../services/manifest-schema.js';
import { createLogger } from '../utils/logger.js';

/**
 * Runs the Dragon Copilot CLI's manifest generation inside the sandbox.
 *
 * The CLI's manifest core is imported as a library (it is synced into
 * `src/cli/radiologists` from `tools/dragon-copilot-cli`), never spawned as a
 * binary: the browser collects the same answers the CLI wizard prompts for, and
 * the server assembles the manifest with the CLI's own code so both surfaces
 * emit identical YAML.
 */
export const cliRouter = Router();

const log = createLogger('cli');

/** The only domain the sandbox can validate and test against today. */
const SUPPORTED_DOMAIN = 'radiologists';

interface ExtensionRequestFields {
  name?: unknown;
  description?: unknown;
  version?: unknown;
  radiologistsExtensibilityApiVersion?: unknown;
}

interface OutputRequestFields {
  name?: unknown;
  description?: unknown;
  schemaVersion?: unknown;
}

interface ToolRequestFields {
  name?: unknown;
  description?: unknown;
  toolType?: unknown;
  capability?: unknown;
  endpoint?: unknown;
  inputTypes?: unknown;
  outputs?: unknown;
  relevanceFilteringCriteria?: {
    relevantBodyParts?: unknown;
    relevantModalities?: unknown;
  };
}

interface GenerateRequestBody {
  domain?: unknown;
  mode?: unknown;
  template?: unknown;
  tenantId?: unknown;
  extension?: ExtensionRequestFields;
  /** A single tool; the original request shape, still accepted. */
  tool?: unknown;
  /** One or more tools. Mutually exclusive with `tool`. */
  tools?: unknown;
}

/** Request-shape problem, reported before any manifest is assembled. */
class BadRequestError extends Error {}

/**
 * Reads a trimmed string from untrusted input.
 *
 * A field that is absent, non-string, or blank all mean the same thing here —
 * "the caller did not supply this" — so all three yield `fallback`. That matches
 * the CLI, where submitting an empty prompt accepts the offered default, and
 * keeps the two surfaces emitting the same manifest for the same answers.
 */
function asString(value: unknown, fallback = ''): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

const VALID_TOOL_TYPES: ReadonlySet<ToolType> = new Set(TOOL_TYPE_CHOICES.map((choice) => choice.value));
const VALID_CAPABILITIES: ReadonlySet<Capability> = new Set(CAPABILITY_CHOICES.map((choice) => choice.value));

/**
 * Reads an optional enumerated field. Blank means "not supplied" (the manifest
 * core applies its default); anything else must be one of `valid`, so an
 * unknown value is rejected as a 400 rather than reaching the core unchecked.
 */
function readChoice<T extends string>(
  value: unknown,
  valid: ReadonlySet<T>,
  field: string,
  label: string,
): T | undefined {
  const text = asString(value);
  if (!text) return undefined;
  if (!(valid as ReadonlySet<string>).has(text)) {
    throw new BadRequestError(`Unknown ${field} '${text}' for ${label}. Expected one of: ${[...valid].join(', ')}.`);
  }
  return text as T;
}

function requireTenantId(body: GenerateRequestBody): string {
  const tenantId = asString(body.tenantId);
  if (!tenantId) {
    throw new BadRequestError('A tenant ID is required. Provide the Azure Entra ID tenant your extension is deployed to.');
  }
  return tenantId;
}

/**
 * GET /api/cli/options
 * Describes what the wizard can generate: templates, selectable values, and the
 * field defaults the CLI prompts offer. Sourced from the CLI so the sandbox
 * never hard-codes a second copy of them.
 */
cliRouter.get('/options', (_req, res) => {
  res.json({
    domain: SUPPORTED_DOMAIN,
    templates: listTemplateSummaries(),
    inputTypes: INPUT_TYPE_CHOICES,
    outputTypes: OUTPUT_TYPE_CHOICES,
    toolTypes: TOOL_TYPE_CHOICES,
    capabilities: CAPABILITY_CHOICES,
    capabilityByToolType: CAPABILITY_BY_TOOL_TYPE,
    outputDefaultsByToolType: OUTPUT_DEFAULTS_BY_TOOL_TYPE,
    bodyParts: BODY_PART_CHOICES,
    modalities: MODALITY_CHOICES,
    outputContentType: DEFAULT_OUTPUT_CONTENT_TYPE,
    defaults: MANIFEST_DEFAULTS,
  });
});

/**
 * POST /api/cli/generate
 * Generates a manifest from either a built-in template or the answers the
 * wizard collected, and returns it as YAML ready to load into the editor.
 */
cliRouter.post('/generate', (req, res) => {
  const body = (req.body ?? {}) as GenerateRequestBody;

  const domain = asString(body.domain, SUPPORTED_DOMAIN);
  if (domain !== SUPPORTED_DOMAIN) {
    log.warn(`Generate rejected: unsupported domain '${domain}'.`);
    res.status(400).json({
      generated: false,
      errors: [{ path: null, message: `Unsupported domain '${domain}'.`, severity: 'error' }],
      message: `This sandbox generates '${SUPPORTED_DOMAIN}' manifests only.`,
    });
    return;
  }

  // Omitted or blank means the default; anything else must name a real mode,
  // or a typo would silently generate a template manifest.
  const mode = asString(body.mode, 'template');

  let manifest: DcrExtensionManifest;
  try {
    if ((body.mode !== undefined && typeof body.mode !== 'string') || (mode !== 'template' && mode !== 'custom')) {
      throw new BadRequestError('mode must be "template" or "custom".');
    }
    manifest = mode === 'custom' ? buildCustomManifest(body) : buildTemplateManifest(body);
  } catch (err: unknown) {
    // Only a BadRequestError describes something the caller can fix, so only its
    // message is safe to echo back. Anything else is a fault on our side: report
    // it as a 500 and keep the internal detail in the server log.
    if (err instanceof BadRequestError) {
      log.warn(`Generate rejected: ${err.message}`);
      res.status(400).json({
        generated: false,
        errors: [{ path: null, message: err.message, severity: 'error' }],
        message: err.message,
      });
      return;
    }

    log.error(`Generate failed unexpectedly: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    const message = 'Manifest generation failed unexpectedly. Check the sandbox server log for details.';
    res.status(500).json({
      generated: false,
      errors: [{ path: null, message, severity: 'error' }],
      message,
    });
    return;
  }

  const yamlContent = renderManifestYaml(manifest);

  // The wizard cannot express every schema rule (name casing, GUID shape, …), so
  // the generated manifest goes through the same validation as an uploaded one.
  // Its YAML is still returned, letting the editor show the errors in context.
  const result = validateManifestDocument(manifest, yamlContent);
  if (!result.valid) {
    log.warn(`Generated manifest failed validation with ${result.errors.length} error(s).`);
    for (const e of result.errors) {
      log.warn(`Generated manifest invalid at ${e.path}${e.line !== null ? ` (line ${e.line})` : ''}: ${e.detail}`);
    }

    res.status(422).json({
      generated: true,
      valid: false,
      yaml: yamlContent,
      errors: result.errors,
      message: `Generated manifest failed validation with ${result.errors.length} error(s). Fix the highlighted fields and validate again.`,
    });
    return;
  }

  const summary = summarizeManifest(result.manifest);
  log.info(
    `Generated ${mode === 'custom' ? 'custom' : `'${asString(body.template)}' template`} manifest ` +
    `'${summary.name}' v${summary.version} with ${summary.toolCount} tool(s).`,
  );

  res.json({
    generated: true,
    valid: true,
    yaml: yamlContent,
    manifest: summary,
    message: describeManifest(summary),
  });
});

/**
 * Builds a manifest from a built-in CLI template, mirroring
 * `dragon-copilot radiologists generate --template <name>`.
 */
function buildTemplateManifest(body: GenerateRequestBody): DcrExtensionManifest {
  const template = asString(body.template);
  const available = listTemplateSummaries().map((summary) => summary.id);

  if (!template) {
    throw new BadRequestError(`A template is required. Available templates: ${available.join(', ')}.`);
  }

  // Checked here rather than letting `buildManifestFromTemplate` throw, so that
  // an unknown name is a typed 400 and anything else escaping the manifest core
  // is treated as the unexpected fault it is.
  if (!available.includes(template)) {
    throw new BadRequestError(`Template '${template}' not found. Available templates: ${available.join(', ')}.`);
  }

  const tenantId = requireTenantId(body);

  return buildManifestFromTemplate(template, { tenantId });
}

/**
 * Builds a manifest from wizard answers, mirroring `dragon-copilot radiologists init`.
 */
function buildCustomManifest(body: GenerateRequestBody): DcrExtensionManifest {
  const tenantId = requireTenantId(body);
  const extension = body.extension ?? {};
  const tools = readToolRequests(body);

  // Mirrors the CLI's `validateToolName`; the schema itself cannot express it.
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = asString(tool.name);
    if (name && seen.has(name)) {
      throw new BadRequestError(`Tool name '${name}' is used more than once. Each tool needs a unique name.`);
    }
    seen.add(name);
  }

  const label = (index: number) => (tools.length === 1 ? 'the tool' : `tool ${index + 1}`);

  return buildManifest({
    extension: {
      name: asString(extension.name, MANIFEST_DEFAULTS.extensionName),
      description: asString(extension.description, MANIFEST_DEFAULTS.extensionDescription),
      version: asString(extension.version, MANIFEST_DEFAULTS.version),
      radiologistsExtensibilityApiVersion: asString(
        extension.radiologistsExtensibilityApiVersion,
        MANIFEST_DEFAULTS.radiologistsExtensibilityApiVersion,
      ),
    },
    auth: { tenantId },
    tools: tools.map((tool, index) => readToolInput(tool, label(index))),
  });
}

/**
 * Reads the tool list from either `tools` (an array) or the original single
 * `tool` field. Supplying both is ambiguous, so it is rejected.
 */
function readToolRequests(body: GenerateRequestBody): ToolRequestFields[] {
  const isObject = (value: unknown): value is ToolRequestFields =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const missing = 'A tool definition is required. Add at least one tool to the manifest.';

  const hasTool = body.tool !== undefined && body.tool !== null;
  const hasTools = body.tools !== undefined && body.tools !== null;

  if (hasTool && hasTools) {
    throw new BadRequestError('Provide either "tool" or "tools", not both.');
  }

  if (hasTools) {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      throw new BadRequestError(missing);
    }
    if (!body.tools.every(isObject)) {
      throw new BadRequestError('Each tool must be an object with a name, tool type, and outputs.');
    }
    return body.tools;
  }

  if (!isObject(body.tool)) {
    throw new BadRequestError(missing);
  }
  return [body.tool];
}

/**
 * Converts one tool from the request into manifest core input. Endpoint and
 * input types are read regardless of tool type; the core ignores them for
 * `partnerInitiated` tools.
 */
function readToolInput(tool: ToolRequestFields, label: string): ToolInput {
  const outputs = Array.isArray(tool.outputs) ? (tool.outputs as OutputRequestFields[]) : [];
  if (outputs.length === 0) {
    throw new BadRequestError(`At least one output is required for ${label}.`);
  }
  if (outputs.some((output) => !output || typeof output !== 'object')) {
    throw new BadRequestError(`Each output must be an object with a name and description (${label}).`);
  }

  const toolInput: ToolInput = {
    name: asString(tool.name),
    description: asString(tool.description),
    endpoint: asString(tool.endpoint),
    inputTypes: asStringArray(tool.inputTypes),
    outputs: outputs.map((output) => ({
      name: asString(output.name),
      description: asString(output.description),
      schemaVersion: asString(output.schemaVersion, MANIFEST_DEFAULTS.schemaVersion),
    })),
  };

  const toolType = readChoice(tool.toolType, VALID_TOOL_TYPES, 'toolType', label);
  if (toolType) {
    toolInput.toolType = toolType;
  }

  const capability = readChoice(tool.capability, VALID_CAPABILITIES, 'capability', label);
  if (capability) {
    toolInput.capability = capability;
  }

  const criteria = readRelevanceFilteringCriteria(tool);
  if (criteria) {
    toolInput.relevanceFilteringCriteria = criteria;
  }

  return toolInput;
}

/**
 * Reads relevance filtering criteria from the request. Empty selections are
 * dropped by the manifest core, which leaves the tool unfiltered.
 */
function readRelevanceFilteringCriteria(tool: ToolRequestFields): RelevanceFilteringCriteria | undefined {
  const criteria = tool.relevanceFilteringCriteria;
  if (!criteria || typeof criteria !== 'object') return undefined;

  return {
    relevantBodyParts: asStringArray(criteria.relevantBodyParts),
    relevantModalities: asStringArray(criteria.relevantModalities),
  };
}
