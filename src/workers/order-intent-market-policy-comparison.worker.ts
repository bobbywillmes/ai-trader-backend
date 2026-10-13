import { processOrderIntentMarketPolicyComparisons } from '../services/order-intent-market-policy-comparison.service.js';

export async function runOrderIntentMarketPolicyComparisonWorker() {
  const result = await processOrderIntentMarketPolicyComparisons();
  if (!result.enabled) return { outcome: 'skipped' as const, skipReason: 'disabled' as const, workSucceeded: false };
  if (result.claimed === 0) return { outcome: 'skipped' as const, skipReason: 'not_due' as const, workSucceeded: false };
  if (result.terminalFailures > 0) throw new Error(`ORDER_INTENT_MARKET_POLICY_COMPARISON_TERMINAL_FAILURE:${result.terminalFailures}`);
  return { outcome: 'success' as const, workSucceeded: result.completed > 0 || result.retrying > 0 };
}
