import 'dotenv/config';

import { prisma } from '../src/db/prisma.js';
import { assessEntryExposureReadiness } from '../src/services/entry-exposure-readiness.service.js';

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const report = await assessEntryExposureReadiness({ apply });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 2;
}

main().finally(() => prisma.$disconnect());
