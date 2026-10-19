import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { getCompleteOpenAlpacaBuyOrders } from '../integrations/alpaca/orders.adapter.js';
import { getAlpacaPositions } from '../integrations/alpaca/positions.adapter.js';
import { BROKER_ACTIVE_ENTRY_STATUSES, TERMINAL_ENTRY_ORDER_STATUSES, UNRESOLVED_ORDER_INTENT_STATUSES } from './entry-lifecycle-status.service.js';
import { describeUnreleasedTerminalEntryClaims } from './entry-dispatch-recovery.service.js';

type Db = PrismaClient;

export type EntryExposureReadinessReport = Awaited<ReturnType<typeof assessEntryExposureReadiness>>;

function key(accountId: number, securityId: number) {
  return `${accountId}:${securityId}`;
}

function canonical(value: string) {
  return value.trim().toUpperCase();
}

export async function assessEntryExposureReadiness(args: {
  apply?: boolean;
  db?: Db;
  now?: Date;
  tradingAccountIds?: number[] | undefined;
} = {}) {
  const db = args.db ?? prisma;
  const apply = args.apply ?? false;
  const now = args.now ?? new Date();
  const accountWhere = args.tradingAccountIds?.length ? { id: { in: args.tradingAccountIds } } : {};
  const exposureAccountWhere = args.tradingAccountIds?.length ? { tradingAccountId: { in: args.tradingAccountIds } } : {};
  const [accounts, securities, positions, intents, localBrokerOrders, allClaims] = await Promise.all([
    db.tradingAccount.findMany({ where: accountWhere, select: { id: true, environment: true, displayName: true }, orderBy: { id: 'asc' } }),
    db.security.findMany({ select: { id: true, symbol: true } }),
    db.trackedPosition.findMany({
      where: { status: { in: ['open', 'closing'] }, tradingAccountId: { not: null }, ...exposureAccountWhere },
      select: { id: true, tradingAccountId: true, securityId: true, symbol: true, status: true, entryExposureClaim: { select: { id: true } } },
    }),
    db.orderIntent.findMany({
      where: { side: 'buy', tradingAccountId: { not: null }, ...exposureAccountWhere },
      select: {
        id: true, tradingAccountId: true, symbol: true, status: true, blockReason: true, trackedPositionId: true,
        trackedPosition: { select: { id: true, status: true } },
        entryExposureClaim: { select: { id: true } },
        brokerOrders: { select: { id: true } },
        brokerActivities: { select: { id: true } },
      },
    }),
    db.brokerOrder.findMany({
      where: { side: { equals: 'buy', mode: 'insensitive' }, tradingAccountId: { not: null }, ...exposureAccountWhere },
      select: { id: true, orderIntentId: true, tradingAccountId: true, securityId: true, symbol: true, status: true, brokerOrderId: true,
        orderIntent: { select: { entryExposureClaim: { select: { id: true, tradingAccountId: true, securityId: true, orderIntentId: true, releasedAt: true } } } } },
    }),
    db.entryExposureClaim.findMany({
      where: { ...(args.tradingAccountIds?.length ? { tradingAccountId: { in: args.tradingAccountIds } } : {}) },
      select: {
        id: true, tradingAccountId: true, securityId: true, orderIntentId: true, trackedPositionId: true,
        status: true, releasedAt: true, updatedAt: true, trackedPosition: { select: { status: true } },
      },
      orderBy: { id: 'asc' },
    }),
  ]);
  const activeClaims = allClaims.filter((claim) => claim.releasedAt === null);

  const securityBySymbol = new Map(securities.map((security) => [canonical(security.symbol), security]));
  const brokerEvidenceUnavailable: Array<{ tradingAccountId: number; environment: string; error: string }> = [];
  const brokerPositions: Array<{ tradingAccountId: number; environment: string; symbol: string; qty: string }> = [];
  const brokerOpenBuys: Array<{ tradingAccountId: number; environment: string; id: string; symbol: string; status: string; clientOrderId: string }> = [];
  for (const account of accounts) {
    try {
      const [accountPositions, accountBuys] = await Promise.all([
        getAlpacaPositions(account.id, 'reconciliation_check'),
        getCompleteOpenAlpacaBuyOrders(account.id, 'reconciliation_check'),
      ]);
      brokerPositions.push(...accountPositions.map((position) => ({
        tradingAccountId: account.id, environment: account.environment, symbol: canonical(position.symbol), qty: position.qty,
      })));
      brokerOpenBuys.push(...accountBuys.map((order) => ({
        tradingAccountId: account.id, environment: account.environment, id: order.id,
        symbol: canonical(order.symbol), status: order.status, clientOrderId: order.client_order_id,
      })));
    } catch (error) {
      brokerEvidenceUnavailable.push({
        tradingAccountId: account.id,
        environment: account.environment,
        error: error instanceof Error ? error.message : 'Broker readiness evidence failed.',
      });
    }
  }

  const localActivePositions = positions.filter((position) => ['open', 'closing'].includes(position.status));
  const claimedPositionIds = new Set(activeClaims.map((claim) => claim.trackedPositionId).filter((id): id is number => id != null));
  const unclaimedActivePositions = localActivePositions.filter((position) => !claimedPositionIds.has(position.id));
  const brokerPositionKeys = new Set(brokerPositions.flatMap((position) => {
    const security = securityBySymbol.get(position.symbol);
    return security ? [key(position.tradingAccountId, security.id)] : [];
  }));
  const localPositionKeys = new Set(localActivePositions.map((position) => key(position.tradingAccountId!, position.securityId)));
  const brokerOnlyPositions = brokerPositions.filter((position) => {
    const security = securityBySymbol.get(position.symbol);
    return !security || !localPositionKeys.has(key(position.tradingAccountId, security.id));
  });
  const localOnlyPositions = localActivePositions.filter((position) => !brokerPositionKeys.has(key(position.tradingAccountId!, position.securityId)));

  const activeClaimIntentIds = new Set(activeClaims.map((claim) => claim.orderIntentId).filter((id): id is number => id != null));
  const hasOutstandingBrokerExposure = (tradingAccountId: number, symbol: string) =>
    brokerPositions.some((position) => position.tradingAccountId === tradingAccountId && position.symbol === canonical(symbol)) ||
    brokerOpenBuys.some((order) => order.tradingAccountId === tradingAccountId && order.symbol === canonical(symbol));
  // Terminal (failed, blocked, ...) entries whose claims are still held, including consumed or recorded
  // dispatches, stay visible here even though stale recovery only selects 'submitting' intents.
  const terminalIntentsWithUnreleasedClaims = await describeUnreleasedTerminalEntryClaims({
    db, tradingAccountIds: args.tradingAccountIds, now, brokerExposure: hasOutstandingBrokerExposure,
  });
  const historicalFilledIntents = intents.filter((intent) => intent.status.toLowerCase() === 'filled' && (
    intent.trackedPosition?.status === 'closed' ||
    (intent.trackedPosition == null && !hasOutstandingBrokerExposure(intent.tradingAccountId!, intent.symbol)) ||
    (intent.trackedPosition != null && ['open', 'closing'].includes(intent.trackedPosition.status) && activeClaimIntentIds.has(intent.id))
  ));
  const historicalFilledIntentIds = new Set(historicalFilledIntents.map((intent) => intent.id));
  const unclaimedUnresolvedBuyIntents = intents.filter((intent) =>
    !activeClaimIntentIds.has(intent.id) && !historicalFilledIntentIds.has(intent.id) &&
    ((UNRESOLVED_ORDER_INTENT_STATUSES as readonly string[]).includes(intent.status) || intent.status.toLowerCase() === 'filled'));
  const localExecutableBrokerBuys = localBrokerOrders.filter((order) =>
    (BROKER_ACTIVE_ENTRY_STATUSES as readonly string[]).includes(order.status.toLowerCase()));
  const unclaimedActiveBrokerBuys = localExecutableBrokerBuys.filter((order) => {
    const claim = order.orderIntent.entryExposureClaim;
    return !claim || claim.releasedAt !== null || claim.tradingAccountId !== order.tradingAccountId ||
      claim.securityId !== order.securityId || claim.orderIntentId !== order.orderIntentId;
  });
  const brokerOnlyOpenBuys = brokerOpenBuys.filter((brokerOrder) => !localBrokerOrders.some((local) =>
    local.tradingAccountId === brokerOrder.tradingAccountId && local.brokerOrderId === brokerOrder.id));
  const brokerOpenBuysWithoutActiveClaim = brokerOpenBuys.filter((brokerOrder) => {
    const local = localBrokerOrders.find((order) => order.tradingAccountId === brokerOrder.tradingAccountId && order.brokerOrderId === brokerOrder.id);
    if (!local) return true;
    const claim = local.orderIntent.entryExposureClaim;
    const security = securityBySymbol.get(brokerOrder.symbol);
    return !claim || claim.releasedAt !== null || !security || claim.tradingAccountId !== brokerOrder.tradingAccountId ||
      claim.securityId !== security.id || claim.orderIntentId !== local.orderIntentId;
  });
  const staleLocalActiveBrokerBuys = localExecutableBrokerBuys.filter((local) =>
    !brokerOpenBuys.some((brokerOrder) =>
      brokerOrder.tradingAccountId === local.tradingAccountId && brokerOrder.id === local.brokerOrderId));
  const historicalTerminalEvidence = localBrokerOrders.filter((order) =>
    !order.orderIntent.entryExposureClaim && (TERMINAL_ENTRY_ORDER_STATUSES as readonly string[]).includes(order.status.toLowerCase()));
  const protectedLegacyOpenPositions = activeClaims.filter((claim) =>
    claim.trackedPositionId != null && claim.trackedPosition && ['open', 'closing'].includes(claim.trackedPosition.status));
  const protectedClaimIds = new Set(protectedLegacyOpenPositions.map((claim) => claim.id));
  const unresolvedClaims = activeClaims.filter((claim) => claim.status === 'UNRESOLVED' && !protectedClaimIds.has(claim.id));
  const strandedClaims = activeClaims.filter((claim) =>
    (!claim.orderIntentId && !claim.trackedPositionId) ||
    (['ENTRY_PENDING', 'ENTRY_SUBMITTING', 'ADMISSION_BLOCKED'].includes(claim.status) && now.getTime() - claim.updatedAt.getTime() > 15 * 60_000));
  const missingSecurity = [
    ...unclaimedUnresolvedBuyIntents.filter((intent) => !securityBySymbol.has(canonical(intent.symbol))).map((intent) => ({
      tradingAccountId: intent.tradingAccountId!, symbol: intent.symbol, source: 'ORDER_INTENT', sourceId: intent.id,
    })),
    ...brokerPositions.filter((position) => !securityBySymbol.has(position.symbol)).map((position) => ({
      tradingAccountId: position.tradingAccountId, symbol: position.symbol, source: 'BROKER_POSITION', sourceId: null,
    })),
    ...brokerOpenBuys.filter((order) => !securityBySymbol.has(order.symbol)).map((order) => ({
      tradingAccountId: order.tradingAccountId, symbol: order.symbol, source: 'BROKER_ORDER', sourceId: order.id,
    })),
  ];

  const adoptablePositions = unclaimedActivePositions.filter((position) =>
    brokerPositions.some((broker) => broker.tradingAccountId === position.tradingAccountId && broker.symbol === canonical(position.symbol)));
  const neverSubmittedIntents = unclaimedUnresolvedBuyIntents.filter((intent) =>
    ['received', 'pending'].includes(intent.status) && !intent.blockReason?.includes('DELIVERY_UNCERTAIN') &&
    intent.brokerOrders.length === 0 && intent.brokerActivities.length === 0 &&
    !brokerPositions.some((position) => position.tradingAccountId === intent.tradingAccountId && position.symbol === canonical(intent.symbol)) &&
    !brokerOpenBuys.some((order) => order.tradingAccountId === intent.tradingAccountId && order.symbol === canonical(intent.symbol)));

  if (apply && brokerEvidenceUnavailable.length === 0) {
    for (const position of adoptablePositions) {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${position.tradingAccountId}:${position.securityId}`}, 0))::text`;
        if (await tx.entryExposureClaim.findFirst({ where: { tradingAccountId: position.tradingAccountId!, securityId: position.securityId, releasedAt: null } })) return;
        await tx.entryExposureClaim.create({ data: {
          tradingAccountId: position.tradingAccountId!, securityId: position.securityId, trackedPositionId: position.id,
          ownerKey: `rollout-position:${position.tradingAccountId}:${position.id}`, status: 'POSITION_OPEN',
          events: { create: { eventType: 'OPERATOR_ROLLOUT_ADOPTION', evidenceJson: {
            trackedPositionId: position.id, symbol: canonical(position.symbol),
            attribution: 'LEGACY_OPEN_POSITION_PROTECTED_UNKNOWN_ENTRY_PROVENANCE', executionAuthority: 'NONE',
          } } },
        } });
      });
    }
    for (const intent of neverSubmittedIntents) {
      const security = securityBySymbol.get(canonical(intent.symbol));
      if (!security) continue;
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${intent.tradingAccountId}:${security.id}`}, 0))::text`;
        if (await tx.entryExposureClaim.findFirst({ where: { tradingAccountId: intent.tradingAccountId!, securityId: security.id, releasedAt: null } })) return;
        const transitioned = await tx.orderIntent.updateMany({
          where: { id: intent.id, status: { in: ['received', 'pending'] } },
          data: { status: 'blocked', blockReason: 'ROLLOUT_VERIFIED_NEVER_SUBMITTED' },
        });
        if (transitioned.count !== 1) return;
        const claim = await tx.entryExposureClaim.create({ data: {
          tradingAccountId: intent.tradingAccountId!, securityId: security.id, orderIntentId: intent.id,
          ownerKey: `rollout-intent:${intent.tradingAccountId}:${intent.id}`, status: 'ADMISSION_BLOCKED',
          events: { create: { eventType: 'OPERATOR_ROLLOUT_NEVER_SUBMITTED_VERIFIED', evidenceJson: {
            orderIntentId: intent.id, symbol: canonical(intent.symbol), brokerPosition: null,
            executableBrokerBuyOrders: [], localBrokerOrders: 0, localBrokerActivities: 0,
          } } },
        } });
        const releasedAt = new Date();
        await tx.entryExposureClaim.update({ where: { id: claim.id }, data: {
          status: 'RELEASED', releasedAt, releaseReason: 'ROLLOUT_VERIFIED_NEVER_SUBMITTED',
          events: { create: { eventType: 'RELEASED_NO_BROKER_EXPOSURE', evidenceJson: { source: 'ROLLOUT_READINESS' } } },
        } });
      });
    }
    return assessEntryExposureReadiness({ apply: false, db, now, tradingAccountIds: args.tradingAccountIds });
  }

  const databaseBlockers = {
    missingSecurity,
    unclaimedActivePositions,
    unclaimedUnresolvedBuyIntents,
    unclaimedActiveBrokerBuys,
    unresolvedClaims,
    strandedClaims,
    terminalIntentsWithUnreleasedClaims,
  };
  const brokerBlockers = { brokerEvidenceUnavailable, brokerOnlyPositions, localOnlyPositions, brokerOnlyOpenBuys, brokerOpenBuysWithoutActiveClaim, staleLocalActiveBrokerBuys };
  const databaseReady = Object.values(databaseBlockers).every((items) => items.length === 0);
  const brokerVerifiedReady = Object.values(brokerBlockers).every((items) => items.length === 0);
  return {
    mode: apply ? 'APPLY' : 'DRY_RUN',
    assessment: brokerEvidenceUnavailable.length ? 'BROKER_EVIDENCE_UNAVAILABLE' : databaseReady && brokerVerifiedReady ? 'BROKER_VERIFIED_READY' : 'BLOCKED',
    ready: databaseReady && brokerVerifiedReady,
    databaseReady,
    brokerVerifiedReady,
    accounts: accounts.map((account) => ({ id: account.id, environment: account.environment, displayName: account.displayName })),
    ...databaseBlockers,
    ...brokerBlockers,
    protectedLegacyOpenPositions,
    historicalTerminalEvidence,
    historicalFilledIntents,
    adoptablePositions,
    neverSubmittedIntents,
    brokerPositions,
    brokerOpenBuys,
  };
}
