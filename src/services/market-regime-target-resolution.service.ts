import type { Prisma, PrismaClient } from '@prisma/client';
import { latestIntradayStressAssessmentTarget } from './intraday-stress-assessment.service.js';
import { latestBreadthV1AssessmentTarget, latestCanonicalDailyAssessmentTarget } from './market-assessment-targets.js';
import type { CalendarException } from './market-calendar.js';
import type { ExpectedMarketRegimeTargets } from './market-regime-composition.service.js';
import { latestParticipationSession } from './participation-publication-calendar.js';

type CalendarReader = Pick<PrismaClient, 'marketCalendarException'> | Pick<Prisma.TransactionClient, 'marketCalendarException'>;

export type MarketRegimeExpectedTargetResolution = {
  observedAt: Date;
  targets: ExpectedMarketRegimeTargets;
  sessions: Record<keyof ExpectedMarketRegimeTargets, string>;
};

function required<T>(value: T | null, label: string): T {
  if (!value) throw new Error(`No expected ${label} target is available within the authoritative calendar horizon.`);
  return value;
}

/**
 * Resolves each composition slot through the same exported target primitive used by its
 * publisher. Intraday resolution retains the latest due target after expiration so the
 * composition can explicitly classify it EXPIRED instead of erasing the expectation.
 */
export function resolveMarketRegimeExpectedTargets(
  observedAt: Date,
  exceptions: readonly CalendarException[],
): MarketRegimeExpectedTargetResolution {
  const canonicalDaily = required(latestCanonicalDailyAssessmentTarget(observedAt, exceptions), 'canonical daily');
  const breadth = required(latestBreadthV1AssessmentTarget(observedAt, exceptions), 'Breadth V1');
  const participation = latestParticipationSession(observedAt, exceptions);
  const intraday = required(latestIntradayStressAssessmentTarget(observedAt, [...exceptions], false), 'Intraday Stress');
  return {
    observedAt,
    targets: {
      trend: canonicalDaily.closeAt,
      volatility: canonicalDaily.closeAt,
      breadth: breadth.closeAt,
      participation: participation.closeAt,
      intradayStress: intraday.targetAt,
    },
    sessions: {
      trend: canonicalDaily.date,
      volatility: canonicalDaily.date,
      breadth: breadth.date,
      participation: participation.date,
      intradayStress: intraday.date,
    },
  };
}

export async function readMarketRegimeExpectedTargets(db: CalendarReader, observedAt: Date) {
  const rows = await db.marketCalendarException.findMany({ orderBy: { sessionDate: 'asc' } });
  const exceptions: CalendarException[] = rows.map(row => ({ ...row, sessionDate: row.sessionDate.toISOString().slice(0, 10) }));
  return resolveMarketRegimeExpectedTargets(observedAt, exceptions);
}
