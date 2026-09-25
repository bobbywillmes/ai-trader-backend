import { readFile } from 'node:fs/promises';
import { prisma } from '../src/db/prisma.js';
import { importSecurityUniverses } from '../src/services/security-universe-import.service.js';

const args = process.argv.slice(2);
const file = args.find(arg => arg.startsWith('--file='))?.slice(7);
const effectiveDate = args.find(arg => arg.startsWith('--effective='))?.slice(12);
if (!file || !effectiveDate || args.some(arg => arg !== '--apply' && !arg.startsWith('--file=') && !arg.startsWith('--effective=')) ||
    args.filter(arg => arg === '--apply').length > 1 || args.filter(arg => arg.startsWith('--file=')).length !== 1 || args.filter(arg => arg.startsWith('--effective=')).length !== 1)
  throw new Error('Usage: npm run universe:import -- --file=reviewed.csv --effective=YYYY-MM-DD [--apply]');
try {
  const csv = await readFile(file, 'utf8');
  console.log(JSON.stringify(await importSecurityUniverses(csv, { effectiveDate, apply: args.includes('--apply') }), null, 2));
} catch (error) {
  console.error(JSON.stringify({ applied: false, conflicts: [error instanceof Error ? error.message : 'Universe import failed.'] }, null, 2));
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
