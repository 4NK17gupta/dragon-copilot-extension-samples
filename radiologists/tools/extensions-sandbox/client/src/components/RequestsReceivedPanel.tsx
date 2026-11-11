import { useId } from 'react';
import { Dropdown, Option } from '@fluentui/react-components';
import type { CapturedRequest, ExecuteErrorDetails, ExecuteResult, ValidationResult } from '../types/testing';
import type { ToolType } from '../types/manifest';
import { describeOutcome, formatReceivedTime } from './captureText';

/** The most requests the panel lists. The oldest are dropped first. */
export const MAX_PANEL_ENTRIES = 50;

interface EntryBase {
  /** 1 for the first entry since the panel was last emptied, then 2, 3 and so on. */
  number: number;
  /** The manifest capability Setup was on when the entry was added. */
  capability: string;
  /** The capability's display name when the entry was added. */
  capabilityLabel: string;
  /** The tool Setup was on when the entry was added. */
  toolName: string;
}

/** A submission the simulated Dragon Copilot endpoint received from a partner service. */
export interface PartnerEntry extends EntryBase {
  kind: 'partner';
  request: CapturedRequest;
}

/** A Run Test of a contractBased tool, kept so it can be shown again without re-running it. */
export interface ContractEntry extends EntryBase {
  kind: 'contract';
  /** When the run finished, as an ISO 8601 timestamp. */
  receivedAt: string;
  /** The Setup inputs the run sent. */
  inputs: Record<string, string>;
  result: ExecuteResult | null;
  validation: ValidationResult | null;
  error: ExecuteErrorDetails | null;
  executionTimeMs: number;
  /** The tool's endpoint at the time of the run. */
  endpoint?: string;
  toolType?: ToolType;
}

/** An entry in the Requests received panel. */
export type RequestEntry = PartnerEntry | ContractEntry;

/** For example "200 OK", "502 DNS resolution failed" or "Sandbox server unreachable". */
function describeContractOutcome({ result, error }: ContractEntry): string {
  if (result) return `${result.status} ${result.statusText}`.trim();
  if (error?.status !== undefined) return `${error.status} ${error.cause ?? 'Error'}`;
  return error?.cause ?? 'Error';
}

/** For example "#5 · 2:46:00 PM · Draft Report Generation · 200 OK". */
export function entryLabel(entry: RequestEntry): string {
  const [time, outcome] = entry.kind === 'partner'
    ? [entry.request.receivedAt, describeOutcome(entry.request)]
    : [entry.receivedAt, describeContractOutcome(entry)];
  return `#${entry.number} · ${formatReceivedTime(time)} · ${entry.capabilityLabel} · ${outcome}`;
}

function countText(count: number): string {
  if (count === 0) return 'No requests yet';
  return `${count} ${count === 1 ? 'request' : 'requests'} received`;
}

interface RequestsReceivedPanelProps {
  /** Newest first. */
  entries: RequestEntry[];
  /** The number of the entry the Results, Outputs and Dragon Copilot Preview tabs show. */
  selectedNumber: number | null;
  onSelect: (number: number) => void;
}

/**
 * Lists the requests the sandbox has received, above the testing tabs so that any of them can be
 * picked from any tab.
 */
export function RequestsReceivedPanel({ entries, selectedNumber, onSelect }: RequestsReceivedPanelProps) {
  const labelId = useId();
  const dropdownId = useId();
  const selected = entries.find((entry) => entry.number === selectedNumber);

  return (
    <section className="requests-panel" aria-labelledby={labelId}>
      <label id={labelId} className="requests-panel-label" htmlFor={dropdownId}>Requests received</label>
      <span className="requests-panel-count" aria-hidden="true">{entries.length}</span>
      <span className="visually-hidden" aria-live="polite">{countText(entries.length)}</span>
      <Dropdown
        id={dropdownId}
        className="requests-panel-dropdown"
        placeholder={entries.length === 0 ? 'No requests yet' : 'Select a request'}
        disabled={entries.length === 0}
        value={selected ? entryLabel(selected) : ''}
        selectedOptions={selected ? [String(selected.number)] : []}
        onOptionSelect={(_, data) => {
          if (data.optionValue) onSelect(Number(data.optionValue));
        }}
      >
        {entries.map((entry) => (
          <Option key={entry.number} value={String(entry.number)}>
            {entryLabel(entry)}
          </Option>
        ))}
      </Dropdown>
    </section>
  );
}
