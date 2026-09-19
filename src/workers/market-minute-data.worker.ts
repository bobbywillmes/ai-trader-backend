import { HttpError } from '../errors/http-error.js';
import { syncMinuteBars } from '../services/market-bar-ingestion.service.js';
import type { WorkerTickResult } from '../services/worker-health.service.js';
let running = false;
export async function runMarketMinuteDataWorker(): Promise<WorkerTickResult> {
  if (running) return { outcome: 'skipped', skipReason: 'already_running' };
  running = true;
  try {
    const result = await syncMinuteBars();
    return result.notDue ? { outcome: 'skipped', skipReason: 'not_due' } : { outcome: result.inserted ? 'success' : 'idle', workSucceeded: result.inserted > 0 };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) return { outcome: 'skipped', skipReason: 'already_running' };
    throw error;
  } finally { running = false; }
}
