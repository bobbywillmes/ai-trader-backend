import { HttpError } from '../errors/http-error.js';
import { publishParticipationAssessments } from '../services/participation-assessment.service.js';
import type { WorkerTickResult } from '../services/worker-health.service.js';

/**
 * Global, account-independent evidence publication. A blocked target is always a failure (even when the
 * identical immutable attempt was suppressed) so a persistent evidence gap stays operationally unhealthy.
 * A shutdown abort propagates as an error; shutdown orchestration, not this mapping, owns that outcome.
 */
export async function runParticipationAssessmentWorker(options: { signal?: AbortSignal } = {}): Promise<WorkerTickResult> {
  try {
    const result = await publishParticipationAssessments(options.signal ? { signal: options.signal } : undefined);
    if (result.blocked) throw new Error(`PARTICIPATION_V1 ${result.blocked.sessionDate}: ${result.blocked.reasonCode}`);
    if (result.notDue) return { outcome: 'skipped', skipReason: 'not_due' };
    return { outcome: result.published > 0 ? 'success' : 'idle', workSucceeded: result.published > 0 };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) return { outcome: 'skipped', skipReason: 'already_running' };
    throw error;
  }
}
