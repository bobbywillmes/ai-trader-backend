import 'dotenv/config';

import { prisma } from '../src/db/prisma.js';
import { assessMarketPolicyBrokerEnforcementReadiness } from '../src/services/market-policy-broker-readiness.service.js';

// Read-only Phase 3C.3 pre-activation inventory. Exit code 2 means owner review is required before
// activating PAPER market-policy enforcement (see docs/production/market-policy-enforcement-rollout.md).
async function main() {
  const report = await assessMarketPolicyBrokerEnforcementReadiness();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.activationGuard.reviewRequired) process.exitCode = 2;
}

main().finally(() => prisma.$disconnect());
