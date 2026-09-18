import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ publish: vi.fn(), persist: vi.fn(), event: vi.fn() }));
vi.mock('../services/trend-assessment.service.js', () => ({ publishTrendAssessments: mocks.publish }));
vi.mock('../db/prisma.js', () => ({ prisma: { workerHealthState: { upsert: mocks.persist, findUnique: vi.fn().mockResolvedValue(null) } } }));
vi.mock('../services/system-event.service.js', () => ({ createSystemEvent: mocks.event }));
vi.mock('../config/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
import { runTrendAssessmentWorker } from './trend-assessment.worker.js';
import { WorkerHealthRegistry } from '../services/worker-health.service.js';
import { getWorkerDefinition, TREND_ASSESSMENT_WORKER_INTERVAL_MS } from './worker-health.definitions.js';
import { HttpError } from '../errors/http-error.js';

beforeEach(() => { vi.clearAllMocks(); mocks.persist.mockResolvedValue({}); mocks.event.mockResolvedValue({}); });
describe('account-independent monitored Trend worker', () => {
  it('uses a fifteen-minute cadence and skips not-due work', async () => {
    expect(TREND_ASSESSMENT_WORKER_INTERVAL_MS).toBe(900_000);
    mocks.publish.mockResolvedValue({ notDue: true, published: 0 });
    expect(await runTrendAssessmentWorker()).toEqual({ outcome: 'skipped', skipReason: 'not_due' });
    expect(mocks.publish).toHaveBeenCalledWith();
  });
  it('reports publication and outage catch-up as useful work', async () => {
    mocks.publish.mockResolvedValue({ published: 4 });
    expect(await runTrendAssessmentWorker()).toEqual({ outcome: 'success', workSucceeded: true });
  });
  it('skips global lock contention', async () => {
    mocks.publish.mockRejectedValue(new HttpError(409, 'locked'));
    expect(await runTrendAssessmentWorker()).toEqual({ outcome: 'skipped', skipReason: 'already_running' });
  });
  it('monitors persistent gaps as failures even when duplicate attempt insertion is suppressed, then recovers', async () => {
    const registry = new WorkerHealthRegistry({ processInstanceId: 'trend-test' });
    registry.registerWorker(getWorkerDefinition('trend_assessment_publication'));
    mocks.publish.mockResolvedValue({ suppressed: true, blocked: { sessionDate: '2026-09-15', status: 'UNAVAILABLE', reasonCode: 'MISSING_MARKET_DATA' } });
    await expect(registry.runMonitoredWorker('trend_assessment_publication', runTrendAssessmentWorker)).rejects.toThrow('MISSING_MARKET_DATA');
    expect(registry.getSnapshot().items[0]).toMatchObject({ key: 'trend_assessment_publication', lastOutcome: 'failed', consecutiveFailures: 1 });
    mocks.publish.mockResolvedValue({ published: 2 });
    await registry.runMonitoredWorker('trend_assessment_publication', runTrendAssessmentWorker);
    expect(registry.getSnapshot().items[0]).toMatchObject({ lastOutcome: 'success', consecutiveFailures: 0 });
    await registry.shutdown();
    expect(mocks.persist).toHaveBeenCalled();
  });
});
