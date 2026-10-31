import { Router } from 'express';
import type { PartnerRun } from '../store/partner-run.js';
import { sessionStore } from '../store/session.js';
import { simulatedEnvironment } from '../store/simulated-environment.js';

/**
 * Run Test for partnerInitiated tools: a capture opens the simulated Dragon Copilot endpoint and
 * records every request it answers, until the capture is stopped.
 */
export const partnerInitiatedRunRouter = Router();

/** A capture as this API returns it, with the path to send requests to. */
export type CaptureResponse = PartnerRun & { callbackPath: string };

// The path follows the simulated environment, which can change while a capture is open.
function withCallbackPath(run: PartnerRun): CaptureResponse {
  return { ...run, callbackPath: simulatedEnvironment.submissionPath };
}

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
    res.status(400).json({ error: 'Only partnerInitiated tools can listen for requests.' });
    return;
  }
  res.status(201).json(withCallbackPath(sessionStore.partnerRuns.start(tool)));
});

partnerInitiatedRunRouter.get('/:runId', (req, res) => {
  const after = req.query.after === undefined ? 0 : Number(req.query.after);
  if (!Number.isSafeInteger(after) || after < 0) {
    res.status(400).json({ error: 'after must be a whole number of 0 or more.' });
    return;
  }
  const run = sessionStore.partnerRuns.get(req.params.runId, after);
  if (!run) {
    res.status(404).json({ error: 'The run has stopped or was replaced.' });
    return;
  }
  res.json(withCallbackPath(run));
});

partnerInitiatedRunRouter.delete('/:runId', (req, res) => {
  sessionStore.partnerRuns.clear(req.params.runId);
  res.sendStatus(204);
});
