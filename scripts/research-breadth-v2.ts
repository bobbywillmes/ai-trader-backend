import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import { runBreadthV2Research } from '../src/dev/breadth-v2-research.js';

const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--') && arg.includes('=')).map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
try {
  const revisionId = Number(args.revision);
  if (!Number.isSafeInteger(revisionId) || revisionId < 1 || !args.from || !args.through) throw new Error('Usage: research:breadth-v2 -- --revision=ID --from=YYYY-MM-DD --through=YYYY-MM-DD [--output=DIR]');
  const result = await runBreadthV2Research({ revisionId, from: args.from, through: args.through, ...(args.output ? { outputDirectory: args.output } : {}) });
  process.stdout.write(`${JSON.stringify({ outputDirectory: result.outputDirectory, dataQuality: result.summary.dataQuality, bridgeCandidates: result.summary.bridgeCandidates }, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Breadth V2 research failed'}\n`); process.exitCode = 1; }
finally { await prisma.$disconnect(); }
