import { HttpError } from '../errors/http-error.js';
import { syncMinuteBars } from '../services/market-bar-ingestion.service.js';
import type { WorkerTickResult } from '../services/worker-health.service.js';
let running = false;
export async function runMarketMinuteDataWorker(): Promise<WorkerTickResult> {
  if (running) return { outcome: 'skipped', skipReason: 'already_running' };
  running = true;
  try {
    const result = await syncMinuteBars();
    if (result.notDue) return { outcome: 'skipped', skipReason: 'not_due' };
    // Continued absence of an eligible, expected regular-session bar is an evidence failure,
    // not healthy idle work: surface it through worker health rather than reporting idle.
    if (result.missing > 0) throw new Error(`${result.missing} eligible MINUTE_15 bar(s) remain missing from Massive after sync.`);
    return { outcome: result.inserted ? 'success' : 'idle', workSucceeded: result.inserted > 0 };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) return { outcome: 'skipped', skipReason: 'already_running' };
    throw error;
  } finally { running = false; }
}
