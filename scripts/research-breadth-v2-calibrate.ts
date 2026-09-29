import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import { runBreadthV2Calibration } from '../src/dev/breadth-v2-calibration-runner.js';

const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--') && arg.includes('=')).map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
try {
  const revisionId = Number(args.revision);
  if (!Number.isSafeInteger(revisionId) || revisionId < 1 || !args.from || !args.through || !args['calibration-through']) throw new Error('Usage: research:breadth-v2:calibrate -- --revision=ID --from=YYYY-MM-DD --through=YYYY-MM-DD --calibration-through=YYYY-MM-DD [--output=DIR] [--expected-input-hash=SHA256]');
  const result = await runBreadthV2Calibration({ revisionId, from: args.from, through: args.through, calibrationThrough: args['calibration-through'], ...(args.output ? { outputDirectory: args.output } : {}), ...(args['expected-input-hash'] ? { expectedInputHash: args['expected-input-hash'] } : {}) });
  process.stdout.write(`${JSON.stringify({ outputDirectory: result.outputDirectory, researchVersion: result.summary.researchVersion, canonicalInputHash: result.summary.canonicalInputHash, stableCoreMemberCount: result.summary.stableCoreSensitivity.stableCoreMemberCount }, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'BREADTH_V2 calibration failed'}\n`); process.exitCode = 1; }
finally { await prisma.$disconnect(); }
