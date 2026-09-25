import { bootstrapMarketSplits } from '../src/services/market-split-bootstrap.service.js';
import { prisma } from '../src/db/prisma.js';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply' && !arg.startsWith('--through=')) || args.filter(arg => arg === '--apply').length > 1 || args.filter(arg => arg.startsWith('--through=')).length > 1) {
  throw new Error('Usage: npm run splits:bootstrap -- [--through=YYYY-MM-DD] [--apply]');
}
try {
  console.log(JSON.stringify(await bootstrapMarketSplits({ apply: args.includes('--apply'), through: args.find(arg => arg.startsWith('--through='))?.slice(10) }), null, 2));
} finally { await prisma.$disconnect(); }
