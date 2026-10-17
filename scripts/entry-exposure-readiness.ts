import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';

const apply = process.argv.slice(2).includes('--apply');

type Candidate = {
  tradingAccountId: number;
  securityId: number;
  symbol: string;
  positionIds: number[];
  intentIds: number[];
};

async function main() {
  const [positions, intents] = await Promise.all([
    prisma.trackedPosition.findMany({
      where: { status: { in: ['open', 'closing'] }, entryExposureClaim: null, tradingAccountId: { not: null } },
      select: { id: true, tradingAccountId: true, securityId: true, symbol: true },
    }),
    prisma.orderIntent.findMany({
      where: {
        side: 'buy', tradingAccountId: { not: null }, entryExposureClaim: null,
        OR: [
          { status: { in: ['received', 'pending', 'submitting', 'submitted'] } },
          { status: 'filled', trackedPositionId: null },
        ],
      },
      select: { id: true, tradingAccountId: true, symbol: true, status: true },
    }),
  ]);
  const securities = await prisma.security.findMany({ select: { id: true, symbol: true } });
  const securityBySymbol = new Map(securities.map((security) => [security.symbol.toUpperCase(), security]));
  const candidates = new Map<string, Candidate>();
  const get = (tradingAccountId: number, securityId: number, symbol: string) => {
    const key = `${tradingAccountId}:${securityId}`;
    const current = candidates.get(key) ?? { tradingAccountId, securityId, symbol, positionIds: [], intentIds: [] };
    candidates.set(key, current);
    return current;
  };
  for (const position of positions) {
    get(position.tradingAccountId!, position.securityId, position.symbol.toUpperCase()).positionIds.push(position.id);
  }
  const missingSecurity: Array<{ orderIntentId: number; tradingAccountId: number; symbol: string }> = [];
  for (const intent of intents) {
    const security = securityBySymbol.get(intent.symbol.toUpperCase());
    if (!security) {
      missingSecurity.push({ orderIntentId: intent.id, tradingAccountId: intent.tradingAccountId!, symbol: intent.symbol });
      continue;
    }
    get(intent.tradingAccountId!, security.id, security.symbol).intentIds.push(intent.id);
  }

  const report = { mode: apply ? 'APPLY' : 'DRY_RUN', adoptable: [] as Candidate[], ambiguous: [] as Candidate[], missingSecurity, adopted: [] as number[] };
  for (const candidate of candidates.values()) {
    const adoptable = (candidate.positionIds.length === 1 && candidate.intentIds.length === 0) ||
      (candidate.positionIds.length === 0 && candidate.intentIds.length === 1);
    (adoptable ? report.adoptable : report.ambiguous).push(candidate);
    if (!apply || !adoptable) continue;
    const claim = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${candidate.tradingAccountId}:${candidate.securityId}`}, 0))`;
      const existing = await tx.entryExposureClaim.findFirst({
        where: { tradingAccountId: candidate.tradingAccountId, securityId: candidate.securityId, releasedAt: null },
      });
      if (existing) return existing;
      const positionId = candidate.positionIds[0] ?? null;
      const intentId = candidate.intentIds[0] ?? null;
      return tx.entryExposureClaim.create({
        data: {
          tradingAccountId: candidate.tradingAccountId,
          securityId: candidate.securityId,
          orderIntentId: intentId,
          trackedPositionId: positionId,
          ownerKey: positionId
            ? `rollout-position:${candidate.tradingAccountId}:${positionId}`
            : `rollout-intent:${candidate.tradingAccountId}:${intentId}`,
          status: positionId ? 'POSITION_OPEN' : 'UNRESOLVED',
          lastDiagnosedAt: positionId ? null : new Date(),
          events: {
            create: {
              eventType: 'OPERATOR_ROLLOUT_ADOPTION',
              evidenceJson: { positionId, intentId, symbol: candidate.symbol },
            },
          },
        },
      });
    });
    report.adopted.push(claim.id);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.ambiguous.length > 0 || report.missingSecurity.length > 0) process.exitCode = 2;
}

main().finally(() => prisma.$disconnect());
