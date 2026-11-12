export interface ExecuteResult {
  status: number;
  statusText: string;
  headers?: Record<string, string>;
  processResponse?: { success?: boolean; message?: string; payload?: Record<string, unknown> } | null;
  rawBody?: unknown;
  sentRequest?: unknown;
}

/** Why a contract-based run failed, as shown in the Results tab. */
export interface ExecuteErrorDetails {
  message: string;
  /** The HTTP status the sandbox server answered with. Absent when the server was unreachable. */
  status?: number;
  endpoint?: string;
  cause?: string;
  troubleshooting?: string[];
  sentRequest?: unknown;
}

export interface ValidationCheck {
  check: string;
  passed: boolean;
  path?: string;
  error?: string;
  /** Advice for a check that passed, such as a value Dragon Copilot accepts but the schema advises against. */
  warning?: string;
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
