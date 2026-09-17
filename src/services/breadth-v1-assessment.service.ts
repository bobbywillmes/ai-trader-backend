import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type MarketRegimeDimensionAssessment } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { addDays, barEligibility, COMPLETION_GRACE_MINUTES, datesBetween, etDate, etInstant, marketSession, type CalendarException } from './market-calendar.js';
import {
  advanceBreadthV1, BREADTH_V1_ALGORITHM_VERSION, BREADTH_V1_DEFINITION, BREADTH_V1_EVIDENCE_SCHEMA_VERSION,
  calculateBreadthV1Series, type BreadthState, type BreadthV1Day, type DailyBreadthV1Observation,
} from './breadth-v1-calculation.js';

/** Mirrors the TREND_V1/VOLATILITY_V1 publication orchestration: historical replay
 * establishes today's calculation state; it never creates retroactive authoritative
 * assessment history. Only the resulting current assessment is published. */

const identity = { dimension: 'BREADTH' as const, algorithmVersion: BREADTH_V1_ALGORITHM_VERSION };
export const BREADTH_V1_PUBLICATION_LOCK_KEY = createHash('sha256').update('ai-trader:breadth-v1-publication').digest().readBigInt64BE(0);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const state = z.enum(['NEGATIVE', 'MIXED', 'POSITIVE']);
const continuationSchema = z.object({
  algorithmVersion: z.literal(BREADTH_V1_ALGORITHM_VERSION), evidenceSchemaVersion: z.literal(BREADTH_V1_EVIDENCE_SCHEMA_VERSION),
  transition: z.object({ effectiveState: state, recoveryConfirmationAfter: z.number().int().min(0).max(1), mildDeteriorationConfirmationAfter: z.number().int().min(0).max(1) }),
  provenance: z.object({ inputFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
});
type Assessment = MarketRegimeDimensionAssessment;
type Reason = 'MISSING_MARKET_DATA' | 'INSUFFICIENT_HISTORY' | 'CALCULATION_FAILED' | 'CALENDAR_EVIDENCE_UNAVAILABLE';
export type BreadthV1PublicationResult = {
  published: number; attempts: number; suppressed: boolean; notDue: boolean; bootstrapRequired: boolean;
  blocked: { sessionDate: string; status: 'UNAVAILABLE' | 'FAILED'; reasonCode: Reason } | null;
};
type Options = { db?: PrismaClient; now?: Date; clock?: () => Date };
type ObservationRow = { id: number; sessionDate: Date; universeCount: number; currentBarCount: number; priorBarCount: number; advancingCount: number; decliningCount: number; unchangedCount: number; directionalCount: number; excludedCount: number; advanceShare: Prisma.Decimal; netBreadth: Prisma.Decimal };

function nextSession(date: string, exceptions: CalendarException[]) {
  for (let i = 1; i <= 370; i++) {
    const session = marketSession(addDays(date, i), exceptions);
    if (session) return session;
  }
  throw new Error('No next eligible session within calendar horizon.');
}
function toObservation(row: ObservationRow): DailyBreadthV1Observation {
  return {
    status: 'VALID', universeCount: row.universeCount, currentBarsFound: row.currentBarCount, priorBarsFound: row.priorBarCount,
    eligibleCount: row.advancingCount + row.decliningCount + row.unchangedCount, excludedCount: row.excludedCount,
    advancingCount: row.advancingCount, decliningCount: row.decliningCount, unchangedCount: row.unchangedCount, directionalCount: row.directionalCount,
    advanceShare: row.advanceShare.toNumber(), netBreadth: row.netBreadth.toNumber(),
  };
}
/** Contributing observation ids for the trailing `count` valid sessions ending at `date`
 * (inclusive), matching exactly how `calculateBreadthV1Series`'s own rolling window is built:
 * walking backward through expected sessions, stopping at the first missing one. */
function trailingObservationIds(expectedDates: readonly string[], byDate: ReadonlyMap<string, ObservationRow>, date: string, count: number): number[] {
  const index = expectedDates.indexOf(date);
  const ids: number[] = [];
  for (let i = index; i >= 0 && ids.length < count; i--) {
    const row = byDate.get(expectedDates[i]!);
    if (!row) break;
    ids.unshift(row.id);
  }
  return ids.length === count ? ids : [];
}
function measurementEvidence(measurement: BreadthV1Day['breadth1'], ids: number[]) {
  return measurement ? { value: measurement.value, state: measurement.state, contributingObservationIds: ids } : null;
}

export async function publishBreadthV1Assessments(options: Options = {}): Promise<BreadthV1PublicationResult> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const clock = options.clock ?? (() => new Date());
  const runStartedAt = clock();
  let insertionTarget: Date | null = null;
  try {
    return await db.$transaction(async tx => {
      const locks = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${BREADTH_V1_PUBLICATION_LOCK_KEY}::bigint) AS acquired`;
      if (!locks[0]?.acquired) throw new HttpError(409, 'BREADTH_V1 publication is already running.');
      const result: BreadthV1PublicationResult = { published: 0, attempts: 0, suppressed: false, notDue: false, bootstrapRequired: false, blocked: null };

      const observationCount = await tx.marketBreadthObservation.count();
      if (observationCount === 0) return { ...result, bootstrapRequired: true };

      let predecessor = await tx.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, status: 'VALID' }, orderBy: { targetAt: 'desc' } });
      const pending = await tx.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, ...(predecessor ? { targetAt: { gt: predecessor.targetAt } } : {}) }, orderBy: [{ targetAt: 'asc' }, { attempt: 'desc' }] });
      const calendarRows = await tx.marketCalendarException.findMany({ orderBy: { sessionDate: 'asc' } });
      const exceptions: CalendarException[] = calendarRows.map(row => ({ ...row, sessionDate: row.sessionDate.toISOString().slice(0, 10) }));
      const today = etDate(now);
      const latest = datesBetween(addDays(today, -370), today).reverse().find(date => barEligibility('DAY_1', etInstant(date, 0), now, exceptions).status === 'ELIGIBLE');
      if (!latest || (predecessor?.sessionDate && predecessor.sessionDate.toISOString().slice(0, 10) >= latest)) return { ...result, notDue: true };

      const earliestObservation = await tx.marketBreadthObservation.findFirst({ orderBy: { sessionDate: 'asc' } });
      const observationRows: ObservationRow[] = await tx.marketBreadthObservation.findMany({ where: { sessionDate: { lte: new Date(latest) } }, orderBy: { sessionDate: 'asc' } });
      const observationByDate = new Map(observationRows.map(row => [row.sessionDate.toISOString().slice(0, 10), row]));

      let date = pending?.sessionDate?.toISOString().slice(0, 10) ?? (predecessor?.sessionDate ? nextSession(predecessor.sessionDate.toISOString().slice(0, 10), exceptions).date : undefined);
      if (!date) {
        // Bootstrap: find the latest calculable session, rather than losing a usable bootstrap
        // because a more recent gap needs to warm up again.
        const inputFrom = earliestObservation!.sessionDate.toISOString().slice(0, 10);
        const expected = datesBetween(inputFrom, latest).filter(d => marketSession(d, exceptions));
        try {
          const replay = calculateBreadthV1Series(expected, expected.map(d => { const row = observationByDate.get(d); return row ? toObservation(row) : null; }));
          date = replay.reverse().find(day => day.effectiveState !== null)?.date ?? latest;
        } catch { date = latest; }
      }

      // Bounded catch-up; another invocation continues at the next session.
      for (let count = 0; count < 20 && date <= latest; count++) {
        const date_: string = date; // Narrowed once per iteration so closures below see a string, not `string | undefined`.
        const startedAt = count === 0 ? runStartedAt : clock();
        const priorAttempt = await tx.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, sessionDate: new Date(date_) }, orderBy: { attempt: 'desc' } });
        const session = marketSession(date_, exceptions);
        const targetAt = priorAttempt?.targetAt ?? session?.closeAt;
        if (!targetAt) throw new Error('An unresolved Breadth session is now closed in calendar configuration.');
        if (now.getTime() < targetAt.getTime() + COMPLETION_GRACE_MINUTES.DAY_1 * 60_000) return { ...result, notDue: result.attempts === 0 };
        const next = nextSession(date_, exceptions);
        const validUntil = new Date(next.closeAt.getTime() + COMPLETION_GRACE_MINUTES.DAY_1 * 60_000);

        let reasonCode: Reason | null = null;
        let status: 'VALID' | 'UNAVAILABLE' | 'FAILED' = 'VALID';
        let continuation: z.infer<typeof continuationSchema> | null = null;
        let inputFrom = earliestObservation!.sessionDate.toISOString().slice(0, 10);
        try {
          if (predecessor) {
            if (predecessor.dimension !== identity.dimension || predecessor.algorithmVersion !== identity.algorithmVersion || predecessor.status !== 'VALID') throw new Error('Invalid predecessor identity.');
            continuation = continuationSchema.parse(predecessor.evidenceJson);
            if (predecessor.evidenceSchemaVersion !== BREADTH_V1_EVIDENCE_SCHEMA_VERSION || continuation.transition.effectiveState !== predecessor.effectiveState) throw new Error('Inconsistent predecessor evidence.');
            inputFrom = continuation.provenance.inputFrom;
          }
        } catch { status = 'FAILED'; reasonCode = 'CALCULATION_FAILED'; }

        const expectedDates = datesBetween(inputFrom, date_).filter(d => marketSession(d, exceptions));
        let day: BreadthV1Day | undefined;
        if (!reasonCode) {
          try {
            const series = calculateBreadthV1Series(expectedDates, expectedDates.map(d => { const row = observationByDate.get(d); return row ? toObservation(row) : null; }));
            day = series.at(-1);
            if (!day || day.date !== date_) { status = 'FAILED'; reasonCode = 'CALCULATION_FAILED'; }
            else if (day.observation === null) { status = 'UNAVAILABLE'; reasonCode = 'MISSING_MARKET_DATA'; }
            else if (day.rawState === null) { status = 'UNAVAILABLE'; reasonCode = 'INSUFFICIENT_HISTORY'; }
            else if (continuation) {
              day.hysteresis = advanceBreadthV1({ effectiveState: continuation.transition.effectiveState, recoveryConfirmation: continuation.transition.recoveryConfirmationAfter, mildDeteriorationConfirmation: continuation.transition.mildDeteriorationConfirmationAfter }, day.rawState);
              day.effectiveState = day.hysteresis.effectiveState;
            }
          } catch { status = 'FAILED'; reasonCode = 'CALCULATION_FAILED'; }
        }
        const currentObservation = observationByDate.get(date_);
        const provenance = {
          provider: 'MASSIVE', universeDefinitionVersion: BREADTH_V1_DEFINITION.universeDefinitionVersion, groupedBarsAdjustment: BREADTH_V1_DEFINITION.groupedBarsAdjustment,
          inputFrom, sessionDate: date_,
          currentObservationId: currentObservation?.id ?? null,
          breadth1ObservationIds: trailingObservationIds(expectedDates, observationByDate, date_, 1),
          breadth5ObservationIds: trailingObservationIds(expectedDates, observationByDate, date_, 5),
          breadth20ObservationIds: trailingObservationIds(expectedDates, observationByDate, date_, 20),
          canonicalReplayHash: hash({ expectedDates, observationIds: expectedDates.map(d => observationByDate.get(d)?.id ?? null), inputFrom, date: date_ }),
        };
        const fingerprint = hash({ algorithmVersion: BREADTH_V1_ALGORITHM_VERSION, evidenceSchemaVersion: BREADTH_V1_EVIDENCE_SCHEMA_VERSION, status, reasonCode, provenance, predecessorId: predecessor?.id ?? null, targetAt, validUntil });
        if (reasonCode && priorAttempt?.status !== 'VALID' && (priorAttempt?.evidenceJson as { attemptFingerprint?: string } | undefined)?.attemptFingerprint === fingerprint) {
          return { ...result, suppressed: true, blocked: { sessionDate: date_, status: status as 'FAILED' | 'UNAVAILABLE', reasonCode } };
        }
        const completedAt = clock();
        const evidence = {
          algorithmVersion: BREADTH_V1_ALGORITHM_VERSION, evidenceSchemaVersion: BREADTH_V1_EVIDENCE_SCHEMA_VERSION,
          definition: BREADTH_V1_DEFINITION, sessionDate: date_, targetAt, dataThroughAt: status === 'VALID' ? targetAt : null, completedAt,
          calendar: { expectedSessionClose: session?.closeAt ?? null, graceMinutes: COMPLETION_GRACE_MINUTES.DAY_1, graceCutoff: new Date(targetAt.getTime() + COMPLETION_GRACE_MINUTES.DAY_1 * 60_000), exception: exceptions.find(e => e.sessionDate === date_) ?? null, nextExpectedSession: { sessionDate: next.date, closeAt: next.closeAt, validUntil, calendarException: exceptions.find(e => e.sessionDate === next.date) ?? null } },
          validUntil: status === 'VALID' ? validUntil : null,
          provenance, attemptFingerprint: fingerprint, reasonCode,
          bootstrap: !predecessor && status === 'VALID',
          ...(status !== 'VALID' ? { transition: { predecessorAssessmentId: predecessor?.id ?? null, ...advanceBreadthV1({ effectiveState: continuation?.transition.effectiveState ?? null, recoveryConfirmation: continuation?.transition.recoveryConfirmationAfter ?? 0, mildDeteriorationConfirmation: continuation?.transition.mildDeteriorationConfirmationAfter ?? 0 }, null) } } : {}),
          ...(!predecessor && status === 'VALID' ? { historicalReplay: { start: expectedDates[0] ?? null, sessionCount: expectedDates.length, observationCount: observationRows.filter(row => row.sessionDate.toISOString().slice(0, 10) >= inputFrom && row.sessionDate.toISOString().slice(0, 10) <= date_).length, dataThroughAt: targetAt, explanation: 'Initialized through historical replay of immutable MarketBreadthObservation evidence. Only the resulting current assessment is published authoritatively; replayed sessions are not publications.' } } : {}),
          ...(status === 'VALID' && day ? {
            measurements: { breadth1: measurementEvidence(day.breadth1, provenance.breadth1ObservationIds), breadth5: measurementEvidence(day.breadth5, provenance.breadth5ObservationIds), breadth20: measurementEvidence(day.breadth20, provenance.breadth20ObservationIds) },
            rawAggregation: { breadth1State: day.breadth1!.state, breadth5State: day.breadth5!.state, breadth20State: day.breadth20!.state, rawState: day.rawState, rule: BREADTH_V1_DEFINITION.aggregationRule },
            transition: { predecessorAssessmentId: predecessor?.id ?? null, ...day.hysteresis },
          } : {}),
        };
        insertionTarget = targetAt;
        const assessment: Assessment = await tx.marketRegimeDimensionAssessment.create({ data: {
          ...identity, evidenceSchemaVersion: BREADTH_V1_EVIDENCE_SCHEMA_VERSION, sessionDate: new Date(date_), targetAt,
          attempt: (priorAttempt?.attempt ?? 0) + 1, status, reasonCode,
          rawState: status === 'VALID' ? day!.rawState : null, effectiveState: status === 'VALID' ? day!.effectiveState : null,
          dataThroughAt: status === 'VALID' ? targetAt : null, validUntil: status === 'VALID' ? validUntil : null,
          previousAssessmentId: predecessor?.id ?? null, startedAt, completedAt, evidenceJson: json(evidence),
        } });
        result.attempts++;
        const event = reasonCode ? 'breadth_assessment_blocked' : !predecessor ? 'breadth_assessment_bootstrap' : priorAttempt ? 'breadth_assessment_recovered' : day!.hysteresis.transitioned ? 'breadth_assessment_transition' : null;
        if (event) await tx.systemEvent.create({ data: { type: event, entityType: 'market_regime_assessment', entityId: String(assessment.id), severity: reasonCode ? 'WARNING' : 'INFO', message: reasonCode ? `BREADTH_V1 stopped at ${date_}: ${reasonCode}.` : `BREADTH_V1 ${date_}: ${day!.effectiveState}.`, payloadJson: { assessmentId: assessment.id, sessionDate: date_, reasonCode, previousAssessmentId: predecessor?.id ?? null } } });
        if (reasonCode) return { ...result, blocked: { sessionDate: date_, status: status as 'FAILED' | 'UNAVAILABLE', reasonCode } };
        result.published++;
        predecessor = assessment;
        date = next.date;
      }
      return result;
    }, { timeout: 240_000, maxWait: 5_000 });
  } catch (error) {
    if (insertionTarget && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await db.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, targetAt: insertionTarget, status: 'VALID' } });
      if (winner) return { published: 0, attempts: 0, suppressed: true, notDue: false, bootstrapRequired: false, blocked: null };
    }
    throw error;
  }
}

export async function latestBreadthV1Assessment() {
  const [latestAttempt, latestValid] = await Promise.all([
    prisma.marketRegimeDimensionAssessment.findFirst({ where: identity, orderBy: [{ targetAt: 'desc' }, { attempt: 'desc' }] }),
    prisma.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, status: 'VALID' }, orderBy: { targetAt: 'desc' } }),
  ]);
  return { latestAttempt, latestValid };
}
export async function listBreadthV1Assessments(limit: number, beforeId?: number) {
  return prisma.marketRegimeDimensionAssessment.findMany({ where: { ...identity, ...(beforeId ? { id: { lt: beforeId } } : {}) }, orderBy: { id: 'desc' }, take: limit });
}
export async function getBreadthV1Assessment(id: number) {
  const row = await prisma.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, id } });
  if (!row) throw new HttpError(404, 'BREADTH_V1 assessment not found.');
  return row;
}
