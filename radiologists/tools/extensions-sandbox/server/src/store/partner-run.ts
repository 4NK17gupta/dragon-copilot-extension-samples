import { randomUUID } from 'node:crypto';
import type { ManifestTool } from '../schemas/manifest.schema.js';
import type { ValidationResult } from '../services/validation.js';

/** The most requests a capture keeps. Older ones are dropped, but still counted. */
export const MAX_CAPTURED_REQUESTS = 20;

export interface PartnerRunResult {
  /** The path the request was sent to. */
  path: string;
  /** The status the simulated endpoint answered with. */
  status: number;
  statusText: string;
  /** The response headers that matter to the caller. */
  headers: Record<string, string>;
  /** The request body, parsed as JSON when it parses, otherwise its text. */
  rawBody: unknown;
  /** The response body, parsed as JSON when there is one. */
  responseBody?: unknown;
  validation: ValidationResult;
}

export interface CapturedRequest extends PartnerRunResult {
  /** 1 for the capture's first request, then 2, 3 and so on. */
  sequence: number;
  /** When the request was answered, as an ISO 8601 timestamp. */
  receivedAt: string;
}

export interface PartnerRun {
  runId: string;
  status: 'capturing';
  /** How many requests the capture has recorded, including any no longer kept. */
  count: number;
  /** The kept requests, oldest first. */
  requests: CapturedRequest[];
}

interface OpenCapture {
  public: PartnerRun;
  tool: ManifestTool;
}

/**
 * The capture Run Test starts for a partnerInitiated tool. While a capture is open, the simulated
 * Dragon Copilot endpoint answers requests and records each one. Only one capture is open at a time.
 */
export class PartnerRunStore {
  private run: OpenCapture | null = null;

  start(tool: ManifestTool): PartnerRun {
    this.run = {
      public: { runId: randomUUID(), status: 'capturing', count: 0, requests: [] },
      tool: structuredClone(tool),
    };
    return this.get(this.run.public.runId)!;
  }

  /** Gets the capture with only the requests recorded after the given sequence number. */
  get(runId: string, after = 0): PartnerRun | null {
    if (this.run?.public.runId !== runId) return null;
    const { requests, ...capture } = this.run.public;
    return { ...capture, requests: requests.filter((request) => request.sequence > after) };
  }

  /** Gets the open capture, or null when none is open. */
  active(): { runId: string; tool: ManifestTool } | null {
    return this.run && { runId: this.run.public.runId, tool: this.run.tool };
  }

  /**
   * Records a request in the capture.
   * @returns The recorded request, or null when the capture was stopped or replaced while the
   * request was being answered.
   */
  record(runId: string, result: PartnerRunResult): CapturedRequest | null {
    if (!this.run || this.run.public.runId !== runId) return null;
    const capture = this.run.public;
    const request: CapturedRequest = { ...result, sequence: capture.count + 1, receivedAt: new Date().toISOString() };
    capture.count = request.sequence;
    capture.requests = [...capture.requests, request].slice(-MAX_CAPTURED_REQUESTS);
    return request;
  }

  clear(runId?: string): void {
    if (runId === undefined || this.run?.public.runId === runId) this.run = null;
  }
}
