import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ findAssessment: vi.fn(), findObservation: vi.fn(), readiness: vi.fn(), observationReadiness: vi.fn(), worker: vi.fn() }));
vi.mock('../db/prisma.js', () => ({ prisma: { $transaction: async (callback: (tx: unknown) => unknown) => callback({ $executeRawUnsafe: vi.fn(), marketRegimeDimensionAssessment: { findFirst: mocks.findAssessment }, marketBreadthObservationSet: { findFirst: mocks.findObservation } }) } }));
vi.mock('./breadth-v2-assessment.service.js', () => ({ breadthV2AssessmentStatus: mocks.readiness }));
vi.mock('./breadth-v2-measurement.service.js', () => ({ breadthV2ObservationStatus: mocks.observationReadiness, BREADTH_V2_MEASUREMENT_VERSION: 'BREADTH_V2_MEASUREMENT_V1' }));
vi.mock('../workers/breadth-v2-shadow.worker.js', () => ({ breadthV2ShadowSnapshot: mocks.worker }));
import { getMarketIntelligenceSummary } from './market-intelligence.service.js';

describe('market intelligence summary', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.findObservation.mockResolvedValue(null); mocks.readiness.mockResolvedValue({ readiness: 'BLOCKED' }); mocks.observationReadiness.mockResolvedValue({ readiness: 'NOT_DUE' }); mocks.worker.mockReturnValue({ enabled: false }); });
  it('preserves latest attempts and latest valid identities without composing authority', async () => {
    mocks.findAssessment.mockImplementation(async ({ where }: { where: { algorithmVersion: string; status?: string } }) => ({ id: where.status === 'VALID' ? 10 : 11, algorithmVersion: where.algorithmVersion, status: where.status ?? 'FAILED' }));
    const now = new Date('2026-10-08T12:00:00.000Z'); const result = await getMarketIntelligenceSummary(now);
    expect(result.evaluatedAt).toBe(now); expect(result.semantics).toContain('not a synchronized market snapshot'); expect(result.semantics).toContain('not trading authority');
    expect(result.dimensions.trend!.latestAttempt).toMatchObject({ id: 11, status: 'FAILED' }); expect(result.dimensions.trend!.latestValid).toMatchObject({ id: 10, status: 'VALID' });
    expect(result.breadthV2.latestAttempt).toMatchObject({ algorithmVersion: 'BREADTH_V2_TERTILE_V1' }); expect(result.breadthV2.assessmentReadiness).toEqual({ readiness: 'BLOCKED' });
  });
});
