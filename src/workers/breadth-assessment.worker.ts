import { HttpError } from '../errors/http-error.js';
import { ingestDueBreadthObservations } from '../services/breadth-observation-ingestion.service.js';
import { publishBreadthV1Assessments } from '../services/breadth-v1-assessment.service.js';
import type { WorkerTickResult } from '../services/worker-health.service.js';

/** Daily dimension worker: ensures due live MarketBreadthObservation ingestion, then runs
 * the BREADTH_V1 publisher. Never infers a historical fetch — if MarketBreadthObservation
 * has not been bootstrapped, this throws a clear BREADTH_BOOTSTRAP_REQUIRED error rather than
 * silently skipping or fetching five years of history. Massive only; never Alpaca. */
export async function runBreadthAssessmentWorker(): Promise<WorkerTickResult> {
  try {
    const ingestion = await ingestDueBreadthObservations();
    if (ingestion.bootstrapRequired) throw new Error('BREADTH_BOOTSTRAP_REQUIRED: MarketBreadthObservation has no rows. Run `npm run breadth:bootstrap -- --apply` before this worker can proceed.');
    if (ingestion.blocked) throw new Error(`Breadth observation ingestion blocked at ${ingestion.blocked.sessionDate}: ${ingestion.blocked.reasonCode} - ${ingestion.blocked.message}`);

    const publication = await publishBreadthV1Assessments();
    if (publication.bootstrapRequired) throw new Error('BREADTH_BOOTSTRAP_REQUIRED: MarketBreadthObservation has no rows. Run `npm run breadth:bootstrap -- --apply` before this worker can proceed.');
    if (publication.blocked) throw new Error(`BREADTH_V1 stopped at ${publication.blocked.sessionDate}: ${publication.blocked.reasonCode}`);

    const workSucceeded = ingestion.inserted > 0 || publication.published > 0;
    if (!workSucceeded && ingestion.notDue && publication.notDue) return { outcome: 'skipped', skipReason: 'not_due' };
    return { outcome: workSucceeded ? 'success' : 'idle', workSucceeded };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) return { outcome: 'skipped', skipReason: 'already_running' };
    throw error;
  }
}
