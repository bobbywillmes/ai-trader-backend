import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { fetchDailyEvidence, fetchMinuteEvidence, type DailyEvidenceBar } from '../integrations/massive/evidence.client.js';
import { addDays, barEligibility, datesBetween, etDate, etInstant, marketSession, validDate, type CalendarException } from './market-calendar.js';
import { calendarExceptions } from './market-calendar.service.js';
import { withMarketDataLock } from './market-data-lock.service.js';
import { TREND_PRE_ROLL_CALENDAR_DAYS, TREND_RESEARCH_START } from './trend-lab.config.js';
import { DAILY_SYNC_RETRY_MS, MAX_BACKFILL_DAYS, MARKET_DAILY_EVIDENCE_SYMBOLS, type DailyEvidenceSymbol } from './market-daily-evidence.definition.js';
import { withMarketMinuteDataLock } from './market-minute-data-lock.service.js';
import { TREND_SYMBOLS } from './trend-lab.config.js';
import { configuredTiingoRestClient, type TiingoBar } from '../integrations/tiingo/rest.client.js';
import { intradayAuthority } from './intraday-stress-provider-authority.js';
import { aggregateTiingoMinuteWindow } from './tiingo-minute-aggregation.js';

export const TREND_DATA_START = addDays(TREND_RESEARCH_START, -TREND_PRE_ROLL_CALENDAR_DAYS);
const SYNC_KEY = 'marketDailyEvidenceSync';
type FetchBars = (symbol: DailyEvidenceSymbol, from: string, to: string) => Promise<DailyEvidenceBar[]>;
type SyncState = { fromDate: string; nextAttemptAt: string; lastAttemptAt: string | null; lastResult: string };
export function validateBackfillRange(from: string, to: string, now = new Date()) {
  if (!validDate(from) || !validDate(to) || from < TREND_DATA_START || to > etDate(now) || from > to || datesBetween(from, to).length > MAX_BACKFILL_DAYS) {
    throw new HttpError(400, `Backfill requires ${TREND_DATA_START} or later, no future dates, and at most ${MAX_BACKFILL_DAYS} days per request.`);
  }
}
export function planDailyGaps(from: string, to: string, present: ReadonlySet<string>, exceptions: readonly CalendarException[], now: Date) {
  const missing: string[] = []; const notYetEligible: string[] = [];
  for (const date of datesBetween(from, to)) {
    const eligibility = barEligibility('DAY_1', etInstant(date, 0), now, exceptions);
    if (eligibility.status === 'NOT_YET_ELIGIBLE') notYetEligible.push(date);
    else if (eligibility.status === 'ELIGIBLE' && !present.has(date)) missing.push(date);
  }
  return { missing, notYetEligible };
}
export async function ingestDailyRange(symbol: DailyEvidenceSymbol, from: string, to: string, options: { now?: Date; db?: PrismaClient; fetchBars?: FetchBars } = {}) {
  const now = options.now ?? new Date(); const db = options.db ?? prisma;
  validateBackfillRange(from, to, now);
  const security = await db.security.findUnique({ where: { symbol }, select: { id: true } });
  if (!security) throw new HttpError(409, `Existing Security ${symbol} is required; create it in Securities before backfill.`);
  const exceptions = await calendarExceptions(from, to, db);
  if (!datesBetween(from, to).some(date => barEligibility('DAY_1', etInstant(date, 0), now, exceptions).status === 'ELIGIBLE')) {
    return { symbol, from, to, returned: 0, eligible: 0, inserted: 0, alreadyStored: 0, ineligible: 0 };
  }
  const bars = await (options.fetchBars ?? fetchDailyEvidence)(symbol, from, to);
  const eligible = bars.filter(bar => barEligibility('DAY_1', bar.barStartAt, now, exceptions).status === 'ELIGIBLE');
  const result = await db.marketBar.createMany({ data: eligible.map(bar => ({ ...bar, securityId: security.id, timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED' })), skipDuplicates: true });
  return { symbol, from, to, returned: bars.length, eligible: eligible.length, inserted: result.count, alreadyStored: eligible.length - result.count, ineligible: bars.length - eligible.length };
}
export async function backfillDailyBars(from: string, to: string, actorUserId?: number) {
  validateBackfillRange(from, to);
  return withMarketDataLock(async () => {
    const startedAt = new Date();
    await prisma.systemEvent.create({ data: { type: 'market_data_backfill_started', entityType: 'market_data', entityId: 'daily', severity: 'INFO', message: 'Daily evidence backfill started.', payloadJson: { from, to }, ...(actorUserId === undefined ? {} : { actorUserId }) } });
    try {
      const results = [];
      for (const symbol of MARKET_DAILY_EVIDENCE_SYMBOLS) results.push(await ingestDailyRange(symbol, from, to));
      await prisma.systemEvent.create({ data: { type: 'market_data_backfill_completed', entityType: 'market_data', entityId: 'daily', severity: 'INFO', message: 'Daily evidence backfill completed.', payloadJson: { from, to, startedAt: startedAt.toISOString(), results }, ...(actorUserId === undefined ? {} : { actorUserId }) } });
      return { results };
    } catch (error) {
      await prisma.systemEvent.create({ data: { type: 'market_data_backfill_failed', entityType: 'market_data', entityId: 'daily', severity: 'ERROR', message: 'Daily evidence backfill failed; retry is insert-only.', payloadJson: { from, to, reason: error instanceof Error ? error.message : 'Unknown error' } } });
      throw error;
    }
  });
}
export async function syncDailyBars(now = new Date()) {
  return withMarketDataLock(async () => {
    const today = etDate(now);
    const setting = await prisma.setting.upsert({ where: { key: SYNC_KEY }, update: {}, create: { key: SYNC_KEY, value: JSON.stringify({ fromDate: today, nextAttemptAt: now.toISOString(), lastAttemptAt: null, lastResult: 'INITIALIZED' } satisfies SyncState) } });
    const state = JSON.parse(setting.value) as SyncState;
    if (!validDate(state.fromDate) || !Number.isFinite(Date.parse(state.nextAttemptAt))) throw new Error('Invalid market sync checkpoint.');
    if (now < new Date(state.nextAttemptAt)) return { inserted: 0, missing: 0, notDue: true };
    // Persist retry timing before calls so restarts/processes cannot hammer missing data.
    state.nextAttemptAt = new Date(now.getTime() + DAILY_SYNC_RETRY_MS).toISOString();
    state.lastAttemptAt = now.toISOString(); state.lastResult = 'RUNNING';
    await prisma.setting.update({ where: { key: SYNC_KEY }, data: { value: JSON.stringify(state) } });
    try {
      const exceptions = await calendarExceptions(state.fromDate, today);
      let inserted = 0; let missing = 0;
      for (const symbol of MARKET_DAILY_EVIDENCE_SYMBOLS) {
        const security = await prisma.security.findUnique({ where: { symbol }, select: { id: true } });
        if (!security) throw new Error(`Existing Security ${symbol} is required for daily sync.`);
        const rows = await prisma.marketBar.findMany({ where: { securityId: security.id, timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED', barStartAt: { gte: etInstant(state.fromDate, 0) } }, select: { barStartAt: true } });
        const gaps = planDailyGaps(state.fromDate, today, new Set(rows.map(row => etDate(row.barStartAt))), exceptions, now);
        // Bounded work per tick; the persistent floor retains all unfinished gaps.
        for (const date of gaps.missing.slice(0, 20)) {
          const result = await ingestDailyRange(symbol, date, date, { now }); inserted += result.inserted;
          if (result.eligible === 0) missing++;
        }
        missing += Math.max(0, gaps.missing.length - 20);
        for (const date of gaps.notYetEligible) {
          const close = barEligibility('DAY_1', etInstant(date, 0), now, exceptions).eligibleAt!.getTime();
          if (close > now.getTime() && close < Date.parse(state.nextAttemptAt)) state.nextAttemptAt = new Date(close).toISOString();
        }
      }
      state.lastResult = missing ? `MISSING:${missing}` : `COMPLETE:${inserted}`;
      await prisma.setting.update({ where: { key: SYNC_KEY }, data: { value: JSON.stringify(state) } });
      if (missing) throw new Error(`${missing} eligible daily bars remain missing. Check Massive availability and calendar exceptions.`);
      return { inserted, missing, notDue: false };
    } catch (error) {
      state.lastResult = error instanceof Error ? error.message : 'FAILED';
      await prisma.setting.update({ where: { key: SYNC_KEY }, data: { value: JSON.stringify(state) } });
      throw error;
    }
  });
}
type MinuteFetcher = (symbol: string, date: string) => Promise<TiingoBar[]>;
function expectedMinuteStarts(session: NonNullable<ReturnType<typeof marketSession>>, now: Date, exceptions: CalendarException[]) {
  const result: number[] = [];
  for (let t = session.openAt.getTime(); t < session.closeAt.getTime(); t += 900_000)
    if (barEligibility('MINUTE_15', new Date(t), now, exceptions).status === 'ELIGIBLE') result.push(t);
  return result;
}
function assertMinuteProvider(symbol: string, rows: { provider: string; barStartAt: Date }[], provider: string) {
  const conflict = rows.find(row => row.provider !== provider);
  if (conflict) throw new Error(`Canonical provider conflict: ${symbol} ${conflict.barStartAt.toISOString()} is ${conflict.provider}; session authority is ${provider}.`);
}
/** Bounded, current-session-only SPY/RSP sync under the existing minute evidence lock. */
export async function syncMinuteBars(now = new Date(), fetchTiingo?: MinuteFetcher) {
  return withMarketMinuteDataLock(async () => {
    const today = etDate(now);
    const authority = intradayAuthority(today);
    if (authority.provider === 'TIINGO' && (await prisma.setting.findUnique({ where: { key: 'tiingoDailyIngestionPaused' } }))?.value === 'true')
      throw new Error('Tiingo minute acquisition is paused after retention purge.');
    const exceptions = await calendarExceptions(today, today);
    const session = marketSession(today, exceptions);
    if (!session) return { inserted: 0, missing: 0, notDue: false };
    const eligibleStarts = expectedMinuteStarts(session, now, exceptions);
    const plans = await Promise.all(TREND_SYMBOLS.map(async symbol => {
      const security = await prisma.security.findUnique({ where: { symbol }, select: { id: true } });
      if (!security) throw new Error(`Existing Security ${symbol} is required for minute sync.`);
      const rows = await prisma.marketBar.findMany({ where: { securityId: security.id, timeframe: 'MINUTE_15', barStartAt: { gte: session.openAt, lt: session.closeAt } }, select: { barStartAt: true, provider: true } });
      assertMinuteProvider(symbol, rows, authority.provider);
      const present = new Set(rows.map(row => row.barStartAt.getTime()));
      return { symbol, securityId: security.id, missing: eligibleStarts.filter(t => !present.has(t)) };
    }));
    if (plans.every(plan => plan.missing.length === 0)) return { inserted: 0, missing: 0, notDue: false };
    const client = authority.provider === 'TIINGO' && !fetchTiingo ? configuredTiingoRestClient() : null;
    const fetched = await Promise.all(plans.map(async plan => {
      if (!plan.missing.length) return { ...plan, bars: [] as Array<{ barStartAt: Date; open: number | string; high: number | string; low: number | string; close: number | string; volume: number | string }> };
      try {
        if (authority.provider === 'MASSIVE') return { ...plan, bars: await fetchMinuteEvidence(plan.symbol, today, today) };
        const minutes = await (fetchTiingo ?? ((symbol, date) => client!.intradayMinutes(symbol, date)))(plan.symbol, today);
        return { ...plan, bars: plan.missing.flatMap(t => {
          const bar = aggregateTiingoMinuteWindow(minutes, new Date(t)); return bar ? [bar] : [];
        }) };
      } catch (error) { throw new Error(`${authority.provider} minute provider request failure for ${plan.symbol}: ${error instanceof Error ? error.message : String(error)}`); }
    }));
    let inserted = 0; let missing = 0;
    for (const plan of fetched) {
      const available = new Map(plan.bars.map(bar => [bar.barStartAt.getTime(), bar]));
      for (const t of plan.missing) {
        const bar = available.get(t);
        if (!bar) { missing++; continue; }
        try {
          await prisma.marketBar.create({ data: { ...bar, securityId: plan.securityId, timeframe: 'MINUTE_15', provider: authority.provider, adjustmentMode: 'UNADJUSTED', receivedAt: (bar as { receivedAt?: Date }).receivedAt ?? now } });
          inserted++;
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
          const winner = await prisma.marketBar.findUnique({ where: { securityId_timeframe_barStartAt: { securityId: plan.securityId, timeframe: 'MINUTE_15', barStartAt: new Date(t) } }, select: { provider: true, barStartAt: true } });
          if (!winner) throw error;
          assertMinuteProvider(plan.symbol, [winner], authority.provider);
        }
      }
    }
    if (authority.provider === 'TIINGO' && missing) throw new Error(`${missing} eligible MINUTE_15 Tiingo window(s) remain incomplete (strict 15/15 minute evidence).`);
    return { inserted, missing, notDue: false };
  });
}
export async function intradayMinuteAuthorityStatus(now = new Date()) {
  const date = etDate(now);
  const authority = intradayAuthority(date);
  const exceptions = await calendarExceptions(date, date);
  const session = marketSession(date, exceptions);
  const expected = session ? expectedMinuteStarts(session, now, exceptions) : [];
  const symbols = await Promise.all(TREND_SYMBOLS.map(async symbol => {
    const security = await prisma.security.findUnique({ where: { symbol }, select: { id: true } });
    const rows = security && session ? await prisma.marketBar.findMany({ where: { securityId: security.id, timeframe: 'MINUTE_15', barStartAt: { gte: session.openAt, lt: session.closeAt } }, select: { barStartAt: true, provider: true }, orderBy: { barStartAt: 'desc' } }) : [];
    const present = new Set(rows.map(row => row.barStartAt.getTime()));
    return { symbol, securityId: security?.id ?? null, count: rows.length, latest: rows[0] ? { barStartAt: rows[0].barStartAt, provider: rows[0].provider } : null,
      eligibleMissingWindows: expected.filter(t => !present.has(t)).map(t => new Date(t)),
      canonicalProviderConflict: rows.filter(row => row.provider !== authority.provider).map(row => ({ barStartAt: row.barStartAt, actualProvider: row.provider })) };
  }));
  return { currentNySession: date, sessionOpen: session?.openAt ?? null, sessionClose: session?.closeAt ?? null,
    configuredCutoverSession: authority.cutoverSession, expectedIntradayProvider: authority.provider, authorityVersion: authority.authorityVersion,
    baselineProvider: 'MASSIVE', tiingoIngestionPaused: (await prisma.setting.findUnique({ where: { key: 'tiingoDailyIngestionPaused' } }))?.value === 'true', symbols };
}
export async function marketDataStatus(now = new Date()) {
  const today = etDate(now); const checkpoint = await prisma.setting.findUnique({ where: { key: SYNC_KEY } });
  const sync = checkpoint ? JSON.parse(checkpoint.value) as SyncState : null;
  const operationalFrom = sync?.fromDate ?? today;
  // Coverage is measured independently of the operational checkpoint, including warmup.
  const coverageFrom = addDays(today, -MAX_BACKFILL_DAYS + 1);
  const exceptions = await calendarExceptions(coverageFrom < operationalFrom ? coverageFrom : operationalFrom, today);
  const symbols = await Promise.all(MARKET_DAILY_EVIDENCE_SYMBOLS.map(async symbol => {
    const security = await prisma.security.findUnique({ where: { symbol }, select: { id: true } });
    const rows = security ? await prisma.marketBar.findMany({ where: { securityId: security.id, timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED' }, orderBy: { barStartAt: 'asc' }, select: { barStartAt: true } }) : [];
    const present = new Set(rows.map(row => etDate(row.barStartAt)));
    return {
      symbol, securityId: security?.id ?? null, count: rows.length,
      earliest: rows[0] ? etDate(rows[0].barStartAt) : null,
      latest: rows.at(-1) ? etDate(rows.at(-1)!.barStartAt) : null,
      coverageFrom, historicalMissing: planDailyGaps(coverageFrom, today, present, exceptions, now).missing,
      ...planDailyGaps(operationalFrom, today, present, exceptions, now),
    };
  }));
  const events = await prisma.systemEvent.findMany({ where: { type: { in: ['market_data_backfill_started', 'market_data_backfill_completed', 'market_data_backfill_failed'] } }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, type: true, message: true, payloadJson: true, createdAt: true } });
  return { researchStart: TREND_RESEARCH_START, dataStart: TREND_DATA_START, maxBackfillDays: MAX_BACKFILL_DAYS, operationalFrom, symbols, sync, events };
}
