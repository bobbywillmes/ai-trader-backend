import { Prisma, type PrismaClient } from '@prisma/client';
import type { SplitEvent } from '../integrations/massive/evidence.client.js';
import type { DailyEvidenceSymbol } from './market-daily-evidence.definition.js';
import { addDays, datesBetween, marketSession, validDate } from './market-calendar.js';
import { marketDailyAuthority, readCanonicalDailyBars } from './market-daily-authority.js';

type Db = Prisma.TransactionClient | PrismaClient;
const day = (value: Date) => value.toISOString().slice(0, 10);

/** Canonical factor is new shares / old shares; calculation price factor is its inverse. */
export function normalizedPersistedSplit(id: number, symbol: DailyEvidenceSymbol, executionDate: string, factor: Prisma.Decimal | string): SplitEvent {
  const splitTo = new Prisma.Decimal(factor).toNumber();
  const priceFactor = 1 / splitTo;
  if (!Number.isSafeInteger(id) || id < 1 || !validDate(executionDate) || !Number.isFinite(splitTo) || splitTo <= 0 || splitTo === 1 || !Number.isFinite(priceFactor) || priceFactor <= 0)
    throw new Error('Invalid persisted split evidence.');
  return { id: `market-split-event:${id}`, symbol, executionDate, splitFrom: 1, splitTo, priceFactor };
}

export async function readPersistedSplits(db: Db, symbol: DailyEvidenceSymbol, from: string, through: string): Promise<SplitEvent[]> {
  if (!validDate(from) || !validDate(through) || from > through) throw new Error('Invalid persisted split range.');
  const security = await db.security.findUnique({ where: { symbol }, select: { id: true } });
  if (!security) throw new Error('Missing split Security.');
  const cutover = marketDailyAuthority(through).cutoverSession;
  const massiveThrough = cutover && cutover <= through ? addDays(cutover, -1) : through;
  const coverage = from <= massiveThrough ? await db.marketSplitCoverage.findMany({
    where: { securityId: security.id, fromDate: { lte: new Date(massiveThrough) }, throughDate: { gte: new Date(from) } },
    orderBy: [{ fromDate: 'asc' }, { throughDate: 'asc' }],
  }) : [];
  let next = from;
  if (from <= massiveThrough) {
    for (const row of coverage) {
      const start = day(row.fromDate), end = day(row.throughDate);
      if (row.provider !== 'MASSIVE' || start > next) throw new Error('Incomplete or mixed-provider split coverage.');
      if (end >= next) next = addDays(end, 1);
      if (next > massiveThrough) break;
    }
    if (next <= massiveThrough) throw new Error('Incomplete persisted split coverage.');
  }
  const tiingoFrom = cutover && cutover <= through ? (cutover > from ? cutover : from) : null;
  const tiingoBars = tiingoFrom ? await readCanonicalDailyBars(db, [security.id], tiingoFrom, through) : [];
  if (tiingoFrom) {
    const calendarRows = await db.marketCalendarException.findMany({ where: { sessionDate: { gte: new Date(tiingoFrom), lte: new Date(through) } } });
    const exceptions = calendarRows.map(row => ({ sessionDate: day(row.sessionDate), type: row.type, closeTimeMinutesEt: row.closeTimeMinutesEt }));
    const expected = datesBetween(tiingoFrom, through).filter(date => marketSession(date, exceptions));
    if (tiingoBars.length !== expected.length || expected.some(date => !tiingoBars.some(bar => bar.sessionDate === date && bar.splitFactor?.gt(0))))
      throw new Error('Incomplete Tiingo DAY_1 split-factor coverage.');
  }
  const rows = await db.marketSplitEvent.findMany({
    where: { securityId: security.id, executionDate: { gte: new Date(from), lte: new Date(through) } },
    orderBy: [{ executionDate: 'asc' }, { id: 'asc' }],
  });
  const events = rows.map(row => {
    const date = day(row.executionDate);
    if (marketDailyAuthority(date).provider === 'MASSIVE') {
      if (row.provider !== 'MASSIVE' || !row.provenance.startsWith('MASSIVE:') || row.provenance.length <= 8 || !coverage.some(c => day(c.fromDate) <= date && day(c.throughDate) >= date))
        throw new Error('Split event conflicts with coverage.');
    } else {
      const bar = tiingoBars.find(item => item.sessionDate === date);
      if (row.provider !== 'TIINGO' || row.provenance !== `TIINGO:EOD:${symbol}:${date}` || !bar?.splitFactor?.equals(row.splitFactor))
        throw new Error('Tiingo split event conflicts with canonical DAY_1 factor.');
    }
    return normalizedPersistedSplit(row.id, symbol, date, row.splitFactor);
  });
  for (const bar of tiingoBars) if (bar.splitFactor && !bar.splitFactor.equals(1) && !rows.some(row => day(row.executionDate) === bar.sessionDate))
    throw new Error('Missing persisted Tiingo split event.');
  return events;
}
