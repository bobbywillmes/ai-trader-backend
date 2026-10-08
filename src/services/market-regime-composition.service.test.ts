import { describe, expect, it } from 'vitest';
import type { DimensionAssessmentCandidate, ExpectedMarketRegimeTargets } from './market-regime-composition.service.js';
import { isMarketRegimeCompositionUsable, selectMarketRegimeComposition } from './market-regime-composition.service.js';

const observedAt = new Date('2026-10-08T18:00:00Z');
const dailyTarget = new Date('2026-10-07T20:00:00Z');
const intradayTarget = new Date('2026-10-08T17:45:00Z');
const expectedTargets: ExpectedMarketRegimeTargets = {
  trend: dailyTarget, volatility: dailyTarget, breadth: dailyTarget,
  participation: dailyTarget, intradayStress: intradayTarget,
};
const identities = [
  ['TREND', 'TREND_V1', 'UP'], ['VOLATILITY', 'VOLATILITY_V1', 'NORMAL'],
  ['BREADTH', 'BREADTH_V1', 'POSITIVE'], ['PARTICIPATION', 'PARTICIPATION_V1', 'ACTIVE'],
  ['INTRADAY_STRESS', 'INTRADAY_STRESS_V1', 'NORMAL'],
] as const;
function row(index: number, override: Partial<DimensionAssessmentCandidate> = {}): DimensionAssessmentCandidate {
  const [dimension, algorithmVersion, state] = identities[index]!;
  const targetAt = dimension === 'INTRADAY_STRESS' ? intradayTarget : dailyTarget;
  return { id: index + 1, dimension, algorithmVersion, evidenceSchemaVersion: 1, targetAt, attempt: 1,
    status: 'VALID', reasonCode: null, rawState: state, effectiveState: state, dataThroughAt: targetAt,
    validUntil: new Date('2026-10-08T18:15:00Z'), completedAt: new Date(targetAt.getTime() + 60_000), ...override };
}
const completeRows = () => identities.map((_, index) => row(index));

describe('market regime composition selection', () => {
  it('selects exactly the five authoritative V1 identities and rejects Breadth V2 by identity', () => {
    const selected = selectMarketRegimeComposition({ observedAt, expectedTargets, assessments: [
      ...completeRows(), row(2, { id: 99, algorithmVersion: 'BREADTH_V2_TERTILE_V1', targetAt: new Date('2026-10-08T17:00:00Z') }),
    ] });
    expect(selected.evidenceHealth).toBe('COMPLETE');
    expect(selected.sources).toHaveLength(5);
    expect(selected.sources.map(source => [source.dimension, source.requiredAlgorithmVersion])).toEqual([
      ['TREND', 'TREND_V1'], ['VOLATILITY', 'VOLATILITY_V1'], ['BREADTH', 'BREADTH_V1'],
      ['PARTICIPATION', 'PARTICIPATION_V1'], ['INTRADAY_STRESS', 'INTRADAY_STRESS_V1'],
    ]);
    expect(selected.sources[2]?.source?.id).toBe(3);
  });

  it('orders by target, attempt, completion and ID without allowing an older late backfill to displace the current target', () => {
    const older = row(0, { id: 200, targetAt: new Date('2026-10-06T20:00:00Z'), attempt: 50, completedAt: new Date('2026-10-08T17:59:00Z') });
    const retry = row(0, { id: 201, attempt: 2, status: 'FAILED', reasonCode: 'LATE_RETRY_FAILED', rawState: null, effectiveState: null, dataThroughAt: null, validUntil: null, completedAt: new Date('2026-10-08T17:58:00Z') });
    const selected = selectMarketRegimeComposition({ observedAt, expectedTargets, assessments: [...completeRows(), older, retry] });
    expect(selected.sources[0]).toMatchObject({ source: { id: 201, attempt: 2 }, health: 'FAILED', reasonCode: 'LATE_RETRY_FAILED' });
    expect(selected.evidenceHealth).toBe('DEGRADED');
  });

  it('excludes attempts completed after the observation time', () => {
    const futureRetry = row(4, { id: 300, attempt: 2, status: 'FAILED', reasonCode: 'FUTURE', rawState: null, effectiveState: null,
      dataThroughAt: null, validUntil: null, completedAt: new Date('2026-10-08T18:00:01Z') });
    const selected = selectMarketRegimeComposition({ observedAt, expectedTargets, assessments: [...completeRows(), futureRetry] });
    expect(selected.sources[4]).toMatchObject({ source: { id: 5, attempt: 1 }, health: 'AVAILABLE' });
  });

  it.each([
    ['MISSING', [], 'SOURCE_MISSING'],
    ['UNAVAILABLE', [row(0, { status: 'UNAVAILABLE', reasonCode: 'MISSING_DATA', rawState: null, effectiveState: null, dataThroughAt: null, validUntil: null })], 'MISSING_DATA'],
    ['FAILED', [row(0, { status: 'FAILED', reasonCode: 'CALCULATION_FAILED', rawState: null, effectiveState: null, dataThroughAt: null, validUntil: null })], 'CALCULATION_FAILED'],
    ['STALE', [row(0, { targetAt: new Date('2026-10-06T20:00:00Z') })], 'EXPECTED_TARGET_NOT_PUBLISHED'],
    ['EXPIRED', [row(0, { validUntil: observedAt })], 'SOURCE_EXPIRED'],
    ['INVALID', [row(0, { effectiveState: null })], 'SOURCE_EVIDENCE_INVALID'],
  ] as const)('records a %s source slot while retaining all five dimensions', (health, trendRows, reasonCode) => {
    const selected = selectMarketRegimeComposition({ observedAt, expectedTargets, assessments: [...completeRows().slice(1), ...trendRows] });
    expect(selected.sources).toHaveLength(5);
    expect(selected.sources[0]).toMatchObject({ health, reasonCode });
    expect(selected).toMatchObject({ publicationStatus: 'SUCCEEDED', evidenceHealth: 'DEGRADED', validUntil: null, dataThroughAt: null });
  });

  it('keeps a stable fingerprint across polls and changes it at source or freshness transitions', () => {
    const first = selectMarketRegimeComposition({ observedAt, expectedTargets, assessments: completeRows() });
    const later = selectMarketRegimeComposition({ observedAt: new Date('2026-10-08T18:05:00Z'), expectedTargets, assessments: completeRows() });
    const expired = selectMarketRegimeComposition({ observedAt: new Date('2026-10-08T18:15:00Z'), expectedTargets, assessments: completeRows() });
    expect(later.sourceSetFingerprint).toBe(first.sourceSetFingerprint);
    expect(expired.sourceSetFingerprint).not.toBe(first.sourceSetFingerprint);
    expect(expired.evidenceHealth).toBe('DEGRADED');
  });

  it('rechecks expiration when deciding whether a persisted successful composition is usable', () => {
    const selected = selectMarketRegimeComposition({ observedAt, expectedTargets, assessments: completeRows() });
    expect(isMarketRegimeCompositionUsable(selected, new Date('2026-10-08T18:14:59Z'))).toBe(true);
    expect(isMarketRegimeCompositionUsable(selected, new Date('2026-10-08T18:15:00Z'))).toBe(false);
  });
});
