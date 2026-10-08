import { Router, json } from 'express';
import { STATUS_CODES } from 'node:http';
import { sessionStore } from '../store/session.js';
import { partnerValidationResult, validatePartnerOutput } from '../services/partner-validation.js';
import type { ValidationResult } from '../services/validation.js';

export const partnerInitiatedRunRouter = Router();
export const partnerInitiatedCallbackRouter = Router();

partnerInitiatedRunRouter.post('/start', (req, res) => {
  const manifest = sessionStore.getManifest();
  if (!manifest) {
    res.status(400).json({ error: 'No manifest loaded. Upload a manifest first.' });
    return;
  }
  const { capability, tool: toolName } = req.body ?? {};
  if (typeof capability !== 'string' || typeof toolName !== 'string') {
    res.status(400).json({ error: 'capability and tool are required strings.' });
    return;
  }
  const tool = manifest.tools.find((candidate) => candidate.name === toolName && candidate.capability === capability);
  if (!tool) {
    res.status(404).json({ error: 'Tool not found for this capability.' });
    return;
  }
  if (tool.toolType !== 'partnerInitiated') {
    res.status(400).json({ error: 'Only partnerInitiated tools can start a listener.' });
    return;
  }
  res.status(201).json(sessionStore.partnerRuns.start(manifest, tool));
});

partnerInitiatedRunRouter.get('/:runId', (req, res) => {
  const run = sessionStore.partnerRuns.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: 'Run not found or no longer active.' });
    return;
  }
  res.json(run);
});

partnerInitiatedRunRouter.delete('/:runId', (req, res) => {
  sessionStore.partnerRuns.clear(req.params.runId);
  res.sendStatus(204);
});

const parseJson = json({ type: ['application/json', 'application/*+json'], strict: false, limit: '1mb' });

// Mount before the global JSON parser: parse failures belong to this run and must
// never reach the global error logger, which could print the clinical body.
partnerInitiatedCallbackRouter.post('/:tenantId/:toolName', (req, res) => {
  const claim = sessionStore.partnerRuns.claim(req.params.tenantId, req.params.toolName);
  if (typeof claim === 'number') {
    res.status(claim).json({ error: claim === 404 ? 'No matching listener is armed.' : 'This listener already received a request.' });
    return;
  }

  const complete = (status: number, rawBody: unknown, validation: ValidationResult): void => {
    if (!sessionStore.partnerRuns.complete(claim.runId, {
      status, statusText: STATUS_CODES[status]!, rawBody, validation,
    })) {
      res.status(409).json({ error: 'This listener was cancelled or replaced.' });
      return;
    }
    sessionStore.addValidationResult(validation);
    res.status(status).json({ validation });
  };
  const failBody = (status: number, message: string, rawBody: unknown = null): void => {
    complete(status, rawBody, partnerValidationResult(claim.tool, [
      { check: 'Request body is supported JSON', passed: false, error: message },
    ]));
  };

  if (!req.is(['application/json', 'application/*+json'])) {
    failBody(415, 'Content-Type must be application/json or application/*+json.');
    return;
  }
  parseJson(req, res, (error?: { type?: string; body?: unknown }) => {
    if (error) {
      switch (error.type) {
        case 'entity.parse.failed':
          failBody(400, 'Request body is not valid JSON.', error.body ?? null);
          return;
        case 'entity.too.large':
          failBody(413, 'Request body exceeds the 1 MB limit.');
          return;
        case 'charset.unsupported':
        case 'encoding.unsupported':
          failBody(415, 'Request body uses an unsupported charset or content encoding.');
          return;
        case 'request.aborted':
        case 'request.size.invalid':
          failBody(400, 'Request body was incomplete.');
          return;
        default:
          // Do not forward body-parser error details (which can include PHI).
          failBody(400, 'Request body could not be read.');
          return;
      }
    }
    const rawBody: unknown = req.body ?? null;
    const validation = validatePartnerOutput(claim.tool, rawBody);
    complete(validation.valid ? 200 : 422, rawBody, validation);
  });
});
