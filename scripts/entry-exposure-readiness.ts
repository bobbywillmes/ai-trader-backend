import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import { BROKER_ACTIVE_ENTRY_STATUSES, TERMINAL_ENTRY_ORDER_STATUSES, UNRESOLVED_ORDER_INTENT_STATUSES } from '../src/services/entry-lifecycle-status.service.js';

const apply = process.argv.slice(2).includes('--apply');

type Candidate = {
  tradingAccountId: number;
  securityId: number;
  symbol: string;
  positionIds: number[];
  intentIds: number[];
};

async function main() {
  const [positions, intents, brokerOrders, activeClaims] = await Promise.all([
    prisma.trackedPosition.findMany({
      where: { status: { in: ['open', 'closing'] }, entryExposureClaim: null, tradingAccountId: { not: null } },
      select: { id: true, tradingAccountId: true, securityId: true, symbol: true },
    }),
    prisma.orderIntent.findMany({
      where: {
        side: 'buy', tradingAccountId: { not: null }, entryExposureClaim: null,
        OR: [
          { status: { in: [...UNRESOLVED_ORDER_INTENT_STATUSES] } },
          { status: 'filled', trackedPositionId: null },
        ],
      },
      select: { id: true, tradingAccountId: true, symbol: true, status: true },
    }),
    prisma.brokerOrder.findMany({
      where: { side: { equals: 'buy', mode: 'insensitive' }, tradingAccountId: { not: null }, orderIntent: { entryExposureClaim: null } },
      select: { id: true, orderIntentId: true, tradingAccountId: true, securityId: true, symbol: true, status: true, brokerOrderId: true },
    }),
    prisma.entryExposureClaim.findMany({
      where: { releasedAt: null },
      select: {
        id: true, tradingAccountId: true, securityId: true, orderIntentId: true,
        trackedPositionId: true, status: true, updatedAt: true,
        trackedPosition: { select: { status: true } },
      },
      orderBy: { id: 'asc' },
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

  const unclaimedActiveBrokerBuys = brokerOrders.filter((order) =>
    (BROKER_ACTIVE_ENTRY_STATUSES as readonly string[]).includes(order.status.toLowerCase()));
  const historicalTerminalEvidence = brokerOrders.filter((order) =>
    (TERMINAL_ENTRY_ORDER_STATUSES as readonly string[]).includes(order.status.toLowerCase()));
  const protectedLegacyOpenPositions = activeClaims.filter((claim) =>
    claim.status === 'UNRESOLVED' && claim.trackedPositionId != null &&
    claim.trackedPosition && ['open', 'closing'].includes(claim.trackedPosition.status));
  const protectedClaimIds = new Set(protectedLegacyOpenPositions.map((claim) => claim.id));
  const unresolvedClaims = activeClaims.filter((claim) => claim.status === 'UNRESOLVED' && !protectedClaimIds.has(claim.id));
  const strandedClaims = activeClaims.filter((claim) =>
    !claim.orderIntentId && !claim.trackedPositionId ||
    ['ENTRY_PENDING', 'ENTRY_SUBMITTING', 'ADMISSION_BLOCKED'].includes(claim.status) &&
      Date.now() - claim.updatedAt.getTime() > 15 * 60_000);
  const report = {
    mode: apply ? 'APPLY' : 'DRY_RUN',
    ready: false,
    adoptable: [] as Candidate[], ambiguous: [] as Candidate[], missingSecurity,
    activeClaims,
    unresolvedClaims,
    protectedLegacyOpenPositions,
    strandedClaims,
    unclaimedActivePositions: positions,
    unclaimedUnresolvedBuyIntents: intents,
    unclaimedActiveBrokerBuys,
    historicalTerminalEvidence,
    adopted: [] as number[], alreadyClaimed: activeClaims.map((claim) => claim.id),
    skipped: [] as Candidate[], rejected: [] as Candidate[],
  };
  const adoptedPositionIds = new Set<number>();
  for (const candidate of candidates.values()) {
    const adoptable = (candidate.positionIds.length === 1 && candidate.intentIds.length === 0) ||
      (candidate.positionIds.length === 0 && candidate.intentIds.length === 1);
    (adoptable ? report.adoptable : report.ambiguous).push(candidate);
    if (!apply || !adoptable) continue;
    const claim = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${candidate.tradingAccountId}:${candidate.securityId}`}, 0))::text`;
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
          lastDiagnosedAt: new Date(),
          events: {
            create: {
              eventType: 'OPERATOR_ROLLOUT_ADOPTION',
              evidenceJson: {
                positionId, intentId, symbol: candidate.symbol,
                attribution: positionId ? 'LEGACY_OPEN_POSITION_PROTECTED_UNKNOWN_ENTRY_PROVENANCE' : 'LEGACY_INTENT_UNRESOLVED',
                executionAuthority: 'NONE',
              },
            },
          },
        },
      });
    });
    report.adopted.push(claim.id);
    if (claim.trackedPositionId && candidate.positionIds.includes(claim.trackedPositionId)) {
      adoptedPositionIds.add(claim.trackedPositionId);
    }
  }
  report.ready = report.ambiguous.length === 0 && report.missingSecurity.length === 0 &&
    report.unclaimedActivePositions.every((position) => adoptedPositionIds.has(position.id)) &&
    report.unclaimedUnresolvedBuyIntents.length === 0 &&
    report.unclaimedActiveBrokerBuys.length === 0 && report.unresolvedClaims.length === 0 &&
    report.strandedClaims.length === 0;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 2;
}

main().finally(() => prisma.$disconnect());
