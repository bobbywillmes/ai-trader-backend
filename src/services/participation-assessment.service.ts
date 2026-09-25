import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type MarketRegimeDimensionAssessment } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type { SplitEvent } from '../integrations/massive/evidence.client.js';
import { readPersistedSplits } from './persisted-split-evidence.service.js';
import { addDays, etDate, etInstant, isFullMarketSession, marketSession, type CalendarException } from './market-calendar.js';
import { calculateParticipationV1, normalizeParticipationVolumes, participationMedian, validateParticipationSplits } from './participation-v1-calculation.js';
import { PARTICIPATION_ALGORITHM_VERSION, PARTICIPATION_PUBLICATION_EVIDENCE_VERSION, PARTICIPATION_SYMBOLS, PARTICIPATION_BASELINE_SESSIONS, PARTICIPATION_THRESHOLDS, type ParticipationSymbol } from './participation-v1.definition.js';
import { latestParticipationSession, participationDueAt, planParticipationWindow, selectParticipationSession } from './participation-publication-calendar.js';

const identity = { dimension: 'PARTICIPATION' as const, algorithmVersion: PARTICIPATION_ALGORITHM_VERSION };
export const PARTICIPATION_PUBLICATION_LOCK_KEY = createHash('sha256').update('ai-trader:participation-v1-publication').digest().readBigInt64BE(0);
const definition = { symbols: PARTICIPATION_SYMBOLS, baselineSessions: PARTICIPATION_BASELINE_SESSIONS, thresholds: PARTICIPATION_THRESHOLDS,
  panel: 'median-of-five', baseline: 'median-of-exact-prior-full-sessions', normalization: 'rawVolume/product(splitFrom/splitTo); barDate < executionDate <= targetDate', hysteresis: false };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
  if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Nonfinite Participation evidence.');
  return item;
})) as Prisma.InputJsonValue;
type Reason = 'MISSING_MARKET_DATA' | 'INSUFFICIENT_HISTORY' | 'SPLIT_EVIDENCE_UNAVAILABLE' | 'CALCULATION_FAILED' | 'CALENDAR_EVIDENCE_UNAVAILABLE';
export type ParticipationPublicationResult = { published: number; attempts: number; suppressed: boolean; notDue: boolean;
  blocked: null | { sessionDate: string; status: 'UNAVAILABLE' | 'FAILED'; reasonCode: Reason } };
/** Injected dependencies must honor cancellation and settle before returning. */
export type ParticipationSplitFetcher = (symbol: ParticipationSymbol, from: string, through: string, signal: AbortSignal) => Promise<SplitEvent[]>;
/** `signal` is an external shutdown/cancellation signal: it aborts and rolls back the run and never records a FAILED assessment. */
type Options = { db?: PrismaClient; now?: Date; clock?: () => Date; fetchSplits?: ParticipationSplitFetcher; signal?: AbortSignal };
const emptyResult = (): ParticipationPublicationResult => ({ published: 0, attempts: 0, suppressed: false, notDue: false, blocked: null });
function splitFailureCode(error: unknown, aborted: boolean): string {
  if (aborted) return 'PUBLICATION_DEADLINE';
  // Classify only the strict client's controlled errors; never retain provider/error prose.
  if (error instanceof HttpError && error.message.startsWith('Massive evidence: ')) {
    if (/pagination/.test(error.message)) return 'INVALID_SPLIT_PAGINATION';
    if (/request failed/.test(error.message)) return 'SPLIT_REQUEST_FAILED';
    if (/duplicate|conflicting/.test(error.message)) return 'AMBIGUOUS_SPLIT_EVIDENCE';
    return 'INVALID_SPLIT_RESPONSE';
  }
  return 'STRICT_SPLIT_EVIDENCE_FAILED';
}
type Observation = { sessionDate: string; marketBarId: number; rawVolume: string; normalizedVolume: number | null; priceFactorProduct: number | null; receivedAt: Date };
type Missing = { symbol: ParticipationSymbol; role: 'SECURITY' | 'TARGET' | 'BASELINE'; sessionDate?: string };

/** Immutable, account-independent evidence publication. All database work uses the lock-owning transaction. */
export async function publishParticipationAssessments(options: Options = {}): Promise<ParticipationPublicationResult> {
  const db = options.db ?? prisma, now = new Date(+(options.now ?? new Date()));
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock();
  let insertionTarget: Date | null = null;
  options.signal?.throwIfAborted();
  try {
    return await db.$transaction(async tx => {
      const lock = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${PARTICIPATION_PUBLICATION_LOCK_KEY}::bigint) AS acquired`;
      if (!lock[0]?.acquired) throw new HttpError(409, 'PARTICIPATION_V1 publication is already running.');
      options.signal?.throwIfAborted();
      // One deadline for all symbols/pages; leaves half the transaction ceiling for DB work.
      // The optional external signal is combined but remains distinguishable: it is infrastructure, not evidence.
      const deadline = AbortSignal.timeout(120_000);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      const result = emptyResult();
      let predecessor = await tx.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, status: 'VALID' }, orderBy: { targetAt: 'desc' } });
      const pending = await tx.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, ...(predecessor ? { targetAt: { gt: predecessor.targetAt } } : {}) }, orderBy: [{ targetAt: 'asc' }, { attempt: 'desc' }] });
      const fresh = !predecessor && !pending;
      const calendarRows = await tx.marketCalendarException.findMany({ orderBy: { sessionDate: 'asc' } });
      const exceptions: CalendarException[] = calendarRows.map(e => ({ sessionDate: e.sessionDate.toISOString().slice(0, 10), type: e.type, closeTimeMinutesEt: e.closeTimeMinutesEt }));
      // Validate persisted identity even for an otherwise idle/not-due invocation.
      for (const previous of [predecessor, pending]) if (previous) {
        const d = previous.sessionDate?.toISOString().slice(0, 10);
        if (!d || !isFullMarketSession(d, exceptions) || +marketSession(d, exceptions)!.closeAt !== +previous.targetAt)
          throw new Error('PARTICIPATION_V1 persisted target conflicts with calendar; operator review required.');
      }
      const first = pending?.sessionDate?.toISOString().slice(0, 10) ?? (predecessor
        ? selectParticipationSession(addDays(predecessor.sessionDate!.toISOString().slice(0, 10), 1), 1, exceptions).date
        : latestParticipationSession(now, exceptions).date);
      const plans: { date: string; targetAt: Date; window: ReturnType<typeof planParticipationWindow> }[] = [];
      let date = first;
      for (let i = 0; i < (fresh ? 1 : 20); i++) {
        const targetAt = i === 0 && pending ? pending.targetAt : marketSession(date, exceptions)!.closeAt;
        if (participationDueAt(targetAt) > now) break;
        const window = planParticipationWindow(date, exceptions);
        plans.push({ date, targetAt, window });
        if (window.calendar.failures.length || !window.next) break;
        date = window.next.date;
      }
      if (!plans.length) return { ...result, notDue: true };
      let splitCache: SplitEvent[][] | null = null;
      let splitFailures: { symbol: ParticipationSymbol; code: string }[] = [];
      const splitFrom = plans[0]!.window.baselineDates[0] ?? first, splitThrough = plans.at(-1)!.date;
      for (const { date: targetDate, targetAt, window } of plans) {
        options.signal?.throwIfAborted();
        if (predecessor && (predecessor.dimension !== identity.dimension || predecessor.algorithmVersion !== identity.algorithmVersion || predecessor.status !== 'VALID' || predecessor.targetAt >= targetAt))
          throw new Error('Invalid PARTICIPATION_V1 predecessor lineage.');
        const priorAttempt = await tx.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, targetAt }, orderBy: { attempt: 'desc' } });
        if (priorAttempt?.status === 'VALID') throw new Error('Unexpected already-valid Participation target.');
        const expectedDates = [...window.baselineDates, targetDate];
        const missing: Missing[] = [], failures: { code: string; symbol?: ParticipationSymbol; sessionDate?: string }[] = [];
        let reasonCode: Reason | null = window.calendar.failures.length ? 'CALENDAR_EVIDENCE_UNAVAILABLE' : null;
        let status: 'VALID' | 'UNAVAILABLE' | 'FAILED' = reasonCode ? 'FAILED' : 'VALID';
        const block = (reason: Reason, unavailable = false) => { if (!reasonCode) { reasonCode = reason; status = unavailable ? 'UNAVAILABLE' : 'FAILED'; } };
        const instruments: { symbol: ParticipationSymbol; securityId: number | null; target: Observation | null; baseline: (Observation | null)[];
          medianVolume20: number | null; rvol20: number | null; splitEvidence: { requestedFrom: string; requestedThrough: string; complete: boolean; events: SplitEvent[] } }[] = [];
        if (!reasonCode) {
          const securities = await tx.security.findMany({ where: { symbol: { in: [...PARTICIPATION_SYMBOLS] } }, select: { id: true, symbol: true } });
          const rows = await tx.marketBar.findMany({ where: { securityId: { in: securities.map(s => s.id) }, timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED',
            OR: expectedDates.map(d => ({ barStartAt: { gte: etInstant(d, 0), lt: etInstant(addDays(d, 1), 0) } })) }, orderBy: [{ barStartAt: 'asc' }, { id: 'asc' }] });
          for (const symbol of PARTICIPATION_SYMBOLS) {
            const matches = securities.filter(s => s.symbol === symbol), security = matches[0];
            if (matches.length > 1) failures.push({ code: 'DUPLICATE_SECURITY', symbol });
            if (!security) missing.push({ symbol, role: 'SECURITY' });
            const mapped = new Map<string, Observation>();
            for (const row of rows.filter(r => r.securityId === security?.id)) {
              const d = etDate(row.barStartAt);
              try {
                const decimal = new Prisma.Decimal(row.volume.toString()), volume = decimal.toNumber();
                if (!expectedDates.includes(d) || +row.barStartAt !== +etInstant(d, 0) || mapped.has(d) || !decimal.isFinite() || decimal.lt(0) || decimal.decimalPlaces() > 6 || decimal.gte(new Prisma.Decimal(10).pow(24)) || !Number.isFinite(volume) || (decimal.gt(0) && volume === 0)) throw new Error('Invalid stored input');
                mapped.set(d, { sessionDate: d, marketBarId: row.id, rawVolume: decimal.toFixed(), normalizedVolume: null, priceFactorProduct: null, receivedAt: row.receivedAt });
              } catch { failures.push({ code: 'INVALID_STORED_OBSERVATION', symbol, sessionDate: d }); }
            }
            if (security) for (const d of expectedDates) if (!mapped.has(d)) missing.push({ symbol, sessionDate: d, role: d === targetDate ? 'TARGET' : 'BASELINE' });
            instruments.push({ symbol, securityId: security?.id ?? null, target: mapped.get(targetDate) ?? null, baseline: window.baselineDates.map(d => mapped.get(d) ?? null), medianVolume20: null, rvol20: null,
              splitEvidence: { requestedFrom: window.baselineDates[0] ?? targetDate, requestedThrough: targetDate, complete: false, events: [] } });
          }
          if (rows.some(r => !securities.some(s => s.id === r.securityId && PARTICIPATION_SYMBOLS.some(symbol => symbol === s.symbol)))) failures.push({ code: 'UNEXPECTED_SECURITY' });
          if (new Set(rows.map(r => r.id)).size !== rows.length) failures.push({ code: 'DUPLICATE_MARKET_BAR_ID' });
          if (failures.length) block('CALCULATION_FAILED');
          if (missing.length) block('MISSING_MARKET_DATA', true);
          if (window.baselineDates.length !== 20) block('INSUFFICIENT_HISTORY', true);
          // Positive split ratios preserve which volumes are zero; no provider work is needed for a zero median.
          if (!reasonCode && instruments.some(i => participationMedian(i.baseline.map(b => Number(b!.rawVolume))) === 0)) {
            failures.push({ code: 'ZERO_MEDIAN_BASELINE' }); block('INSUFFICIENT_HISTORY', true);
          }
        }
        if (!reasonCode && !splitCache) {
          const responses = await Promise.allSettled(PARTICIPATION_SYMBOLS.map(async symbol => {
            signal.throwIfAborted();
            const events = await (options.fetchSplits ?? ((s, from, through) => readPersistedSplits(tx, s, from, through)))(symbol, splitFrom, splitThrough, signal);
            signal.throwIfAborted();
            validateParticipationSplits(events);
            if (events.some(e => e.symbol !== symbol || e.executionDate < splitFrom || e.executionDate > splitThrough)) throw new Error('Invalid split identity/range');
            return events.map(e => ({ id: e.id, symbol: e.symbol, executionDate: e.executionDate, splitFrom: e.splitFrom, splitTo: e.splitTo, priceFactor: e.priceFactor }))
              .sort((a, b) => a.executionDate.localeCompare(b.executionDate) || a.id.localeCompare(b.id));
          }));
          // Shutdown cancellation propagates (rollback) instead of becoming SPLIT_EVIDENCE_UNAVAILABLE.
          options.signal?.throwIfAborted();
          splitFailures = responses.flatMap((r, i) => r.status === 'rejected' ? [{ symbol: PARTICIPATION_SYMBOLS[i]!, code: options.fetchSplits ? splitFailureCode(r.reason, signal.aborted) : signal.aborted ? 'PUBLICATION_DEADLINE' : 'PERSISTED_SPLIT_EVIDENCE_FAILED' }] : []);
          if (!splitFailures.length) splitCache = responses.map(r => (r as PromiseFulfilledResult<SplitEvent[]>).value);
        }
        if (!reasonCode && splitFailures.length) block('SPLIT_EVIDENCE_UNAVAILABLE');
        let calculation: ReturnType<typeof calculateParticipationV1> | null = null;
        if (!reasonCode) {
          // Capture every symbol's authoritative split inputs even if later arithmetic fails.
          instruments.forEach((instrument, i) => {
            instrument.splitEvidence = { ...instrument.splitEvidence, complete: true,
              events: splitCache![i]!.filter(e => e.executionDate >= instrument.splitEvidence.requestedFrom && e.executionDate <= targetDate) };
          });
          try {
            const observations: Parameters<typeof calculateParticipationV1>[0]['observations'] = {};
            instruments.forEach(instrument => {
              const bars = [...instrument.baseline, instrument.target] as Observation[];
              const normalized = normalizeParticipationVolumes(bars.map(b => ({ date: b.sessionDate, volume: Number(b.rawVolume) })), instrument.splitEvidence.events, targetDate);
              normalized.forEach((b, n) => {
                if (!Number.isFinite(b.volume) || b.volume < 0 || !Number.isFinite(b.normalizationFactor) || b.normalizationFactor <= 0) throw new Error('Invalid normalized volume');
                bars[n]!.normalizedVolume = b.volume; bars[n]!.priceFactorProduct = b.normalizationFactor;
              });
              observations[instrument.symbol] = normalized;
            });
            calculation = calculateParticipationV1({ targetDate, baselineDates: window.baselineDates, observations });
            if (!calculation.available) {
              failures.push(...calculation.diagnostics);
              if (calculation.diagnostics.some(d => d.code === 'MISSING_VOLUME')) block('MISSING_MARKET_DATA', true);
              else if (calculation.diagnostics.every(d => d.code === 'ZERO_MEDIAN_BASELINE')) block('INSUFFICIENT_HISTORY', true);
              else block('CALCULATION_FAILED');
            } else calculation.instruments.forEach((c, i) => { instruments[i]!.medianVolume20 = c.medianVolume20; instruments[i]!.rvol20 = c.rvol20; });
          } catch { failures.push({ code: 'ARITHMETIC_FAILED' }); block('CALCULATION_FAILED'); }
        }
        const panel = !reasonCode && calculation?.available ? { rvol20BySymbol: Object.fromEntries(calculation.instruments.map(i => [i.symbol, i.rvol20])),
          panelMedianRvol: calculation.panel.panelMedianRvol, rawState: calculation.panel.rawState, effectiveState: calculation.panel.effectiveState,
          diagnostics: { agreement: calculation.panel.agreement, minimumRvol: calculation.panel.minimumRvol, maximumRvol: calculation.panel.maximumRvol, range: calculation.panel.range, affectsClassification: false } } : null;
        const splitEvidenceSource = options.fetchSplits ? 'INJECTED' : 'MARKET_SPLIT_EVENT';
        const canonicalInputHash = hash({ ...identity, evidenceSchemaVersion: PARTICIPATION_PUBLICATION_EVIDENCE_VERSION, definition, targetDate, targetAt, splitEvidenceSource,
          baselineDates: window.baselineDates, calendar: window.calendar,
          instruments: instruments.map(i => ({ symbol: i.symbol, securityId: i.securityId, observations: [...i.baseline, i.target].map(b => b ? { sessionDate: b.sessionDate, marketBarId: b.marketBarId, rawVolume: b.rawVolume } : null), splitEvidence: i.splitEvidence })) });
        const attemptFingerprint = hash({ ...identity, evidenceSchemaVersion: PARTICIPATION_PUBLICATION_EVIDENCE_VERSION, targetDate, targetAt, proposedValidUntil: window.proposedValidUntil,
          previousAssessmentId: predecessor?.id ?? null, status, reasonCode, canonicalInputHash, missing, failures, splitFailures });
        if (reasonCode && (priorAttempt?.evidenceJson as { attemptFingerprint?: string } | undefined)?.attemptFingerprint === attemptFingerprint)
          return { ...result, suppressed: true, blocked: { sessionDate: targetDate, status: status as 'UNAVAILABLE' | 'FAILED', reasonCode } };
        options.signal?.throwIfAborted();
        const completedAt = clock();
        const evidence = { ...identity, evidenceSchemaVersion: PARTICIPATION_PUBLICATION_EVIDENCE_VERSION, definition, sessionDate: targetDate, targetAt, dueAt: participationDueAt(targetAt),
          dataThroughAt: panel ? targetAt : null, validUntil: panel ? window.proposedValidUntil : null, proposedValidUntil: window.proposedValidUntil,
          expectedBaselineDates: window.baselineDates, calendar: window.calendar, normalizationThrough: targetDate, provider: 'MASSIVE', splitEvidenceSource, timeframe: 'DAY_1', adjustmentMode: 'UNADJUSTED',
          dailyVolumeSemantics: 'Provider daily aggregate; not reconstructed strictly from regular-hours trades.', instruments, panel,
          lineage: { previousAssessmentId: predecessor?.id ?? null, calculationAuthority: false }, bootstrap: !predecessor && panel !== null,
          ...(!predecessor && panel ? { initialization: { mode: 'baseline-only', baselineFrom: window.baselineDates[0], baselineThrough: window.baselineDates.at(-1), eligibleBaselineSessionCount: 20, inputBarCount: 105, replayedAssessmentCount: 0, publishedHistoricalAssessmentCount: 0 } } : {}),
          reasonCode, missing, failures, splitFailures, canonicalInputHash, attemptFingerprint, startedAt, completedAt };
        insertionTarget = targetAt;
        const assessment: MarketRegimeDimensionAssessment = await tx.marketRegimeDimensionAssessment.create({ data: { ...identity, evidenceSchemaVersion: PARTICIPATION_PUBLICATION_EVIDENCE_VERSION,
          sessionDate: new Date(targetDate), targetAt, attempt: (priorAttempt?.attempt ?? 0) + 1, status, reasonCode,
          rawState: panel?.rawState ?? null, effectiveState: panel?.effectiveState ?? null, dataThroughAt: panel ? targetAt : null, validUntil: panel ? window.proposedValidUntil : null,
          previousAssessmentId: predecessor?.id ?? null, startedAt, completedAt, evidenceJson: json(evidence) } });
        const event = reasonCode ? 'blocked' : !predecessor ? 'bootstrap' : priorAttempt ? 'recovered' : predecessor.effectiveState !== panel!.effectiveState ? 'transition' : null;
        if (event) await tx.systemEvent.create({ data: { type: `participation_assessment_${event}`, entityType: 'market_regime_assessment', entityId: String(assessment.id), severity: reasonCode ? 'WARNING' : 'INFO',
          message: reasonCode ? `PARTICIPATION_V1 stopped at ${targetDate}: ${reasonCode}.` : `PARTICIPATION_V1 ${targetDate}: ${panel!.effectiveState}.`,
          payloadJson: { assessmentId: assessment.id, sessionDate: targetDate, attempt: assessment.attempt, reasonCode, previousAssessmentId: predecessor?.id ?? null,
            previousState: predecessor?.effectiveState ?? null, currentState: panel?.effectiveState ?? null, recoveredFromAttemptId: priorAttempt?.id ?? null } } });
        result.attempts++;
        if (reasonCode) return { ...result, blocked: { sessionDate: targetDate, status: status as 'UNAVAILABLE' | 'FAILED', reasonCode } };
        result.published++; predecessor = assessment;
      }
      return result;
    }, { timeout: 240_000, maxWait: 5_000 });
  } catch (error) {
    if (insertionTarget && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await db.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, targetAt: insertionTarget, status: 'VALID' } });
      if (winner) return { ...emptyResult(), suppressed: true };
    }
    throw error;
  }
}

export async function latestParticipationV1Assessment(db: PrismaClient = prisma) {
  const [latestAttempt, latestValid] = await Promise.all([
    db.marketRegimeDimensionAssessment.findFirst({ where: identity, orderBy: [{ targetAt: 'desc' }, { attempt: 'desc' }] }),
    db.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, status: 'VALID' }, orderBy: { targetAt: 'desc' } }),
  ]);
  return { latestAttempt, latestValid };
}
export async function listParticipationV1Assessments(limit: number, beforeId?: number, db: PrismaClient = prisma) {
  return db.marketRegimeDimensionAssessment.findMany({ where: { ...identity, ...(beforeId ? { id: { lt: beforeId } } : {}) }, orderBy: { id: 'desc' }, take: limit });
}
export async function getParticipationV1Assessment(id: number, db: PrismaClient = prisma) {
  const row = await db.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, id } });
  if (!row) throw new HttpError(404, 'PARTICIPATION_V1 assessment not found.');
  return row;
}
