import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { buildVolatilityReport } from '../src/dev/volatility-report.js';
import { prisma } from '../src/db/prisma.js';

try {
  const report = await buildVolatilityReport();
  const { days: _days, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
} finally { await prisma.$disconnect(); }
