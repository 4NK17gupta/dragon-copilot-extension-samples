export interface ExecuteResult {
  status: number;
  statusText: string;
  headers?: Record<string, string>;
  processResponse?: { success?: boolean; message?: string; payload?: Record<string, unknown> } | null;
  rawBody?: unknown;
  sentRequest?: unknown;
}

export interface ValidationCheck {
  check: string;
  passed: boolean;
  path?: string;
  error?: string;
}

export interface ValidationResult {
  valid: boolean;
  toolName: string;
  outputContentType: string;
  checks: ValidationCheck[];
  summary: { passed: number; failed: number };
  timestamp: string;
}

export interface PartnerInitiatedResult extends ExecuteResult {
  validation: ValidationResult;
  /** The body of the simulated endpoint's response, when it had one. */
  responseBody?: unknown;
}

/** A request the simulated Dragon Copilot endpoint answered while the sandbox was capturing. */
export interface CapturedRequest extends PartnerInitiatedResult {
  /** 1 for a capture's first request, then 2, 3 and so on. */
  sequence: number;
  /** When the sandbox answered the request, as an ISO 8601 timestamp. */
  receivedAt: string;
  /** The path the request was sent to. */
  path: string;
}
