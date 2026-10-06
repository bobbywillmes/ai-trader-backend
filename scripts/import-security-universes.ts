import { readFile } from 'node:fs/promises';
import { prisma } from '../src/db/prisma.js';
import { importSecurityUniverses } from '../src/services/security-universe-import.service.js';

const args = process.argv.slice(2);
const file = args.find(arg => arg.startsWith('--file='))?.slice(7);
const scheduledDate = args.find(arg => arg.startsWith('--schedule='))?.slice(11);
if (!file || args.some(arg => arg !== '--apply' && !arg.startsWith('--file=') && !arg.startsWith('--schedule=')) ||
    args.filter(arg => arg === '--apply').length > 1 || args.filter(arg => arg.startsWith('--file=')).length !== 1 || args.filter(arg => arg.startsWith('--schedule=')).length > 1)
  throw new Error('Usage: npm run universe:import -- --file=changes.csv [--schedule=YYYY-MM-DD] [--apply]. Imports take effect today in America/New_York unless a future membership date is scheduled; historical dates are not accepted. Only explicit nonblank cells change Security data; membership removal requires 0.');
try {
  const csv = await readFile(file, 'utf8');
  console.log(JSON.stringify(await importSecurityUniverses(csv, { timing: scheduledDate ? { kind: 'scheduled', membershipEffectiveDate: scheduledDate } : { kind: 'immediate' }, apply: args.includes('--apply') }), null, 2));
} catch (error) {
  console.error(JSON.stringify({ applied: false, conflicts: [error instanceof Error ? error.message : 'Universe import failed.'] }, null, 2));
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
