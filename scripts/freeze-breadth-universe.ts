import { prisma } from '../src/db/prisma.js';
import { freezeBreadthUniverse } from '../src/services/security-universe-import.service.js';

const args = process.argv.slice(2);
const effectiveDate = args.find(arg => arg.startsWith('--effective='))?.slice(12);
if (!effectiveDate || args.some(arg => arg !== '--apply' && !arg.startsWith('--effective=')) ||
    args.filter(arg => arg === '--apply').length > 1 || args.filter(arg => arg.startsWith('--effective=')).length !== 1)
  throw new Error('Usage: npm run universe:freeze -- --effective=YYYY-MM-DD [--apply]');
try {
  console.log(JSON.stringify(await freezeBreadthUniverse({ effectiveDate, apply: args.includes('--apply') }), null, 2));
} catch (error) {
  console.error(JSON.stringify({ applied: false, error: error instanceof Error ? error.message : 'Breadth revision freeze failed.' }, null, 2));
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
