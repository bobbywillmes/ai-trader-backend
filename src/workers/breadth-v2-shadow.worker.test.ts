import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ observation: vi.fn(), assessment: vi.fn() }));
vi.mock('../services/breadth-v2-measurement.service.js', () => ({ runBreadthV2Observations: mocks.observation }));
vi.mock('../services/breadth-v2-assessment.service.js', () => ({ publishBreadthV2Assessments: mocks.assessment }));
import { breadthV2ShadowSnapshot, runBreadthV2ShadowWorker } from './breadth-v2-shadow.worker.js';
import { getWorkerDefinition, BREADTH_V2_SHADOW_WORKER_INTERVAL_MS } from './worker-health.definitions.js';

const now = new Date('2026-09-30T17:00:00Z');
const observation = (overrides = {}) => ({ latestEligibleSession: '2026-09-29', inserted: 0, attempted: 0, notDue: false, blocked: null, results: [], ...overrides });
const assessment = (overrides = {}) => ({ published: 0, attempts: 0, notDue: false, blocked: null, assessments: [], ...overrides });
const run = () => runBreadthV2ShadowWorker({ enabled: true, now });

describe('BREADTH_V2 shadow orchestration', () => {
  beforeEach(() => { mocks.observation.mockReset(); mocks.assessment.mockReset(); mocks.observation.mockResolvedValue(observation()); mocks.assessment.mockResolvedValue(assessment()); });

  it('is disabled by default and performs no publication calls', async () => {
    expect(getWorkerDefinition('breadth_v2_shadow_publication').enabledByDefault).toBe(false);
    expect(BREADTH_V2_SHADOW_WORKER_INTERVAL_MS).toBe(3_600_000);
    expect(await runBreadthV2ShadowWorker({ enabled: false })).toMatchObject({ skipReason: 'disabled' });
    expect(mocks.observation).not.toHaveBeenCalled(); expect(mocks.assessment).not.toHaveBeenCalled();
  });
  it('is healthy before eligibility and when already current', async () => {
    mocks.observation.mockResolvedValueOnce(observation({ notDue: true })); mocks.assessment.mockResolvedValueOnce(assessment({ notDue: true }));
    expect(await run()).toMatchObject({ outcome: 'idle' }); expect(breadthV2ShadowSnapshot().outcome).toMatch(/NOT_DUE|DISABLED/);
    expect(await run()).toMatchObject({ outcome: 'idle' });
    expect(mocks.assessment).toHaveBeenCalledTimes(2);
  });
  it('publishes measurements before assessments and follows existing bounded service results', async () => {
    const order: string[] = [];
    mocks.observation.mockImplementationOnce(async () => { order.push('observation'); return observation({ inserted: 5, attempted: 5 }); });
    mocks.assessment.mockImplementationOnce(async () => { order.push('assessment'); return assessment({ published: 3, attempts: 3 }); });
    expect(await run()).toMatchObject({ outcome: 'success', workSucceeded: true });
    expect(order).toEqual(['observation', 'assessment']);
    expect(mocks.observation).toHaveBeenCalledTimes(1); expect(mocks.assessment).toHaveBeenCalledTimes(1);
  });
  it('advances an assessment even when its measurement already exists', async () => {
    mocks.assessment.mockResolvedValueOnce(assessment({ published: 1, attempts: 1 }));
    expect(await run()).toMatchObject({ outcome: 'success' });
  });
  it('stops on temporary coverage and does not invoke assessment or throw repeatedly', async () => {
    mocks.observation.mockResolvedValue(observation({ blocked: { code: 'INSUFFICIENT_TARGET_COVERAGE', sessionDate: '2026-09-29' } }));
    expect(await run()).toMatchObject({ outcome: 'idle' }); expect(await run()).toMatchObject({ outcome: 'idle' });
    expect(mocks.assessment).not.toHaveBeenCalled();
  });
  it('surfaces assessment waiting independently and material failures as unhealthy', async () => {
    mocks.assessment.mockResolvedValueOnce(assessment({ blocked: { reasonCode: 'MISSING_MEASUREMENT', sessionDate: '2026-09-29' } }));
    expect(await run()).toMatchObject({ outcome: 'idle' });
    mocks.assessment.mockResolvedValueOnce(assessment({ blocked: { reasonCode: 'INVALID_MEASUREMENT_EVIDENCE', sessionDate: '2026-09-29' } }));
    await expect(run()).rejects.toThrow('INVALID_MEASUREMENT_EVIDENCE');
    mocks.observation.mockResolvedValueOnce(observation({ inserted: 1, attempted: 1 }));
    expect(await run()).toMatchObject({ outcome: 'success' });
  });
  it('stops at material observation failure and releases the in-process guard', async () => {
    mocks.observation.mockResolvedValueOnce(observation({ blocked: { code: 'CALCULATION_FAILED', sessionDate: '2026-09-29' } }));
    await expect(run()).rejects.toThrow('CALCULATION_FAILED');
    expect(mocks.assessment).not.toHaveBeenCalled();
    expect(await run()).toMatchObject({ outcome: 'idle' });
  });
});
