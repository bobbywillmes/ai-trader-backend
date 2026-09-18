import 'dotenv/config';
import { getTrendLab } from '../src/services/trend-lab.service.js';
import { marketDataStatus } from '../src/services/market-bar-ingestion.service.js';
import { prisma } from '../src/db/prisma.js';
import { etDate } from '../src/services/market-calendar.js';
import { closeMarketDataLockPool } from '../src/services/market-data-lock.service.js';
try {
  const from = process.argv[2] ?? '2023-01-01';
  const to = process.argv[3] ?? etDate(new Date());
  const lab = await getTrendLab(from, to);
  const status = await marketDataStatus();
  console.log(JSON.stringify({ from, to, datasetId: lab.datasetId, stored: status.symbols, source: lab.series.map(s => ({symbol:s.symbol, count:s.source.count, earliest:s.source.earliest, dataThrough:s.source.dataThrough, preRollSessions:s.source.preRollSessions, splits:s.splits})), profiles: Object.fromEntries(Object.entries(lab.profiles).map(([name,value])=>[name,value.summary])), warnings:lab.warnings, authoritativeAssessments:await prisma.marketRegimeDimensionAssessment.count() },null,2));
} finally { await prisma.$disconnect(); await closeMarketDataLockPool(); }
