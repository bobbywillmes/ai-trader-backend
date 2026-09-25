import { Prisma, type PrismaClient } from '@prisma/client';
import type { SplitEvent } from '../integrations/massive/evidence.client.js';
import type { DailyEvidenceSymbol } from './market-daily-evidence.definition.js';
import { addDays, validDate } from './market-calendar.js';

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
  const coverage = await db.marketSplitCoverage.findMany({
    where: { securityId: security.id, fromDate: { lte: new Date(through) }, throughDate: { gte: new Date(from) } },
    orderBy: [{ fromDate: 'asc' }, { throughDate: 'asc' }],
  });
  let next = from;
  for (const row of coverage) {
    const start = day(row.fromDate), end = day(row.throughDate);
    if (row.provider !== 'MASSIVE' || start > next) throw new Error('Incomplete or mixed-provider split coverage.');
    if (end >= next) next = addDays(end, 1);
    if (next > through) break;
  }
  if (next <= through) throw new Error('Incomplete persisted split coverage.');
  const rows = await db.marketSplitEvent.findMany({
    where: { securityId: security.id, executionDate: { gte: new Date(from), lte: new Date(through) } },
    orderBy: [{ executionDate: 'asc' }, { id: 'asc' }],
  });
  return rows.map(row => {
    if (row.provider !== 'MASSIVE' || !row.provenance.startsWith('MASSIVE:') || row.provenance.length <= 8 || !coverage.some(c => day(c.fromDate) <= day(row.executionDate) && day(c.throughDate) >= day(row.executionDate)))
      throw new Error('Split event conflicts with coverage.');
    return normalizedPersistedSplit(row.id, symbol, day(row.executionDate), row.splitFactor);
  });
}
