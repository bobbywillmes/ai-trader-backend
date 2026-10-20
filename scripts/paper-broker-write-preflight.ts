/** Read-only PAPER executor preflight. It never calls broker endpoints or mutates the database. */
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { assessPaperBrokerWriteAuthority } from '../src/services/paper-broker-write-authority.service.js';
import { assertPaperBrokerWritePreflightContext, parsePaperBrokerWritePreflightArgs } from '../src/services/paper-broker-write-preflight.js';

try {
  const args = parsePaperBrokerWritePreflightArgs(process.argv.slice(2));
  const { mode, expectedTradingAccountId, expectedBrokerAccountId } = args;
  const identity = await prisma.$queryRaw<Array<{ database: string; host: string | null; port: number; user: string }>>
    `SELECT current_database() AS database, host(inet_server_addr()) AS host, inet_server_port() AS port, current_user AS user`;
  const target = identity[0];
  if (!target?.database || !target.user) throw new Error('Database identity could not be verified.');
  assertPaperBrokerWritePreflightContext(args, env.NODE_ENV, process.env.IMAGE_REVISION, target);
  const result = await assessPaperBrokerWriteAuthority();
  const asserted = result.accounts.filter(item => item.tradingAccountId === expectedTradingAccountId);
  const assertionReady = mode === 'inspect' ? false : asserted.length === 1 && asserted[0]?.outcome === 'AUTHORIZED'
    && asserted[0].expectedBrokerAccountId === expectedBrokerAccountId;
  const verdict = mode === 'inspect' ? 'INFORMATIONAL_ONLY' : result.ready && assertionReady ? 'GO' : 'STOP';
  console.log(JSON.stringify({ verdict, mode, nodeEnv: env.NODE_ENV, imageRevision: process.env.IMAGE_REVISION ?? null, databaseTarget: target,
    brokerApiBehavior: 'NOT_INVOKED_BY_PREFLIGHT_CODE_PATH', expectedTradingAccountId,
    expectedBrokerAccountId, assessment: result }, null, 2));
  if (mode !== 'inspect' && verdict !== 'GO') process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'PAPER authority preflight failed.');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
