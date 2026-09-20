import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ publish: vi.fn(), persist: vi.fn(), event: vi.fn() }));
vi.mock('../services/participation-assessment.service.js', () => ({ publishParticipationAssessments: mocks.publish }));
vi.mock('../db/prisma.js', () => ({ prisma: { workerHealthState: { upsert: mocks.persist, findUnique: vi.fn().mockResolvedValue(null) } } }));
vi.mock('../services/system-event.service.js', () => ({ createSystemEvent: mocks.event }));
vi.mock('../config/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { runParticipationAssessmentWorker } from './participation-assessment.worker.js';
import { WorkerHealthRegistry } from '../services/worker-health.service.js';
import { getWorkerDefinition, PARTICIPATION_ASSESSMENT_WORKER_INTERVAL_MS, workerDefinitions } from './worker-health.definitions.js';
import { HttpError } from '../errors/http-error.js';

const KEY = 'participation_assessment_publication';
const blocked = { sessionDate: '2026-09-21', status: 'UNAVAILABLE', reasonCode: 'MISSING_MARKET_DATA' };
beforeEach(() => { vi.clearAllMocks(); mocks.persist.mockResolvedValue({}); mocks.event.mockResolvedValue({}); });

describe('Participation WorkerHealth definition', () => {
  it('is an informational fifteen-minute global worker with the daily publication run budget', () => {
    expect(PARTICIPATION_ASSESSMENT_WORKER_INTERVAL_MS).toBe(900_000);
    expect(getWorkerDefinition(KEY)).toMatchObject({ key: KEY, displayName: 'Daily Participation assessment', criticality: 'informational', expectedIntervalMs: 900_000, enabledByDefault: true, maxRunDurationMs: 240_000,
      startupGraceMs: 2_700_000, delayedAfterMs: 2_250_000, staleAfterMs: 4_500_000 });
    expect(workerDefinitions.filter(w => w.key === KEY)).toHaveLength(1);
  });
});
describe('account-independent monitored Participation worker', () => {
  it('maps notDue to a skipped/not_due tick', async () => {
    mocks.publish.mockResolvedValue({ notDue: true, published: 0, attempts: 0, suppressed: false, blocked: null });
    expect(await runParticipationAssessmentWorker()).toEqual({ outcome: 'skipped', skipReason: 'not_due' });
    expect(mocks.publish).toHaveBeenCalledWith(undefined);
  });
  it('maps publication (including bounded catch-up) to useful work', async () => {
    mocks.publish.mockResolvedValue({ published: 3, attempts: 3, suppressed: false, notDue: false, blocked: null });
    expect(await runParticipationAssessmentWorker()).toEqual({ outcome: 'success', workSucceeded: true });
  });
  it('maps an unblocked no-op to idle', async () => {
    mocks.publish.mockResolvedValue({ published: 0, attempts: 0, suppressed: false, notDue: false, blocked: null });
    expect(await runParticipationAssessmentWorker()).toEqual({ outcome: 'idle', workSucceeded: false });
  });
  it('skips publication-lock contention as already_running but rethrows other HTTP/infra errors', async () => {
    mocks.publish.mockRejectedValueOnce(new HttpError(409, 'locked'));
    expect(await runParticipationAssessmentWorker()).toEqual({ outcome: 'skipped', skipReason: 'already_running' });
    mocks.publish.mockRejectedValueOnce(new HttpError(500, 'calendar authority')); await expect(runParticipationAssessmentWorker()).rejects.toThrow('calendar authority');
    mocks.publish.mockRejectedValueOnce(new Error('db down')); await expect(runParticipationAssessmentWorker()).rejects.toThrow('db down');
  });
  it('throws for a blocked target, including a suppressed identical attempt', async () => {
    mocks.publish.mockResolvedValue({ published: 0, attempts: 1, suppressed: false, notDue: false, blocked });
    await expect(runParticipationAssessmentWorker()).rejects.toThrow('PARTICIPATION_V1 2026-09-21: MISSING_MARKET_DATA');
    mocks.publish.mockResolvedValue({ published: 0, attempts: 0, suppressed: true, notDue: false, blocked });
    await expect(runParticipationAssessmentWorker()).rejects.toThrow('PARTICIPATION_V1 2026-09-21: MISSING_MARKET_DATA');
  });
  it('blocked wins over notDue and never treats a partial catch-up before a block as healthy', async () => {
    mocks.publish.mockResolvedValue({ published: 2, attempts: 3, suppressed: false, notDue: false, blocked });
    await expect(runParticipationAssessmentWorker()).rejects.toThrow('MISSING_MARKET_DATA');
  });
  it('passes the shutdown signal through and propagates a shutdown abort instead of mapping it to a skip/idle/success', async () => {
    const controller = new AbortController(); controller.abort();
    mocks.publish.mockRejectedValue(controller.signal.reason);
    await expect(runParticipationAssessmentWorker({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.publish).toHaveBeenCalledWith({ signal: controller.signal });
  });
  it('increments health failures for repeated blocked ticks, then recovers through the existing registry', async () => {
    const registry = new WorkerHealthRegistry({ processInstanceId: 'participation-test' });
    registry.registerWorker(getWorkerDefinition(KEY));
    const item = () => registry.getSnapshot().items.find(i => i.key === KEY)!;
    mocks.publish.mockResolvedValue({ published: 0, attempts: 1, suppressed: false, notDue: false, blocked });
    await expect(registry.runMonitoredWorker(KEY, () => runParticipationAssessmentWorker())).rejects.toThrow('MISSING_MARKET_DATA');
    expect(item()).toMatchObject({ lastOutcome: 'failed', consecutiveFailures: 1 });
    mocks.publish.mockResolvedValue({ published: 0, attempts: 0, suppressed: true, notDue: false, blocked });
    await expect(registry.runMonitoredWorker(KEY, () => runParticipationAssessmentWorker())).rejects.toThrow('MISSING_MARKET_DATA');
    expect(item()).toMatchObject({ lastOutcome: 'failed', consecutiveFailures: 2 });
    mocks.publish.mockResolvedValue({ published: 0, attempts: 1, suppressed: false, notDue: false, blocked: { ...blocked, reasonCode: 'SPLIT_EVIDENCE_UNAVAILABLE', status: 'FAILED' } });
    await expect(registry.runMonitoredWorker(KEY, () => runParticipationAssessmentWorker())).rejects.toThrow('SPLIT_EVIDENCE_UNAVAILABLE');
    expect(item()).toMatchObject({ consecutiveFailures: 3 });
    mocks.publish.mockResolvedValue({ published: 1, attempts: 1, suppressed: false, notDue: false, blocked: null });
    await registry.runMonitoredWorker(KEY, () => runParticipationAssessmentWorker());
    expect(item()).toMatchObject({ lastOutcome: 'success', consecutiveFailures: 0 });
    mocks.publish.mockResolvedValue({ notDue: true, published: 0, attempts: 0, suppressed: false, blocked: null });
    await registry.runMonitoredWorker(KEY, () => runParticipationAssessmentWorker());
    expect(item()).toMatchObject({ lastOutcome: 'skipped', consecutiveFailures: 0 });
    mocks.publish.mockRejectedValue(new HttpError(409, 'locked'));
    await registry.runMonitoredWorker(KEY, () => runParticipationAssessmentWorker());
    expect(item()).toMatchObject({ lastOutcome: 'skipped', consecutiveFailures: 0 });
    await registry.shutdown();
    expect(mocks.persist).toHaveBeenCalled();
  });
});
