import { HttpError } from '../errors/http-error.js';
import { syncTiingoDaily } from '../services/tiingo-daily.service.js';
import type { WorkerTickResult } from '../services/worker-health.service.js';

let running = false;
export async function runTiingoDailyWorker(): Promise<WorkerTickResult> {
  if (running) return { outcome: 'skipped', skipReason: 'already_running' };
  running = true;
  try {
    const result = await syncTiingoDaily();
    if (result.dormant) return { outcome: 'skipped', skipReason: 'not_due' };
    if (!result.status) throw new Error('Tiingo daily status unavailable.');
    if (result.status.existingOtherProvider || result.result?.counts.otherProvider || result.result?.counts.conflict || result.result?.counts.failed) {
      throw new Error(`Tiingo daily operational failure: otherProvider=${result.status.existingOtherProvider} conflicts=${result.result?.counts.conflict ?? 0} providerFailures=${result.result?.counts.failed ?? 0}`);
    }
    if (result.notDue) return { outcome: 'skipped', skipReason: 'not_due' };
    const workSucceeded = !!(result.result?.counts.succeeded || result.result?.counts.retryScheduled || result.result?.counts.terminalizedNoEodCoverage);
    return { outcome: workSucceeded ? 'success' : 'idle', workSucceeded };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) return { outcome: 'skipped', skipReason: 'already_running' };
    throw error;
  } finally { running = false; }
}
