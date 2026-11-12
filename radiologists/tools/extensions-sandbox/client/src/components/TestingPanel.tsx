import { useState, useEffect, useCallback, useRef, useId } from 'react';
import {
  Button,
  Dropdown,
  Option,
  Tab,
  TabList,
  Spinner,
  Link,
} from '@fluentui/react-components';
import { ArrowCounterclockwiseRegular, ArrowLeftRegular, CodeRegular, CopyRegular, RecordStopRegular } from '@fluentui/react-icons';
import { DynamicForm, getFieldPaths, SchemaProperty } from './DynamicForm';
import type { DynamicFormHandle } from './DynamicForm';
import { AuthSettings } from './AuthSettings';
import { DragonCopilotPreview } from './DragonCopilotPreview';
import { MAX_PANEL_ENTRIES, RequestsReceivedPanel } from './RequestsReceivedPanel';
import type { ContractEntry, RequestEntry } from './RequestsReceivedPanel';
import { SimulatedEnvironmentSettings } from './SimulatedEnvironmentSettings';
import { describeOutcome, formatReceivedTime } from './captureText';
import { usePartnerInitiatedTest } from '../hooks/usePartnerInitiatedTest';
import type { CapturePhase } from '../hooks/usePartnerInitiatedTest';
import type { CapturedRequest, ExecuteErrorDetails, ExecuteResult, ValidationResult } from '../types/testing';
import { PARTNER_INITIATED } from '../types/manifest';
import type { ToolType } from '../types/manifest';
import './ValidationResults.css';

const LISTENING_LABELS: Record<CapturePhase, string> = {
  idle: 'Not listening',
  starting: 'Starting to listen…',
  capturing: 'Listening',
  stopping: 'Stopping…',
};

/** Whether the sandbox listens for partner submissions. `announce: false` keeps a second badge from repeating changes. */
function ListeningBadge({ phase, announce = true }: { phase: CapturePhase; announce?: boolean }) {
  return (
    <span
      role="status"
      aria-live={announce ? undefined : 'off'}
      className={phase === 'capturing' ? 'listening-badge listening-badge-on' : 'listening-badge'}
    >
      {LISTENING_LABELS[phase]}
    </span>
  );
}

interface ToolInput {
  name: string;
  description: string;
  contentType: string;
  required: boolean;
  type?: string;
  placeholder?: string;
  schema?: SchemaProperty | null;
}

interface ToolOutput {
  name: string;
  contentType: string;
  description?: string;
}

interface Tool {
  name: string;
  description: string;
  toolType?: ToolType;
  /** Absent for partnerInitiated tools, which Dragon Copilot never calls. */
  endpoint?: string;
  inputs: ToolInput[];
  outputs: ToolOutput[];
}

interface Capability {
  /** The manifest `capability` value, sent back to the server. */
  name: string;
  /** Label shown in the UI; falls back to `name` when absent. */
  displayName?: string;
  description: string;
  toolCount: number;
}

interface ManifestInfo {
  name: string;
  version: string;
  toolCount: number;
  capabilities: string[];
}

interface InputValidationCheck {
  check: string;
  passed: boolean;
  path?: string;
  error?: string;
}

interface InputValidationError {
  valid: boolean;
  inputName: string;
  inputContentType: string;
  checks: InputValidationCheck[];
  summary: { passed: number; failed: number };
}

interface TestingPanelProps {
  manifestInfo: ManifestInfo | null;
  manifestRevision: number;
}

function failedCheckIndexes(validation: ValidationResult): Set<number> {
  return new Set(validation.checks
    .map((check, index) => !check.passed && check.error ? index : -1)
    .filter((index) => index >= 0));
}

export function TestingPanel({ manifestInfo, manifestRevision }: TestingPanelProps) {
  const capabilityId = useId();
  const toolId = useId();
  const [activeTab, setActiveTab] = useState<string>('setup');
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [selectedCapability, setSelectedCapability] = useState<string>('');
  const [tools, setTools] = useState<Tool[]>([]);
  const [selectedTool, setSelectedTool] = useState<string>('');
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [isExecuting, setIsExecuting] = useState(false);
  const [result, setResult] = useState<ExecuteResult | null>(null);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [executionTimeMs, setExecutionTimeMs] = useState<number>(0);
  const [executeError, setExecuteError] = useState<ExecuteErrorDetails | null>(null);
  const [expandedChecks, setExpandedChecks] = useState<Set<number>>(new Set());
  const [copyToast, setCopyToast] = useState(false);
  const [inputValidationErrors, setInputValidationErrors] = useState<InputValidationError[] | null>(null);
  /** The captured request the Results, Outputs and Preview tabs show, for partnerInitiated tools. */
  const [shownRequest, setShownRequest] = useState<CapturedRequest | null>(null);
  /** The Requests received panel's entries, newest first. */
  const [requestEntries, setRequestEntries] = useState<RequestEntry[]>([]);
  const [selectedEntryNumber, setSelectedEntryNumber] = useState<number | null>(null);
  const nextEntryNumber = useRef(1);
  /** The tool to select once the capability picked from the panel has loaded its tools. */
  const pendingTool = useRef<string | null>(null);
  /** The inputs to restore once Setup has switched to the tool of the contract run picked from the panel. */
  const pendingInputs = useRef<{ toolName: string; inputs: Record<string, string> } | null>(null);
  /** The tools of the capability picked from the panel, fetched before switching Setup to it. */
  const prefetchedTools = useRef<{ capability: string; tools: Tool[] } | null>(null);
  /** Changes on every panel pick, Setup change and panel reset, so a superseded pick doesn't switch Setup. */
  const selectToken = useRef(0);
  /** Changes whenever the panel is emptied, so a run that started before doesn't add an entry. */
  const panelGeneration = useRef(0);
  /** The panel generation Clear stored results last started, to tell it apart from a manifest change. */
  const clearedGeneration = useRef(-1);
  /** Whether the last Run Test finished after Clear stored results, so it wasn't kept. */
  const [runNotKept, setRunNotKept] = useState(false);
  const formRef = useRef<DynamicFormHandle>(null);
  const [partnerResultCount, setPartnerResultCount] = useState(0);

  const selectedCapabilityEntry = capabilities.find((c) => c.name === selectedCapability);
  const selectedCapabilityLabel = selectedCapabilityEntry
    ? selectedCapabilityEntry.displayName ?? selectedCapabilityEntry.name
    : selectedCapability;
  /** What the sandbox is set up to test, read when a request arrives. */
  const setupContext = useRef({ capability: '', capabilityLabel: '', toolName: '' });
  setupContext.current = { capability: selectedCapability, capabilityLabel: selectedCapabilityLabel, toolName: selectedTool };

  const showCapturedRequest = useCallback((request: CapturedRequest) => {
    setResult(request);
    setValidationResult(request.validation);
    setShownRequest(request);
    setExecuteError(null);
    setExpandedChecks(failedCheckIndexes(request.validation));
  }, []);

  /** Empties Results, Outputs and Dragon Copilot Preview. The panel keeps its entries. */
  const clearShownResult = useCallback(() => {
    setSelectedEntryNumber(null);
    setShownRequest(null);
    setResult(null);
    setValidationResult(null);
    setExecuteError(null);
    setExpandedChecks(new Set());
  }, []);

  const clearRequestEntries = useCallback(() => {
    setRequestEntries([]);
    nextEntryNumber.current = 1;
    selectToken.current++;
    panelGeneration.current++;
    pendingInputs.current = null;
    prefetchedTools.current = null;
    setRunNotKept(false);
  }, []);

  const addRequestEntry = useCallback((entry: RequestEntry) => {
    setRequestEntries((entries) => [entry, ...entries].slice(0, MAX_PANEL_ENTRIES));
    setSelectedEntryNumber(entry.number);
    setRunNotKept(false);
  }, []);

  const handleCapturedRequest = useCallback((request: CapturedRequest) => {
    addRequestEntry({ kind: 'partner', number: nextEntryNumber.current++, request, ...setupContext.current });
    showCapturedRequest(request);
    setPartnerResultCount((count) => count + 1);
    // Later requests update the Results tab without moving away from the tab in use.
    if (request.sequence === 1) setActiveTab('results');
  }, [addRequestEntry, showCapturedRequest]);

  /** Shows a panel entry's Results, Outputs and Preview. */
  const showEntry = useCallback((entry: RequestEntry) => {
    if (entry.kind === 'partner') {
      showCapturedRequest(entry.request);
      return;
    }
    setShownRequest(null);
    setResult(entry.result);
    setValidationResult(entry.validation);
    setExpandedChecks(entry.validation ? failedCheckIndexes(entry.validation) : new Set());
    setExecuteError(entry.error);
    setExecutionTimeMs(entry.executionTimeMs);
  }, [showCapturedRequest]);

  /**
   * Adds a finished Run Test of a contractBased tool to the panel and shows it. Showing the entry replaces
   * all of the shown state at once, so nothing shown earlier is left mixed in with the run's result.
   */
  const recordContractRun = useCallback((run: Omit<ContractEntry, 'kind' | 'number' | 'receivedAt'>) => {
    const entry: ContractEntry = {
      kind: 'contract', number: nextEntryNumber.current++, receivedAt: new Date().toISOString(), ...run,
    };
    addRequestEntry(entry);
    showEntry(entry);
  }, [addRequestEntry, showEntry]);

  const partnerTest = usePartnerInitiatedTest({
    manifestInfo, manifestRevision, capability: selectedCapability, toolName: selectedTool,
    onRequest: handleCapturedRequest,
  });
  const { start: startPartnerTest, cancel: cancelPartnerTest, clear: clearPartnerTest } = partnerTest;

  /**
   * Shows a panel entry and points Setup at its capability and tool, restoring a contract run's inputs.
   * Stays on the current tab and never re-runs. Setup stays as it is when the tool is no longer in the manifest.
   */
  const handleSelectEntry = useCallback((number: number) => {
    const entry = requestEntries.find((e) => e.number === number);
    if (!entry || number === selectedEntryNumber) return;
    if (partnerTest.isActive) void cancelPartnerTest();
    const token = ++selectToken.current;
    setSelectedEntryNumber(number);
    showEntry(entry);
    setInputValidationErrors(null);
    const restore = entry.kind === 'contract' ? { toolName: entry.toolName, inputs: entry.inputs } : null;

    if (entry.capability === selectedCapability) {
      if (entry.toolName === selectedTool) {
        if (restore) setInputValues({ ...restore.inputs });
      } else if (tools.some((t) => t.name === entry.toolName)) {
        pendingInputs.current = restore;
        setSelectedTool(entry.toolName);
      }
      return;
    }
    if (!capabilities.some((c) => c.name === entry.capability)) return;
    // Fetch the capability's tools first, so Setup only switches when the entry's tool is still there.
    fetch(`/api/manifest/capabilities/${encodeURIComponent(entry.capability)}/tools`)
      .then((res) => res.ok ? res.json() : [])
      .then((data: Tool[]) => {
        if (token !== selectToken.current || !data.some((t) => t.name === entry.toolName)) return;
        prefetchedTools.current = { capability: entry.capability, tools: data };
        pendingTool.current = entry.toolName;
        pendingInputs.current = restore;
        setSelectedCapability(entry.capability);
      })
      .catch(() => { /* Setup stays as it is. */ });
  }, [requestEntries, selectedEntryNumber, partnerTest.isActive, cancelPartnerTest, showEntry,
    selectedCapability, selectedTool, capabilities, tools]);

  /** After Clear stored results: empties the panel and the tabs. Listening carries on. */
  const handleStoredResultsCleared = useCallback(() => {
    clearRequestEntries();
    clearedGeneration.current = panelGeneration.current;
    clearShownResult();
  }, [clearRequestEntries, clearShownResult]);

  // Load capabilities when manifest is loaded
  useEffect(() => {
    setSelectedEntryNumber(null);
    setShownRequest(null);
    clearRequestEntries();
    if (!manifestInfo) {
      setCapabilities([]);
      setSelectedCapability('');
      setTools([]);
      setSelectedTool('');
      setInputValues({});
      setResult(null);
      setValidationResult(null);
      setExecuteError(null);
      setExpandedChecks(new Set());
      setInputValidationErrors(null);
      setActiveTab('setup');
      return;
    }

    // Reset state so the form is regenerated even if capability/tool names match.
    // Clearing selectedCapability also stops the tools effect from fetching a
    // capability that may not exist in the new manifest.
    setSelectedCapability('');
    setTools([]);
    setSelectedTool('');
    setInputValues({});
    setResult(null);
    setValidationResult(null);
    setExecuteError(null);
    setExpandedChecks(new Set());
    setInputValidationErrors(null);
    setActiveTab('setup');

    let cancelled = false;
    fetch('/api/manifest/capabilities')
      .then((res) => res.ok ? res.json() : [])
      .then((data: Capability[]) => {
        if (cancelled) return;
        setCapabilities(data);
        if (data.length > 0) {
          setSelectedCapability(data[0].name);
        }
      })
      .catch(() => {
        if (!cancelled) setCapabilities([]);
      });
    return () => {
      cancelled = true;
    };
  }, [manifestInfo, clearRequestEntries]);

  // Clear stale test/validation results whenever the manifest is edited.
  // This fires on every revision bump (including text edits before debounced
  // revalidation completes) so users never see results from a prior manifest.
  useEffect(() => {
    if (manifestRevision === 0) return; // skip initial mount
    setResult(null);
    setValidationResult(null);
    setExecuteError(null);
    setExpandedChecks(new Set());
    setInputValidationErrors(null);
    setSelectedEntryNumber(null);
    setShownRequest(null);
    clearRequestEntries();
  }, [manifestRevision, clearRequestEntries]);

  // Load tools when the selected capability changes. A manifest change clears
  // selectedCapability first, so this refetches even when the name is reused.
  useEffect(() => {
    setTools([]);
    setSelectedTool('');
    const prefetched = prefetchedTools.current;
    prefetchedTools.current = null;
    if (!selectedCapability) {
      return;
    }

    const applyTools = (data: Tool[]) => {
      setTools(data);
      const wanted = pendingTool.current;
      pendingTool.current = null;
      if (wanted && data.some((t) => t.name === wanted)) {
        setSelectedTool(wanted);
      } else if (data.length > 0) {
        setSelectedTool(data[0].name);
      }
    };

    if (prefetched?.capability === selectedCapability) {
      applyTools(prefetched.tools);
      return;
    }

    let cancelled = false;
    fetch(`/api/manifest/capabilities/${encodeURIComponent(selectedCapability)}/tools`)
      .then((res) => res.ok ? res.json() : [])
      .then((data: Tool[]) => {
        if (!cancelled) applyTools(data);
      })
      .catch(() => {
        if (!cancelled) setTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCapability]);

  // Reset input values when tool changes, or restore those of the contract run picked from the panel
  useEffect(() => {
    const tool = tools.find((t) => t.name === selectedTool);
    if (tool) {
      const defaults: Record<string, string> = {};
      for (const path of getFieldPaths(tool.inputs)) {
        defaults[path] = '';
      }
      const restore = pendingInputs.current;
      pendingInputs.current = null;
      setInputValues(restore?.toolName === tool.name ? { ...defaults, ...restore.inputs } : defaults);
    }
  }, [selectedTool, tools]);

  const currentTool = tools.find((t) => t.name === selectedTool);
  const isPartnerInitiated = currentTool?.toolType === PARTNER_INITIATED;

  const handleInputChange = useCallback((name: string, value: string) => {
    setInputValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleResetInputs = useCallback(() => {
    clearPartnerTest();
    clearShownResult();
    if (currentTool) {
      const defaults: Record<string, string> = {};
      for (const path of getFieldPaths(currentTool.inputs)) {
        defaults[path] = '';
      }
      setInputValues(defaults);
    }
    setInputValidationErrors(null);
  }, [currentTool, clearPartnerTest, clearShownResult]);

  /** Run Test for a partnerInitiated tool: captures requests to the simulated endpoint. */
  const startCapture = useCallback(async () => {
    clearShownResult();
    setInputValidationErrors(null);
    await startPartnerTest();
  }, [startPartnerTest, clearShownResult]);

  const handleCaptureToggle = useCallback(() => {
    if (partnerTest.isActive) void cancelPartnerTest();
    else void startCapture();
  }, [partnerTest.isActive, cancelPartnerTest, startCapture]);

  const tabListRef = useRef<HTMLDivElement>(null);
  const focusTabAfterStop = useRef(false);

  const handleHeaderStop = useCallback(() => {
    focusTabAfterStop.current = true;
    void cancelPartnerTest();
  }, [cancelPartnerTest]);

  // The header's Stop listening button goes away once listening stops, so focus moves to the shown tab.
  useEffect(() => {
    if (partnerTest.isActive || !focusTabAfterStop.current) return;
    focusTabAfterStop.current = false;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    tabListRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [partnerTest.isActive]);

  const handleRunTest = useCallback(async () => {
    if (!selectedCapability || !selectedTool) return;
    setRunNotKept(false);

    if (currentTool?.toolType === PARTNER_INITIATED) {
      await startCapture();
      return;
    }

    // Validate form before executing
    if (formRef.current && !formRef.current.validate()) {
      return;
    }

    setIsExecuting(true);
    clearShownResult();
    setInputValidationErrors(null);

    const run = {
      ...setupContext.current,
      inputs: { ...inputValues },
      endpoint: currentTool?.endpoint,
      toolType: currentTool?.toolType,
    };
    const generation = panelGeneration.current;
    /** Whether the manifest changed or the panel was cleared during the run, so its result no longer applies. */
    const isDiscarded = () => {
      if (generation === panelGeneration.current) return false;
      // Only a clear is reported; a manifest change already resets the whole panel.
      if (panelGeneration.current === clearedGeneration.current) setRunNotKept(true);
      return true;
    };
    const startTime = performance.now();

    try {
      // The server validates the inputs before calling the extension and the
      // response after, returning both results here. Doing it in one call
      // means a failure of the validation step cannot be skipped past.
      const response = await fetch('/api/manifest/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capability: selectedCapability,
          tool: selectedTool,
          inputs: inputValues,
        }),
      });

      const elapsedMs = Math.round(performance.now() - startTime);
      const data = await response.json();

      // 422 – inputs did not match their declared schema, so no call was made.
      if (response.status === 422) {
        const failedResults = (data.inputValidation || []).filter(
          (r: InputValidationError) => !r.valid,
        );
        setInputValidationErrors(
          failedResults.length > 0
            ? failedResults
            : [{
                valid: false,
                inputName: '*',
                inputContentType: 'unknown',
                checks: [{ check: 'Input validation', passed: false, error: data.error }],
                summary: { passed: 0, failed: 1 },
              }],
        );
        setActiveTab('setup');
        return;
      }

      if (isDiscarded()) return;

      if (response.ok) {
        const validation: ValidationResult | null = data.validation ?? null;
        recordContractRun({ ...run, result: data, validation, error: null, executionTimeMs: elapsedMs });
      } else {
        const error: ExecuteErrorDetails = {
          message: data.error || `HTTP ${response.status}`,
          status: response.status,
          endpoint: data.endpoint,
          cause: data.cause,
          troubleshooting: data.troubleshooting,
          sentRequest: data.sentRequest,
        };
        recordContractRun({ ...run, result: null, validation: null, error, executionTimeMs: elapsedMs });
      }

      // Always switch to Results tab after execution
      setActiveTab('results');
    } catch {
      if (isDiscarded()) return;
      const elapsedMs = Math.round(performance.now() - startTime);
      const error: ExecuteErrorDetails = {
        message: 'Network error: could not reach the sandbox server.',
        cause: 'Sandbox server unreachable',
        troubleshooting: [
          'Ensure the sandbox development server is running.',
          'Check that the browser can reach the server on the expected port.',
        ],
      };
      recordContractRun({ ...run, result: null, validation: null, error, executionTimeMs: elapsedMs });
      setActiveTab('results');
    } finally {
      setIsExecuting(false);
    }
  }, [selectedCapability, selectedTool, inputValues, currentTool, startCapture, clearShownResult, recordContractRun]);

  const toggleCheck = useCallback((index: number) => {
    setExpandedChecks((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const handleCopyResults = useCallback(() => {
    if (!validationResult) return;
    const lines: string[] = [
      `Validation Results — ${validationResult.toolName}`,
      `Overall: ${validationResult.valid ? 'PASS' : 'FAIL'}`,
      `Passed: ${validationResult.summary.passed}  Failed: ${validationResult.summary.failed}`,
      '',
      'Checks:',
    ];
    for (const check of validationResult.checks) {
      const icon = check.passed ? '✓' : '✕';
      lines.push(`  ${icon} ${check.check} — ${check.passed ? 'PASS' : 'FAIL'}`);
      if (!check.passed && check.error) {
        lines.push(`    Error: ${check.error}`);
      }
      if (check.warning) {
        lines.push(`    Warning: ${check.warning}`);
      }
    }
    navigator.clipboard.writeText(lines.join('\n'))
      .then(() => {
        setCopyToast(true);
        setTimeout(() => setCopyToast(false), 2500);
      })
      .catch(() => { /* ignore */ });
  }, [validationResult]);

  if (!manifestInfo) {
    return (
      <div className="testing-panel">
        <h2 className="panel-title">Testing</h2>
        <div className="testing-empty">
          <p>Upload a manifest to begin testing tools.</p>
        </div>
      </div>
    );
  }

  const shownEntry = requestEntries.find((e) => e.number === selectedEntryNumber);
  const shownContractRun = shownEntry?.kind === 'contract' ? shownEntry : undefined;
  /** The inputs of the shown result: those the shown contract run was sent with, otherwise Setup's. */
  const shownInputs = shownContractRun?.inputs ?? inputValues;
  const shownEndpoint = shownContractRun ? shownContractRun.endpoint : currentTool?.endpoint;
  /** Re-running uses Setup, so it's offered only when Setup is on the tool of the shown result. */
  const canRerun = !isPartnerInitiated && (!shownEntry || (shownContractRun !== undefined
    && shownContractRun.capability === selectedCapability && shownContractRun.toolName === selectedTool));

  /** A manual Setup change stops showing the panel entry, which belongs to the previous tool. */
  const handleSetupChange = () => {
    selectToken.current++;
    pendingInputs.current = null;
    if (selectedEntryNumber !== null) clearShownResult();
    setResult(null);
    setExecuteError(null);
    setRunNotKept(false);
  };

  return (
    <div className="testing-panel">
      <div className="panel-header">
        <h2 className="panel-title">Testing</h2>
        {partnerTest.isActive && (
          <div className="panel-header-listening" role="group" aria-label="Request listener">
            <ListeningBadge phase={partnerTest.phase} announce={activeTab !== 'setup'} />
            <Button
              size="small"
              appearance="secondary"
              icon={<RecordStopRegular />}
              onClick={handleHeaderStop}
              disabledFocusable={partnerTest.phase === 'stopping'}
            >
              Stop listening
            </Button>
          </div>
        )}
      </div>

      <RequestsReceivedPanel
        entries={requestEntries}
        selectedNumber={selectedEntryNumber}
        onSelect={handleSelectEntry}
        disabled={isExecuting}
      />

      <TabList
        ref={tabListRef}
        selectedValue={activeTab}
        onTabSelect={(_, data) => setActiveTab(data.value as string)}
      >
        <Tab value="setup">Setup</Tab>
        <Tab value="results">Results</Tab>
        <Tab value="outputs">Outputs</Tab>
        <Tab value="preview">Dragon Copilot Preview</Tab>
      </TabList>

      {partnerTest.error && <div className="execute-error" role="alert">{partnerTest.error}</div>}
      {runNotKept && (
        <div className="run-not-kept" role="status">
          The run finished after the results were cleared, so it wasn't kept.
        </div>
      )}

      <div className="tab-content">
        {activeTab === 'setup' && (
          <div className="setup-tab">
            <div className="manifest-info-line">
              Manifest: <strong>{manifestInfo.name}</strong> v{manifestInfo.version}
            </div>

            <div className="form-field">
              <label className="field-label" htmlFor={capabilityId}>Capability</label>
              <Dropdown
                id={capabilityId}
                value={selectedCapabilityEntry ? selectedCapabilityLabel : ''}
                selectedOptions={[selectedCapability]}
                onOptionSelect={(_, data) => {
                  setSelectedCapability(data.optionValue as string);
                  handleSetupChange();
                }}
              >
                {capabilities.map((cap) => (
                  <Option key={cap.name} value={cap.name}>
                    {cap.displayName ?? cap.name}
                  </Option>
                ))}
              </Dropdown>
            </div>

            <div className="form-field">
              <label className="field-label" htmlFor={toolId}>Tool</label>
              <Dropdown
                id={toolId}
                value={tools.find(t => t.name === selectedTool)?.name || ''}
                selectedOptions={[selectedTool]}
                onOptionSelect={(_, data) => {
                  setSelectedTool(data.optionValue as string);
                  handleSetupChange();
                }}
              >
                {tools.map((tool) => (
                  <Option key={tool.name} value={tool.name}>
                    {tool.name}
                  </Option>
                ))}
              </Dropdown>
              {currentTool && (
                <p className="setup-body-text">{currentTool.description}</p>
              )}
              {isPartnerInitiated && (
                <>
                  <p className="setup-body-text">
                    This tool is partnerInitiated: your service submits draft reports to Dragon Copilot.
                    Click Run Test to start listening, then send submissions to the simulated endpoint below.
                    The sandbox shows each one until you stop listening.
                  </p>
                  <SimulatedEnvironmentSettings
                    refreshKey={partnerResultCount}
                    requestCount={requestEntries.length}
                    onStoredResultsCleared={handleStoredResultsCleared}
                  />
                </>
              )}
            </div>

            {!isPartnerInitiated && (
              <div className="form-field">
                <label className="field-label">Authentication</label>
                <AuthSettings />
              </div>
            )}

            {currentTool && !isPartnerInitiated && (
              <DynamicForm
                ref={formRef}
                inputs={currentTool.inputs}
                values={inputValues}
                onChange={handleInputChange}
              />
            )}

            <div className="action-bar">
              <Button
                appearance="primary"
                icon={isPartnerInitiated && partnerTest.isActive ? <RecordStopRegular /> : <CodeRegular />}
                onClick={isPartnerInitiated ? handleCaptureToggle : handleRunTest}
                disabled={isExecuting || !currentTool || partnerTest.phase === 'stopping'}
              >
                {isExecuting ? 'Running...' : isPartnerInitiated && partnerTest.isActive ? 'Stop listening' : 'Run Test'}
              </Button>
              {isPartnerInitiated && <ListeningBadge phase={partnerTest.phase} />}
              <Button
                appearance="subtle"
                icon={<ArrowCounterclockwiseRegular />}
                onClick={handleResetInputs}
              >
                Reset Inputs
              </Button>
            </div>

            {isExecuting && (
              <div className="execute-loading">
                <Spinner size="small" label="Executing tool..." />
              </div>
            )}

            {executeError && (
              <div className="execute-error">
                <strong>Error:</strong> {executeError.message}
              </div>
            )}

            {inputValidationErrors && inputValidationErrors.length > 0 && (
              <div className="input-validation-errors" role="alert">
                <div className="input-validation-header">
                  <span className="error-icon" aria-hidden="true">⚠️</span>
                  <strong>Input Schema Validation Failed</strong>
                </div>
                <p className="input-validation-summary">
                  The input data does not match the expected schema for the declared content-type(s). Fix the errors below before running the test.
                </p>
                {inputValidationErrors.map((inputErr, idx) => (
                  <div key={idx} className="input-validation-input-block">
                    <div className="input-validation-input-header">
                      <span className="check-icon check-icon-fail" aria-hidden="true">✕</span>
                      <strong>{inputErr.inputName}</strong>
                      <code className="input-content-type-badge">{inputErr.inputContentType}</code>
                    </div>
                    <ul className="input-validation-check-list">
                      {inputErr.checks.filter(c => !c.passed).map((check, cIdx) => (
                        <li key={cIdx} className="input-validation-check-item">
                          <span className="check-icon check-icon-fail" aria-hidden="true">✕</span>
                          <span className="input-validation-check-text">
                            {check.error || check.check}
                            {check.path && <code className="input-validation-path">{check.path}</code>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'results' && (
          <div className="results-tab">
            {(result || executeError) ? (
              <div className="validation-results">
                {/* Tool context card */}
                <div className="tool-context">
                  <div className="tool-context-row">
                    <div>
                      <div className="tool-context-label">Capability</div>
                      <div className="tool-context-value">{shownEntry?.capabilityLabel ?? selectedCapabilityLabel}</div>
                    </div>
                    <div>
                      <div className="tool-context-label">Tool</div>
                      <div className="tool-context-value">{shownEntry?.toolName ?? selectedTool}</div>
                    </div>
                    <div>
                      <div className="tool-context-label">{shownRequest ? 'Received' : 'Execution Time'}</div>
                      <div className="tool-context-value">
                        {shownRequest ? formatReceivedTime(shownRequest.receivedAt) : `${executionTimeMs} ms`}
                      </div>
                    </div>
                    {result && (
                      <div>
                        <div className="tool-context-label">HTTP Status</div>
                        <div className="tool-context-value">
                          {result.status}{result.statusText ? ` ${result.statusText}` : ''}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Validation Results header */}
                {validationResult && (
                  <>
                    <div className="validation-header">
                      <h2>Validation Results</h2>
                      <span className={`badge ${validationResult.valid ? 'badge-pass' : 'badge-fail'}`}>
                        <span className="badge-icon" aria-hidden="true">{validationResult.valid ? '✓' : '✕'}</span>
                        {validationResult.valid ? 'PASS' : 'FAIL'}
                      </span>
                    </div>

                    {/* Summary */}
                    <p className="validation-summary">
                      {validationResult.valid
                        ? `All ${validationResult.summary.passed} checks passed — ${shownRequest ? 'the draft report was stored' : 'response matches the expected schema'}.`
                        : `${validationResult.summary.failed} of ${validationResult.summary.passed + validationResult.summary.failed} checks failed — ${shownRequest
                          ? `${describeOutcome(shownRequest)}.`
                          : validationResult.checks.filter(c => !c.passed).map(c => c.error || c.check).join('; ')}`}
                    </p>

                    {/* Check list */}
                    <ul className="check-list" role="list" aria-label="Validation checks">
                      {validationResult.checks.map((check, index) => {
                        const hasFailed = !check.passed && !!check.error;
                        const expanded = expandedChecks.has(index);
                        return (
                          <li key={index} className={`check-item${hasFailed ? ' expandable' : ''}`} role="listitem">
                            <div
                              className="check-item-row"
                              {...(hasFailed ? {
                                role: 'button',
                                tabIndex: 0,
                                onClick: () => toggleCheck(index),
                                onKeyDown: (e: React.KeyboardEvent) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    toggleCheck(index);
                                  }
                                },
                                'aria-expanded': expanded,
                              } : {})}
                            >
                              <span className={`check-icon ${check.passed ? 'check-icon-pass' : 'check-icon-fail'}`} aria-hidden="true">
                                {check.passed ? '✓' : '✕'}
                              </span>
                              <span className="check-label">{check.check}</span>
                              <span className={`check-status ${check.passed ? 'check-status-pass' : 'check-status-fail'}`}>
                                {check.passed ? 'PASS' : 'FAIL'}
                              </span>
                              {hasFailed && <span className={`chevron${expanded ? ' open' : ''}`}>▶</span>}
                            </div>
                            {hasFailed && expanded && (
                              <div className="check-error-detail" role="alert">
                                {check.error}
                              </div>
                            )}
                            {check.warning && (
                              <div className="check-warning-detail" role="note">
                                <span aria-hidden="true">⚠ </span>
                                {check.warning}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}

                {/* Network/execution error (no validation result available) */}
                {executeError && !validationResult && (
                  <div className="execute-error-detailed" style={{ marginTop: '1rem' }}>
                    <div className="error-header">
                      <span className="error-icon" aria-hidden="true">⚠️</span>
                      <strong>{executeError.cause || 'Error'}</strong>
                    </div>
                    <p className="error-message">{executeError.message}</p>
                    {executeError.endpoint && (
                      <p className="error-endpoint">
                        <strong>Endpoint:</strong>{' '}
                        <code>{executeError.endpoint}</code>
                      </p>
                    )}
                    {executeError.troubleshooting && executeError.troubleshooting.length > 0 && (
                      <div className="error-troubleshooting">
                        <strong>Troubleshooting:</strong>
                        <ul>
                          {executeError.troubleshooting.map((tip, i) => (
                            <li key={i}>{tip}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {!!executeError.sentRequest && (
                      <p className="error-outputs-hint">
                        <Link onClick={() => setActiveTab('outputs')}>
                          View request payload in Outputs tab →
                        </Link>
                      </p>
                    )}
                  </div>
                )}

                {/* Action buttons */}
                <div className="validation-actions">
                  {canRerun && (
                    <Button
                      appearance="primary"
                      icon={<CodeRegular />}
                      onClick={handleRunTest}
                      disabled={isExecuting || !currentTool}
                    >
                      Re-run Execution
                    </Button>
                  )}
                  <Button
                    appearance="secondary"
                    icon={<CopyRegular />}
                    onClick={handleCopyResults}
                    disabled={!validationResult}
                  >
                    Copy Results
                  </Button>
                  <Button
                    appearance="secondary"
                    icon={<ArrowLeftRegular />}
                    onClick={() => setActiveTab('setup')}
                  >
                    Back to Setup
                  </Button>
                </div>

                {/* Session persistence banner */}
                {validationResult && (
                  <div className="session-banner">
                    <span className="session-banner-icon">ℹ</span>
                    Results saved to session - will be included in the consolidated validation report.
                  </div>
                )}
              </div>
            ) : (
              <p className="results-empty">
                {!isPartnerInitiated
                  ? 'No results yet. Run a test from the Setup tab.'
                  : partnerTest.isActive
                    ? 'No requests yet. Send one to the endpoint shown in the Setup tab.'
                    : 'No requests yet. Click Run Test, then send a request to the endpoint.'}
              </p>
            )}

            {/* Copy-to-clipboard toast */}
            {copyToast && <div className="copy-toast" role="status" aria-live="polite">✓ Results copied to clipboard</div>}
          </div>
        )}

        {activeTab === 'outputs' && (
          <div className="outputs-tab">
            {shownRequest ? (
              <div className="outputs-display">
                <h3 className="outputs-section-title">Received Request Payload</h3>
                <div className="request-method-badge">POST {new URL(shownRequest.path, window.location.origin).href}</div>
                <pre className="dark-code-block">
                  {shownRequest.rawBody === undefined
                    ? 'No request body'
                    : typeof shownRequest.rawBody === 'string' ? shownRequest.rawBody : JSON.stringify(shownRequest.rawBody, null, 2)}
                </pre>

                <h3 className="outputs-section-title">Endpoint Response</h3>
                <pre className="dark-code-block">
                  {[
                    `HTTP ${shownRequest.status} ${shownRequest.statusText}`.trim(),
                    ...Object.entries(shownRequest.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
                    '',
                    shownRequest.responseBody === undefined
                      ? '(no body)'
                      : JSON.stringify(shownRequest.responseBody, null, 2),
                  ].join('\n')}
                </pre>
              </div>
            ) : result && (shownContractRun || currentTool) ? (
              <div className="outputs-display">
                <h3 className="outputs-section-title">Request Payload</h3>
                <div className="request-method-badge">POST {shownEndpoint ?? '(no endpoint)'}</div>
                <pre className="dark-code-block">
                  {result.sentRequest
                    ? JSON.stringify(result.sentRequest, null, 2)
                    : JSON.stringify({ endpoint: shownEndpoint, payload: shownInputs }, null, 2)}
                </pre>

                <h3 className="outputs-section-title">Response Payload</h3>
                <pre className="dark-code-block">
                  {result.processResponse
                    ? JSON.stringify(result.processResponse, null, 2)
                    : result.rawBody
                      ? (typeof result.rawBody === 'string' ? result.rawBody : JSON.stringify(result.rawBody, null, 2))
                      : 'No output data'}
                </pre>
              </div>
            ) : executeError ? (
              <div className="outputs-display">
                {!!executeError.sentRequest && (
                  <>
                    <h3 className="outputs-section-title">Request Payload</h3>
                    <div className="request-method-badge">POST {executeError.endpoint || ''}</div>
                    <pre className="dark-code-block">{JSON.stringify(executeError.sentRequest, null, 2)}</pre>
                  </>
                )}

                <h3 className="outputs-section-title">Response Payload <span className="sandbox-generated-label">(Sandbox-generated error context, not from extension)</span></h3>
                <pre className="dark-code-block">{JSON.stringify({
                  errorCode: executeError.cause?.toUpperCase().replace(/\s+/g, '_') || 'MISSING_REQUIRED_INPUT',
                  requiredMissing: Object.keys(shownInputs).filter(k => !shownInputs[k]),
                }, null, 2)}</pre>
              </div>
            ) : (
              <p className="results-empty">No outputs yet. Run a test from the Setup tab.</p>
            )}
          </div>
        )}

        {activeTab === 'preview' && (
          <div className="preview-tab">
            <DragonCopilotPreview
              toolType={shownEntry ? (shownEntry.kind === 'partner' ? PARTNER_INITIATED : shownEntry.toolType) : currentTool?.toolType}
              result={result}
              executionError={!shownContractRun && isPartnerInitiated && partnerTest.error && !result
                ? { message: partnerTest.error }
                : executeError}
              toolName={shownEntry?.toolName ?? (selectedTool || undefined)}
              extensionName={manifestInfo.name}
              listening={isPartnerInitiated && partnerTest.isActive}
            />
          </div>
        )}
      </div>
    </div>
  );
}
