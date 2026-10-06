import { env } from '../config/env.js';
import { HttpError } from '../errors/http-error.js';
import { runBreadthV2Observations } from '../services/breadth-v2-measurement.service.js';
import { publishBreadthV2Assessments } from '../services/breadth-v2-assessment.service.js';
import type { WorkerTickResult } from '../services/worker-health.service.js';

export type ShadowOutcome = 'DISABLED' | 'NOT_DUE' | 'ALREADY_CURRENT' | 'PROGRESSED' | 'WAITING_FOR_EVIDENCE' | 'MATERIAL_FAILURE';
type Stage = { inserted?: number; attempted?: number; published?: number; attempts?: number; blocked?: { code: string; sessionDate: string } | null };
export type ShadowSnapshot = { enabled: boolean; runAt: string | null; latestEligibleSession: string | null; observation: Stage | null; assessment: Stage | null; outcome: ShadowOutcome };

let running = false;
let last: ShadowSnapshot = { enabled: false, runAt: null, latestEligibleSession: null, observation: null, assessment: null, outcome: 'DISABLED' };
export function breadthV2ShadowSnapshot(): ShadowSnapshot {
  return { ...last, enabled: env.BREADTH_V2_SHADOW_WORKER_ENABLED, outcome: env.BREADTH_V2_SHADOW_WORKER_ENABLED ? last.outcome : 'DISABLED' };
}

const waitingObservation = new Set(['INSUFFICIENT_TARGET_COVERAGE', 'INSUFFICIENT_HORIZON_COVERAGE', 'ZERO_DIRECTIONAL_BREADTH']);
const waitingAssessment = new Set(['MISSING_MEASUREMENT']);

/** Orchestration only: both publication services retain their own locks, clocks, and catch-up limits. */
export async function runBreadthV2ShadowWorker(options: {
  enabled?: boolean;
  now?: Date;
  observations?: typeof runBreadthV2Observations;
  assessments?: typeof publishBreadthV2Assessments;
} = {}): Promise<WorkerTickResult> {
  const enabled = options.enabled ?? env.BREADTH_V2_SHADOW_WORKER_ENABLED;
  if (!enabled) return { outcome: 'skipped', skipReason: 'disabled' };
  if (running) return { outcome: 'skipped', skipReason: 'already_running' };
  running = true;
  const now = options.now ?? new Date();
  const snapshot: ShadowSnapshot = { enabled: true, runAt: now.toISOString(), latestEligibleSession: null, observation: null, assessment: null, outcome: 'NOT_DUE' };
  try {
    const observation = await (options.observations ?? runBreadthV2Observations)({ now });
    snapshot.latestEligibleSession = observation.latestEligibleSession;
    snapshot.observation = { inserted: observation.inserted, attempted: observation.attempted, blocked: observation.blocked ? { code: observation.blocked.code, sessionDate: observation.blocked.sessionDate } : null };
    if (observation.blocked) {
      snapshot.outcome = waitingObservation.has(observation.blocked.code) ? 'WAITING_FOR_EVIDENCE' : 'MATERIAL_FAILURE';
      last = snapshot;
      if (snapshot.outcome === 'MATERIAL_FAILURE') throw new Error(`BREADTH_V2 observation blocked at ${observation.blocked.sessionDate}: ${observation.blocked.code}`);
      return { outcome: 'idle', workSucceeded: observation.inserted > 0 };
    }

    // An already published measurement can still have an unpublished assessment.
    const assessment = await (options.assessments ?? publishBreadthV2Assessments)({ now });
    snapshot.assessment = { published: assessment.published, attempts: assessment.attempts, blocked: assessment.blocked ? { code: assessment.blocked.reasonCode, sessionDate: assessment.blocked.sessionDate } : null };
    snapshot.latestEligibleSession ??= assessment.blocked?.sessionDate ?? null;
    if (assessment.blocked) {
      snapshot.outcome = waitingAssessment.has(assessment.blocked.reasonCode) ? 'WAITING_FOR_EVIDENCE' : 'MATERIAL_FAILURE';
      last = snapshot;
      if (snapshot.outcome === 'MATERIAL_FAILURE') throw new Error(`BREADTH_V2 assessment blocked at ${assessment.blocked.sessionDate}: ${assessment.blocked.reasonCode}`);
      return { outcome: 'idle', workSucceeded: observation.inserted + assessment.published > 0 };
    }
    const progress = observation.inserted + assessment.published > 0;
    snapshot.outcome = progress ? 'PROGRESSED' : observation.notDue && assessment.notDue ? 'NOT_DUE' : 'ALREADY_CURRENT';
    last = snapshot;
    return progress ? { outcome: 'success', workSucceeded: true } : { outcome: 'idle' };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) return { outcome: 'skipped', skipReason: 'already_running' };
    snapshot.outcome = 'MATERIAL_FAILURE';
    last = snapshot;
    throw error;
  } finally { running = false; }
}
