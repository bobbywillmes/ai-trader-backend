import { HttpError } from '../errors/http-error.js';
import { publishVolatilityAssessments } from '../services/volatility-assessment.service.js';
import type { WorkerTickResult } from '../services/worker-health.service.js';

export async function runVolatilityAssessmentWorker(): Promise<WorkerTickResult> {
  try {
    const result = await publishVolatilityAssessments();
    if (result.blocked) throw new Error(`VOLATILITY_V1 ${result.blocked.sessionDate}: ${result.blocked.reasonCode}`);
    if (result.notDue) return { outcome: 'skipped', skipReason: 'not_due' };
    return { outcome: result.published ? 'success' : 'idle', workSucceeded: result.published > 0 };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) return { outcome: 'skipped', skipReason: 'already_running' };
    throw error;
  }
}
