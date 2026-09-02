import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { parseSubscriptionKeyFromClientOrderId } from './client-order-id.service.js';
import { linkEntryDecisionToTrackedPosition } from './entry-decision.service.js';
import {
  attributionEvidenceJson,
  resolveExactBrokerOrderAttribution,
  type AttributionBrokerLookupPolicy,
} from './attribution-evidence-resolver.service.js';

export type SubscriptionResolutionSource =
  | 'local_order_intent'
  | 'broker_client_order_id'
  | 'unique_observer_fallback'
  | 'unresolved'
  | 'ambiguous';

export type SubscriptionResolutionResult =
  | {
      status: 'resolved';
      source: Exclude<
        SubscriptionResolutionSource,
        'unresolved' | 'ambiguous'
      >;
      subscriptionId: number;
      subscriptionKey: string;
      tradingAccountSubscriptionId: number;
      reason: string;
      evidence: Prisma.InputJsonValue;
    }
  | {
      status: 'unresolved' | 'ambiguous';
      source: 'unresolved' | 'ambiguous';
      subscriptionId: null;
      subscriptionKey: null;
      tradingAccountSubscriptionId: null;
      reason: string;
      evidence: Prisma.InputJsonValue;
    };

const ENTRY_INTENT_LOOKBACK_MINUTES = 12 * 60;

function minutesBefore(date: Date, minutes: number) {
  return new Date(date.getTime() - minutes * 60_000);
}

function getOpenFillSide(positionSide: string): 'buy' | 'sell' {
  return positionSide.toLowerCase() === 'short' ? 'sell' : 'buy';
}

function normalizeSymbol(symbol: string) {
  return symbol.trim().toUpperCase();
}

function isCompatibleSubscription(subscription: {
  symbol: string;
  enabled: boolean;
  strategy?: { enabled: boolean } | null;
  exitProfile?: { enabled: boolean } | null;
}, args: {
  symbol: string;
}) {
  return (
    normalizeSymbol(subscription.symbol) === normalizeSymbol(args.symbol) &&
    subscription.enabled &&
    subscription.strategy?.enabled !== false &&
    subscription.exitProfile?.enabled !== false
  );
}

async function findLocalOpeningOrderIntent(args: {
  tradingAccountId: number;
  broker: string;
  symbol: string;
  side: string;
  openedAt: Date;
}) {
  const entrySide = getOpenFillSide(args.side);

  const candidates = await prisma.orderIntent.findMany({
    where: {
      symbol: normalizeSymbol(args.symbol),
      tradingAccountId: args.tradingAccountId,
      side: entrySide,
      subscriptionId: { not: null },
      tradingAccountSubscriptionId: { not: null },
      tradingAccountSubscription: {
        is: {
          tradingAccountId: args.tradingAccountId,
          enabled: true,
        },
      },
      blockReason: null,
      createdAt: {
        gte: minutesBefore(args.openedAt, ENTRY_INTENT_LOOKBACK_MINUTES),
      },
      OR: [
        { trackedPositionId: null },
        { trackedPosition: { is: { status: { not: 'closed' } } } },
      ],
      brokerOrders: {
        some: {
          broker: args.broker,
          tradingAccountId: args.tradingAccountId,
          side: entrySide,
          OR: [
            { trackedPositionId: null },
            { trackedPosition: { is: { status: { not: 'closed' } } } },
          ],
        },
      },
    },
    include: {
      subscription: {
        include: {
          strategy: true,
          exitProfile: true,
        },
      },
      tradingAccountSubscription: true,
      brokerOrders: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: 2,
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

function extractClientOrderIdFromRawBrokerJson(value: Prisma.JsonValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const clientOrderId = raw.client_order_id ?? raw.clientOrderId;

  return typeof clientOrderId === 'string' ? clientOrderId : null;
}

async function resolveFromBrokerClientOrderId(args: {
  tradingAccountId: number;
  broker: string;
  symbol: string;
  side: string;
  openedAt: Date;
  mode: string;
}) {
  const entrySide = getOpenFillSide(args.side);
  const activities = await prisma.brokerActivity.findMany({
    where: {
      broker: args.broker,
      tradingAccountId: args.tradingAccountId,
      mode: args.mode,
      activityType: 'FILL',
      symbol: normalizeSymbol(args.symbol),
      side: entrySide,
      transactionTime: {
        gte: minutesBefore(args.openedAt, ENTRY_INTENT_LOOKBACK_MINUTES),
      },
    },
    include: {
      brokerOrderRecord: true,
    },
    orderBy: {
      transactionTime: 'desc',
    },
  });

  const subscriptionKeys = new Set<string>();
  const clientOrderIds: string[] = [];

  for (const activity of activities) {
    const clientOrderId =
      activity.brokerOrderRecord?.clientOrderId ??
      extractClientOrderIdFromRawBrokerJson(activity.rawBrokerJson);

    if (!clientOrderId) {
      continue;
    }

    clientOrderIds.push(clientOrderId);
    const subscriptionKey = parseSubscriptionKeyFromClientOrderId(clientOrderId);

    if (subscriptionKey) {
      subscriptionKeys.add(subscriptionKey);
    }
  }

  if (subscriptionKeys.size === 0) {
    return null;
  }

  if (subscriptionKeys.size > 1) {
    return {
      status: 'ambiguous' as const,
      source: 'ambiguous' as const,
      subscriptionId: null,
      subscriptionKey: null,
      tradingAccountSubscriptionId: null,
      reason: 'multiple_broker_client_order_subscription_keys',
      evidence: {
        clientOrderIds,
        subscriptionKeys: Array.from(subscriptionKeys),
      } as Prisma.InputJsonValue,
    };
  }

  const subscriptionKey = Array.from(subscriptionKeys)[0]!;
  const subscription = await prisma.subscription.findFirst({
    where: {
      key: subscriptionKey,
      accountSubscriptions: {
        some: {
          tradingAccountId: args.tradingAccountId,
          enabled: true,
        },
      },
    },
    include: {
      strategy: true,
      exitProfile: true,
      accountSubscriptions: {
        where: { tradingAccountId: args.tradingAccountId },
        select: { id: true },
      },
    },
  });

  if (
    !subscription ||
    !isCompatibleSubscription(subscription, {
      symbol: args.symbol,
    })
  ) {
    return {
      status: 'unresolved' as const,
      source: 'unresolved' as const,
      subscriptionId: null,
      subscriptionKey: null,
      tradingAccountSubscriptionId: null,
      reason: 'broker_client_order_subscription_key_not_eligible',
      evidence: {
        subscriptionKey,
        clientOrderIds,
      } as Prisma.InputJsonValue,
    };
  }

  return {
    status: 'resolved' as const,
    source: 'broker_client_order_id' as const,
    subscriptionId: subscription.id,
    subscriptionKey: subscription.key,
    tradingAccountSubscriptionId: subscription.accountSubscriptions[0]!.id,
    reason: 'broker_client_order_subscription_key',
    evidence: {
      subscriptionKey,
      clientOrderIds,
    } as Prisma.InputJsonValue,
  };
}

async function resolveFromUniqueObserverFallback(args: {
  tradingAccountId: number;
  broker: string;
  symbol: string;
  mode: string;
}) {
  const candidates = await prisma.subscription.findMany({
    where: {
      symbol: normalizeSymbol(args.symbol),
      enabled: true,
      accountSubscriptions: {
        some: {
          tradingAccountId: args.tradingAccountId,
          enabled: true,
        },
      },
      strategy: {
        enabled: true,
      },
      exitProfile: {
        enabled: true,
      },
    },
    include: {
      strategy: true,
      exitProfile: true,
      accountSubscriptions: {
        where: { tradingAccountId: args.tradingAccountId },
        select: { id: true },
      },
    },
    orderBy: {
      id: 'asc',
    },
  });

  if (candidates.length === 0) {
    return {
      status: 'unresolved' as const,
      source: 'unresolved' as const,
      subscriptionId: null,
      subscriptionKey: null,
      tradingAccountSubscriptionId: null,
      reason: 'no_eligible_subscription_for_observed_position',
      evidence: {
        broker: args.broker,
        mode: args.mode,
        symbol: normalizeSymbol(args.symbol),
      } as Prisma.InputJsonValue,
    };
  }

  if (candidates.length > 1) {
    return {
      status: 'ambiguous' as const,
      source: 'ambiguous' as const,
      subscriptionId: null,
      subscriptionKey: null,
      tradingAccountSubscriptionId: null,
      reason: 'multiple_eligible_subscriptions_for_observed_position',
      evidence: {
        broker: args.broker,
        mode: args.mode,
        symbol: normalizeSymbol(args.symbol),
        candidateSubscriptionKeys: candidates.map((candidate) => candidate.key),
        candidateSubscriptionIds: candidates.map((candidate) => candidate.id),
      } as Prisma.InputJsonValue,
    };
  }

  const subscription = candidates[0]!;

  return {
    status: 'resolved' as const,
    source: 'unique_observer_fallback' as const,
    subscriptionId: subscription.id,
    subscriptionKey: subscription.key,
    tradingAccountSubscriptionId: subscription.accountSubscriptions[0]!.id,
    reason: 'single_eligible_subscription_for_observed_position',
    evidence: {
      broker: args.broker,
      mode: args.mode,
      symbol: normalizeSymbol(args.symbol),
    } as Prisma.InputJsonValue,
  };
}

export async function resolveTrackedPositionSubscription(args: {
  tradingAccountId: number;
  broker: string;
  symbol: string;
  side: string;
  openedAt: Date;
  qty?: number;
  avgEntryPrice?: number;
  brokerLookupPolicy?: AttributionBrokerLookupPolicy;
}): Promise<SubscriptionResolutionResult> {
  const account = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: args.tradingAccountId },
    select: { environment: true },
  });
  const mode = account.environment.toLowerCase();

  const localIntent = await findLocalOpeningOrderIntent({
    tradingAccountId: args.tradingAccountId,
    broker: args.broker,
    symbol: args.symbol,
    side: args.side,
    openedAt: args.openedAt,
  });

  if (
    localIntent?.subscriptionId &&
    localIntent.subscription &&
    localIntent.tradingAccountSubscription &&
    localIntent.tradingAccountSubscription.tradingAccountId ===
      args.tradingAccountId &&
    localIntent.tradingAccountSubscription.subscriptionId ===
      localIntent.subscriptionId &&
    isCompatibleSubscription(localIntent.subscription, {
      symbol: args.symbol,
    })
  ) {
    return {
      status: 'resolved',
      source: 'local_order_intent',
      subscriptionId: localIntent.subscriptionId,
      subscriptionKey: localIntent.subscription.key,
      tradingAccountSubscriptionId:
        localIntent.tradingAccountSubscription.id,
      reason: 'local_order_intent_with_broker_order',
      evidence: {
        orderIntentId: localIntent.id,
        clientOrderId: localIntent.clientOrderId,
        tradingAccountSubscriptionId:
          localIntent.tradingAccountSubscriptionId,
        brokerOrderIds: localIntent.brokerOrders.map((order) => order.id),
      } as Prisma.InputJsonValue,
    };
  }

  const brokerClientOrderResolution = await resolveFromBrokerClientOrderId({
    tradingAccountId: args.tradingAccountId,
    broker: args.broker,
    symbol: args.symbol,
    side: args.side,
    openedAt: args.openedAt,
    mode,
  });

  if (brokerClientOrderResolution) {
    return brokerClientOrderResolution;
  }

  if (args.qty !== undefined && args.avgEntryPrice !== undefined) {
    const exact = await resolveExactBrokerOrderAttribution({
      tradingAccountId: args.tradingAccountId,
      broker: args.broker,
      symbol: args.symbol,
      side: args.side,
      qty: args.qty,
      avgEntryPrice: args.avgEntryPrice,
      openedAt: args.openedAt,
      mode,
      policy: args.brokerLookupPolicy ?? 'LOCAL_ONLY',
    });
    if (exact) {
      if (exact.confidence === 'DETERMINISTIC' && exact.assignment) {
        return {
          status: 'resolved', source: 'broker_client_order_id',
          subscriptionId: exact.assignment.subscriptionId,
          subscriptionKey: exact.assignment.subscriptionKey,
          tradingAccountSubscriptionId: exact.assignment.id,
          reason: exact.reason,
          evidence: attributionEvidenceJson(exact),
        };
      }
      return {
        status: exact.confidence === 'AMBIGUOUS' ? 'ambiguous' : 'unresolved',
        source: exact.confidence === 'AMBIGUOUS' ? 'ambiguous' : 'unresolved',
        subscriptionId: null, subscriptionKey: null,
        tradingAccountSubscriptionId: null,
        reason: exact.reason,
        evidence: attributionEvidenceJson(exact),
      };
    }
  }

  return resolveFromUniqueObserverFallback({
    tradingAccountId: args.tradingAccountId,
    broker: args.broker,
    symbol: args.symbol,
    mode,
  });
}

export async function linkLocalEntryOwnership(args: {
  trackedPositionId: number;
  tradingAccountId: number;
  broker: string;
  symbol: string;
  side: string;
  openedAt: Date;
  expectedSubscriptionId?: number;
  expectedTradingAccountSubscriptionId?: number;
}) {
  const intent = await findLocalOpeningOrderIntent({
    ...args,
  });

  if (!intent) {
    return false;
  }

  if (
    args.expectedSubscriptionId !== undefined &&
    intent.subscriptionId !== args.expectedSubscriptionId
  ) return false;
  if (
    args.expectedTradingAccountSubscriptionId !== undefined &&
    intent.tradingAccountSubscriptionId !== args.expectedTradingAccountSubscriptionId
  ) return false;

  const linkedAt = new Date();
  const linked = await prisma.$transaction(async (tx) => {
    const conflicts = await Promise.all([
      tx.orderIntent.count({ where: { id: intent.id, trackedPositionId: { not: null }, NOT: { trackedPositionId: args.trackedPositionId } } }),
      tx.brokerOrder.count({ where: { orderIntentId: intent.id, tradingAccountId: args.tradingAccountId, trackedPositionId: { not: null }, NOT: { trackedPositionId: args.trackedPositionId } } }),
      tx.brokerActivity.count({ where: { orderIntentId: intent.id, tradingAccountId: args.tradingAccountId, activityType: 'FILL', trackedPositionId: { not: null }, NOT: { trackedPositionId: args.trackedPositionId } } }),
    ]);
    if (conflicts.some(Boolean)) return false;
    await tx.trackedPosition.updateMany({
      where: {
        id: args.trackedPositionId,
        tradingAccountId: args.tradingAccountId,
        OR: [
          { subscriptionId: null },
          { subscriptionId: intent.subscriptionId },
        ],
      },
      data: {
        subscriptionId: intent.subscriptionId,
        ...(intent.tradingAccountSubscriptionId !== null && {
          tradingAccountSubscriptionId: intent.tradingAccountSubscriptionId,
        }),
      },
    });
    await tx.orderIntent.updateMany({
      where: {
        id: intent.id,
        tradingAccountId: args.tradingAccountId,
        trackedPositionId: null,
      },
      data: {
        trackedPositionId: args.trackedPositionId,
      },
    });

    if (intent.tradingAccountSubscriptionId !== null) {
      await tx.trackedPosition.updateMany({
        where: {
          id: args.trackedPositionId,
          tradingAccountId: args.tradingAccountId,
          tradingAccountSubscriptionId: null,
        },
        data: {
          tradingAccountSubscriptionId: intent.tradingAccountSubscriptionId,
        },
      });
    }

    await tx.brokerOrder.updateMany({
      where: {
        orderIntentId: intent.id,
        tradingAccountId: args.tradingAccountId,
        trackedPositionId: null,
      },
      data: {
        trackedPositionId: args.trackedPositionId,
      },
    });

    await tx.brokerActivity.updateMany({
      where: {
        orderIntentId: intent.id,
        tradingAccountId: args.tradingAccountId,
        activityType: 'FILL',
        brokerOrderRecordId: {
          in: intent.brokerOrders.map((order) => order.id),
        },
        trackedPositionId: null,
      },
      data: {
        trackedPositionId: args.trackedPositionId,
        trackedPositionLinkSource: 'broker_order',
        trackedPositionLinkedAt: linkedAt,
      },
    });
    return true;
  });

  if (!linked) return false;

  await linkEntryDecisionToTrackedPosition({
    orderIntentId: intent.id,
    trackedPositionId: args.trackedPositionId,
    tradingAccountId: intent.tradingAccountId,
    tradingAccountSubscriptionId: intent.tradingAccountSubscriptionId,
  });
  return true;
}
