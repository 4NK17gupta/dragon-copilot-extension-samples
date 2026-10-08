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
}
