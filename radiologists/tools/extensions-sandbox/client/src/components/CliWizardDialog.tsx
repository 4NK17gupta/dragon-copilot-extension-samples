import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Radio,
  RadioGroup,
  Spinner,
  Textarea,
} from '@fluentui/react-components';
import { AddRegular, DeleteRegular } from '@fluentui/react-icons';
import { CONTRACT_BASED, PARTNER_INITIATED } from '../types/manifest';

interface Choice {
  name: string;
  value: string;
}

interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  toolCount: number;
}

interface OutputDefaults {
  name: string;
  description: string;
}

interface CliOptions {
  templates: TemplateSummary[];
  inputTypes: Choice[];
  toolTypes: Choice[];
  capabilities: Choice[];
  capabilityByToolType: Record<string, string>;
  outputDefaultsByToolType: Record<string, OutputDefaults>;
  bodyParts: Choice[];
  modalities: Choice[];
  outputContentType: string;
  defaults: {
    extensionName: string;
    extensionDescription: string;
    version: string;
    radiologistsExtensibilityApiVersion: string;
    toolName: string;
    toolDescription: string;
    endpoint: string;
    outputName: string;
    outputDescription: string;
    schemaVersion: string;
  };
}

/** One tool being authored in custom mode. */
interface ToolDraft {
  /** Stable React key; tool names are editable and can collide. */
  key: number;
  toolType: string;
  name: string;
  description: string;
  /** Used by Contract Based tools only. */
  endpoint: string;
  /** Used by Contract Based tools only. */
  inputTypes: string[];
  outputName: string;
  outputDescription: string;
  schemaVersion: string;
  bodyParts: string[];
  modalities: string[];
}

interface CliWizardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the generated YAML so the editor can load and validate it.
   * Returning `false` means the editor declined it (e.g. the user chose to keep
   * their current manifest), and the wizard stays open.
   */
  onGenerated: (yaml: string) => boolean | void;
}

type Mode = 'template' | 'custom';

function outputDefaultsFor(options: CliOptions, toolType: string): OutputDefaults {
  return options.outputDefaultsByToolType[toolType] ?? {
    name: options.defaults.outputName,
    description: options.defaults.outputDescription,
  };
}

function createToolDraft(options: CliOptions, key: number, name: string): ToolDraft {
  const toolType = options.toolTypes[0]?.value ?? CONTRACT_BASED;
  const output = outputDefaultsFor(options, toolType);

  return {
    key,
    toolType,
    name,
    description: options.defaults.toolDescription,
    endpoint: options.defaults.endpoint,
    inputTypes: options.inputTypes.map((choice) => choice.value),
    outputName: output.name,
    outputDescription: output.description,
    schemaVersion: options.defaults.schemaVersion,
    bodyParts: [],
    modalities: [],
  };
}

/** Default name for an added tool: the CLI's default name with the first free numeric suffix. */
function nextToolName(baseName: string, tools: ToolDraft[]): string {
  const taken = new Set(tools.map((tool) => tool.name.trim()));
  let suffix = tools.length + 1;
  while (taken.has(`${baseName}${suffix}`)) suffix += 1;
  return `${baseName}${suffix}`;
}

function isPartnerInitiated(tool: ToolDraft): boolean {
  return tool.toolType === PARTNER_INITIATED;
}

function hasRequiredToolFields(tool: ToolDraft): boolean {
  const hasCommonFields = Boolean(
    tool.name.trim() &&
    tool.description.trim() &&
    tool.outputName.trim() &&
    tool.outputDescription.trim() &&
    tool.schemaVersion.trim(),
  );
  // Dragon Copilot never calls a Partner Initiated tool, so it has no endpoint or inputs.
  return hasCommonFields && (isPartnerInitiated(tool) || Boolean(tool.endpoint.trim() && tool.inputTypes.length > 0));
}

function findDuplicateNames(tools: ToolDraft[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const tool of tools) {
    const name = tool.name.trim();
    if (!name) continue;
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return duplicates;
}

/**
 * Runs the Dragon Copilot CLI's manifest wizard from the Manifest Editor.
 *
 * The CLI asks its questions on a TTY, which the browser has no equivalent for,
 * so this dialog collects the same answers as a form and posts them to
 * `/api/cli/generate`, where the CLI's own manifest code assembles the YAML.
 * Field choices and defaults come from `/api/cli/options` rather than being
 * duplicated here, so the two surfaces cannot drift apart.
 */
export function CliWizardDialog({ open, onOpenChange, onGenerated }: CliWizardDialogProps) {
  const [options, setOptions] = useState<CliOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string>('');
  const [mode, setMode] = useState<Mode>('template');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string>('');

  const [template, setTemplate] = useState<string>('');
  const [tenantId, setTenantId] = useState<string>('');

  const [extensionName, setExtensionName] = useState<string>('');
  const [extensionDescription, setExtensionDescription] = useState<string>('');
  const [version, setVersion] = useState<string>('');
  const [apiVersion, setApiVersion] = useState<string>('');

  const [tools, setTools] = useState<ToolDraft[]>([]);
  const nextToolKey = useRef(0);

  // Removing a tool unmounts the focused Remove button, so focus is moved to a
  // neighbouring tool's Name field (or the Add button) once the list re-renders.
  const nameInputRefs = useRef(new Map<number, HTMLInputElement>());
  const addToolButtonRef = useRef<HTMLButtonElement>(null);
  const [pendingFocusKey, setPendingFocusKey] = useState<number | null>(null);

  // Load the wizard's choices and defaults the first time it is opened.
  useEffect(() => {
    if (!open || options) return;

    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/cli/options');
        if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
        const data: CliOptions = await response.json();
        if (cancelled) return;

        setOptions(data);
        setOptionsError('');
        setTemplate(data.templates[0]?.id ?? '');
        setExtensionName(data.defaults.extensionName);
        setExtensionDescription(data.defaults.extensionDescription);
        setVersion(data.defaults.version);
        setApiVersion(data.defaults.radiologistsExtensibilityApiVersion);
        setTools([createToolDraft(data, nextToolKey.current++, data.defaults.toolName)]);
      } catch {
        if (!cancelled) setOptionsError('Could not load the CLI wizard options. Is the sandbox server running?');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, options]);

  // Drop the previous attempt's failure so reopening the wizard starts clean.
  useEffect(() => {
    if (!open) setError('');
  }, [open]);

  const updateTool = useCallback((key: number, changes: Partial<ToolDraft>) => {
    setTools((current) => current.map((tool) => (tool.key === key ? { ...tool, ...changes } : tool)));
  }, []);

  // Offer the new tool type's output defaults, but keep any output name or
  // description the user has already typed.
  const changeToolType = useCallback((key: number, toolType: string) => {
    if (!options) return;
    setTools((current) =>
      current.map((tool) => {
        if (tool.key !== key || tool.toolType === toolType) return tool;
        const previous = outputDefaultsFor(options, tool.toolType);
        const next = outputDefaultsFor(options, toolType);
        return {
          ...tool,
          toolType,
          outputName: tool.outputName === previous.name ? next.name : tool.outputName,
          outputDescription: tool.outputDescription === previous.description ? next.description : tool.outputDescription,
        };
      }),
    );
  }, [options]);

  const toggleInputType = useCallback((key: number, value: string, checked: boolean) => {
    setTools((current) =>
      current.map((tool) => {
        if (tool.key !== key) return tool;
        const inputTypes = checked
          ? [...new Set([...tool.inputTypes, value])]
          : tool.inputTypes.filter((item) => item !== value);
        return { ...tool, inputTypes };
      }),
    );
  }, []);

  const addTool = useCallback(() => {
    if (!options) return;
    const key = nextToolKey.current++;
    setTools((current) => [...current, createToolDraft(options, key, nextToolName(options.defaults.toolName, current))]);
  }, [options]);

  const removeTool = useCallback((key: number) => {
    const index = tools.findIndex((tool) => tool.key === key);
    if (tools.length <= 1 || index === -1) return;
    const neighbour = tools[index - 1] ?? tools[index + 1];
    setPendingFocusKey(neighbour?.key ?? -1);
    setTools((current) => current.filter((tool) => tool.key !== key));
  }, [tools]);

  useEffect(() => {
    if (pendingFocusKey === null) return;
    (nameInputRefs.current.get(pendingFocusKey) ?? addToolButtonRef.current)?.focus();
    setPendingFocusKey(null);
  }, [pendingFocusKey, tools]);

  const buildRequestBody = useCallback(() => {
    if (mode === 'template') {
      return { domain: 'radiologists', mode, template, tenantId };
    }

    return {
      domain: 'radiologists',
      mode,
      tenantId,
      extension: {
        name: extensionName,
        description: extensionDescription,
        version,
        radiologistsExtensibilityApiVersion: apiVersion,
      },
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        toolType: tool.toolType,
        ...(isPartnerInitiated(tool) ? {} : { endpoint: tool.endpoint, inputTypes: tool.inputTypes }),
        outputs: [{ name: tool.outputName, description: tool.outputDescription, schemaVersion: tool.schemaVersion }],
        relevanceFilteringCriteria: { relevantBodyParts: tool.bodyParts, relevantModalities: tool.modalities },
      })),
    };
  }, [apiVersion, extensionDescription, extensionName, mode, template, tenantId, tools, version]);

  const handleGenerate = useCallback(async () => {
    setIsGenerating(true);
    setError('');

    try {
      const response = await fetch('/api/cli/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildRequestBody()),
      });
      const data = await response.json();

      // A malformed request produces no manifest, so the wizard stays open with
      // the reason. A schema-invalid manifest still comes back as YAML: it is
      // loaded into the editor, which reports the errors in place.
      if (!data.yaml) {
        setError(data.message ?? 'Manifest generation failed.');
        return;
      }

      if (onGenerated(data.yaml) === false) return;
      onOpenChange(false);
    } catch {
      setError('Network error: could not reach the server.');
    } finally {
      setIsGenerating(false);
    }
  }, [buildRequestBody, onGenerated, onOpenChange]);

  const duplicateNames = findDuplicateNames(tools);

  // Gate on every field the form marks `required`, so the button's enabled state
  // matches what the form asks for. Blank values would otherwise reach the server
  // and come back as a 422 (or be quietly replaced by a default) instead of being
  // caught while the user is still looking at the field.
  const hasRequiredCustomFields =
    extensionName.trim() &&
    extensionDescription.trim() &&
    version.trim() &&
    apiVersion.trim() &&
    tools.length > 0 &&
    tools.every(hasRequiredToolFields) &&
    duplicateNames.size === 0;

  const canGenerate = Boolean(
    options && tenantId.trim() && (mode === 'template' ? template : hasRequiredCustomFields),
  );

  const selectedTemplate = options?.templates.find((item) => item.id === template);

  return (
    <Dialog open={open} onOpenChange={(_event, data) => onOpenChange(data.open)}>
      <DialogSurface className="cli-wizard-surface">
        <DialogBody>
          <DialogTitle>Create a manifest with the Dragon Copilot CLI</DialogTitle>
          <DialogContent>
            <p className="cli-wizard-intro">
              Asks the core questions from <code>dragon-copilot radiologists init</code>, for Contract Based
              and Partner Initiated tools. The manifest is generated by the CLI and loaded straight into the
              editor for validation and testing.
            </p>

            {optionsError && (
              <MessageBar intent="error">
                <MessageBarBody>{optionsError}</MessageBarBody>
              </MessageBar>
            )}

            {!options && !optionsError && <Spinner size="small" label="Loading CLI options..." />}

            {options && (
              <div className="cli-wizard-form">
                <Field label="Start from">
                  <RadioGroup value={mode} onChange={(_event, data) => setMode(data.value as Mode)} layout="horizontal">
                    <Radio value="template" label="A built-in template" />
                    <Radio value="custom" label="My own values" />
                  </RadioGroup>
                </Field>

                {mode === 'template' && (
                  <Field label="Template" required>
                    <Dropdown
                      value={selectedTemplate?.description ?? ''}
                      selectedOptions={template ? [template] : []}
                      onOptionSelect={(_event, data) => setTemplate(data.optionValue ?? '')}
                    >
                      {options.templates.map((item) => (
                        <Option key={item.id} value={item.id} text={item.description}>
                          {item.description}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                )}

                <Field
                  label="Azure Entra ID tenant ID"
                  required
                  hint="The tenant your extension is deployed to, in GUID format."
                >
                  <Input
                    value={tenantId}
                    placeholder="12345678-1234-1234-1234-123456789abc"
                    onChange={(_event, data) => setTenantId(data.value)}
                  />
                </Field>

                {mode === 'custom' && (
                  <>
                    <div className="cli-wizard-section">Extension</div>

                    <Field label="Name" required hint="camelCase, e.g. myRadiologistsExtension.">
                      <Input value={extensionName} onChange={(_event, data) => setExtensionName(data.value)} />
                    </Field>

                    <Field label="Description" required>
                      <Textarea
                        value={extensionDescription}
                        rows={2}
                        onChange={(_event, data) => setExtensionDescription(data.value)}
                      />
                    </Field>

                    <div className="cli-wizard-row">
                      <Field label="Version" required hint="x.y.z">
                        <Input value={version} onChange={(_event, data) => setVersion(data.value)} />
                      </Field>
                      <Field label="Extensibility API version" required hint="x.y.z">
                        <Input value={apiVersion} onChange={(_event, data) => setApiVersion(data.value)} />
                      </Field>
                    </div>

                    {tools.map((tool, index) => {
                      const heading = tools.length > 1 ? `Tool ${index + 1}` : 'Tool';
                      const partnerInitiated = isPartnerInitiated(tool);
                      const isDuplicate = duplicateNames.has(tool.name.trim());
                      const capability = options.capabilityByToolType[tool.toolType] ?? '';
                      const capabilityName =
                        options.capabilities.find((choice) => choice.value === capability)?.name ?? capability;

                      return (
                        <div key={tool.key} className="cli-wizard-tool" role="group" aria-label={heading}>
                          <div className="cli-wizard-section cli-wizard-tool-header">
                            <span>{heading}</span>
                            {tools.length > 1 && (
                              <Button
                                appearance="subtle"
                                size="small"
                                icon={<DeleteRegular />}
                                aria-label={`Remove ${heading.toLowerCase()}`}
                                onClick={() => removeTool(tool.key)}
                              >
                                Remove
                              </Button>
                            )}
                          </div>

                          <Field
                            label="Name"
                            required
                            hint="camelCase, e.g. myRadiologistsTool."
                            validationState={isDuplicate ? 'error' : 'none'}
                            validationMessage={isDuplicate ? 'Tool names must be unique.' : undefined}
                          >
                            <Input
                              ref={(element) => {
                                if (element) nameInputRefs.current.set(tool.key, element);
                                else nameInputRefs.current.delete(tool.key);
                              }}
                              value={tool.name}
                              onChange={(_event, data) => updateTool(tool.key, { name: data.value })}
                            />
                          </Field>

                          <Field label="Description" required>
                            <Textarea
                              value={tool.description}
                              rows={2}
                              onChange={(_event, data) => updateTool(tool.key, { description: data.value })}
                            />
                          </Field>

                          <Field
                            label="Tool type"
                            required
                            hint="Contract Based: Dragon Copilot calls your endpoint. Partner Initiated: you submit draft reports to Dragon Copilot."
                          >
                            <RadioGroup
                              value={tool.toolType}
                              layout="horizontal"
                              onChange={(_event, data) => changeToolType(tool.key, data.value)}
                            >
                              {options.toolTypes.map((choice) => (
                                <Radio key={choice.value} value={choice.value} label={choice.name} />
                              ))}
                            </RadioGroup>
                          </Field>

                          <Field label="Capability" hint="Set by the tool type.">
                            <Input value={capabilityName} readOnly />
                          </Field>

                          {!partnerInitiated && (
                            <>
                              <Field label="API endpoint" required hint="The HTTPS URL Dragon Copilot calls.">
                                <Input
                                  value={tool.endpoint}
                                  onChange={(_event, data) => updateTool(tool.key, { endpoint: data.value })}
                                />
                              </Field>

                              <Field label="Input data types" required hint="Select at least one.">
                                <div className="cli-wizard-checkboxes">
                                  {options.inputTypes.map((choice) => (
                                    <Checkbox
                                      key={choice.value}
                                      label={choice.name}
                                      checked={tool.inputTypes.includes(choice.value)}
                                      onChange={(_event, data) =>
                                        toggleInputType(tool.key, choice.value, Boolean(data.checked))
                                      }
                                    />
                                  ))}
                                </div>
                              </Field>
                            </>
                          )}

                          <div className="cli-wizard-row">
                            <Field label="Output name" required>
                              <Input
                                value={tool.outputName}
                                onChange={(_event, data) => updateTool(tool.key, { outputName: data.value })}
                              />
                            </Field>
                            <Field label="Output payload schemaVersion" required hint="major.minor">
                              <Input
                                value={tool.schemaVersion}
                                onChange={(_event, data) => updateTool(tool.key, { schemaVersion: data.value })}
                              />
                            </Field>
                          </div>

                          <Field label="Output description" required>
                            <Input
                              value={tool.outputDescription}
                              onChange={(_event, data) => updateTool(tool.key, { outputDescription: data.value })}
                            />
                          </Field>

                          <div className="cli-wizard-subsection">Relevance filtering (optional)</div>
                          <p className="cli-wizard-hint">
                            Limits when the tool is considered. Leave both empty to always consider it.
                            {partnerInitiated &&
                              ' For Partner Initiated tools these criteria are declarative and not currently enforced.'}
                          </p>

                          <div className="cli-wizard-row">
                            <Field label="Body parts">
                              <Dropdown
                                multiselect
                                placeholder="Any body part"
                                selectedOptions={tool.bodyParts}
                                value={tool.bodyParts
                                  .map((value) => options.bodyParts.find((choice) => choice.value === value)?.name ?? value)
                                  .join(', ')}
                                onOptionSelect={(_event, data) => updateTool(tool.key, { bodyParts: data.selectedOptions })}
                              >
                                {options.bodyParts.map((choice) => (
                                  <Option key={choice.value} value={choice.value} text={choice.name}>
                                    {choice.name}
                                  </Option>
                                ))}
                              </Dropdown>
                            </Field>
                            <Field label="Imaging modalities">
                              <Dropdown
                                multiselect
                                placeholder="Any modality"
                                selectedOptions={tool.modalities}
                                value={tool.modalities
                                  .map((value) => options.modalities.find((choice) => choice.value === value)?.name ?? value)
                                  .join(', ')}
                                onOptionSelect={(_event, data) => updateTool(tool.key, { modalities: data.selectedOptions })}
                              >
                                {options.modalities.map((choice) => (
                                  <Option key={choice.value} value={choice.value} text={choice.name}>
                                    {choice.name}
                                  </Option>
                                ))}
                              </Dropdown>
                            </Field>
                          </div>
                        </div>
                      );
                    })}

                    <div>
                      <Button ref={addToolButtonRef} appearance="secondary" icon={<AddRegular />} onClick={addTool}>
                        Add another tool
                      </Button>
                    </div>
                  </>
                )}

                {error && (
                  <MessageBar intent="error">
                    <MessageBarBody>{error}</MessageBarBody>
                  </MessageBar>
                )}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={handleGenerate} disabled={!canGenerate || isGenerating}>
              {isGenerating ? 'Generating...' : 'Generate manifest'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
