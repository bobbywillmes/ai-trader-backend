import { reconcileMomentumEligibility } from '../src/services/momentum-eligibility-reconciliation.service.js';
import { prisma } from '../src/db/prisma.js';

const flags = new Set(process.argv.slice(2));
const apply = flags.has('--apply');
const dryRun = flags.has('--dry-run');

if (apply === dryRun) {
  console.error('Specify exactly one of --dry-run or --apply.');
  process.exitCode = 1;
  await prisma.$disconnect();
} else {
  try {
    const report = await reconcileMomentumEligibility({ apply });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
