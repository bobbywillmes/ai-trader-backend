/** Read-only PAPER executor identity preflight. Never verifies credentials or calls broker writes. */
import { assessPaperBrokerWriteAuthority } from '../src/services/paper-broker-write-authority.service.js';
import { prisma } from '../src/db/prisma.js';

try {
  const result = await assessPaperBrokerWriteAuthority();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'PAPER authority preflight failed.');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
