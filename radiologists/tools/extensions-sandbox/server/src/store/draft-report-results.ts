import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_VENDOR_NAME = 'Sample Imaging Vendor';

/** Oldest results are dropped beyond this, so memory stays bounded. */
export const MAX_STORED_RESULTS = 100;

/**
 * Oldest results are also dropped while their outputs total more than this many characters, as a
 * draft report can be nearly as large as the body limit. The newest result is always kept.
 */
export const MAX_STORED_OUTPUT_LENGTH = 50_000_000;

/** Oldest identifiers are forgotten beyond this; a forgotten identifier is accepted again. */
export const MAX_STORED_IDENTIFIERS = 10_000;

export const MAX_ORDERS = 1_000;
export const MAX_SETTING_LENGTH = 256;

export interface DraftReportSettings {
  /** Reported as `aiModelsInformation[].vendorName` on retrieve for results stored while it is set. */
  vendorName: string;
  /** Accession numbers of the orders in the simulated environment. */
  orders: string[];
}

/** A submission Dragon Copilot accepted, with what the retrieve simulation reports for it. */
export interface DraftReportResult {
  environmentId: string;
  partnerTenantId: string;
  extensionName: string;
  toolName: string;
  identifier: string;
  accessionNumber: string;
  aiModelVersion: string;
  draftReport: unknown;
}

interface StoredDraftReport {
  environmentId: string;
  accessionNumber: string;
  vendorName: string;
  aiModelName: string;
  aiModelVersion: string;
  /** The retrieve `output`, serialized when stored so later changes to the body can't alter it. */
  output: string;
}

export interface AiModelInformation {
  vendorName: string;
  aiModelName: string;
  aiModelVersion: string;
}

export interface DraftReportRetrieveOutput {
  alias: 'DraftReport';
  output: string;
  aiModelsInformation: AiModelInformation[];
}

export interface DraftReportRetrieveResponse {
  capabilityExecutionId: string;
  capabilityExecutionResults: { outputs: DraftReportRetrieveOutput[] };
}

/** Environment IDs are GUIDs, so they match ignoring case. */
function environmentKey(environmentId: string): string {
  return environmentId.toUpperCase();
}

/** Hashed, so an identifier as long as the body doesn't stay in memory. */
function identifierKey(environmentId: string, identifier: string): string {
  return createHash('sha256').update(`${environmentKey(environmentId)}\t${identifier}`).digest('base64');
}

/**
 * The draft reports stored in the simulated customer environments, and the identifiers Dragon Copilot
 * checks before it stores another. Stored results don't depend on the loaded manifest, as in Dragon
 * Copilot they outlive the extension that submitted them, so results from several extensions can be
 * retrieved together.
 */
export class DraftReportResultStore {
  private vendor = DEFAULT_VENDOR_NAME;
  /** Identifiers of stored results, by environment, oldest first. */
  private readonly identifiers = new Set<string>();
  /** Keyed by environment, partner tenant, extension, tool and accession number, oldest first. */
  private readonly results = new Map<string, StoredDraftReport>();
  private outputLength = 0;

  get vendorName(): string {
    return this.vendor;
  }

  set vendorName(vendorName: string) {
    this.vendor = vendorName;
  }

  resetVendorName(): void {
    this.vendor = DEFAULT_VENDOR_NAME;
  }

  hasIdentifier(environmentId: string, identifier: string): boolean {
    return this.identifiers.has(identifierKey(environmentId, identifier));
  }

  /**
   * Stores a result. A newer result for the same tool and accession number replaces the earlier one,
   * as Dragon Copilot keeps one draft per study and tool.
   */
  store(result: DraftReportResult): void {
    // Serialized before anything is recorded, so a body that can't be serialized
    // changes nothing and the identifier can still be submitted.
    const output = JSON.stringify({
      partnerTenantId: result.partnerTenantId,
      extensionName: result.extensionName,
      toolName: result.toolName,
      draftReport: result.draftReport,
    });
    const key = JSON.stringify([
      environmentKey(result.environmentId),
      result.partnerTenantId.toLowerCase(),
      result.extensionName.toLowerCase(),
      result.toolName.toLowerCase(),
      result.accessionNumber,
    ]);

    // Deleted first so a repeated key moves to the end, keeping both collections oldest first.
    const identifier = identifierKey(result.environmentId, result.identifier);
    this.identifiers.delete(identifier);
    this.identifiers.add(identifier);
    while (this.identifiers.size > MAX_STORED_IDENTIFIERS) {
      this.identifiers.delete(this.identifiers.values().next().value!);
    }

    this.delete(key);
    this.results.set(key, {
      environmentId: environmentKey(result.environmentId),
      accessionNumber: result.accessionNumber,
      vendorName: this.vendor,
      aiModelName: result.toolName,
      aiModelVersion: result.aiModelVersion,
      output,
    });
    this.outputLength += output.length;
    while (this.results.size > 1 && (this.results.size > MAX_STORED_RESULTS || this.outputLength > MAX_STORED_OUTPUT_LENGTH)) {
      this.delete(this.results.keys().next().value!);
    }
  }

  /**
   * Returns every result stored in an environment for an accession number, from any extension, in the
   * shape Dragon Copilot returns them in. No result gives an empty collection.
   */
  retrieve(environmentId: string, accessionNumber: string): DraftReportRetrieveResponse {
    const environment = environmentKey(environmentId);
    const outputs: DraftReportRetrieveOutput[] = [];
    for (const result of this.results.values()) {
      if (result.environmentId !== environment || result.accessionNumber !== accessionNumber) continue;
      outputs.push({
        alias: 'DraftReport',
        output: result.output,
        aiModelsInformation: [{
          vendorName: result.vendorName,
          aiModelName: result.aiModelName,
          aiModelVersion: result.aiModelVersion,
        }],
      });
    }
    return { capabilityExecutionId: randomUUID(), capabilityExecutionResults: { outputs } };
  }

  /** How many identifiers are stored, in every environment. */
  get identifierCount(): number {
    return this.identifiers.size;
  }

  /** How many results are kept for retrieve. */
  get size(): number {
    return this.results.size;
  }

  clearResults(): void {
    this.identifiers.clear();
    this.results.clear();
    this.outputLength = 0;
  }

  private delete(key: string): void {
    const stored = this.results.get(key);
    if (stored) {
      this.outputLength -= stored.output.length;
      this.results.delete(key);
    }
  }
}