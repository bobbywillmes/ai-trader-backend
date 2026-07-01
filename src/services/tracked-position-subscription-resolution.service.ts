import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { getRuntimeTradingConfig } from './config.service.js';
import { parseSubscriptionKeyFromClientOrderId } from './client-order-id.service.js';
import { linkEntryDecisionToTrackedPosition } from './entry-decision.service.js';
import { resolveDefaultTradingAccountId } from './trading-account.service.js';

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
      reason: string;
      evidence: Prisma.InputJsonValue;
    }
  | {
      status: 'unresolved' | 'ambiguous';
      source: 'unresolved' | 'ambiguous';
      subscriptionId: null;
      subscriptionKey: null;
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

function getModeFromRuntimeConfig(config: { paperMode: boolean }) {
  return config.paperMode ? 'paper' : 'live';
}

function isCompatibleSubscription(subscription: {
  symbol: string;
  broker: string;
  brokerMode: string;
  enabled: boolean;
  strategy?: { enabled: boolean } | null;
  exitProfile?: { enabled: boolean } | null;
}, args: {
  symbol: string;
  broker: string;
  mode: string;
}) {
  return (
    normalizeSymbol(subscription.symbol) === normalizeSymbol(args.symbol) &&
    subscription.broker.toLowerCase() === args.broker.toLowerCase() &&
    subscription.brokerMode.toLowerCase() === args.mode.toLowerCase() &&
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

  return prisma.orderIntent.findFirst({
    where: {
      symbol: normalizeSymbol(args.symbol),
      tradingAccountId: args.tradingAccountId,
      side: entrySide,
      subscriptionId: { not: null },
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
      brokerOrders: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
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
      tradingAccountId: args.tradingAccountId,
    },
    include: {
      strategy: true,
      exitProfile: true,
    },
  });

  if (
    !subscription ||
    !isCompatibleSubscription(subscription, {
      broker: args.broker,
      symbol: args.symbol,
      mode: args.mode,
    })
  ) {
    return {
      status: 'unresolved' as const,
      source: 'unresolved' as const,
      subscriptionId: null,
      subscriptionKey: null,
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
      tradingAccountId: args.tradingAccountId,
      broker: args.broker,
      brokerMode: args.mode,
      enabled: true,
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
    reason: 'single_eligible_subscription_for_observed_position',
    evidence: {
      broker: args.broker,
      mode: args.mode,
      symbol: normalizeSymbol(args.symbol),
    } as Prisma.InputJsonValue,
  };
}

export async function resolveTrackedPositionSubscription(args: {
  broker: string;
  symbol: string;
  side: string;
  openedAt: Date;
}): Promise<SubscriptionResolutionResult> {
  const runtimeConfig = await getRuntimeTradingConfig();
  const tradingAccountId = await resolveDefaultTradingAccountId();
  const mode = getModeFromRuntimeConfig(runtimeConfig);

  const localIntent = await findLocalOpeningOrderIntent({
    tradingAccountId,
    broker: args.broker,
    symbol: args.symbol,
    side: args.side,
    openedAt: args.openedAt,
  });

  if (
    localIntent?.subscriptionId &&
    localIntent.subscription &&
    isCompatibleSubscription(localIntent.subscription, {
      broker: args.broker,
      symbol: args.symbol,
      mode,
    })
  ) {
    return {
      status: 'resolved',
      source: 'local_order_intent',
      subscriptionId: localIntent.subscriptionId,
      subscriptionKey: localIntent.subscription.key,
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
    tradingAccountId,
    broker: args.broker,
    symbol: args.symbol,
    side: args.side,
    openedAt: args.openedAt,
    mode,
  });

  if (brokerClientOrderResolution) {
    return brokerClientOrderResolution;
  }

  return resolveFromUniqueObserverFallback({
    tradingAccountId,
    broker: args.broker,
    symbol: args.symbol,
    mode,
  });
}

export async function linkLocalEntryOwnership(args: {
  trackedPositionId: number;
  broker: string;
  symbol: string;
  side: string;
  openedAt: Date;
}) {
  const tradingAccountId = await resolveDefaultTradingAccountId();
  const intent = await findLocalOpeningOrderIntent({
    ...args,
    tradingAccountId,
  });

  if (!intent) {
    return;
  }

  await prisma.orderIntent.updateMany({
    where: {
      id: intent.id,
      trackedPositionId: null,
    },
    data: {
      trackedPositionId: args.trackedPositionId,
    },
  });

  if (intent.tradingAccountSubscriptionId !== null) {
    await prisma.trackedPosition.updateMany({
      where: {
        id: args.trackedPositionId,
        tradingAccountSubscriptionId: null,
      },
      data: {
        tradingAccountSubscriptionId: intent.tradingAccountSubscriptionId,
      },
    });
  }

  await prisma.brokerOrder.updateMany({
    where: {
      orderIntentId: intent.id,
      trackedPositionId: null,
    },
    data: {
      trackedPositionId: args.trackedPositionId,
    },
  });

  await linkEntryDecisionToTrackedPosition({
    orderIntentId: intent.id,
    trackedPositionId: args.trackedPositionId,
    tradingAccountId: intent.tradingAccountId,
    tradingAccountSubscriptionId: intent.tradingAccountSubscriptionId,
  });
}
