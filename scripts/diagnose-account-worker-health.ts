import { prisma } from '../src/db/prisma.js';
import { deriveTradingAccountWorkerStatus } from '../src/services/trading-account-worker-health.service.js';
import { getWorkerDefinition, type WorkerKey } from '../src/workers/worker-health.definitions.js';

const accounts = await prisma.tradingAccount.findMany({
  orderBy: { id: 'asc' },
  select: {
    id: true, displayName: true, environment: true, status: true,
    tradingEnabled: true, killSwitchEnabled: true,
    credential: { select: { status: true } },
    workerHealthStates: { orderBy: { workerKey: 'asc' } },
    _count: { select: { trackedPositions: { where: { status: { in: ['open', 'closing'] } } } } },
  },
});

const duplicateActiveCycles = await prisma.$queryRaw<Array<{
  tradingAccountId: number; broker: string; symbol: string; count: bigint;
}>>`
  SELECT "tradingAccountId", lower(broker) broker, upper(symbol) symbol, count(*) count
  FROM "TrackedPosition"
  WHERE "tradingAccountId" IS NOT NULL AND status IN ('open', 'closing')
  GROUP BY "tradingAccountId", lower(broker), upper(symbol)
  HAVING count(*) > 1
`;

console.dir({
  generatedAt: new Date().toISOString(),
  duplicateActiveCycles: duplicateActiveCycles.map((row) => ({ ...row, count: Number(row.count) })),
  accounts: accounts.map((account) => ({
    ...account,
    readiness: {
      credentialsUsable: account.credential?.status === 'ACTIVE',
      activeExposure: account._count.trackedPositions,
      liveWritesDisabledByDefault: account.environment === 'LIVE',
    },
    workerHealthStates: account.workerHealthStates.map((state) => ({
      ...state,
      status: deriveTradingAccountWorkerStatus(
        state, getWorkerDefinition(state.workerKey as WorkerKey)
      ),
    })),
  })),
}, { depth: null });

await prisma.$disconnect();
