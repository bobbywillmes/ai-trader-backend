import { Prisma, type MarketRegimeDimension } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { BREADTH_V2_TERTILE_V1 } from './breadth-v2.definition.js';
import { breadthV2AssessmentStatus } from './breadth-v2-assessment.service.js';
import { breadthV2ObservationStatus, BREADTH_V2_MEASUREMENT_VERSION } from './breadth-v2-measurement.service.js';
import { breadthV2ShadowSnapshot } from '../workers/breadth-v2-shadow.worker.js';

const V1_IDENTITIES = [
  { key: 'trend', dimension: 'TREND', algorithmVersion: 'TREND_V1' },
  { key: 'volatility', dimension: 'VOLATILITY', algorithmVersion: 'VOLATILITY_V1' },
  { key: 'breadth', dimension: 'BREADTH', algorithmVersion: 'BREADTH_V1' },
  { key: 'participation', dimension: 'PARTICIPATION', algorithmVersion: 'PARTICIPATION_V1' },
  { key: 'intradayStress', dimension: 'INTRADAY_STRESS', algorithmVersion: 'INTRADAY_STRESS_V1' },
] as const satisfies readonly { key: string; dimension: MarketRegimeDimension; algorithmVersion: string }[];

const order = [{ targetAt: 'desc' as const }, { attempt: 'desc' as const }];

/**
 * Observes independently published dimensions. The result is not a synchronized market snapshot
 * and grants no trading authority. Assessment identities are read from one repeatable-read view;
 * readiness remains an independently evaluated operational observation.
 */
export async function getMarketIntelligenceSummary(now = new Date()) {
  const observed = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const dimensions = await Promise.all(V1_IDENTITIES.map(async identity => {
      const where = { dimension: identity.dimension, algorithmVersion: identity.algorithmVersion };
      const [latestAttempt, latestValid] = await Promise.all([
        tx.marketRegimeDimensionAssessment.findFirst({ where, orderBy: order }),
        tx.marketRegimeDimensionAssessment.findFirst({ where: { ...where, status: 'VALID' }, orderBy: { targetAt: 'desc' } }),
      ]);
      return [identity.key, { dimension: identity.dimension, algorithmVersion: identity.algorithmVersion, latestAttempt, latestValid }] as const;
    }));
    const v2Where = { dimension: 'BREADTH' as const, algorithmVersion: BREADTH_V2_TERTILE_V1.algorithmVersion };
    const [latestAttempt, latestValid, latestObservation] = await Promise.all([
      tx.marketRegimeDimensionAssessment.findFirst({ where: v2Where, orderBy: order }),
      tx.marketRegimeDimensionAssessment.findFirst({ where: { ...v2Where, status: 'VALID' }, orderBy: { targetAt: 'desc' } }),
      tx.marketBreadthObservationSet.findFirst({ where: { measurementVersion: BREADTH_V2_MEASUREMENT_VERSION }, orderBy: [{ sessionDate: 'desc' }, { id: 'desc' }], include: { horizons: { orderBy: { horizonSessions: 'asc' } } } }),
    ]);
    return { dimensions: Object.fromEntries(dimensions), breadthV2: { latestAttempt, latestValid, latestObservation } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

  const [assessmentReadiness, observationReadiness] = await Promise.all([
    breadthV2AssessmentStatus({ now }),
    breadthV2ObservationStatus({ now }),
  ]);
  return {
    evaluatedAt: now,
    semantics: 'Independent publication observations; not a synchronized market snapshot and not trading authority.',
    ...observed,
    breadthV2: { ...observed.breadthV2, assessmentReadiness, observationReadiness, worker: breadthV2ShadowSnapshot() },
  };
}
