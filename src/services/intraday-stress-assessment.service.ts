import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type MarketRegimeDimensionAssessment } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type { SplitEvent } from '../integrations/massive/evidence.client.js';
import { readPersistedSplits } from './persisted-split-evidence.service.js';
import { addDays, barEligibility, COMPLETION_GRACE_MINUTES, datesBetween, etDate, etInstant, marketSession, type CalendarException } from './market-calendar.js';
import { normalizeSplits, type ResearchBar } from './trend-calculation.js';
import { instrumentMeasurements } from './volatility-calculation.js';
import {
  advanceIntradayStress, marketRawState, measureIntradaySession, INTRADAY_STRESS_STATES,
  type IntradayStressBar, type IntradayStressHistory, type IntradayStressState, type IntradayStressTarget, type IntradayStressTransition,
} from './intraday-stress-calculation.js';
import { INTRADAY_STRESS_ALGORITHM_VERSION, INTRADAY_STRESS_PUBLICATION_EVIDENCE_VERSION, INTRADAY_STRESS_V1_DEFINITION } from './intraday-stress-v1.definition.js';
import { VERIFIED_NYSE_CLOSURES } from './market-calendar-bootstrap.definition.js';

const identity = { dimension: 'INTRADAY_STRESS' as const, algorithmVersion: INTRADAY_STRESS_ALGORITHM_VERSION };
export const INTRADAY_STRESS_PUBLICATION_LOCK_KEY = createHash('sha256').update('ai-trader:intraday-stress-v1-publication').digest().readBigInt64BE(0);
const SYMBOLS = ['SPY', 'RSP'] as const;
type IntradaySymbol = typeof SYMBOLS[number];
const INTERVAL_MS = INTRADAY_STRESS_V1_DEFINITION.intervalMs;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const stateSchema = z.enum(INTRADAY_STRESS_STATES);
const continuationSchema = z.object({
  algorithmVersion: z.literal(INTRADAY_STRESS_ALGORITHM_VERSION), evidenceSchemaVersion: z.literal(INTRADAY_STRESS_PUBLICATION_EVIDENCE_VERSION),
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), index: z.number().int().min(1),
  transition: z.object({ effectiveState: stateSchema.nullable(), confirmationAfter: z.number().int().min(0).max(1) }),
  baseline: z.object({ spy: z.number().positive().nullable(), rsp: z.number().positive().nullable() }),
});
type Assessment = MarketRegimeDimensionAssessment;
type Reason = 'CALENDAR_EVIDENCE_UNAVAILABLE' | 'PRIOR_ATR_UNAVAILABLE' | 'SPLIT_EVIDENCE_UNAVAILABLE' | 'MISSING_INTRADAY_EVIDENCE' | 'ROLLING_CONTINUITY_FAILURE' | 'CALCULATION_FAILED';
export type IntradayStressPublicationResult = { published: number; suppressed: boolean; notDue: boolean; blocked: { sessionDate: string; index: number; status: 'UNAVAILABLE' | 'FAILED'; reasonCode: Reason } | null };
type SplitReader = (symbol: IntradaySymbol, from: string, through: string) => Promise<SplitEvent[]>;
type Options = { db?: PrismaClient; now?: Date; clock?: () => Date; fetchSplits?: SplitReader };
type Tx = Prisma.TransactionClient;

function actionableTargets(date: string, exceptions: CalendarException[]) {
  const session = marketSession(date, exceptions);
  if (!session) return null;
  const total = (session.closeAt.getTime() - session.openAt.getTime()) / INTERVAL_MS;
  if (!Number.isInteger(total)) throw new Error('Session must align to 15-minute intervals.');
  return { session, count: total - 1 };
}
/** Most recent actionable 15-minute target (walking recent sessions backward) that is currently
 * publishable: its evidence grace has elapsed AND it has not yet expired (`now < validUntil`).
 * Historical replay establishes calculation state; it never creates retroactive authoritative
 * history, so an expired target — one whose own currentness window has already closed, e.g. a
 * prior session's final target once session close has passed — is never returned here, even if
 * it was itself never published.
 */
function latestActionableTarget(now: Date, exceptions: CalendarException[]) {
  const today = etDate(now);
  for (let back = 0; back <= 10; back++) {
    const date = addDays(today, -back);
    const targets = actionableTargets(date, exceptions);
    if (!targets) continue;
    for (let index = targets.count; index >= 1; index--) {
      const targetAt = new Date(targets.session.openAt.getTime() + index * INTERVAL_MS);
      const barStart = new Date(targetAt.getTime() - INTERVAL_MS);
      if (barEligibility('MINUTE_15', barStart, now, exceptions).status !== 'ELIGIBLE') continue;
      if (now.getTime() >= validUntilFor(date, index, exceptions).getTime()) continue;
      return { date, index, targetAt };
    }
  }
  return null;
}
function previousSessionDate(date: string, exceptions: CalendarException[]): string | null {
  for (let back = 1; back <= 15; back++) {
    const candidate = addDays(date, -back);
    if (marketSession(candidate, exceptions)) return candidate;
  }
  return null;
}
function nextActionableTargetAt(date: string, index: number, exceptions: CalendarException[]): Date {
  const targets = actionableTargets(date, exceptions)!;
  if (index < targets.count) return new Date(targets.session.openAt.getTime() + (index + 1) * INTERVAL_MS);
  for (let forward = 1; forward <= 15; forward++) {
    const next = addDays(date, forward);
    const nextTargets = actionableTargets(next, exceptions);
    if (nextTargets) return new Date(nextTargets.session.openAt.getTime() + INTERVAL_MS);
  }
  throw new Error('No next session within calendar horizon.');
}
/** The final actionable target of a session is only current through session close: it must
 * never remain "current" overnight into the next session's pre-open hours.
 */
function validUntilFor(date: string, index: number, exceptions: CalendarException[]): Date {
  const targets = actionableTargets(date, exceptions)!;
  if (index < targets.count) return new Date(nextActionableTargetAt(date, index, exceptions).getTime() + COMPLETION_GRACE_MINUTES.MINUTE_15 * 60_000);
  return targets.session.closeAt;
}

async function fetchIntradayBars(tx: Tx, symbol: IntradaySymbol, date: string, now: Date, exceptions: CalendarException[]): Promise<IntradayStressBar[]> {
  const security = await tx.security.findUnique({ where: { symbol }, select: { id: true } });
  if (!security) return [];
  const session = marketSession(date, exceptions)!;
  const rows = await tx.marketBar.findMany({ where: { securityId: security.id, timeframe: 'MINUTE_15', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED', barStartAt: { gte: session.openAt, lt: session.closeAt } }, orderBy: [{ barStartAt: 'asc' }, { id: 'asc' }] });
  return rows.filter(row => barEligibility('MINUTE_15', row.barStartAt, now, exceptions).status === 'ELIGIBLE')
    .map(row => ({ barStartAtMs: row.barStartAt.getTime(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }));
}

type BaselineResult = { perSymbol: Record<IntradaySymbol, number | null>; reasonCode: Reason | null; provenance: Record<string, unknown> | null };
/** Prior completed regular-session ATR14 percentage per symbol (VOLATILITY_V1 Wilder semantics),
 * frozen for the whole current session once computed. Reused directly from the last VALID
 * same-session assessment rather than recomputed on every target within that session.
 */
async function computeBaseline(tx: Tx, priorDate: string | null, latestDate: string, exceptions: CalendarException[], fetchSplits: SplitReader): Promise<BaselineResult> {
  if (!priorDate) return { perSymbol: { SPY: null, RSP: null }, reasonCode: 'PRIOR_ATR_UNAVAILABLE', provenance: null };
  const dailyFrom = addDays(priorDate, -400);
  const securities = await tx.security.findMany({ where: { symbol: { in: [...SYMBOLS] } }, select: { id: true, symbol: true } });
  const rows = await tx.marketBar.findMany({ where: { securityId: { in: securities.map(s => s.id) }, timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED', barStartAt: { gte: etInstant(dailyFrom, 0), lte: etInstant(priorDate, 0) } }, orderBy: [{ barStartAt: 'asc' }, { id: 'asc' }] });
  let splits: SplitEvent[][];
  try {
    splits = await Promise.all(SYMBOLS.map(symbol => fetchSplits(symbol, dailyFrom, latestDate)));
    splits.forEach((events, i) => {
      if (events.some(event => event.symbol !== SYMBOLS[i] || event.executionDate < dailyFrom || event.executionDate > latestDate)) throw new Error('Invalid split identity.');
      normalizeSplits([], events, latestDate);
    });
  } catch { return { perSymbol: { SPY: null, RSP: null }, reasonCode: 'SPLIT_EVIDENCE_UNAVAILABLE', provenance: null }; }
  const dates = datesBetween(dailyFrom, priorDate).filter(date => marketSession(date, exceptions));
  const perSymbol: Record<IntradaySymbol, number | null> = { SPY: null, RSP: null };
  const instruments: Record<string, unknown> = {};
  SYMBOLS.forEach((symbol, i) => {
    const security = securities.find(s => s.symbol === symbol);
    const bars: ResearchBar[] = rows.filter(row => row.securityId === security?.id).map(row => ({ id: row.id, date: etDate(row.barStartAt), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }));
    const normalized = new Map(normalizeSplits(bars, splits[i]!, latestDate).map(bar => [bar.date, bar]));
    const measurements = instrumentMeasurements(dates.map(date => normalized.get(date) ?? null));
    const last = measurements.at(-1);
    perSymbol[symbol] = last?.ATR14Pct ? last.ATR14Pct.value / 100 : null;
    instruments[symbol] = { securityId: security?.id ?? null, atr14: last?.atr14 ?? null, atr14Pct: last?.ATR14Pct?.value ?? null, consecutiveSessions: last?.consecutiveSessions ?? 0, dailyBarCount: bars.length, splits: splits[i] };
  });
  const reasonCode: Reason | null = SYMBOLS.some(symbol => perSymbol[symbol] === null) ? 'PRIOR_ATR_UNAVAILABLE' : null;
  return { perSymbol, reasonCode, provenance: { dailyFrom, through: priorDate, dates, instruments } };
}

/** Publishes at most one authoritative assessment per invocation: the current due 15-minute
 * target. Any intervening targets skipped by downtime are replayed in-memory (never persisted)
 * purely to reconstruct the correct hysteresis chain; INTRADAY_STRESS never writes retroactive
 * authoritative rows for stale targets. All reads, state selection, and writes share the
 * transaction that owns the lock. No account scope; no trading side effects.
 */
export async function publishIntradayStressAssessments(options: Options = {}): Promise<IntradayStressPublicationResult> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock();
  let insertionTarget: Date | null = null;
  try {
    return await db.$transaction(async tx => {
      const locks = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${INTRADAY_STRESS_PUBLICATION_LOCK_KEY}::bigint) AS acquired`;
      if (!locks[0]?.acquired) throw new HttpError(409, 'INTRADAY_STRESS_V1 publication is already running.');
      const result: IntradayStressPublicationResult = { published: 0, suppressed: false, notDue: false, blocked: null };
      const predecessor = await tx.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, status: 'VALID' }, orderBy: { targetAt: 'desc' } });
      const calendarRows = await tx.marketCalendarException.findMany({ orderBy: { sessionDate: 'asc' } });
      const exceptions: CalendarException[] = calendarRows.map(row => ({ ...row, sessionDate: row.sessionDate.toISOString().slice(0, 10) }));
      const latest = latestActionableTarget(now, exceptions);
      if (!latest || (predecessor && predecessor.targetAt.getTime() >= latest.targetAt.getTime())) return { ...result, notDue: true };
      // Any existing row at this exact targetAt is guaranteed non-VALID (a VALID one would have
      // satisfied the notDue check above) and represents a prior failed attempt at the same target.
      const priorAttempt = await tx.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, targetAt: latest.targetAt }, orderBy: { attempt: 'desc' } });

      // Calendar-authority horizon: outside the range VERIFIED_NYSE_CLOSURES actually covers, no
      // session can be treated as authoritatively known — an ordinary-weekday assumption past the
      // verified horizon is exactly the silent-drift risk this guards against. Fail closed rather
      // than extend verified knowledge implicitly; the static list is extended only through the
      // explicit bootstrap/review process, never inferred or fetched at runtime.
      const withinCalendarAuthority = latest.date >= VERIFIED_NYSE_CLOSURES.from && latest.date <= VERIFIED_NYSE_CLOSURES.to;
      const windowFrom = addDays(latest.date, -40);
      const missingClosures = VERIFIED_NYSE_CLOSURES.closedDates.filter(date => date >= windowFrom && date <= latest.date
        && !exceptions.some(row => row.sessionDate === date && row.type === 'CLOSED' && row.closeTimeMinutesEt === null));
      // A missing or conflicting verified early close is just as much a calendar-evidence failure
      // as a missing full-day closure: an unconfigured/misconfigured EARLY_CLOSE date would make
      // marketSession/barEligibility treat it as a full 16:00 session, corrupting this session-
      // boundary-sensitive dimension's actionable-target count and validity window.
      const missingEarlyCloses = VERIFIED_NYSE_CLOSURES.earlyCloseDates.filter(date => date >= windowFrom && date <= latest.date
        && !exceptions.some(row => row.sessionDate === date && row.type === 'EARLY_CLOSE' && row.closeTimeMinutesEt === VERIFIED_NYSE_CLOSURES.earlyCloseTimeMinutesEt));
      let reasonCode: Reason | null = !withinCalendarAuthority || missingClosures.length || missingEarlyCloses.length ? 'CALENDAR_EVIDENCE_UNAVAILABLE' : null;
      let status: 'VALID' | 'UNAVAILABLE' | 'FAILED' = reasonCode ? 'FAILED' : 'VALID';

      const predecessorSessionDate = predecessor?.sessionDate ? predecessor.sessionDate.toISOString().slice(0, 10) : null;
      const sameSession = predecessorSessionDate === latest.date;
      let continuation: z.infer<typeof continuationSchema> | null = null;
      if (!reasonCode && predecessor) {
        try {
          if (predecessor.dimension !== identity.dimension || predecessor.algorithmVersion !== identity.algorithmVersion || predecessor.status !== 'VALID') throw new Error('Invalid predecessor identity.');
          continuation = continuationSchema.parse(predecessor.evidenceJson);
          if (predecessor.evidenceSchemaVersion !== INTRADAY_STRESS_PUBLICATION_EVIDENCE_VERSION || continuation.transition.effectiveState !== predecessor.effectiveState) throw new Error('Inconsistent predecessor evidence.');
        } catch { status = 'FAILED'; reasonCode = 'CALCULATION_FAILED'; }
      }

      let baseline: Record<IntradaySymbol, number | null> = { SPY: null, RSP: null };
      let baselineProvenance: Record<string, unknown> | null = null;
      if (!reasonCode && sameSession && continuation) {
        baseline = { SPY: continuation.baseline.spy, RSP: continuation.baseline.rsp };
        baselineProvenance = { reused: true, fromAssessmentId: predecessor!.id };
      } else if (!reasonCode) {
        try {
          const priorDate = previousSessionDate(latest.date, exceptions);
          const computed = await computeBaseline(tx, priorDate, latest.date, exceptions, options.fetchSplits ?? ((symbol, from, through) => readPersistedSplits(tx, symbol, from, through)));
          baseline = computed.perSymbol;
          baselineProvenance = { reused: false, splitEvidenceSource: options.fetchSplits ? 'INJECTED' : 'MARKET_SPLIT_EVENT', ...(computed.provenance ?? {}) };
          if (computed.reasonCode) { status = computed.reasonCode === 'SPLIT_EVIDENCE_UNAVAILABLE' ? 'FAILED' : 'UNAVAILABLE'; reasonCode = computed.reasonCode; }
        } catch { status = 'FAILED'; reasonCode = 'CALCULATION_FAILED'; }
      }

      const replayFromIndex = sameSession && continuation ? continuation.index + 1 : 1;
      let history: IntradayStressHistory = sameSession && continuation ? { effectiveState: continuation.transition.effectiveState, confirmation: continuation.transition.confirmationAfter } : { effectiveState: null, confirmation: 0 };
      let finalSpy: IntradayStressTarget | null = null; let finalRsp: IntradayStressTarget | null = null;
      let finalRaw: IntradayStressState | null = null; let finalTransition: IntradayStressTransition | null = null;
      let replayedCount = 0;
      const replayTrail: { index: number; targetAt: string; rawState: IntradayStressState | null; effectiveState: IntradayStressState | null; confirmationAfter: number; transitioned: boolean; reason: string }[] = [];
      if (!reasonCode) {
        try {
          const [spyBars, rspBars] = await Promise.all([fetchIntradayBars(tx, 'SPY', latest.date, now, exceptions), fetchIntradayBars(tx, 'RSP', latest.date, now, exceptions)]);
          const spyTargets = measureIntradaySession(latest.date, spyBars, baseline.SPY, exceptions);
          const rspTargets = measureIntradaySession(latest.date, rspBars, baseline.RSP, exceptions);
          for (let index = replayFromIndex; index <= latest.index; index++) {
            const spyTarget = spyTargets[index - 1]!; const rspTarget = rspTargets[index - 1]!;
            const raw = spyTarget.status === 'VALID' && rspTarget.status === 'VALID' && spyTarget.instrumentRawState && rspTarget.instrumentRawState
              ? marketRawState(spyTarget.instrumentRawState, rspTarget.instrumentRawState) : null;
            const transition = advanceIntradayStress(history, raw);
            history = { effectiveState: transition.effectiveState, confirmation: transition.confirmationAfter };
            // Compact per-replayed-target trail (bounded: at most one session's worth of targets,
            // <=25) so a reconstructed effective state after downtime is auditable without
            // duplicating full OHLC evidence for every skipped target — MarketBar remains the raw source.
            replayTrail.push({ index, targetAt: spyTarget.targetAt, rawState: raw, effectiveState: transition.effectiveState,
              confirmationAfter: transition.confirmationAfter, transitioned: transition.transitioned, reason: transition.reason });
            finalSpy = spyTarget; finalRsp = rspTarget; finalRaw = raw; finalTransition = transition;
            replayedCount++;
          }
          if (finalRaw === null) {
            status = 'UNAVAILABLE';
            const issues = new Set([...(finalSpy?.issues ?? []), ...(finalRsp?.issues ?? [])]);
            reasonCode = issues.has('PRIOR_ATR_UNAVAILABLE') ? 'PRIOR_ATR_UNAVAILABLE'
              : (issues.has('MISSING_INVALID_OR_DUPLICATE_BAR') || issues.has('MISSING_REFERENCE') || issues.has('INCOMPLETE_SESSION_PREFIX')) ? 'MISSING_INTRADAY_EVIDENCE'
              : issues.has('ROLLING_CONTINUITY_FAILURE') ? 'ROLLING_CONTINUITY_FAILURE' : 'MISSING_INTRADAY_EVIDENCE';
          }
        } catch { status = 'FAILED'; reasonCode = 'CALCULATION_FAILED'; }
      }

      const targetAt = latest.targetAt;
      const validUntil = validUntilFor(latest.date, latest.index, exceptions);
      const completedAt = clock();
      // Final currentness boundary revalidation: `latest` was selected while still publishable,
      // but the baseline/evidence/replay work above takes real time, and this target's own
      // validity window may have closed before reaching this point (e.g. publication starts at
      // 15:59:55 for a target whose validUntil is 16:00:00, and completes at 16:00:03). This is
      // a second, independent check from the initial latestActionableTarget selection check
      // above — it does not weaken it. Once the window has closed, the completed computation is
      // no longer authoritative publication material regardless of what status it reached:
      // discard it entirely (no VALID row, and no FAILED/UNAVAILABLE row merely because time
      // ran out) and report a clean no-publication result.
      if (completedAt.getTime() >= validUntil.getTime()) return { ...result, notDue: true };
      const rawState = status === 'VALID' ? finalRaw : null;
      const effectiveState = status === 'VALID' ? finalTransition!.effectiveState : null;
      const fingerprint = hash({ algorithmVersion: INTRADAY_STRESS_ALGORITHM_VERSION, evidenceSchemaVersion: INTRADAY_STRESS_PUBLICATION_EVIDENCE_VERSION, status, reasonCode, targetAt, sessionDate: latest.date, index: latest.index });

      const evidence = {
        algorithmVersion: INTRADAY_STRESS_ALGORITHM_VERSION, evidenceSchemaVersion: INTRADAY_STRESS_PUBLICATION_EVIDENCE_VERSION,
        definition: INTRADAY_STRESS_V1_DEFINITION, sessionDate: latest.date, index: latest.index, targetAt, completedAt,
        dataThroughAt: status === 'VALID' ? targetAt : null,
        calendar: { graceMinutes: COMPLETION_GRACE_MINUTES.MINUTE_15, exception: exceptions.find(row => row.sessionDate === latest.date) ?? null },
        validUntil: status === 'VALID' ? validUntil : null,
        nextExpectedTargetAt: nextActionableTargetAt(latest.date, latest.index, exceptions),
        calendarAuthority: { from: VERIFIED_NYSE_CLOSURES.from, to: VERIFIED_NYSE_CLOSURES.to, withinAuthority: withinCalendarAuthority },
        missingClosures, missingEarlyCloses, reasonCode, attemptFingerprint: fingerprint,
        session: { sameSession, previousSessionDate: predecessorSessionDate, bootstrap: !predecessor },
        baseline: { spy: baseline.SPY, rsp: baseline.RSP, frozenForSession: true, provenance: baselineProvenance },
        replay: { fromIndex: replayFromIndex, throughIndex: latest.index, replayedCount, trail: replayTrail, note: 'Only the current due target is persisted as an authoritative row; any earlier skipped targets are replayed in-memory only (trail), to reconstruct hysteresis without fabricating retroactive history or duplicating full OHLC evidence.' },
        spy: finalSpy, rsp: finalRsp,
        market: { rawState: finalRaw, explanation: 'Market raw state is worse(SPY instrument raw state, RSP instrument raw state); either instrument SEVERE is sufficient for market SEVERE. No averaging or voting.' },
        transition: { predecessorAssessmentId: predecessor?.id ?? null, previousEffectiveState: sameSession ? (continuation?.transition.effectiveState ?? null) : null,
          effectiveState, confirmationAfter: status === 'VALID' ? finalTransition!.confirmationAfter : (sameSession ? history.confirmation : 0),
          transitioned: finalTransition?.transitioned ?? false, reason: finalTransition?.reason ?? 'Evidence unavailable for this target.' },
      };
      if (reasonCode && priorAttempt && priorAttempt.status !== 'VALID' && (priorAttempt.evidenceJson as { attemptFingerprint?: string } | undefined)?.attemptFingerprint === fingerprint) {
        return { ...result, suppressed: true, blocked: { sessionDate: latest.date, index: latest.index, status: status as 'FAILED' | 'UNAVAILABLE', reasonCode } };
      }
      insertionTarget = targetAt;
      const assessment: Assessment = await tx.marketRegimeDimensionAssessment.create({ data: {
        ...identity, evidenceSchemaVersion: INTRADAY_STRESS_PUBLICATION_EVIDENCE_VERSION, sessionDate: new Date(latest.date), targetAt,
        attempt: (priorAttempt?.attempt ?? 0) + 1, status, reasonCode, rawState, effectiveState,
        dataThroughAt: status === 'VALID' ? targetAt : null, validUntil: status === 'VALID' ? validUntil : null,
        previousAssessmentId: predecessor?.id ?? null, startedAt, completedAt, evidenceJson: json(evidence),
      } });
      const event = reasonCode ? 'intraday_stress_assessment_blocked'
        : !predecessor ? 'intraday_stress_assessment_bootstrap'
        : !sameSession ? 'intraday_stress_assessment_session_start'
        : (replayedCount > 1 || priorAttempt) ? 'intraday_stress_assessment_recovered'
        : finalTransition!.transitioned ? 'intraday_stress_assessment_transition' : null;
      if (event) await tx.systemEvent.create({ data: { type: event, entityType: 'market_regime_assessment', entityId: String(assessment.id), severity: reasonCode ? 'WARNING' : 'INFO',
        message: reasonCode ? `INTRADAY_STRESS_V1 stopped at ${latest.date} #${latest.index}: ${reasonCode}.` : `INTRADAY_STRESS_V1 ${latest.date} #${latest.index}: ${effectiveState}.`,
        payloadJson: { assessmentId: assessment.id, sessionDate: latest.date, index: latest.index, reasonCode, previousAssessmentId: predecessor?.id ?? null } } });
      if (reasonCode) return { ...result, blocked: { sessionDate: latest.date, index: latest.index, status: status as 'FAILED' | 'UNAVAILABLE', reasonCode } };
      result.published = 1;
      return result;
    }, { timeout: 60_000, maxWait: 5_000 });
  } catch (error) {
    if (insertionTarget && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await db.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, targetAt: insertionTarget, status: 'VALID' } });
      if (winner) return { published: 0, suppressed: true, notDue: false, blocked: null };
    }
    throw error;
  }
}

export async function latestIntradayStressAssessment() {
  const [latestAttempt, latestValid] = await Promise.all([
    prisma.marketRegimeDimensionAssessment.findFirst({ where: identity, orderBy: [{ targetAt: 'desc' }, { attempt: 'desc' }] }),
    prisma.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, status: 'VALID' }, orderBy: { targetAt: 'desc' } }),
  ]);
  return { latestAttempt, latestValid };
}
export async function listIntradayStressAssessments(limit: number, beforeId?: number) {
  return prisma.marketRegimeDimensionAssessment.findMany({ where: { ...identity, ...(beforeId ? { id: { lt: beforeId } } : {}) }, orderBy: { id: 'desc' }, take: limit });
}
export async function getIntradayStressAssessment(id: number) {
  const row = await prisma.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, id } });
  if (!row) throw new HttpError(404, 'INTRADAY_STRESS_V1 assessment not found.');
  return row;
}
