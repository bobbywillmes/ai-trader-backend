import { prisma } from '../src/db/prisma.js';
import { resumeTiingoDailyIngestion, tiingoRetentionPurge } from '../src/services/tiingo-daily.service.js';

try {
  const confirm = process.argv.find(arg => arg.startsWith('--confirm='))?.slice(10);
  const result = process.argv.includes('--resume') ? await resumeTiingoDailyIngestion(confirm ?? '') : await tiingoRetentionPurge(process.argv.includes('--apply'), confirm);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Tiingo purge failed'}\n`); process.exitCode = 1; }
finally { await prisma.$disconnect(); }
