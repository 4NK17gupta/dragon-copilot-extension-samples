import { randomUUID } from 'node:crypto';
import type { ExtensionManifest, ManifestTool } from '../schemas/manifest.schema.js';
import type { ValidationResult } from '../services/validation.js';

export interface PartnerRunResult {
  status: number;
  statusText: string;
  rawBody: unknown;
  validation: ValidationResult;
}

export interface PartnerRun {
  runId: string;
  status: 'waiting' | 'completed';
  callbackPath: string;
  result?: PartnerRunResult;
}

interface ActivePartnerRun {
  public: PartnerRun;
  tenantId: string;
  tool: ManifestTool;
  claimed: boolean;
}

/** One bounded, single-user run; claim before reading the body to prevent races. */
export class PartnerRunStore {
  private run: ActivePartnerRun | null = null;

  start(manifest: ExtensionManifest, tool: ManifestTool): PartnerRun {
    this.run = {
      public: {
        runId: randomUUID(),
        status: 'waiting',
        callbackPath: `/api/partnerInitiated/${encodeURIComponent(manifest.auth.tenantId)}/${encodeURIComponent(tool.name)}`,
      },
      tenantId: manifest.auth.tenantId,
      tool: structuredClone(tool),
      claimed: false,
    };
    return this.run.public;
  }

  get(runId: string): PartnerRun | null {
    return this.run?.public.runId === runId ? this.run.public : null;
  }

  claim(tenantId: string, toolName: string): { runId: string; tool: ManifestTool } | number {
    if (!this.run || this.run.tenantId !== tenantId || this.run.tool.name !== toolName) return 404;
    if (this.run.claimed || this.run.public.status !== 'waiting') return 409;
    this.run.claimed = true;
    return { runId: this.run.public.runId, tool: this.run.tool };
  }

  complete(runId: string, result: PartnerRunResult): boolean {
    if (!this.run || this.run.public.runId !== runId || this.run.public.status !== 'waiting') return false;
    this.run.public = { ...this.run.public, status: 'completed', result };
    return true;
  }

  clear(runId?: string): void {
    if (runId === undefined || this.run?.public.runId === runId) this.run = null;
  }
}
