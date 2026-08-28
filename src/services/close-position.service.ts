import {
  Prisma,
  SystemEventSeverity,
  type Prisma as PrismaTypes,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { placeAlpacaOrder } from '../integrations/alpaca/orders.adapter.js';
import { getAlpacaOrderByClientOrderId } from '../integrations/alpaca/orders.adapter.js';
import { HttpError } from '../errors/http-error.js';
import {
  BrokerWriteDeliveryError,
  type BrokerWriteDeliveryClassification,
} from '../errors/broker-write-delivery-error.js';
import { adaptivePollingCoordinator } from './adaptive-polling.service.js';
import { createSystemEvent } from './system-event.service.js';
import { NONTERMINAL_BROKER_ORDER_PRISMA_FILTER } from './broker-order-lifecycle-status.service.js';

export type ClosePositionMode = 'AUTOMATED_STRATEGY' | 'MANUAL_EMERGENCY_CLOSE';

type ClosePositionOptions = {
  mode?: ClosePositionMode;
};

function buildCloseClientOrderId(args: {
  tradingAccountId: number;
  trackedPositionId: number;
}) {
  return `ai-exit-close-${args.tradingAccountId}-${args.trackedPositionId}`.slice(
    0,
    128
  );
}

function sanitizeError(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown broker close error.';
}

const DELIVERY_CLASSIFICATION_PREFIX = 'BROKER_WRITE_DELIVERY';

function getDeliveryClassification(error: unknown): BrokerWriteDeliveryClassification {
  return error instanceof BrokerWriteDeliveryError
    ? error.classification
    : 'DELIVERY_UNCERTAIN';
}

export function closeFailureSeverity(args: {
  classification: BrokerWriteDeliveryClassification;
  environment: 'PAPER' | 'LIVE';
  hasVerifiedProtection: boolean;
}) {
  if (args.classification === 'DELIVERY_UNCERTAIN') {
    return args.environment === 'LIVE'
      ? SystemEventSeverity.CRITICAL
      : SystemEventSeverity.ERROR;
  }
  if (args.classification === 'BROKER_REJECTED') {
    return SystemEventSeverity.ERROR;
  }
  return args.hasVerifiedProtection
    ? SystemEventSeverity.WARNING
    : SystemEventSeverity.ERROR;
}

export async function closePosition(
  trackedPositionId: number,
  options: ClosePositionOptions = {}
) {
  const mode = options.mode ?? 'AUTOMATED_STRATEGY';

  const claim = await prisma.$transaction(
    async (tx) => {
      const position = await tx.trackedPosition.findUnique({
        where: { id: trackedPositionId },
        include: {
          tradingAccount: { select: { environment: true } },
          tradingAccountSubscription: {
            select: {
              id: true,
              tradingAccountId: true,
              subscriptionId: true,
              enabled: true,
              exitsEnabled: true,
            },
          },
          orderIntents: {
            where: {
              source: 'close-position',
              status: { in: ['pending', 'submitting', 'submitted'] },
            },
            select: { id: true, status: true, clientOrderId: true },
            take: 1,
          },
          brokerOrders: {
            where: {
              status: NONTERMINAL_BROKER_ORDER_PRISMA_FILTER,
            },
            select: { id: true, status: true },
            take: 1,
          },
        },
      });

      if (!position) {
        throw new HttpError(
          404,
          `Active tracked position ${trackedPositionId} was not found.`
        );
      }
      if (position.tradingAccountId === null) {
        throw new HttpError(
          409,
          `Tracked position ${position.id} has no TradingAccount identity.`
        );
      }
      const assignment = position.tradingAccountSubscription;
      if (
        !assignment ||
        assignment.tradingAccountId !== position.tradingAccountId ||
        assignment.subscriptionId !== position.subscriptionId
      ) {
        throw new HttpError(
          409,
          `Tracked position ${position.id} has missing or inconsistent account assignment identity.`
        );
      }
      if (
        mode === 'AUTOMATED_STRATEGY' &&
        (!assignment.enabled || !assignment.exitsEnabled)
      ) {
        throw new HttpError(
          409,
          `TradingAccountSubscription ${assignment.id} has automated exits disabled.`
        );
      }
      if (
        position.status !== 'open' ||
        position.orderIntents.length > 0 ||
        position.brokerOrders.length > 0
      ) {
        throw new HttpError(
          409,
          `A close is already pending for tracked position ${position.id}.`
        );
      }

      const claimed = await tx.trackedPosition.updateMany({
        where: { id: position.id, status: 'open' },
        data: { status: 'closing', lastSyncedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new HttpError(
          409,
          `A close is already pending for tracked position ${position.id}.`
        );
      }

      const clientOrderId = buildCloseClientOrderId({
        tradingAccountId: position.tradingAccountId,
        trackedPositionId: position.id,
      });
      const intent = await tx.orderIntent.create({
        data: {
          source: 'close-position',
          symbol: position.symbol.toUpperCase(),
          side: position.side === 'short' ? 'buy' : 'sell',
          orderType: 'market',
          timeInForce: 'day',
          qty: Math.abs(position.qty),
          notional: null,
          limitPrice: null,
          extendedHours: false,
          clientOrderId,
          tradingAccountId: position.tradingAccountId,
          tradingAccountSubscriptionId: assignment.id,
          status: 'submitting',
          subscriptionId: position.subscriptionId,
          subscriptionKey: null,
          trackedPositionId: position.id,
          rawRequestJson: {
            signalType: 'exit',
            source: 'close-position',
            mode,
            trackedPositionId: position.id,
            tradingAccountId: position.tradingAccountId,
            tradingAccountSubscriptionId: assignment.id,
          } as PrismaTypes.InputJsonValue,
        },
      });

      return { position, intent, clientOrderId };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  const tradingAccountId = claim.position.tradingAccountId!;
  const upperSymbol = claim.position.symbol.toUpperCase();
  let brokerOrder;

  try {
    brokerOrder = await placeAlpacaOrder(
      tradingAccountId,
      {
        symbol: upperSymbol,
        side: claim.position.side === 'short' ? 'buy' : 'sell',
        type: 'market',
        time_in_force: 'day',
        qty: String(Math.abs(claim.position.qty)),
        client_order_id: claim.clientOrderId,
        extended_hours: false,
      },
      'position_close'
    );
  } catch (error) {
    let classification = getDeliveryClassification(error);

    if (classification === 'BROKER_REJECTED') {
      try {
        brokerOrder = await getAlpacaOrderByClientOrderId(
          tradingAccountId,
          claim.clientOrderId,
          'pending_order_idempotency_check'
        );
      } catch {
        classification = 'DELIVERY_UNCERTAIN';
      }
      if (brokerOrder) {
        // Alpaca accepted the deterministic order despite the response error.
        // Continue into the normal idempotent materialization path below.
      }
    }

    if (!brokerOrder && classification !== 'DELIVERY_UNCERTAIN') {
      const intentStatus =
        classification === 'NOT_SENT_BLOCKED' ? 'blocked' : 'failed';
      await prisma.$transaction(async (tx) => {
        await tx.orderIntent.updateMany({
          where: { id: claim.intent.id, status: 'submitting' },
          data: {
            status: intentStatus,
            blockReason: `${DELIVERY_CLASSIFICATION_PREFIX}:${classification}:${sanitizeError(error)}`,
          },
        });
        await tx.trackedPosition.updateMany({
          where: { id: claim.position.id, status: 'closing' },
          data: { status: 'open', lastSyncedAt: new Date() },
        });
      });
      await createSystemEvent({
        type:
          classification === 'BROKER_REJECTED'
            ? 'position.close_rejected'
            : 'position.close_not_sent',
        entityType: 'trackedPosition',
        entityId: claim.position.id,
        tradingAccountId,
        severity: closeFailureSeverity({
          classification,
          environment: claim.position.tradingAccount!.environment,
          hasVerifiedProtection: false,
        }),
        message:
          classification === 'BROKER_REJECTED'
            ? `${upperSymbol} close was rejected and no broker order exists; the local claim was released.`
            : `${upperSymbol} close was not sent to the broker; the local claim was released.`,
        payloadJson: {
          trackedPositionId: claim.position.id,
          orderIntentId: claim.intent.id,
          clientOrderId: claim.clientOrderId,
          mode,
          deliveryClassification: classification,
          error: sanitizeError(error),
        } as PrismaTypes.InputJsonValue,
      });
      throw error;
    }

    if (!brokerOrder) {
      await prisma.orderIntent.updateMany({
        where: { id: claim.intent.id, status: 'submitting' },
        data: {
          blockReason: `${DELIVERY_CLASSIFICATION_PREFIX}:DELIVERY_UNCERTAIN:${sanitizeError(error)}`,
        },
      });
      await createSystemEvent({
        type: 'position.close_submission_uncertain',
        entityType: 'trackedPosition',
        entityId: claim.position.id,
        tradingAccountId,
        severity: closeFailureSeverity({
          classification: 'DELIVERY_UNCERTAIN',
          environment: claim.position.tradingAccount!.environment,
          hasVerifiedProtection: false,
        }),
        message: `${upperSymbol} close delivery is uncertain; deterministic recovery is required.`,
        payloadJson: {
          trackedPositionId: claim.position.id,
          orderIntentId: claim.intent.id,
          clientOrderId: claim.clientOrderId,
          mode,
          deliveryClassification: 'DELIVERY_UNCERTAIN',
          error: sanitizeError(error),
        } as PrismaTypes.InputJsonValue,
      });
      throw error;
    }
  }

  await prisma.$transaction(async (tx) => {
    const existingOrder = await tx.brokerOrder.findFirst({
      where: {
        tradingAccountId,
        broker: 'alpaca',
        brokerOrderId: brokerOrder.id,
      },
      select: { id: true },
    });
    const data = {
      orderIntentId: claim.intent.id,
      tradingAccountId,
      broker: 'alpaca',
      brokerOrderId: brokerOrder.id,
      clientOrderId: brokerOrder.client_order_id,
      symbol: brokerOrder.symbol.toUpperCase(),
      side: brokerOrder.side,
      status: brokerOrder.status,
      securityId: claim.position.securityId,
      trackedPositionId: claim.position.id,
      rawBrokerJson: brokerOrder as unknown as PrismaTypes.InputJsonValue,
    };
    if (existingOrder) {
      await tx.brokerOrder.update({
        where: { id: existingOrder.id },
        data,
      });
    } else {
      await tx.brokerOrder.create({ data });
    }
    await tx.orderIntent.updateMany({
      where: { id: claim.intent.id, status: 'submitting' },
      data: { status: 'submitted', blockReason: null },
    });
  });

  adaptivePollingCoordinator.forceAfterBrokerPositionWrite(
    tradingAccountId,
    'broker_position_close_requested'
  );
  await createSystemEvent({
    type: 'position.close_requested',
    entityType: 'trackedPosition',
    entityId: claim.position.id,
    tradingAccountId,
    severity: SystemEventSeverity.INFO,
    payloadJson: {
      symbol: upperSymbol,
      broker: 'alpaca',
      trackedPositionId: claim.position.id,
      orderIntentId: claim.intent.id,
      brokerOrderId: brokerOrder.id,
      clientOrderId: brokerOrder.client_order_id,
      mode,
    } as PrismaTypes.InputJsonValue,
  });

  return {
    ok: true,
    trackedPositionId: claim.position.id,
    symbol: upperSymbol,
    tradingAccountId,
    orderIntentId: claim.intent.id,
    brokerOrderId: brokerOrder.id,
    clientOrderId: brokerOrder.client_order_id,
  };
}
