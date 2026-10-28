import { processExternalSignalCorrelationWork } from '../services/external-signal-correlation.service.js';

export async function runExternalSignalCorrelationWorker() {
  return processExternalSignalCorrelationWork({ limit: 10 });
}
