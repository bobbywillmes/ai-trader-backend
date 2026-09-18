import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type MarketRegimeDimensionAssessment } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { fetchSplitEvidence, type SplitEvent } from '../integrations/massive/evidence.client.js';
import { addDays, barEligibility, COMPLETION_GRACE_MINUTES, datesBetween, etDate, etInstant, marketSession, type CalendarException } from './market-calendar.js';
import { advanceVolatility, calculateVolatility, type VolatilityDay } from './volatility-calculation.js';
import { normalizeSplits, type ResearchBar } from './trend-calculation.js';
import { VOLATILITY_ALGORITHM_VERSION, VOLATILITY_PUBLICATION_EVIDENCE_VERSION, VOLATILITY_V1_DEFINITION } from './volatility-v1.definition.js';
import { VERIFIED_NYSE_CLOSURES } from './market-calendar-bootstrap.definition.js';

const identity = { dimension: 'VOLATILITY' as const, algorithmVersion: VOLATILITY_ALGORITHM_VERSION };
export const VOLATILITY_PUBLICATION_LOCK_KEY = createHash('sha256').update('ai-trader:volatility-v1-publication').digest().readBigInt64BE(0);
function instrumentEvidence(input: VolatilityDay['spy']) {
  return { ...input, severities: [input.RV10, input.RV20, input.ATR14Pct].map(m => m ? VOLATILITY_V1_DEFINITION.severity[m.state] : null) };
}
const symbols = ['SPY', 'RSP'] as const;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const state = z.enum(['LOW', 'NORMAL', 'HIGH', 'EXTREME']);
const continuationSchema = z.object({
  algorithmVersion: z.literal(VOLATILITY_ALGORITHM_VERSION), evidenceSchemaVersion: z.literal(VOLATILITY_PUBLICATION_EVIDENCE_VERSION),
  transition: z.object({ effectiveState: state, confirmationAfter: z.number().int().min(0).max(1) }),
  provenance: z.object({ inputFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), operationalFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
});
type Assessment = MarketRegimeDimensionAssessment;
type Reason = 'MISSING_MARKET_DATA' | 'INSUFFICIENT_HISTORY' | 'SPLIT_EVIDENCE_UNAVAILABLE' | 'CALCULATION_FAILED' | 'CALENDAR_EVIDENCE_UNAVAILABLE';
export type VolatilityPublicationResult = { published: number; attempts: number; suppressed: boolean; notDue: boolean; blocked: { sessionDate: string; status: 'UNAVAILABLE' | 'FAILED'; reasonCode: Reason } | null };
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
export async function publishVolatilityAssessments(options: Options = {}): Promise<VolatilityPublicationResult> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const clock = options.clock ?? (() => new Date());
  const runStartedAt = clock();
  let insertionTarget: Date | null = null;
  try {
    return await db.$transaction(async tx => {
      const locks = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${VOLATILITY_PUBLICATION_LOCK_KEY}::bigint) AS acquired`;
      if (!locks[0]?.acquired) throw new HttpError(409, 'VOLATILITY_V1 publication is already running.');
      const result: VolatilityPublicationResult = { published: 0, attempts: 0, suppressed: false, notDue: false, blocked: null };
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
      const earliestInput = inputs.flatMap(input => input.bars.map(bar => bar.date)).sort()[0] ?? latest;
      const missingClosures = VERIFIED_NYSE_CLOSURES.closedDates.filter(date => date >= earliestInput && date <= addDays(latest, 370)
        && !exceptions.some(row => row.sessionDate === date && row.type === 'CLOSED' && row.closeTimeMinutesEt === null));
      // A failed first bootstrap pins its target too: recovery must not silently skip it.
      let date = pending?.sessionDate?.toISOString().slice(0, 10) ?? (predecessor?.sessionDate ? nextSession(predecessor.sessionDate.toISOString().slice(0, 10), exceptions).date : common.at(-1)?.date ?? latest);
      let splitCache: SplitEvent[][] | null = null;
      let splitFailed = false;
      if (!predecessor && !pending && common.length && !missingClosures.length) {
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
            const ordered = datesBetween(from, latest).filter(d => marketSession(d, exceptions));
            const normalized = inputs.map((input, i) => new Map(normalizeSplits(input.bars, splitCache![i]!, latest).map(bar => [bar.date, bar])));
            const replay = calculateVolatility(ordered, ordered.map(d => normalized[0]!.get(d) ?? null), ordered.map(d => normalized[1]!.get(d) ?? null));
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
        if (!targetAt) throw new Error('An unresolved Volatility session is now closed in calendar configuration.');
        if (now.getTime() < targetAt.getTime() + COMPLETION_GRACE_MINUTES.DAY_1 * 60_000) return { ...result, notDue: result.attempts === 0 };
        const next = nextSession(date, exceptions);
        const validUntil = new Date(next.closeAt.getTime() + COMPLETION_GRACE_MINUTES.DAY_1 * 60_000);
        let reasonCode: Reason | null = null;
        let status: 'VALID' | 'UNAVAILABLE' | 'FAILED' = 'VALID';
        if (missingClosures.length) { status = 'FAILED'; reasonCode = 'CALENDAR_EVIDENCE_UNAVAILABLE'; }
        let day: VolatilityDay | undefined;
        let normalizationFactors: { from: string; through: string; factor: number; count: number }[][] = [[], []];
        let continuation: z.infer<typeof continuationSchema> | null = null;
        let inputFrom = inputs.flatMap(input => input.bars.map(bar => bar.date)).sort()[0] ?? date;
        let operationalFrom = date;
        try {
          if (predecessor) {
            if (predecessor.dimension !== identity.dimension || predecessor.algorithmVersion !== identity.algorithmVersion || predecessor.status !== 'VALID') throw new Error('Invalid predecessor identity.');
            continuation = continuationSchema.parse(predecessor.evidenceJson);
            if (predecessor.evidenceSchemaVersion !== VOLATILITY_PUBLICATION_EVIDENCE_VERSION || continuation.transition.effectiveState !== predecessor.effectiveState) throw new Error('Inconsistent predecessor evidence.');
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
        // Every expected historical session is required, including absent-both gaps.
        for (const expected of datesBetween(inputFrom, date)) if (marketSession(expected, exceptions)) dates.add(expected);
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
            day = calculateVolatility(ordered, ordered.map(d => normalized[0]!.get(d) ?? null), ordered.map(d => normalized[1]!.get(d) ?? null)).at(-1);
            if (!day || day.date !== date || day.status !== 'VALID') { status = 'UNAVAILABLE'; reasonCode = 'INSUFFICIENT_HISTORY'; }
            else if (continuation) {
              day.hysteresis = advanceVolatility({ effectiveState: continuation.transition.effectiveState, confirmation: continuation.transition.confirmationAfter }, day.rawState);
              day.effectiveState = day.hysteresis.effectiveState;
            }
          } catch { status = 'FAILED'; reasonCode = 'CALCULATION_FAILED'; }
        }
        const provenance = {
          provider: 'MASSIVE', timeframe: 'DAY_1', adjustmentSemantics: 'Stored UNADJUSTED; split-normalized only in calculation; no dividend adjustment.',
          inputFrom, operationalFrom, normalizedThrough: date,
          canonicalInputHash: hash({ source, splits, dates: ordered, calendar: exceptions.filter(e => e.sessionDate >= inputFrom && e.sessionDate <= next.date) }),
          instruments: source.map((input, i) => ({ symbol: input.symbol, securityId: input.securityId, count: input.bars.length, from: input.bars[0]?.date ?? null, through: input.bars.at(-1)?.date ?? null, marketBarIds: input.bars.map(bar => bar.id), firstMarketBarId: input.bars[0]?.id ?? null, lastMarketBarId: input.bars.at(-1)?.id ?? null, splits: splits[i], normalizationFactors: normalizationFactors[i], normalization: 'For each bar multiply prices by the product of splitFrom/splitTo for events after its session and through normalizedThrough; divide volume by that product.' })),
        };
        const fingerprint = hash({ algorithmVersion: VOLATILITY_ALGORITHM_VERSION, evidenceSchemaVersion: VOLATILITY_PUBLICATION_EVIDENCE_VERSION, status, reasonCode, provenance, missingSymbols, missingClosures, predecessorId: predecessor?.id ?? null, targetAt, validUntil });
        if (reasonCode && priorAttempt?.status !== 'VALID' && (priorAttempt?.evidenceJson as { attemptFingerprint?: string } | undefined)?.attemptFingerprint === fingerprint) {
          return { ...result, suppressed: true, blocked: { sessionDate: date, status: status as 'FAILED' | 'UNAVAILABLE', reasonCode } };
        }
        const completedAt = clock();
        const evidence = {
          algorithmVersion: VOLATILITY_ALGORITHM_VERSION, evidenceSchemaVersion: VOLATILITY_PUBLICATION_EVIDENCE_VERSION,
          definition: VOLATILITY_V1_DEFINITION, sessionDate: date, targetAt, dataThroughAt: status === 'VALID' ? targetAt : null, completedAt,
          calendar: { expectedSessionClose: session?.closeAt ?? null, graceMinutes: COMPLETION_GRACE_MINUTES.DAY_1, graceCutoff: new Date(targetAt.getTime() + COMPLETION_GRACE_MINUTES.DAY_1 * 60_000), exception: exceptions.find(e => e.sessionDate === date) ?? null, exceptions: exceptions.filter(e => e.sessionDate >= inputFrom && e.sessionDate <= next.date) },
          validUntil: status === 'VALID' ? validUntil : null,
          nextExpectedSession: { sessionDate: next.date, closeAt: next.closeAt, graceMinutes: COMPLETION_GRACE_MINUTES.DAY_1, validUntil, calendarException: exceptions.find(e => e.sessionDate === next.date) ?? null },
          provenance, attemptFingerprint: fingerprint, reasonCode, missingSymbols, missingClosures,
          bootstrap: !predecessor && status === 'VALID',
          ...(status !== 'VALID' ? { transition: { predecessorAssessmentId: predecessor?.id ?? null, ...advanceVolatility({ effectiveState: continuation?.transition.effectiveState ?? null, confirmation: continuation?.transition.confirmationAfter ?? 0 }, null) } } : {}),
          ...(!predecessor && status === 'VALID' ? { historicalReplay: { start: ordered[0] ?? null, sessionCount: ordered.length, dataThroughAt: targetAt, explanation: 'Initialized through historical replay. Only the resulting current assessment is published authoritatively; replayed sessions are not publications. Historical replay requires every expected session using persisted calendar exceptions.' } } : {}),
          ...(status === 'VALID' && day ? { spy: instrumentEvidence(day.spy), rsp: instrumentEvidence(day.rsp), market: { spyState: day.spy.rawState, rspState: day.rsp.rawState, rawState: day.rawState, explanation: 'Market raw severity is max(SPY instrument severity, RSP instrument severity).' }, transition: { predecessorAssessmentId: predecessor?.id ?? null, ...day.hysteresis } } : {}),
        };
        insertionTarget = targetAt;
        const assessment: Assessment = await tx.marketRegimeDimensionAssessment.create({ data: {
          ...identity, evidenceSchemaVersion: VOLATILITY_PUBLICATION_EVIDENCE_VERSION, sessionDate: new Date(date), targetAt,
          attempt: (priorAttempt?.attempt ?? 0) + 1, status, reasonCode,
          rawState: status === 'VALID' ? day!.rawState : null, effectiveState: status === 'VALID' ? day!.effectiveState : null,
          dataThroughAt: status === 'VALID' ? targetAt : null, validUntil: status === 'VALID' ? validUntil : null,
          previousAssessmentId: predecessor?.id ?? null, startedAt, completedAt, evidenceJson: json(evidence),
        } });
        result.attempts++;
        const event = reasonCode ? 'volatility_assessment_blocked' : !predecessor ? 'volatility_assessment_bootstrap' : priorAttempt ? 'volatility_assessment_recovered' : day!.hysteresis.transitioned ? 'volatility_assessment_transition' : null;
        if (event) await tx.systemEvent.create({ data: { type: event, entityType: 'market_regime_assessment', entityId: String(assessment.id), severity: reasonCode ? 'WARNING' : 'INFO', message: reasonCode ? `VOLATILITY_V1 stopped at ${date}: ${reasonCode}.` : `VOLATILITY_V1 ${date}: ${day!.effectiveState}.`, payloadJson: { assessmentId: assessment.id, sessionDate: date, reasonCode, previousAssessmentId: predecessor?.id ?? null } } });
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

export async function latestVolatilityAssessment() {
  const [latestAttempt, latestValid] = await Promise.all([
    prisma.marketRegimeDimensionAssessment.findFirst({ where: identity, orderBy: [{ targetAt: 'desc' }, { attempt: 'desc' }] }),
    prisma.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, status: 'VALID' }, orderBy: { targetAt: 'desc' } }),
  ]);
  return { latestAttempt, latestValid };
}
export async function listVolatilityAssessments(limit: number, beforeId?: number) {
  return prisma.marketRegimeDimensionAssessment.findMany({ where: { ...identity, ...(beforeId ? { id: { lt: beforeId } } : {}) }, orderBy: { id: 'desc' }, take: limit });
}
export async function getVolatilityAssessment(id: number) {
  const row = await prisma.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, id } });
  if (!row) throw new HttpError(404, 'VOLATILITY_V1 assessment not found.');
  return row;
}
