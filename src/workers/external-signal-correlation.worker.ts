import { processExternalSignalCorrelationWork, terminalizeAbandonedExternalSignalCycles } from '../services/external-signal-correlation.service.js';
import { processProspectiveTradingViewEntries } from '../services/external-signal-entry-admission.service.js';

export async function runExternalSignalCorrelationWorker() {
  const result = await processExternalSignalCorrelationWork({ limit: 10 });
  const housekeeping = await terminalizeAbandonedExternalSignalCycles({ limit: 10 });
  const admission = await processProspectiveTradingViewEntries({ limit: 10 });
  if (result.failed > 0) throw new Error(`EXTERNAL_SIGNAL_CORRELATION_FAILED:${result.failed}`);
  return { outcome: result.claimed === 0 ? 'idle' as const : 'success' as const,
    workSucceeded: result.completed > 0 || housekeeping.terminalized > 0 || admission.admitted > 0, details: { ...result, housekeeping, admission } };
}
