import { readFile } from 'node:fs/promises';
import { prisma } from '../src/db/prisma.js';
import { importSecurityUniverses } from '../src/services/security-universe-import.service.js';

const args = process.argv.slice(2);
const file = args.find(arg => arg.startsWith('--file='))?.slice(7);
const scheduledDate = args.find(arg => arg.startsWith('--schedule='))?.slice(11);
const mode = args.find(arg => arg.startsWith('--mode='))?.slice(7) ?? 'partial';
if (!file || !['partial', 'snapshot'].includes(mode) || args.some(arg => arg !== '--apply' && !arg.startsWith('--file=') && !arg.startsWith('--schedule=') && !arg.startsWith('--mode=')) ||
    args.filter(arg => arg === '--apply').length > 1 || args.filter(arg => arg.startsWith('--file=')).length !== 1 || args.filter(arg => arg.startsWith('--schedule=')).length > 1 || args.filter(arg => arg.startsWith('--mode=')).length > 1)
  throw new Error('Usage: npm run universe:import -- --file=reviewed.csv [--mode=partial|snapshot] [--schedule=YYYY-MM-DD] [--apply]. Imports take effect today in America/New_York unless a future membership date is scheduled; historical dates are not accepted. Full reconciliation requires --mode=snapshot.');
try {
  const csv = await readFile(file, 'utf8');
  console.log(JSON.stringify(await importSecurityUniverses(csv, { timing: scheduledDate ? { kind: 'scheduled', membershipEffectiveDate: scheduledDate } : { kind: 'immediate' }, mode: mode as 'partial' | 'snapshot', apply: args.includes('--apply') }), null, 2));
} catch (error) {
  console.error(JSON.stringify({ applied: false, conflicts: [error instanceof Error ? error.message : 'Universe import failed.'] }, null, 2));
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
