import type { WorkerTickResult } from '../services/worker-health.service.js';
import { publishMarketRegimeComposition } from '../services/market-regime-composition-publication.service.js';

export async function runMarketRegimeCompositionWorker(): Promise<WorkerTickResult> {
  const result = await publishMarketRegimeComposition({ contention: 'return' });
  if (result.outcome === 'ALREADY_RUNNING_ELSEWHERE') {
    return { outcome: 'skipped', skipReason: 'not_due', workSucceeded: false };
  }
  return result.published
    ? { outcome: 'success', workSucceeded: true }
    : { outcome: 'skipped', skipReason: 'not_due', workSucceeded: false };
}
