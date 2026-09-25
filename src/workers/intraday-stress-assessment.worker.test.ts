import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ publish: vi.fn(), persist: vi.fn(), event: vi.fn() }));
vi.mock('../services/intraday-stress-assessment.service.js', () => ({ publishIntradayStressAssessments: mocks.publish }));
vi.mock('../db/prisma.js', () => ({ prisma: { workerHealthState: { upsert: mocks.persist, findUnique: vi.fn().mockResolvedValue(null) } } }));
vi.mock('../services/system-event.service.js', () => ({ createSystemEvent: mocks.event }));
vi.mock('../config/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
import { runIntradayStressAssessmentWorker } from './intraday-stress-assessment.worker.js';
import { WorkerHealthRegistry } from '../services/worker-health.service.js';
import { getWorkerDefinition, INTRADAY_STRESS_ASSESSMENT_WORKER_INTERVAL_MS } from './worker-health.definitions.js';
import { HttpError } from '../errors/http-error.js';

beforeEach(() => { vi.clearAllMocks(); mocks.persist.mockResolvedValue({}); mocks.event.mockResolvedValue({}); });
describe('account-independent monitored Intraday Stress worker', () => {
  it('uses a bounded sub-fifteen-minute cadence and skips not-due work', async () => {
    expect(INTRADAY_STRESS_ASSESSMENT_WORKER_INTERVAL_MS).toBe(120_000);
    mocks.publish.mockResolvedValue({ notDue: true, published: 0 });
    expect(await runIntradayStressAssessmentWorker()).toEqual({ outcome: 'skipped', skipReason: 'not_due' });
    expect(mocks.publish).toHaveBeenCalledWith();
  });
  it('reports publication as useful work', async () => {
    mocks.publish.mockResolvedValue({ published: 1 });
    expect(await runIntradayStressAssessmentWorker()).toEqual({ outcome: 'success', workSucceeded: true });
  });
  it('skips global lock contention', async () => {
    mocks.publish.mockRejectedValue(new HttpError(409, 'locked'));
    expect(await runIntradayStressAssessmentWorker()).toEqual({ outcome: 'skipped', skipReason: 'already_running' });
  });
  it('monitors persistent target failures even when duplicate attempt insertion is suppressed, then recovers', async () => {
    const registry = new WorkerHealthRegistry({ processInstanceId: 'intraday-stress-test' });
    registry.registerWorker(getWorkerDefinition('intraday_stress_assessment_publication'));
    mocks.publish.mockResolvedValue({ suppressed: true, blocked: { sessionDate: '2026-09-15', index: 3, status: 'UNAVAILABLE', reasonCode: 'MISSING_INTRADAY_EVIDENCE' } });
    await expect(registry.runMonitoredWorker('intraday_stress_assessment_publication', runIntradayStressAssessmentWorker)).rejects.toThrow('MISSING_INTRADAY_EVIDENCE');
    expect(registry.getSnapshot().items[0]).toMatchObject({ key: 'intraday_stress_assessment_publication', lastOutcome: 'failed', consecutiveFailures: 1 });
    mocks.publish.mockResolvedValue({ published: 1 });
    await registry.runMonitoredWorker('intraday_stress_assessment_publication', runIntradayStressAssessmentWorker);
    expect(registry.getSnapshot().items[0]).toMatchObject({ lastOutcome: 'success', consecutiveFailures: 0 });
    await registry.shutdown();
    expect(mocks.persist).toHaveBeenCalled();
  });
});
