import { prisma } from '../src/db/prisma.js';
import { tiingoDailyBackfill } from '../src/services/tiingo-daily.service.js';

const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--') && arg.includes('=')).map(arg => { const i = arg.indexOf('='); return [arg.slice(2, i), arg.slice(i + 1)]; }));
const apply = process.argv.includes('--apply');
try {
  const revisionId = Number(args.revision);
  if (!Number.isSafeInteger(revisionId) || revisionId < 1 || !args.from || !args.through) throw new Error('Usage: --revision=ID --from=YYYY-MM-DD --through=YYYY-MM-DD [--symbols=AAPL,MSFT] [--apply]');
  const result = await tiingoDailyBackfill({ revisionId, from: args.from, through: args.through, symbols: args.symbols?.split(','), apply });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (apply && (result.counts.conflict || result.counts.failed || result.counts.missing || result.counts.otherProvider)) process.exitCode = 1;
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Tiingo backfill failed'}\n`); process.exitCode = 1; }
finally { await prisma.$disconnect(); }
