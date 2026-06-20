import type { Prisma } from '@prisma/client';

import { AlpacaRateLimitDeferredError } from '../errors/alpaca-rate-limit-deferred-error.js';
import { prisma } from '../db/prisma.js';
import { getNormalizedOpenOrders } from '../services/orders.service.js';
import { placeOrderSchema } from '../validators/place-order.schema.js';
import type { ResolvedPlaceOrderInput } from '../validators/place-order.schema.js';
import {
  submitOrderToBroker,
  type BrokerOrderSubmissionInput,
} from '../services/place-order.service.js';
import { getRuntimeTradingConfig } from '../services/config.service.js';
import {
  entrySessionDetailsAsJson,
  evaluateEntrySessionGuard,
  isEntrySessionBlocked,
} from '../services/entry-session-guard.service.js';
import { createSystemEvent } from '../services/system-event.service.js';
import { syncTrailingStopOrderStatus } from '../services/position-exit-state.service.js';

function isEntryOrder(input: BrokerOrderSubmissionInput): boolean {
  return input.side === 'buy' && (input.signalType ?? 'entry') === 'entry';
}

export async function processPendingOrders() {
  const pending = await prisma.orderIntent.findMany({
    where: { status: 'pending' },
    take: 5,
    orderBy: { createdAt: 'asc' },
  });

  if (pending.length > 0) {
    console.log(`Order worker: Found ${pending.length} pending orders`);
  }

  let processed = 0;

  for (const intent of pending) {
    console.log(`Processing intent (${intent.id}): ${intent.symbol} ${intent.side} ${intent.orderType}`);

    try {
      const claimed = await prisma.orderIntent.updateMany({
        where: {
          id: intent.id,
          status: 'pending',
        },
        data: {
          status: 'submitting',
        },
      });

      if (claimed.count !== 1) {
        console.log(`Intent (${intent.id}) was already claimed by another worker tick.`);
        continue;
      }

      processed += 1;

      if (!intent.clientOrderId) {
        throw new Error(
          `OrderIntent ${intent.id} is missing clientOrderId. Cannot submit safely.`
        );
      }

      const rawInput = placeOrderSchema.parse(intent.rawRequestJson);

      const resolvedInput: BrokerOrderSubmissionInput = {
        ...rawInput,
        symbol: intent.symbol,
        side: intent.side as 'buy' | 'sell',
        orderType: intent.orderType as 'market' | 'limit',
        timeInForce: intent.timeInForce as 'day' | 'gtc',
        clientOrderId: intent.clientOrderId,
      };

      if (intent.subscriptionId !== null) {
        resolvedInput.subscriptionId = intent.subscriptionId;
      }

      if (isEntryOrder(resolvedInput)) {
        const config = await getRuntimeTradingConfig();
        const entrySession = await evaluateEntrySessionGuard(config);

        if (isEntrySessionBlocked(entrySession)) {
          await prisma.orderIntent.update({
            where: { id: intent.id },
            data: {
              status: 'blocked',
              blockReason: entrySession.reason,
            },
          });

          await createSystemEvent({
            type: 'order_intent.blocked.entry_session',
            entityType: 'orderIntent',
            entityId: String(intent.id),
            payloadJson: {
              orderIntentId: intent.id,
              symbol: resolvedInput.symbol,
              side: resolvedInput.side,
              subscriptionKey: resolvedInput.subscriptionKey ?? null,
              reason: entrySession.reason,
              statusCode: entrySession.statusCode,
              details: entrySessionDetailsAsJson(entrySession),
            } as Prisma.InputJsonValue,
          });

          console.log(
            `Intent (${intent.id}) blocked by entry session guard: ${entrySession.details.rule}`
          );

          continue;
        }
      }

      const result = await submitOrderToBroker(resolvedInput);
      const brokerOrder = result.order;

      const existingBrokerOrderRecord = await prisma.brokerOrder.findFirst({
        where: {
          broker: 'alpaca',
          brokerOrderId: brokerOrder.id,
        },
      });

      if (existingBrokerOrderRecord) {
        await prisma.orderIntent.update({
          where: { id: intent.id },
          data: {
            status: 'submitted',
          },
        });

        console.log(`Intent (${intent.id}) already has broker order ${brokerOrder.id}; marked submitted.`);

        continue;
      }

      await prisma.orderIntent.update({
        where: { id: intent.id },
        data: {
          status: 'submitted',
          brokerOrders: {
            create: {
              broker: 'alpaca',
              brokerOrderId: brokerOrder.id,
              clientOrderId: brokerOrder.client_order_id,
              symbol: brokerOrder.symbol,
              side: brokerOrder.side,
              status: brokerOrder.status,
              ...(intent.trackedPositionId !== null
                ? {
                    trackedPosition: {
                      connect: { id: intent.trackedPositionId },
                    },
                  }
                : {}),
              security: {
                connect: { symbol: brokerOrder.symbol.toUpperCase() },
              },
              rawBrokerJson: brokerOrder as unknown as Prisma.InputJsonValue,
            },
          },
        },
      });

      console.log(`Intent (${intent.id}) for ${intent.symbol} submitted.`);
    } catch (error) {
      await prisma.orderIntent.update({
        where: { id: intent.id },
        data: {
          status: 'failed',
          blockReason:
            error instanceof Error ? error.message : 'Unknown worker error.',
        },
      });

      console.error(`Intent (${intent.id}) failed during broker submission`, error);
    }
  }

  return {
    found: pending.length,
    processed,
  };
}

export async function syncSubmittedOrders() {
  const submittedIntents = await prisma.orderIntent.findMany({
    where: {
      status: 'submitted'
    },
    include: {
      brokerOrders: true
    },
    take: 10
  });

  if (submittedIntents.length === 0) {
    return {
      found: 0,
      synced: 0,
      deferred: false,
    };
  }

  let openOrders: Awaited<ReturnType<typeof getNormalizedOpenOrders>>;

  try {
    openOrders = await getNormalizedOpenOrders('submitted_order_sync');
  } catch (error) {
    if (error instanceof AlpacaRateLimitDeferredError) {
      return {
        found: submittedIntents.length,
        synced: 0,
        deferred: true,
        reason: 'rate_limited' as const,
        backoffUntil: error.backoffUntil?.toISOString() ?? null,
      };
    }

    console.error('Failed to fetch Alpaca open orders during submitted order sync', error);
    throw error;
  }

  const openOrdersByBrokerOrderId = new Map(
    openOrders.map((order) => [order.id, order])
  );

  let synced = 0;

  for (const intent of submittedIntents) {
    try {
      const brokerOrder = intent.brokerOrders[0];

      if (!brokerOrder) {
        continue;
      }

      const alpacaOrder = openOrdersByBrokerOrderId.get(brokerOrder.brokerOrderId);

      if (!alpacaOrder) {
        continue;
      }

      const previousStatus = brokerOrder.status;
      const nextStatus = alpacaOrder.status;

      await syncTrailingStopOrderStatus({
        clientOrderId: brokerOrder.clientOrderId,
        brokerOrderId: brokerOrder.brokerOrderId,
        orderStatus: nextStatus,
        rawBrokerJson: {
          brokerOrderId: brokerOrder.brokerOrderId,
          clientOrderId: brokerOrder.clientOrderId,
          previousStatus: brokerOrder.status,
          nextStatus,
          matchedOpenOrder: alpacaOrder.status ?? null,
        } as Prisma.InputJsonValue,
      });

      if (previousStatus !== nextStatus) {
        const updated = await prisma.brokerOrder.updateMany({
          where: {
            id: brokerOrder.id,
            status: previousStatus,
          },
          data: {
            status: nextStatus,
            rawBrokerJson: alpacaOrder as unknown as Prisma.InputJsonValue,
          },
        });

        if (updated.count !== 1) {
          console.log(
            `Order ${brokerOrder.id} status was already updated by another worker tick.`
          );

          continue;
        }

        await prisma.orderIntent.update({
          where: { id: brokerOrder.orderIntentId },
          data: {
            status: nextStatus,
          },
        });

        await createSystemEvent({
          type: `order.${nextStatus}`,
          entityType: 'brokerOrder',
          entityId: brokerOrder.id,
          payloadJson: {
            orderIntentId: brokerOrder.orderIntentId,
            brokerOrderId: brokerOrder.brokerOrderId,
            symbol: brokerOrder.symbol,
            side: brokerOrder.side,
            previousStatus,
            nextStatus,
          } as Prisma.InputJsonValue,
        });

        console.log(
          `Order ${brokerOrder.id} changed from ${previousStatus} to ${nextStatus}`
        );
        synced += 1;
      }
    } catch (error) {
      console.error(`Sync error for intent ${intent.id}`, error);
    }
  }

  return {
    found: submittedIntents.length,
    synced,
    deferred: false,
  };
}
