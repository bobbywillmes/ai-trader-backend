import type { WorkerTickResult } from '../services/worker-health.service.js';
import { publishMarketRegimeComposition } from '../services/market-regime-composition-publication.service.js';

export async function runMarketRegimeCompositionWorker(): Promise<WorkerTickResult> {
  const result = await publishMarketRegimeComposition();
  return result.published
    ? { outcome: 'success', workSucceeded: true }
    : { outcome: 'skipped', skipReason: 'not_due', workSucceeded: false };
}
