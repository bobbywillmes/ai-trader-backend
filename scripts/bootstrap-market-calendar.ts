import 'dotenv/config';
import { bootstrapMarketCalendar } from '../src/services/market-calendar-bootstrap.service.js';
import { prisma } from '../src/db/prisma.js';
try {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: bootstrap-market-calendar.ts [--apply]');
  const result = await bootstrapMarketCalendar(process.argv.includes('--apply'));
  console.log(JSON.stringify(result, null, 2));
  if (result.conflicts.length) process.exitCode = 1;
} finally { await prisma.$disconnect(); }
