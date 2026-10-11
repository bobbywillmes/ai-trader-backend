import { processOrderIntentBrokerComparisons } from '../services/order-intent-broker-comparison.service.js';

export async function runOrderIntentBrokerComparisonWorker() {
  const result = await processOrderIntentBrokerComparisons();
  if (result.terminalFailures > 0) throw new Error(`TERMINAL_FAILURE:${result.terminalFailures}`);
  if (!result.enabled) return { outcome: 'skipped' as const, skipReason: 'disabled' as const, details: result };
  return { outcome: 'success' as const, details: result };
}
