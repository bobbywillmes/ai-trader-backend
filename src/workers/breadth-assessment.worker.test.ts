import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ ingest: vi.fn(), publish: vi.fn(), persist: vi.fn(), event: vi.fn() }));
vi.mock('../services/breadth-observation-ingestion.service.js', () => ({ ingestDueBreadthObservations: mocks.ingest }));
vi.mock('../services/breadth-v1-assessment.service.js', () => ({ publishBreadthV1Assessments: mocks.publish }));
vi.mock('../db/prisma.js', () => ({ prisma: { workerHealthState: { upsert: mocks.persist, findUnique: vi.fn().mockResolvedValue(null) } } }));
vi.mock('../services/system-event.service.js', () => ({ createSystemEvent: mocks.event }));
vi.mock('../config/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
import { runBreadthAssessmentWorker } from './breadth-assessment.worker.js';
import { WorkerHealthRegistry } from '../services/worker-health.service.js';
import { getWorkerDefinition, BREADTH_ASSESSMENT_WORKER_INTERVAL_MS } from './worker-health.definitions.js';
import { HttpError } from '../errors/http-error.js';

const notDueIngestion = { bootstrapRequired: false, notDue: true, inserted: 0, attempted: 0, blocked: null };
const notDuePublication = { published: 0, attempts: 0, suppressed: false, notDue: true, bootstrapRequired: false, blocked: null };

beforeEach(() => {
  vi.clearAllMocks(); mocks.persist.mockResolvedValue({}); mocks.event.mockResolvedValue({});
  mocks.ingest.mockResolvedValue(notDueIngestion); mocks.publish.mockResolvedValue(notDuePublication);
});
describe('account-independent monitored Breadth worker', () => {
  it('uses a fifteen-minute cadence and skips when neither step has due work', async () => {
    expect(BREADTH_ASSESSMENT_WORKER_INTERVAL_MS).toBe(900_000);
    expect(await runBreadthAssessmentWorker()).toEqual({ outcome: 'skipped', skipReason: 'not_due' });
    expect(mocks.ingest).toHaveBeenCalledWith();
    expect(mocks.publish).toHaveBeenCalledWith();
  });
  it('ensures observation ingestion before publication, in that order', async () => {
    const order: string[] = [];
    mocks.ingest.mockImplementation(async () => { order.push('ingest'); return notDueIngestion; });
    mocks.publish.mockImplementation(async () => { order.push('publish'); return notDuePublication; });
    await runBreadthAssessmentWorker();
    expect(order).toEqual(['ingest', 'publish']);
  });
  it('reports either step succeeding as useful work', async () => {
    mocks.ingest.mockResolvedValue({ ...notDueIngestion, notDue: false, inserted: 1 });
    expect(await runBreadthAssessmentWorker()).toEqual({ outcome: 'success', workSucceeded: true });
    mocks.ingest.mockResolvedValue(notDueIngestion);
    mocks.publish.mockResolvedValue({ ...notDuePublication, notDue: false, published: 1 });
    expect(await runBreadthAssessmentWorker()).toEqual({ outcome: 'success', workSucceeded: true });
  });
  it('throws a clear BREADTH_BOOTSTRAP_REQUIRED error rather than inferring a historical fetch', async () => {
    mocks.ingest.mockResolvedValue({ ...notDueIngestion, bootstrapRequired: true });
    await expect(runBreadthAssessmentWorker()).rejects.toThrow('BREADTH_BOOTSTRAP_REQUIRED');
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('surfaces an ingestion block before ever attempting publication', async () => {
    mocks.ingest.mockResolvedValue({ ...notDueIngestion, blocked: { sessionDate: '2026-09-15', reasonCode: 'PROVIDER_FAILURE', message: 'HTTP 503' } });
    await expect(runBreadthAssessmentWorker()).rejects.toThrow('PROVIDER_FAILURE');
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('surfaces a publication block', async () => {
    mocks.publish.mockResolvedValue({ ...notDuePublication, blocked: { sessionDate: '2026-09-15', status: 'UNAVAILABLE', reasonCode: 'MISSING_MARKET_DATA' } });
    await expect(runBreadthAssessmentWorker()).rejects.toThrow('MISSING_MARKET_DATA');
  });
  it('skips global lock contention from either step', async () => {
    mocks.ingest.mockRejectedValue(new HttpError(409, 'locked'));
    expect(await runBreadthAssessmentWorker()).toEqual({ outcome: 'skipped', skipReason: 'already_running' });
  });
  it('monitors persistent gaps as failures, then recovers', async () => {
    const registry = new WorkerHealthRegistry({ processInstanceId: 'breadth-test' });
    registry.registerWorker(getWorkerDefinition('breadth_assessment_publication'));
    mocks.publish.mockResolvedValue({ ...notDuePublication, blocked: { sessionDate: '2026-09-15', status: 'UNAVAILABLE', reasonCode: 'MISSING_MARKET_DATA' } });
    await expect(registry.runMonitoredWorker('breadth_assessment_publication', runBreadthAssessmentWorker)).rejects.toThrow('MISSING_MARKET_DATA');
    expect(registry.getSnapshot().items[0]).toMatchObject({ key: 'breadth_assessment_publication', lastOutcome: 'failed', consecutiveFailures: 1 });
    mocks.publish.mockResolvedValue({ ...notDuePublication, notDue: false, published: 1 });
    await registry.runMonitoredWorker('breadth_assessment_publication', runBreadthAssessmentWorker);
    expect(registry.getSnapshot().items[0]).toMatchObject({ lastOutcome: 'success', consecutiveFailures: 0 });
    await registry.shutdown();
    expect(mocks.persist).toHaveBeenCalled();
  });
});
