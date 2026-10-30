import { randomUUID } from 'node:crypto';

export const DEFAULT_VENDOR_NAME = 'Sample Imaging Vendor';

/**
 * Accession numbers of the simulated environment's orders. A number listed twice
 * stands for two orders, so it exercises the 409 MultipleOrdersMatched path.
 */
export const DEFAULT_ORDERS: readonly string[] = [
  'ACC-0000001',
  'ACC-0000002',
  'ACC-0000003',
  'ACC-AMBIGUOUS',
  'ACC-AMBIGUOUS',
];

/** Oldest results are dropped beyond this, so memory stays bounded (bodies are up to 1 MB). */
export const MAX_STORED_RESULTS = 100;

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

export interface DraftReportSubmission {
  partnerTenantId: string;
  extensionName: string;
  toolName: string;
  identifier: string;
  accessionNumber: string;
  aiModelVersion: string;
  draftReport: unknown;
}

interface StoredDraftReport {
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

function defaultSettings(): DraftReportSettings {
  return { vendorName: DEFAULT_VENDOR_NAME, orders: [...DEFAULT_ORDERS] };
}

/**
 * The draft reports stored in the sandbox's single simulated customer environment,
 * and the orders they are matched to. It is independent of the loaded manifest, as
 * stored results in Dragon Copilot outlive the extension that submitted them, so
 * results from several extensions can be retrieved together.
 */
export class DraftReportResultStore {
  private settings = defaultSettings();
  private readonly identifiers = new Set<string>();
  /** Keyed by partner tenant, extension, tool and accession number, oldest first. */
  private readonly results = new Map<string, StoredDraftReport>();

  getSettings(): DraftReportSettings {
    return { vendorName: this.settings.vendorName, orders: [...this.settings.orders] };
  }

  updateSettings(update: Partial<DraftReportSettings>): DraftReportSettings {
    this.settings = {
      vendorName: update.vendorName ?? this.settings.vendorName,
      orders: update.orders ? [...update.orders] : this.settings.orders,
    };
    return this.getSettings();
  }

  resetSettings(): void {
    this.settings = defaultSettings();
  }

  hasIdentifier(identifier: string): boolean {
    return this.identifiers.has(identifier);
  }

  countOrders(accessionNumber: string): number {
    return this.settings.orders.filter((order) => order === accessionNumber).length;
  }

  /**
   * Stores a submission. A newer submission for the same tool and accession number
   * replaces the earlier one, as Dragon Copilot keeps one draft per study and tool.
   */
  store(submission: DraftReportSubmission): void {
    // Serialized before anything is recorded, so a body that can't be serialized
    // changes nothing and the identifier can still be submitted.
    const output = JSON.stringify({
      partnerTenantId: submission.partnerTenantId,
      extensionName: submission.extensionName,
      toolName: submission.toolName,
      draftReport: submission.draftReport,
    });
    const key = JSON.stringify([
      submission.partnerTenantId.toLowerCase(),
      submission.extensionName.toLowerCase(),
      submission.toolName.toLowerCase(),
      submission.accessionNumber,
    ]);

    this.identifiers.add(submission.identifier);
    while (this.identifiers.size > MAX_STORED_IDENTIFIERS) {
      this.identifiers.delete(this.identifiers.values().next().value!);
    }

    // Delete first so the replacement moves to the end, keeping the map oldest first.
    this.results.delete(key);
    this.results.set(key, {
      accessionNumber: submission.accessionNumber,
      vendorName: this.settings.vendorName,
      aiModelName: submission.toolName,
      aiModelVersion: submission.aiModelVersion,
      output,
    });
    while (this.results.size > MAX_STORED_RESULTS) {
      this.results.delete(this.results.keys().next().value!);
    }
  }

  /**
   * Returns every stored result for an accession number, from any extension, in the
   * shape Dragon Copilot returns them in. No result gives an empty collection.
   */
  retrieve(accessionNumber: string): DraftReportRetrieveResponse {
    const outputs: DraftReportRetrieveOutput[] = [];
    for (const result of this.results.values()) {
      if (result.accessionNumber !== accessionNumber) continue;
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

  get size(): number {
    return this.results.size;
  }

  clearResults(): void {
    this.identifiers.clear();
    this.results.clear();
  }
}
