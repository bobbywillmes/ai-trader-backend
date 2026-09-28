import { HttpError } from '../errors/http-error.js';
import { syncTiingoDaily } from '../services/tiingo-daily.service.js';
import type { WorkerTickResult } from '../services/worker-health.service.js';

let running = false;
export async function runTiingoDailyWorker(): Promise<WorkerTickResult> {
  if (running) return { outcome: 'skipped', skipReason: 'already_running' };
  running = true;
  try {
    const result = await syncTiingoDaily();
    if (result.notDue) return { outcome: 'skipped', skipReason: 'not_due' };
    if (result.status.missing || result.status.existingOtherProvider || result.result?.counts.conflict || result.result?.counts.failed) {
      throw new Error(`Tiingo daily incomplete: missing=${result.status.missing} otherProvider=${result.status.existingOtherProvider} conflicts=${result.result?.counts.conflict ?? 0} providerFailures=${result.result?.counts.failed ?? 0}`);
    }
    return { outcome: result.result?.counts.succeeded ? 'success' : 'idle', workSucceeded: !!result.result?.counts.succeeded };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) return { outcome: 'skipped', skipReason: 'already_running' };
    throw error;
  } finally { running = false; }
}
