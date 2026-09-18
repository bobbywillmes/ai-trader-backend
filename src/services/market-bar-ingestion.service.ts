import type { PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { fetchDailyEvidence, type DailyEvidenceBar } from '../integrations/massive/evidence.client.js';
import { addDays, barEligibility, datesBetween, etDate, etInstant, validDate, type CalendarException } from './market-calendar.js';
import { calendarExceptions } from './market-calendar.service.js';
import { withMarketDataLock } from './market-data-lock.service.js';
import { DAILY_SYNC_RETRY_MS, MAX_BACKFILL_DAYS, TREND_PRE_ROLL_CALENDAR_DAYS, TREND_RESEARCH_START, TREND_SYMBOLS, type TrendSymbol } from './trend-lab.config.js';

export const TREND_DATA_START = addDays(TREND_RESEARCH_START, -TREND_PRE_ROLL_CALENDAR_DAYS);
const SYNC_KEY = 'marketDailyEvidenceSync';
type FetchBars = (symbol: TrendSymbol, from: string, to: string) => Promise<DailyEvidenceBar[]>;
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
export async function ingestDailyRange(symbol: TrendSymbol, from: string, to: string, options: { now?: Date; db?: PrismaClient; fetchBars?: FetchBars } = {}) {
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
    await prisma.systemEvent.create({ data: { type: 'market_data_backfill_started', entityType: 'market_data', entityId: 'daily', severity: 'INFO', message: 'Daily research backfill started.', payloadJson: { from, to }, ...(actorUserId === undefined ? {} : { actorUserId }) } });
    try {
      const results = [];
      for (const symbol of TREND_SYMBOLS) results.push(await ingestDailyRange(symbol, from, to));
      await prisma.systemEvent.create({ data: { type: 'market_data_backfill_completed', entityType: 'market_data', entityId: 'daily', severity: 'INFO', message: 'Daily research backfill completed.', payloadJson: { from, to, startedAt: startedAt.toISOString(), results }, ...(actorUserId === undefined ? {} : { actorUserId }) } });
      return { results };
    } catch (error) {
      await prisma.systemEvent.create({ data: { type: 'market_data_backfill_failed', entityType: 'market_data', entityId: 'daily', severity: 'ERROR', message: 'Daily research backfill failed; retry is insert-only.', payloadJson: { from, to, reason: error instanceof Error ? error.message : 'Unknown error' } } });
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
      for (const symbol of TREND_SYMBOLS) {
        const security = await prisma.security.findUnique({ where: { symbol }, select: { id: true } });
        if (!security) throw new Error(`Existing Security ${symbol} is required for daily sync.`);
        const rows = await prisma.marketBar.findMany({ where: { securityId: security.id, timeframe: 'DAY_1', barStartAt: { gte: etInstant(state.fromDate, 0) } }, select: { barStartAt: true } });
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
export async function marketDataStatus(now = new Date()) {
  const today = etDate(now); const checkpoint = await prisma.setting.findUnique({ where: { key: SYNC_KEY } });
  const sync = checkpoint ? JSON.parse(checkpoint.value) as SyncState : null;
  const operationalFrom = sync?.fromDate ?? today;
  const exceptions = await calendarExceptions(operationalFrom, today);
  const symbols = await Promise.all(TREND_SYMBOLS.map(async symbol => {
    const security = await prisma.security.findUnique({ where: { symbol }, select: { id: true } });
    const rows = security ? await prisma.marketBar.findMany({ where: { securityId: security.id, timeframe: 'DAY_1' }, orderBy: { barStartAt: 'asc' }, select: { barStartAt: true } }) : [];
    return { symbol, securityId: security?.id ?? null, count: rows.length, earliest: rows[0] ? etDate(rows[0].barStartAt) : null, latest: rows.at(-1) ? etDate(rows.at(-1)!.barStartAt) : null, ...planDailyGaps(operationalFrom, today, new Set(rows.map(row => etDate(row.barStartAt))), exceptions, now) };
  }));
  const events = await prisma.systemEvent.findMany({ where: { type: { in: ['market_data_backfill_started', 'market_data_backfill_completed', 'market_data_backfill_failed'] } }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, type: true, message: true, payloadJson: true, createdAt: true } });
  return { researchStart: TREND_RESEARCH_START, dataStart: TREND_DATA_START, maxBackfillDays: MAX_BACKFILL_DAYS, operationalFrom, symbols, sync, events };
}
