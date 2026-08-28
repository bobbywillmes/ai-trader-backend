import {
  Prisma,
  SystemEventSeverity,
  type Prisma as PrismaTypes,
} from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import type { AlpacaOrder } from '../integrations/alpaca/alpaca.types.js';
import {
  getAlpacaOrderByClientOrderId,
  placeAlpacaOrder,
} from '../integrations/alpaca/orders.adapter.js';
import { createSystemEvent } from './system-event.service.js';
import {
  ensurePositionExitState,
  markTrailingStopOrderSubmitted,
} from './position-exit-state.service.js';
import { adaptivePollingCoordinator } from './adaptive-polling.service.js';
import {
  BrokerWriteDeliveryError,
  type BrokerWriteDeliveryClassification,
} from '../errors/broker-write-delivery-error.js';

const TRAILING_STOP_TIME_IN_FORCE = 'gtc' as const;
export const PROTECTIVE_SUBMISSION_RECOVERY_BACKOFF_MS = 30_000;
const DELIVERY_PREFIX = 'BROKER_WRITE_DELIVERY';

function getDeliveryClassification(blockReason: string | null) {
  return blockReason?.match(
    /BROKER_WRITE_DELIVERY:(NOT_SENT_RETRYABLE|NOT_SENT_BLOCKED|BROKER_REJECTED|DELIVERY_UNCERTAIN)/
  )?.[1] as BrokerWriteDeliveryClassification | undefined;
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown protective write error.';
}

async function recordTrailingStopSubmissionUncertain(args: {
  tradingAccountId: number;
  environment: 'PAPER' | 'LIVE';
  trackedPositionId: number;
  orderIntentId: number;
  securityId: number;
  symbol: string;
  clientOrderId: string;
  error: unknown;
}) {
  await createSystemEvent({
    type: 'exit.trailing_stop_submission_uncertain',
    entityType: 'trackedPosition',
    entityId: args.trackedPositionId,
    tradingAccountId: args.tradingAccountId,
    severity: args.environment === 'LIVE'
      ? SystemEventSeverity.CRITICAL
      : SystemEventSeverity.ERROR,
    message: `${args.symbol} trailing-stop submission delivery is uncertain.`,
    payloadJson: {
      environment: args.environment,
      deploymentRole: env.LIVE_WRITE_DEPLOYMENT_ROLE,
      authoritativeProductionExecutor:
        env.NODE_ENV === 'production' &&
        env.LIVE_WRITE_DEPLOYMENT_ROLE === 'PRODUCTION_EXECUTOR',
      trackedPositionId: args.trackedPositionId,
      orderIntentId: args.orderIntentId,
      securityId: args.securityId,
      symbol: args.symbol,
      clientOrderId: args.clientOrderId,
      deliveryClassification: 'DELIVERY_UNCERTAIN',
      error: safeError(args.error),
      observedAt: new Date().toISOString(),
    } as Prisma.InputJsonValue,
  });
}

function compactDate(date: Date) {
  return date
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
}

function buildTrailingStopClientOrderId(args: {
  symbol: string;
  trackedPositionId: number;
  targetUnlockedAt: Date;
}) {
  return [
    'ai',
    'exit',
    'trail',
    args.symbol.toUpperCase(),
    args.trackedPositionId,
    compactDate(args.targetUnlockedAt),
  ]
    .join('-')
    .slice(0, 128);
}

function getWholeShareQty(qty: number) {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`Invalid trailing stop quantity: ${qty}`);
  }

  if (!Number.isInteger(qty)) {
    throw new Error(
      `Broker-native trailing stop exits require a whole-share quantity. Received qty=${qty}.`
    );
  }

  return String(qty);
}

async function persistTrailingStopOrder(args: {
  tradingAccountId: number;
  trackedPositionId: number;
  clientOrderId: string;
  order: AlpacaOrder;
}) {
  const position = await prisma.trackedPosition.findUnique({
    where: { id: args.trackedPositionId },
    include: {
      subscription: true,
      exitState: true,
      tradingAccountSubscription: true,
      tradingAccount: { select: { environment: true } },
    },
  });

  if (!position) {
    throw new Error(`Tracked position ${args.trackedPositionId} was not found.`);
  }
  if (
    position.tradingAccountId !== args.tradingAccountId ||
    !position.tradingAccountSubscription ||
    position.tradingAccountSubscription.tradingAccountId !==
      args.tradingAccountId ||
    position.tradingAccountSubscription.subscriptionId !==
      position.subscriptionId
  ) {
    throw new Error(
      `TrackedPosition ${position.id} has missing or inconsistent account attribution; refusing trailing-stop persistence.`
    );
  }
  const assignment = position.tradingAccountSubscription;
  const tradingAccountId = args.tradingAccountId;
  const side = position.side === 'short' ? 'buy' : 'sell';

  const existingIntent = await prisma.orderIntent.findFirst({
    where: {
      tradingAccountId,
      clientOrderId: args.clientOrderId,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (
    existingIntent &&
    existingIntent.trackedPositionId !== position.id
  ) {
    throw new Error(
      `Protective OrderIntent ${existingIntent.id} belongs to a different tracked position.`
    );
  }

  const orderIntent =
    existingIntent ??
    (await prisma.orderIntent.create({
      data: {
        source: 'exit-evaluator',
        symbol: position.symbol,
        side,
        orderType: 'trailing_stop',
        timeInForce: TRAILING_STOP_TIME_IN_FORCE,
        qty: position.qty,
        notional: null,
        limitPrice: null,
        extendedHours: false,
        clientOrderId: args.clientOrderId,
        tradingAccountId,
        tradingAccountSubscriptionId:
          position.tradingAccountSubscription.id,
        trackedPositionId: position.id,
        subscriptionId: position.subscriptionId,
        subscriptionKey: position.subscription?.key ?? null,
        status: 'submitted',
        rawRequestJson: {
          source: 'exit-evaluator',
          orderKind: 'target_unlock_trailing_stop',
          trackedPositionId: position.id,
          tradingAccountId,
          tradingAccountSubscriptionId:
            assignment.id,
          exitStateId: position.exitState?.id ?? null,
          trailPercent: position.exitState?.trailingStopPct ?? null,
          clientOrderId: args.clientOrderId,
        } as Prisma.InputJsonValue,
      },
    }));

  const existingBrokerOrderRecord = await prisma.brokerOrder.findFirst({
    where: {
      tradingAccountId,
      broker: 'alpaca',
      clientOrderId: args.clientOrderId,
    },
    select: { id: true },
  });
  const brokerOrderData = {
      orderIntentId: orderIntent.id,
      tradingAccountId,
      broker: 'alpaca',
      brokerOrderId: args.order.id,
      clientOrderId: args.clientOrderId,
      trackedPositionId: position.id,
      securityId: position.securityId,
      symbol: position.symbol,
      side,
      status: args.order.status,
      rawBrokerJson: args.order as unknown as Prisma.InputJsonValue,
  };
  if (existingBrokerOrderRecord) {
    await prisma.brokerOrder.update({
      where: { id: existingBrokerOrderRecord.id },
      data: brokerOrderData,
    });
  } else {
    await prisma.brokerOrder.create({ data: brokerOrderData });
  }

  await prisma.orderIntent.updateMany({
    where: { id: orderIntent.id },
    data: { status: 'submitted', blockReason: null },
  });

  await markTrailingStopOrderSubmitted({
    trackedPositionId: position.id,
    broker: 'alpaca',
    brokerOrderId: args.order.id,
    clientOrderId: args.clientOrderId,
    orderStatus: args.order.status,
    rawBrokerJson: args.order as unknown as Prisma.InputJsonValue,
  });
}

export async function submitTrailingStopExitOrder(
  tradingAccountId: number,
  trackedPositionId: number,
  now = new Date()
) {
  const position = await prisma.trackedPosition.findUnique({
    where: { id: trackedPositionId },
    include: {
      subscription: true,
      exitState: true,
      tradingAccountSubscription: true,
      tradingAccount: { select: { environment: true } },
    },
  });

  if (!position) {
    throw new Error(`Tracked position ${trackedPositionId} was not found.`);
  }
  if (position.tradingAccountId !== tradingAccountId) {
    throw new Error(
      `TrackedPosition ${position.id} does not belong to TradingAccount ${tradingAccountId}; refusing trailing-stop broker access.`
    );
  }
  if (
    !position.tradingAccountSubscription ||
    position.tradingAccountSubscription.tradingAccountId !== tradingAccountId ||
    position.tradingAccountSubscription.subscriptionId !== position.subscriptionId
  ) {
    throw new Error(
      `TrackedPosition ${position.id} has missing or inconsistent account assignment attribution.`
    );
  }
  const assignment = position.tradingAccountSubscription;

  const exitState =
    position.exitState ?? (await ensurePositionExitState(position.id));

  if (!exitState.targetUnlocked) {
    throw new Error(
      `Cannot submit trailing stop for ${position.symbol}; target has not been unlocked.`
    );
  }

  if (!exitState.targetUnlockedAt) {
    throw new Error(
      `Cannot submit trailing stop for ${position.symbol}; targetUnlockedAt is missing.`
    );
  }

  if (exitState.trailBrokerOrderId) {
    return {
      submitted: false,
      reason: 'already_submitted',
      brokerOrderId: exitState.trailBrokerOrderId,
      clientOrderId: exitState.trailClientOrderId,
    };
  }

  const trailingStopPct = exitState.trailingStopPct;

  if (trailingStopPct === null || trailingStopPct === undefined) {
    throw new Error(
      `Cannot submit trailing stop for ${position.symbol}; trailingStopPct is missing.`
    );
  }

  const qty = getWholeShareQty(position.qty);
  const clientOrderId = buildTrailingStopClientOrderId({
    symbol: position.symbol,
    trackedPositionId: position.id,
    targetUnlockedAt: exitState.targetUnlockedAt,
  });

  const existingBrokerOrder = await prisma.brokerOrder.findFirst({
    where: {
      tradingAccountId,
      broker: 'alpaca',
      clientOrderId,
    },
  });

  if (existingBrokerOrder) {
    await markTrailingStopOrderSubmitted({
      trackedPositionId: position.id,
      broker: 'alpaca',
      brokerOrderId: existingBrokerOrder.brokerOrderId,
      clientOrderId,
      orderStatus: existingBrokerOrder.status,
      rawBrokerJson: existingBrokerOrder.rawBrokerJson as Prisma.InputJsonValue,
    });

    return {
      submitted: false,
      reason: 'already_persisted',
      brokerOrderId: existingBrokerOrder.brokerOrderId,
      clientOrderId,
    };
  }

  const claim = await prisma.$transaction(
    async (tx) => {
      const existingIntent = await tx.orderIntent.findFirst({
        where: { tradingAccountId, clientOrderId },
        orderBy: { createdAt: 'desc' },
      });
      if (existingIntent) {
        if (existingIntent.trackedPositionId !== position.id) {
          throw new Error(
            `Protective OrderIntent ${existingIntent.id} belongs to a different tracked position.`
          );
        }
        return { intent: existingIntent, created: false };
      }

      const exitClaim = await tx.positionExitState.updateMany({
        where: {
          trackedPositionId: position.id,
          trailBrokerOrderId: null,
          trailClientOrderId: null,
        },
        data: {
          status: 'trailing_stop_submitting',
          trailBroker: 'alpaca',
          trailClientOrderId: clientOrderId,
          trailOrderStatus: 'pending_submit',
        },
      });
      if (exitClaim.count !== 1) {
        throw new Error(
          `Protective submission for TrackedPosition ${position.id} is already claimed.`
        );
      }

      const intent = await tx.orderIntent.create({
        data: {
          source: 'exit-evaluator',
          symbol: position.symbol,
          side: position.side === 'short' ? 'buy' : 'sell',
          orderType: 'trailing_stop',
          timeInForce: TRAILING_STOP_TIME_IN_FORCE,
          qty: position.qty,
          notional: null,
          limitPrice: null,
          extendedHours: false,
          clientOrderId,
          tradingAccountId,
          tradingAccountSubscriptionId:
            assignment.id,
          trackedPositionId: position.id,
          subscriptionId: position.subscriptionId,
          subscriptionKey: position.subscription?.key ?? null,
          status: 'submitting',
          rawRequestJson: {
            signalType: 'exit',
            source: 'exit-evaluator',
            orderKind: 'target_unlock_trailing_stop',
            trackedPositionId: position.id,
            tradingAccountId,
            tradingAccountSubscriptionId:
              assignment.id,
            exitStateId: exitState.id,
            trailPercent: trailingStopPct,
            clientOrderId,
          } as PrismaTypes.InputJsonValue,
        },
      });
      return { intent, created: true };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  const recordedClassification = getDeliveryClassification(
    claim.intent.blockReason
  );
  if (
    !claim.created &&
    now.getTime() - claim.intent.updatedAt.getTime() <
      PROTECTIVE_SUBMISSION_RECOVERY_BACKOFF_MS
  ) {
    return {
      submitted: false,
      reason: 'recovery_backoff',
      brokerOrderId: null,
      clientOrderId,
    };
  }

  const existingAlpacaOrder = await getAlpacaOrderByClientOrderId(
    tradingAccountId,
    clientOrderId,
    'protective_order_idempotency_check'
  );

  if (existingAlpacaOrder) {
    await persistTrailingStopOrder({
      tradingAccountId,
      trackedPositionId: position.id,
      clientOrderId,
      order: existingAlpacaOrder,
    });

    return {
      submitted: false,
      reason: 'already_at_broker',
      brokerOrderId: existingAlpacaOrder.id,
      clientOrderId,
    };
  }

  if (
    !claim.created &&
    (recordedClassification === 'DELIVERY_UNCERTAIN' ||
      recordedClassification === 'BROKER_REJECTED')
  ) {
    await prisma.orderIntent.updateMany({
      where: { id: claim.intent.id },
      data: {
        blockReason: `${DELIVERY_PREFIX}:${recordedClassification}:broker lookup remains inconclusive`,
      },
    });
    return {
      submitted: false,
      reason: 'recovery_inconclusive',
      brokerOrderId: null,
      clientOrderId,
    };
  }

  const payload = {
    symbol: position.symbol,
    side: position.side === 'short' ? 'buy' as const : 'sell' as const,
    type: 'trailing_stop' as const,
    time_in_force: TRAILING_STOP_TIME_IN_FORCE,
    qty,
    trail_percent: String(trailingStopPct),
    client_order_id: clientOrderId,
  };

  let created;
  try {
    created = await placeAlpacaOrder(
      tradingAccountId,
      payload,
      'protective_order_submission'
    );
  } catch (error) {
    let classification =
      error instanceof BrokerWriteDeliveryError
        ? error.classification
        : 'DELIVERY_UNCERTAIN';
    if (classification === 'BROKER_REJECTED') {
      let recovered = null;
      try {
        recovered = await getAlpacaOrderByClientOrderId(
          tradingAccountId,
          clientOrderId,
          'protective_order_idempotency_check'
        );
      } catch {
        classification = 'DELIVERY_UNCERTAIN';
      }
      if (recovered) {
        await persistTrailingStopOrder({
          tradingAccountId,
          trackedPositionId: position.id,
          clientOrderId,
          order: recovered,
        });
        return {
          submitted: false,
          reason: 'already_at_broker',
          brokerOrderId: recovered.id,
          clientOrderId,
        };
      }
    }
    await prisma.orderIntent.updateMany({
      where: { id: claim.intent.id },
      data: {
        status:
          classification === 'NOT_SENT_BLOCKED'
            ? 'blocked'
            : classification === 'NOT_SENT_RETRYABLE'
              ? 'failed'
              : 'submitting',
        blockReason: `${DELIVERY_PREFIX}:${classification}:${safeError(error)}`,
      },
    });
    if (classification === 'DELIVERY_UNCERTAIN') {
      await recordTrailingStopSubmissionUncertain({
        tradingAccountId,
        environment: position.tradingAccount!.environment,
        trackedPositionId: position.id,
        orderIntentId: claim.intent.id,
        securityId: position.securityId,
        symbol: position.symbol,
        clientOrderId,
        error,
      });
    }
    throw error;
  }

  adaptivePollingCoordinator.forceAfterBrokerOrderCreated(
    tradingAccountId,
    'protective_order_created'
  );

  try {
    await persistTrailingStopOrder({
      tradingAccountId,
      trackedPositionId: position.id,
      clientOrderId,
      order: created,
    });
  } catch (error) {
    await prisma.orderIntent.updateMany({
      where: { id: claim.intent.id },
      data: {
        status: 'submitting',
        blockReason: `${DELIVERY_PREFIX}:DELIVERY_UNCERTAIN:broker accepted before local persistence completed`,
      },
    });
    await recordTrailingStopSubmissionUncertain({
      tradingAccountId,
      environment: position.tradingAccount!.environment,
      trackedPositionId: position.id,
      orderIntentId: claim.intent.id,
      securityId: position.securityId,
      symbol: position.symbol,
      clientOrderId,
      error,
    });
    throw new BrokerWriteDeliveryError({
      classification: 'DELIVERY_UNCERTAIN',
      message:
        'Protective order was accepted but local persistence did not complete.',
      cause: error,
    });
  }

  await createSystemEvent({
    type: 'exit.trailing_stop_submitted',
    entityType: 'trackedPosition',
    entityId: position.id,
    tradingAccountId,
    severity: SystemEventSeverity.INFO,
    message: `${position.symbol} trailing stop exit order submitted after target unlock.`,
    payloadJson: {
      symbol: position.symbol,
      qty,
      trailingStopPct,
      clientOrderId,
      brokerOrderId: created.id,
      brokerStatus: created.status,
      timeInForce: TRAILING_STOP_TIME_IN_FORCE,
    } as Prisma.InputJsonValue,
  });

  return {
    submitted: true,
    brokerOrderId: created.id,
    clientOrderId,
  };
}
