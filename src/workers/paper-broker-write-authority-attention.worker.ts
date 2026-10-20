import { reconcileAllPaperBrokerWriteAuthorityAttention } from '../services/paper-broker-write-authority-attention.service.js';

let inFlight = false;

export async function runPaperBrokerWriteAuthorityAttentionWorker() {
  if (inFlight) return { outcome: 'skipped' as const, skipReason: 'already_running' as const };
  inFlight = true;
  try {
    const result = await reconcileAllPaperBrokerWriteAuthorityAttention();
    if (result.assessmentUnresolved.length > 0) {
      throw new Error(`PAPER authority assessment unresolved: ${result.assessmentUnresolved.join(' ')}`);
    }
    if (result.failures.length > 0) {
      throw new Error(`PAPER authority attention failed for TradingAccount IDs: ${result.failures.map(item => item.tradingAccountId).join(', ')}.`);
    }
    return { outcome: result.assessed > 0 ? 'success' as const : 'idle' as const, workSucceeded: result.assessed > 0 };
  } finally {
    inFlight = false;
  }
}
