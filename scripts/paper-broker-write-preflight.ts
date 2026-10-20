/** Read-only PAPER executor preflight. It never calls broker endpoints or mutates the database. */
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { assessPaperBrokerWriteAuthority } from '../src/services/paper-broker-write-authority.service.js';

type Mode = 'inspect' | 'development-validation' | 'production';
const value = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const mode = (value('--mode') ?? 'inspect') as Mode;
const expectedTradingAccountId = Number(value('--expected-trading-account-id'));
const expectedBrokerAccountId = value('--expected-broker-account-number');
const expectedDatabase = value('--expected-database');

try {
  if (!['inspect', 'development-validation', 'production'].includes(mode)) throw new Error('Use --mode inspect, development-validation, or production.');
  const identity = await prisma.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
  const database = identity[0]?.database;
  if (!database) throw new Error('Database identity could not be verified.');
  if (mode !== 'inspect') {
    if (!Number.isInteger(expectedTradingAccountId) || expectedTradingAccountId < 1 || !expectedBrokerAccountId || !expectedDatabase) {
      throw new Error('Execution readiness requires --expected-trading-account-id, --expected-broker-account-number, and --expected-database.');
    }
    if (database !== expectedDatabase) throw new Error(`Connected database ${database} does not match asserted database ${expectedDatabase}.`);
    if (mode === 'production' && env.NODE_ENV !== 'production') throw new Error(`Production preflight requires NODE_ENV=production; received ${env.NODE_ENV}.`);
    if (mode === 'development-validation' && env.NODE_ENV !== 'development') throw new Error(`Development validation preflight requires NODE_ENV=development; received ${env.NODE_ENV}.`);
  }
  const result = await assessPaperBrokerWriteAuthority();
  const asserted = result.accounts.filter(item => item.tradingAccountId === expectedTradingAccountId);
  const assertionReady = mode === 'inspect' ? false : asserted.length === 1 && asserted[0]?.outcome === 'AUTHORIZED'
    && asserted[0].expectedBrokerAccountId === expectedBrokerAccountId;
  const verdict = mode === 'inspect' ? 'INFORMATIONAL_ONLY' : result.ready && assertionReady ? 'GO' : 'STOP';
  console.log(JSON.stringify({ verdict, mode, nodeEnv: env.NODE_ENV, database, brokerCallsMade: 0,
    expectedTradingAccountId: Number.isInteger(expectedTradingAccountId) ? expectedTradingAccountId : null,
    expectedBrokerAccountId: expectedBrokerAccountId ?? null, assessment: result }, null, 2));
  if (mode !== 'inspect' && verdict !== 'GO') process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'PAPER authority preflight failed.');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
