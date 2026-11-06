import { Router, json } from 'express';
import { MAX_ORDERS, MAX_SETTING_LENGTH, type DraftReportSettings } from '../store/draft-report-results.js';
import { simulatedEnvironment } from '../store/simulated-environment.js';

/**
 * Sandbox-only routes for the draft reports the simulated endpoint stores: a retrieve simulation and
 * its settings. Mount at `/api/draft-report-ai-results`, before the global JSON parser.
 */
export const draftReportResultsRouter = Router();

/**
 * GET /api/draft-report-ai-results?accessionNumber=...
 * Returns every result stored in the simulated environment for the accession number, from any
 * extension, shaped as Dragon Copilot's retrieve response. The accession number is a query parameter
 * so the request logger, which logs only the path, never records it.
 */
draftReportResultsRouter.get('/', (req, res) => {
  const { accessionNumber } = req.query;
  if (typeof accessionNumber !== 'string' || !accessionNumber.trim()) {
    res.status(400).json({ error: 'accessionNumber query parameter is required.' });
    return;
  }
  res.json(simulatedEnvironment.retrieve(accessionNumber));
});

/** DELETE /api/draft-report-ai-results — forgets every stored result and identifier. */
draftReportResultsRouter.delete('/', (_req, res) => {
  simulatedEnvironment.clearStoredResults();
  res.sendStatus(204);
});

/** GET /api/draft-report-ai-results/settings — the vendor name and orders of the simulated environment. */
draftReportResultsRouter.get('/settings', (_req, res) => {
  res.json(simulatedEnvironment.getResultSettings());
});

/**
 * Fits the largest valid settings body, every value at MAX_SETTING_LENGTH with each
 * character escaped as `\uXXXX`, which the global 100 KB parser would reject.
 */
const SETTINGS_BODY_LIMIT = (MAX_ORDERS + 1) * (MAX_SETTING_LENGTH * 6 + 4) + 1024;

// Mount this router before the global JSON parser, so this one parses the settings body.
const parseSettingsJson = json({ limit: SETTINGS_BODY_LIMIT, inflate: false });

/** PUT /api/draft-report-ai-results/settings — updates `vendorName` and/or `orders`. */
draftReportResultsRouter.put('/settings', parseSettingsJson, (req, res) => {
  const update = parseSettings(req.body);
  if (typeof update === 'string') {
    res.status(400).json({ error: update });
    return;
  }
  res.json(simulatedEnvironment.updateResultSettings(update));
});

function isSettingValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_SETTING_LENGTH;
}

function parseSettings(body: unknown): Partial<DraftReportSettings> | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'Body must be a JSON object.';
  }
  if (Object.keys(body).some((key) => key !== 'vendorName' && key !== 'orders')) {
    return 'Only vendorName and orders can be set.';
  }
  const { vendorName, orders } = body as Record<string, unknown>;
  const update: Partial<DraftReportSettings> = {};
  if (vendorName !== undefined) {
    if (!isSettingValue(vendorName)) {
      return `vendorName must be a non-blank string of at most ${MAX_SETTING_LENGTH} characters.`;
    }
    update.vendorName = vendorName;
  }
  if (orders !== undefined) {
    if (!Array.isArray(orders) || orders.length > MAX_ORDERS || !orders.every(isSettingValue)) {
      return `orders must be an array of at most ${MAX_ORDERS} accession numbers, each a non-blank string of at most ${MAX_SETTING_LENGTH} characters.`;
    }
    update.orders = orders;
  }
  return update;
}
