import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type MarketRegimeDimensionAssessment } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { fetchSplitEvidence, type SplitEvent } from '../integrations/massive/evidence.client.js';
import { addDays, barEligibility, COMPLETION_GRACE_MINUTES, datesBetween, etDate, etInstant, marketSession, type CalendarException } from './market-calendar.js';
import { advanceTrend, calculateTrendWithThresholds, normalizeSplits, type TrendDay, type ResearchBar } from './trend-calculation.js';
import { TREND_ALGORITHM_VERSION, TREND_PUBLICATION_EVIDENCE_VERSION, TREND_V1_THRESHOLDS, TREND_V1_THRESHOLD_EVIDENCE } from './trend-v1.definition.js';

const identity = { dimension: 'TREND' as const, algorithmVersion: TREND_ALGORITHM_VERSION };
export const TREND_PUBLICATION_LOCK_KEY = createHash('sha256').update('ai-trader:trend-v1-publication').digest().readBigInt64BE(0);
const symbols = ['SPY', 'RSP'] as const;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const state = z.enum(['DOWN', 'NEUTRAL', 'UP']);
const continuationSchema = z.object({
  algorithmVersion: z.literal(TREND_ALGORITHM_VERSION), evidenceSchemaVersion: z.literal(TREND_PUBLICATION_EVIDENCE_VERSION),
  transition: z.object({ effectiveState: state, recoveryConfirmation: z.number().int().min(0).max(1) }),
  provenance: z.object({ inputFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), operationalFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
});
type Assessment = MarketRegimeDimensionAssessment;
type Reason = 'MISSING_MARKET_DATA' | 'INSUFFICIENT_HISTORY' | 'SPLIT_EVIDENCE_UNAVAILABLE' | 'CALCULATION_FAILED';
export type TrendPublicationResult = { published: number; attempts: number; suppressed: boolean; notDue: boolean; blocked: { sessionDate: string; status: 'UNAVAILABLE' | 'FAILED'; reasonCode: Reason } | null };
type Options = { db?: PrismaClient; now?: Date; clock?: () => Date; fetchSplits?: typeof fetchSplitEvidence };

function nextSession(date: string, exceptions: CalendarException[]) {
  for (let i = 1; i <= 370; i++) {
    const session = marketSession(addDays(date, i), exceptions);
    if (session) return session;
  }
  throw new Error('No next eligible session within calendar horizon.');
}

/** All reads, state selection, and writes share the transaction that owns the lock.
 * Losing its connection rolls back writes and releases the lock together. No account scope.
 */
export async function publishTrendAssessments(options: Options = {}): Promise<TrendPublicationResult> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const clock = options.clock ?? (() => new Date());
  const runStartedAt = clock();
  let insertionTarget: Date | null = null;
  try {
    return await db.$transaction(async tx => {
      const locks = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${TREND_PUBLICATION_LOCK_KEY}::bigint) AS acquired`;
      if (!locks[0]?.acquired) throw new HttpError(409, 'TREND_V1 publication is already running.');
      const result: TrendPublicationResult = { published: 0, attempts: 0, suppressed: false, notDue: false, blocked: null };
      let predecessor = await tx.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, status: 'VALID' }, orderBy: { targetAt: 'desc' } });
      const pending = await tx.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, ...(predecessor ? { targetAt: { gt: predecessor.targetAt } } : {}) }, orderBy: [{ targetAt: 'asc' }, { attempt: 'desc' }] });
      const calendarRows = await tx.marketCalendarException.findMany({ orderBy: { sessionDate: 'asc' } });
      const exceptions: CalendarException[] = calendarRows.map(row => ({ ...row, sessionDate: row.sessionDate.toISOString().slice(0, 10) }));
      const today = etDate(now);
      // One year covers even extended closures, without inventing an eligible date.
      const latest = datesBetween(addDays(today, -370), today).reverse().find(date => barEligibility('DAY_1', etInstant(date, 0), now, exceptions).status === 'ELIGIBLE');
      if (!latest || (predecessor?.sessionDate && predecessor.sessionDate.toISOString().slice(0, 10) >= latest)) return { ...result, notDue: true };
      const securities = await tx.security.findMany({ where: { symbol: { in: [...symbols] } }, select: { id: true, symbol: true } });
      const rows = await tx.marketBar.findMany({ where: { securityId: { in: securities.map(s => s.id) }, timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED', barStartAt: { lt: etInstant(addDays(latest, 1), 0) } }, orderBy: [{ barStartAt: 'asc' }, { id: 'asc' }] });
      const inputs = symbols.map(symbol => {
        const security = securities.find(s => s.symbol === symbol);
        const bars: ResearchBar[] = rows.filter(row => row.securityId === security?.id && barEligibility('DAY_1', row.barStartAt, now, exceptions).status === 'ELIGIBLE').map(row => ({ id: row.id, date: etDate(row.barStartAt), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }));
        return { symbol, securityId: security?.id ?? null, bars };
      });
      const common = inputs[0]!.bars.filter(bar => inputs[1]!.bars.some(other => other.date === bar.date));
      // A failed first bootstrap pins its target too: recovery must not silently skip it.
      let date = pending?.sessionDate?.toISOString().slice(0, 10) ?? (predecessor?.sessionDate ? nextSession(predecessor.sessionDate.toISOString().slice(0, 10), exceptions).date : common.at(-1)?.date ?? latest);
      let splitCache: SplitEvent[][] | null = null;
      let splitFailed = false;
      if (!predecessor && !pending && common.length) {
        // Find the latest calculable common session, rather than losing a usable
        // bootstrap because a more recent partial history needs to warm up again.
        const from = inputs.flatMap(input => input.bars.map(bar => bar.date)).sort()[0]!;
        try {
          splitCache = await Promise.all(symbols.map(symbol => (options.fetchSplits ?? fetchSplitEvidence)(symbol, from, latest)));
          splitCache.forEach((splits, i) => {
            if (splits.some(s => s.symbol !== symbols[i] || s.executionDate < from || s.executionDate > latest)) throw new Error('Invalid split identity.');
            normalizeSplits([], splits, latest);
          });
        } catch { splitCache = null; splitFailed = true; }
        if (splitCache) {
          try {
            const ordered = [...new Set(inputs.flatMap(input => input.bars.map(bar => bar.date)))].sort();
            const normalized = inputs.map((input, i) => new Map(normalizeSplits(input.bars, splitCache![i]!, latest).map(bar => [bar.date, bar])));
            const replay = calculateTrendWithThresholds(ordered, ordered.map(d => normalized[0]!.get(d) ?? null), ordered.map(d => normalized[1]!.get(d) ?? null), TREND_V1_THRESHOLDS);
            date = replay.reverse().find(day => day.status === 'VALID')?.date ?? date;
          } catch { /* The attempted target below records the bounded calculation failure. */ }
        }
      }
      // Bounded catch-up; another invocation continues at the next session.
      for (let count = 0; count < 20 && date <= latest; count++) {
        const startedAt = count === 0 ? runStartedAt : clock();
        const priorAttempt = await tx.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, sessionDate: new Date(date) }, orderBy: { attempt: 'desc' } });
        const session = marketSession(date, exceptions);
        // Previously attempted targets retain their publication identity after calendar edits.
        const targetAt = priorAttempt?.targetAt ?? session?.closeAt;
        if (!targetAt) throw new Error('An unresolved Trend session is now closed in calendar configuration.');
        const next = nextSession(date, exceptions);
        const validUntil = new Date(next.closeAt.getTime() + COMPLETION_GRACE_MINUTES.DAY_1 * 60_000);
        let reasonCode: Reason | null = null;
        let status: 'VALID' | 'UNAVAILABLE' | 'FAILED' = 'VALID';
        let day: TrendDay | undefined;
        let normalizationFactors: { from: string; through: string; factor: number; count: number }[][] = [[], []];
        let continuation: z.infer<typeof continuationSchema> | null = null;
        let inputFrom = inputs.flatMap(input => input.bars.map(bar => bar.date)).sort()[0] ?? date;
        let operationalFrom = date;
        try {
          if (predecessor) {
            continuation = continuationSchema.parse(predecessor.evidenceJson);
            if (predecessor.evidenceSchemaVersion !== TREND_PUBLICATION_EVIDENCE_VERSION || continuation.transition.effectiveState !== predecessor.effectiveState) throw new Error('Inconsistent predecessor evidence.');
            inputFrom = continuation.provenance.inputFrom;
            operationalFrom = continuation.provenance.operationalFrom;
          }
        } catch { status = 'FAILED'; reasonCode = 'CALCULATION_FAILED'; }
        const source = inputs.map(input => ({ ...input, bars: input.bars.filter(bar => bar.date >= inputFrom && bar.date <= date) }));
        const missingSymbols = source.filter(input => !input.bars.some(bar => bar.date === date)).map(input => input.symbol);
        if (!reasonCode && missingSymbols.length) { status = 'UNAVAILABLE'; reasonCode = 'MISSING_MARKET_DATA'; }
        if (!reasonCode && !splitCache && !splitFailed) {
          try {
            splitCache = await Promise.all(symbols.map(symbol => (options.fetchSplits ?? fetchSplitEvidence)(symbol, inputFrom, latest)));
            // Validate before treating splits as usable; no raw provider payload is persisted.
            splitCache.forEach((splits, i) => {
              if (splits.some(s => s.symbol !== symbols[i] || s.executionDate < inputFrom || s.executionDate > latest)) throw new Error('Invalid split identity.');
              normalizeSplits([], splits, latest);
            });
          } catch { splitFailed = true; splitCache = null; }
        }
        if (!reasonCode && splitFailed) { status = 'FAILED'; reasonCode = 'SPLIT_EVIDENCE_UNAVAILABLE'; }
        const splits = source.map((_, i) => (splitCache?.[i] ?? []).filter(split => split.executionDate <= date));
        const dates = new Set(source.flatMap(input => input.bars.map(bar => bar.date)));
        // Historical replay uses observed sessions, as in the lab. From bootstrap onward,
        // every expected session is required, including sessions missing BOTH instruments.
        for (const expected of datesBetween(operationalFrom, date)) if (marketSession(expected, exceptions)) dates.add(expected);
        const ordered = [...dates].sort();
        if (!reasonCode) {
          try {
            const normalizedBars = source.map((input, i) => normalizeSplits(input.bars, splits[i]!, date));
            normalizationFactors = normalizedBars.map(bars => {
              const ranges: { from: string; through: string; factor: number; count: number }[] = [];
              for (const bar of bars) {
                const range = ranges.at(-1);
                if (range?.factor === bar.normalizationFactor) { range.through = bar.date; range.count++; }
                else ranges.push({ from: bar.date, through: bar.date, factor: bar.normalizationFactor, count: 1 });
              }
              return ranges;
            });
            const normalized = normalizedBars.map(bars => new Map(bars.map(bar => [bar.date, bar])));
            day = calculateTrendWithThresholds(ordered, ordered.map(d => normalized[0]!.get(d) ?? null), ordered.map(d => normalized[1]!.get(d) ?? null), TREND_V1_THRESHOLDS).at(-1);
            if (!day || day.date !== date || day.status !== 'VALID') { status = 'UNAVAILABLE'; reasonCode = 'INSUFFICIENT_HISTORY'; }
            else if (continuation) {
              day.transition = advanceTrend({ effective: continuation.transition.effectiveState, recoveryConfirmation: continuation.transition.recoveryConfirmation }, day.rawState);
              day.effectiveState = day.transition.effectiveState;
            }
          } catch { status = 'FAILED'; reasonCode = 'CALCULATION_FAILED'; }
        }
        const provenance = {
          provider: 'MASSIVE', timeframe: 'DAY_1', adjustmentSemantics: 'Stored UNADJUSTED; split-normalized only in calculation; no dividend adjustment.',
          inputFrom, operationalFrom, normalizedThrough: date,
          canonicalInputHash: hash({ source, splits, dates: ordered }),
          instruments: source.map((input, i) => ({ symbol: input.symbol, securityId: input.securityId, count: input.bars.length, from: input.bars[0]?.date ?? null, through: input.bars.at(-1)?.date ?? null, firstMarketBarId: input.bars[0]?.id ?? null, lastMarketBarId: input.bars.at(-1)?.id ?? null, splits: splits[i], normalizationFactors: normalizationFactors[i], normalization: 'For each bar multiply prices by the product of splitFrom/splitTo for events after its session and through normalizedThrough; divide volume by that product.' })),
        };
        const fingerprint = hash({ algorithmVersion: TREND_ALGORITHM_VERSION, evidenceSchemaVersion: TREND_PUBLICATION_EVIDENCE_VERSION, status, reasonCode, provenance, missingSymbols, predecessorId: predecessor?.id ?? null, targetAt, validUntil });
        if (reasonCode && priorAttempt?.status !== 'VALID' && (priorAttempt?.evidenceJson as { attemptFingerprint?: string } | undefined)?.attemptFingerprint === fingerprint) {
          return { ...result, suppressed: true, blocked: { sessionDate: date, status: status as 'FAILED' | 'UNAVAILABLE', reasonCode } };
        }
        const completedAt = clock();
        const evidence = {
          algorithmVersion: TREND_ALGORITHM_VERSION, evidenceSchemaVersion: TREND_PUBLICATION_EVIDENCE_VERSION,
          thresholdsPercentagePoints: TREND_V1_THRESHOLD_EVIDENCE, sessionDate: date, targetAt, dataThroughAt: status === 'VALID' ? targetAt : null, completedAt,
          nextExpectedSession: { sessionDate: next.date, closeAt: next.closeAt, graceMinutes: COMPLETION_GRACE_MINUTES.DAY_1, validUntil, calendarException: exceptions.find(e => e.sessionDate === next.date) ?? null },
          provenance, attemptFingerprint: fingerprint, reasonCode, missingSymbols,
          bootstrap: !predecessor && status === 'VALID',
          ...(!predecessor && status === 'VALID' ? { historicalReplay: { start: ordered[0] ?? null, sessionCount: ordered.length, dataThroughAt: targetAt, explanation: 'Initialized through historical replay. Only the resulting current assessment is published authoritatively; replayed sessions are not publications. Historical sessions use observed SPY/RSP dates, not a reconstructed holiday calendar.' } } : {}),
          ...(status === 'VALID' && day ? { spy: day.spy, rsp: day.rsp, market: { spyState: day.spy.state, rspState: day.rsp.state, rawState: day.rawState, explanation: day.marketReason }, transition: { predecessorAssessmentId: predecessor?.id ?? null, ...day.transition } } : {}),
        };
        insertionTarget = targetAt;
        const assessment: Assessment = await tx.marketRegimeDimensionAssessment.create({ data: {
          ...identity, evidenceSchemaVersion: TREND_PUBLICATION_EVIDENCE_VERSION, sessionDate: new Date(date), targetAt,
          attempt: (priorAttempt?.attempt ?? 0) + 1, status, reasonCode,
          rawState: status === 'VALID' ? day!.rawState : null, effectiveState: status === 'VALID' ? day!.effectiveState : null,
          dataThroughAt: status === 'VALID' ? targetAt : null, validUntil: status === 'VALID' ? validUntil : null,
          previousAssessmentId: predecessor?.id ?? null, startedAt, completedAt, evidenceJson: json(evidence),
        } });
        result.attempts++;
        const event = reasonCode ? 'trend_assessment_blocked' : !predecessor ? 'trend_assessment_bootstrap' : priorAttempt ? 'trend_assessment_recovered' : day!.transition.transitioned ? 'trend_assessment_transition' : null;
        if (event) await tx.systemEvent.create({ data: { type: event, entityType: 'market_regime_assessment', entityId: String(assessment.id), severity: reasonCode ? 'WARNING' : 'INFO', message: reasonCode ? `TREND_V1 stopped at ${date}: ${reasonCode}.` : `TREND_V1 ${date}: ${day!.effectiveState}.`, payloadJson: { assessmentId: assessment.id, sessionDate: date, reasonCode, previousAssessmentId: predecessor?.id ?? null } } });
        if (reasonCode) return { ...result, blocked: { sessionDate: date, status: status as 'FAILED' | 'UNAVAILABLE', reasonCode } };
        result.published++;
        predecessor = assessment;
        date = next.date;
      }
      return result;
    }, { timeout: 240_000, maxWait: 5_000 });
  } catch (error) {
    // Final DB uniqueness guard, including competing writers outside this service.
    if (insertionTarget && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await db.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, targetAt: insertionTarget, status: 'VALID' } });
      if (winner) return { published: 0, attempts: 0, suppressed: true, notDue: false, blocked: null };
    }
    throw error;
  }
}

export async function latestTrendAssessment() {
  const [latestAttempt, latestValid] = await Promise.all([
    prisma.marketRegimeDimensionAssessment.findFirst({ where: identity, orderBy: [{ targetAt: 'desc' }, { attempt: 'desc' }] }),
    prisma.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, status: 'VALID' }, orderBy: { targetAt: 'desc' } }),
  ]);
  return { latestAttempt, latestValid };
}
export async function listTrendAssessments(limit: number, beforeId?: number) {
  return prisma.marketRegimeDimensionAssessment.findMany({ where: { ...identity, ...(beforeId ? { id: { lt: beforeId } } : {}) }, orderBy: { id: 'desc' }, take: limit });
}
export async function getTrendAssessment(id: number) {
  const row = await prisma.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, id } });
  if (!row) throw new HttpError(404, 'TREND_V1 assessment not found.');
  return row;
}
