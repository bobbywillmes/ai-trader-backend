import { HttpError } from '../errors/http-error.js';
import { publishTrendAssessments } from '../services/trend-assessment.service.js';
import type { WorkerTickResult } from '../services/worker-health.service.js';

export async function runTrendAssessmentWorker(): Promise<WorkerTickResult> {
  try {
    const result = await publishTrendAssessments();
    if (result.blocked) throw new Error(`TREND_V1 ${result.blocked.sessionDate}: ${result.blocked.reasonCode}`);
    if (result.notDue) return { outcome: 'skipped', skipReason: 'not_due' };
    return { outcome: result.published ? 'success' : 'idle', workSucceeded: result.published > 0 };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) return { outcome: 'skipped', skipReason: 'already_running' };
    throw error;
  }
}
