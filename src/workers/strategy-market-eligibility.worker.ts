import { evaluateActiveStrategyPolicies } from '../services/strategy-market-eligibility.service.js';
import type { WorkerTickResult } from '../services/worker-health.service.js';

export async function runStrategyMarketEligibilityWorker(): Promise<WorkerTickResult> {
  const result = await evaluateActiveStrategyPolicies();
  return result.evaluated === 0
    ? { outcome: 'skipped', skipReason: 'not_due', workSucceeded: false }
    : { outcome: 'success', workSucceeded: result.createdOrReused > 0 };
}
