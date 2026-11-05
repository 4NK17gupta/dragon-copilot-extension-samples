import type { ExtensionManifest, ManifestTool } from '../schemas/manifest.schema.js';
import type { DraftReportSubmission } from '../services/draft-report-submission/request-binder.js';
import {
  DraftReportResultStore,
  MAX_ORDERS,
  MAX_SETTING_LENGTH,
  type DraftReportRetrieveResponse,
  type DraftReportSettings,
} from './draft-report-results.js';

/** The Microsoft Marketplace offer and plan an extension was purchased with. */
export interface MarketplaceIds {
  publisherId: string;
  offerId: string;
  planId: string;
}

/** The customer environment the simulated Dragon Copilot endpoint stands in for. */
export interface SimulatedEnvironmentSettings {
  customerTenantId: string;
  environmentId: string;
  /** The IDs the loaded extension was purchased with, or null when it was uploaded as a custom app. */
  marketplace: MarketplaceIds | null;
  /** The accession numbers of the environment's orders. A number listed twice has two orders. */
  orders: string[];
}

/**
 * The default tenant, environment and order. The order is the bundled example's accession number. The
 * extension starts as a custom app, with no Marketplace IDs, as it is during development.
 */
export function defaultSimulatedEnvironment(): SimulatedEnvironmentSettings {
  return {
    customerTenantId: '11111111-1111-1111-1111-111111111111',
    environmentId: '22222222-2222-2222-2222-222222222222',
    marketplace: null,
    orders: ['ACC-0000001'],
  };
}

/** The steps Dragon Copilot takes to store a valid submission, in order. */
export const SUBMISSION_STEPS = ['environment', 'extension', 'tool', 'storedResult', 'order'] as const;
export type SubmissionStep = (typeof SUBMISSION_STEPS)[number];

export type SubmissionReason =
  | 'EnvironmentNotFound'
  | 'ExtensionNotFound'
  | 'MultipleExtensionsMatched'
  | 'ToolNotFound'
  | 'ResultAlreadyStored'
  | 'OrderNotFound'
  | 'MultipleOrdersMatched';

export type SubmissionOutcome =
  | { status: 200 }
  | { status: 404 | 409; reason: SubmissionReason; step: SubmissionStep };

const GUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const EMPTY_GUID = /^[0-]+$/;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;
const MAX_ID_LENGTH = MAX_SETTING_LENGTH;

function equalsIgnoreCase(left: string | null | undefined, right: string | null | undefined): boolean {
  return left != null && right != null && left.length === right.length && left.toUpperCase() === right.toUpperCase();
}

function copy(settings: SimulatedEnvironmentSettings): SimulatedEnvironmentSettings {
  return {
    customerTenantId: settings.customerTenantId,
    environmentId: settings.environmentId,
    marketplace: settings.marketplace ? { ...settings.marketplace } : null,
    orders: [...settings.orders],
  };
}

/**
 * Checks settings sent by the client.
 * @returns The settings, trimmed, or a message saying what is wrong.
 */
export function parseSimulatedEnvironmentSettings(input: unknown): { settings: SimulatedEnvironmentSettings } | { error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'Send the settings as a JSON object.' };
  }
  const { customerTenantId, environmentId, marketplace, orders } = input as Record<string, unknown>;

  const ids: Record<string, string> = {};
  for (const [name, value] of [['customerTenantId', customerTenantId], ['environmentId', environmentId]] as const) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!GUID.test(id) || EMPTY_GUID.test(id)) {
      return { error: `${name} must be a non-empty GUID, such as ${defaultSimulatedEnvironment()[name]}.` };
    }
    ids[name] = id;
  }

  let marketplaceIds: MarketplaceIds | null = null;
  if (marketplace !== null && marketplace !== undefined) {
    if (typeof marketplace !== 'object' || Array.isArray(marketplace)) {
      return { error: 'marketplace must be an object with publisherId, offerId and planId, or null for a custom app.' };
    }
    const parts: Record<string, string> = {};
    for (const name of ['publisherId', 'offerId', 'planId']) {
      const value = (marketplace as Record<string, unknown>)[name];
      const id = typeof value === 'string' ? value.trim() : '';
      if (id.length === 0 || id.length > MAX_ID_LENGTH || CONTROL_CHARACTER.test(id)) {
        return { error: `marketplace.${name} must be 1 to ${MAX_ID_LENGTH} characters with no control characters.` };
      }
      parts[name] = id;
    }
    marketplaceIds = { publisherId: parts.publisherId, offerId: parts.offerId, planId: parts.planId };
  }

  if (!Array.isArray(orders) || orders.length > MAX_ORDERS) {
    return { error: `orders must be a list of up to ${MAX_ORDERS} accession numbers.` };
  }
  const accessionNumbers: string[] = [];
  for (const order of orders) {
    const accessionNumber = typeof order === 'string' ? order.trim() : '';
    if (accessionNumber.length === 0 || accessionNumber.length > MAX_ID_LENGTH) {
      return { error: `Each accession number must be 1 to ${MAX_ID_LENGTH} characters.` };
    }
    accessionNumbers.push(accessionNumber);
  }

  return {
    settings: {
      customerTenantId: ids.customerTenantId,
      environmentId: ids.environmentId,
      marketplace: marketplaceIds,
      orders: accessionNumbers,
    },
  };
}

/**
 * The customer environment the simulated endpoint answers for. The extension installed in it is the
 * manifest loaded in the sandbox. Like the rest of the sandbox, it is held in memory for a single user.
 */
export class SimulatedEnvironment {
  private settings = defaultSimulatedEnvironment();
  private readonly results = new DraftReportResultStore();

  getSettings(): SimulatedEnvironmentSettings {
    return copy(this.settings);
  }

  setSettings(settings: SimulatedEnvironmentSettings): void {
    this.settings = copy(settings);
  }

  /** The path of the submission endpoint for this environment. */
  get submissionPath(): string {
    const { customerTenantId, environmentId } = this.settings;
    return `/api/v1/tenants/${encodeURIComponent(customerTenantId)}/environments/${encodeURIComponent(environmentId)}/draft-report-ai-results`;
  }

  /** How many results are stored, in every environment. */
  get storedResultCount(): number {
    return this.results.identifierCount;
  }

  clearStoredResults(): void {
    this.results.clearResults();
  }

  /** Restores the defaults and forgets stored results. */
  reset(): void {
    this.settings = defaultSimulatedEnvironment();
    this.results.clearResults();
    this.results.resetVendorName();
  }

  /** The vendor name the retrieve simulation reports, and the orders submissions are matched to. */
  getResultSettings(): DraftReportSettings {
    return { vendorName: this.results.vendorName, orders: [...this.settings.orders] };
  }

  updateResultSettings(update: Partial<DraftReportSettings>): DraftReportSettings {
    if (update.vendorName !== undefined) {
      this.results.vendorName = update.vendorName;
    }
    if (update.orders !== undefined) {
      this.settings = { ...copy(this.settings), orders: [...update.orders] };
    }
    return this.getResultSettings();
  }

  /** Returns the results stored in this environment for an accession number, as Dragon Copilot does. */
  retrieve(accessionNumber: string): DraftReportRetrieveResponse {
    return this.results.retrieve(this.settings.environmentId, accessionNumber);
  }

  /**
   * Stores a valid submission, checking it in Dragon Copilot's order: environment, extension, tool,
   * stored result, then order.
   * @param submission The submission.
   * @param manifest The loaded manifest, which is the extension installed in the environment.
   */
  submit(submission: DraftReportSubmission, manifest: ExtensionManifest | null): SubmissionOutcome {
    const { settings } = this;
    if (!equalsIgnoreCase(settings.customerTenantId, submission.customerTenantId)
      || !equalsIgnoreCase(settings.environmentId, submission.environmentId)) {
      return { status: 404, reason: 'EnvironmentNotFound', step: 'environment' };
    }

    const installations = manifest ? [{ manifest, marketplace: settings.marketplace }] : [];
    const matches = installations.filter((installation) =>
      // With Marketplace IDs, only an extension purchased with that offer and plan matches, so an
      // extension uploaded as a custom app never does.
      (submission.publisherId === null
        || (equalsIgnoreCase(installation.marketplace?.publisherId, submission.publisherId)
          && equalsIgnoreCase(installation.marketplace?.offerId, submission.offerId)
          && equalsIgnoreCase(installation.marketplace?.planId, submission.planId)))
      && equalsIgnoreCase(installation.manifest.name, submission.manifestName));
    if (matches.length === 0) {
      return { status: 404, reason: 'ExtensionNotFound', step: 'extension' };
    }
    if (matches.length > 1) {
      return { status: 409, reason: 'MultipleExtensionsMatched', step: 'extension' };
    }

    const { manifest: installed } = matches[0];
    const submitsDrafts = (tool: ManifestTool) => equalsIgnoreCase(tool.toolType, 'partnerInitiated')
      && equalsIgnoreCase(tool.capability, 'preDraftReportGeneration');
    // A tool named exactly as sent is stored under its own name when the manifest also has one that
    // differs only in case.
    const tool = installed.tools.find((candidate) => candidate.name === submission.toolName && submitsDrafts(candidate))
      ?? installed.tools.find((candidate) => equalsIgnoreCase(candidate.name, submission.toolName) && submitsDrafts(candidate));
    if (!tool) {
      return { status: 404, reason: 'ToolNotFound', step: 'tool' };
    }

    if (this.results.hasIdentifier(submission.environmentId, submission.identifier)) {
      return { status: 409, reason: 'ResultAlreadyStored', step: 'storedResult' };
    }

    const orders = settings.orders.filter((order) => order === submission.accessionNumber).length;
    if (orders === 0) {
      return { status: 404, reason: 'OrderNotFound', step: 'order' };
    }
    if (orders > 1) {
      return { status: 409, reason: 'MultipleOrdersMatched', step: 'order' };
    }

    this.results.store({
      environmentId: submission.environmentId,
      // Dragon Copilot takes this from the access token's tenant, which must equal the manifest's
      // auth.tenantId for the extension to match.
      partnerTenantId: installed.auth.tenantId,
      extensionName: installed.name,
      toolName: tool.name,
      identifier: submission.identifier,
      accessionNumber: submission.accessionNumber,
      aiModelVersion: submission.aiModelVersion,
      draftReport: submission.draftReport,
    });
    return { status: 200 };
  }
}

export const simulatedEnvironment = new SimulatedEnvironment();
