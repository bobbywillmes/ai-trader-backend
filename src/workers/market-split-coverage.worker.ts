import { prisma } from '../db/prisma.js';
import { extendMarketSplitCoverage } from '../services/market-split-bootstrap.service.js';
import type { WorkerTickResult } from '../services/worker-health.service.js';

let running = false;

export async function runMarketSplitCoverageWorker(): Promise<WorkerTickResult> {
  if (running) return { outcome: 'skipped', skipReason: 'already_running' };
  running = true;
  try {
    const result = await extendMarketSplitCoverage();
    if (result.dormant) return { outcome: 'skipped', skipReason: 'not_due' };
    return { outcome: result.extended > 0 ? 'success' : 'idle', workSucceeded: result.extended > 0 };
  } catch (error) {
    try {
      await prisma.systemEvent.create({ data: { type: 'market_split_coverage_extension_failed', entityType: 'market_data', entityId: 'massive', severity: 'ERROR', message: 'Automatic Massive split coverage extension failed.', payloadJson: { reason: error instanceof Error ? error.message : 'Unknown error' } } });
    } catch { /* WorkerHealth still records the original failure. */ }
    throw error;
  } finally {
    running = false;
  }
}
