import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import { backfillDailyBars, marketDataStatus, TREND_DATA_START } from '../src/services/market-bar-ingestion.service.js';
import { closeMarketDataLockPool } from '../src/services/market-data-lock.service.js';
import { addDays, etDate } from '../src/services/market-calendar.js';
import { MAX_BACKFILL_DAYS } from '../src/services/trend-lab.config.js';

// Deliberately local: production backfill is an explicit owner API operation.
const url = new URL(process.env.DATABASE_URL!);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('This helper only backfills a local database.');
try {
  let failures = 0;
  const end = process.argv[3] ?? etDate(new Date());
  for (let from = process.argv[2] ?? TREND_DATA_START; from <= end;) {
    const to = [addDays(from, MAX_BACKFILL_DAYS - 1), end].sort()[0]!;
    try { console.log(JSON.stringify(await backfillDailyBars(from, to))); }
    catch (error) { failures++; console.error(JSON.stringify({ from, to, error: error instanceof Error ? error.message : 'Unknown error' })); }
    from = addDays(to, 1);
  }
  console.log(JSON.stringify(await marketDataStatus(), null, 2));
  if (failures) process.exitCode = 1;
} finally { await prisma.$disconnect(); await closeMarketDataLockPool(); }
