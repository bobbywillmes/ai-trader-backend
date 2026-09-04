import { prisma } from '../src/db/prisma.js';
import {
  closeTradingAccountWorkflowLockPool,
} from '../src/services/trading-account-workflow-lock.service.js';
import {
  repairHistoricalOrderLifecycle,
} from '../src/services/historical-order-lifecycle-repair.service.js';

// Apply mode is deprecated. Retain this script for read-only diagnosis while
// the durable owner-authorized Lifecycle Repair Workbench demonstrates parity.

function option(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function tradingAccountId() {
  const parsed = Number(option('trading-account-id'));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('--trading-account-id=<positive integer> is required.');
  }
  return parsed;
}

repairHistoricalOrderLifecycle({
  tradingAccountId: tradingAccountId(),
  apply: process.argv.includes('--apply'),
  confirmation: option('confirmation'),
})
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await closeTradingAccountWorkflowLockPool();
  });
