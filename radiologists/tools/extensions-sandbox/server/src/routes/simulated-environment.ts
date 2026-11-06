import { Router } from 'express';
import { parseSimulatedEnvironmentSettings, simulatedEnvironment } from '../store/simulated-environment.js';

/** Reads and changes the customer environment the simulated Dragon Copilot endpoint answers for. */
export const simulatedEnvironmentRouter = Router();

function view() {
  return {
    ...simulatedEnvironment.getSettings(),
    submissionPath: simulatedEnvironment.submissionPath,
    storedResultCount: simulatedEnvironment.storedResultCount,
  };
}

simulatedEnvironmentRouter.get('/', (_req, res) => {
  res.json(view());
});

simulatedEnvironmentRouter.put('/', (req, res) => {
  const parsed = parseSimulatedEnvironmentSettings(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  simulatedEnvironment.setSettings(parsed.settings);
  res.json(view());
});

simulatedEnvironmentRouter.delete('/stored-results', (_req, res) => {
  simulatedEnvironment.clearStoredResults();
  res.json(view());
});
