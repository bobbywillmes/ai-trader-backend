import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { getNormalizedOpenOrders } from '../services/orders.service.js';
import { placeOrderSchema } from '../validators/place-order.schema.js';
import { submitOrderToBroker } from '../services/place-order.service.js';
import { createSystemEvent } from '../services/system-event.service.js';

export async function processPendingOrders() {
  const pending = await prisma.orderIntent.findMany({
    where: { status: 'pending' },
    take: 5,
    orderBy: { createdAt: 'asc' }
  });

  if (pending.length > 0) {
    console.log(`Order worker: Found ${pending.length} pending orders`);
  }

  for (const intent of pending) {
    console.log(`Processing intent (${intent.id}): ${intent.symbol} ${intent.side} ${intent.orderType}`);
    try {
      const input = placeOrderSchema.parse(intent.rawRequestJson);
      const result = await submitOrderToBroker(input);
      const brokerOrder = result.order;

      await prisma.orderIntent.update({
        where: { id: intent.id },
        data: {
          status: result.duplicate ? 'duplicate' : 'submitted',
          brokerOrders: {
            create: {
              broker: 'alpaca',
              brokerOrderId: brokerOrder.id,
              clientOrderId: brokerOrder.client_order_id,
              symbol: brokerOrder.symbol,
              side: brokerOrder.side,
              status: brokerOrder.status,
              rawBrokerJson: brokerOrder as unknown as Prisma.InputJsonValue
            }
          }
        }
      });
      console.log(`Intent (${intent.id}) for ${intent.symbol} processed successfully.`);
    } catch (error) {
      await prisma.orderIntent.update({
        where: { id: intent.id },
        data: {
          status: 'failed',
          blockReason:
            error instanceof Error ? error.message : 'Unknown worker error.'
        }
      });
    }
  }
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

  for (const intent of submittedIntents) {
    try {
      const brokerOrder = intent.brokerOrders[0];

      if (!brokerOrder) {
        continue;
      }

      const openOrders = await getNormalizedOpenOrders();

      const match = openOrders.find(
        (order) => order.id === brokerOrder.brokerOrderId
      );

      const previousStatus = intent.status;
      const nextStatus = match?.status ?? 'filled';

      if (previousStatus !== nextStatus) {
        await prisma.orderIntent.update({
          where: { id: intent.id },
          data: {
            status: nextStatus
          }
        });

        await createSystemEvent({
          type: `order.${nextStatus}`,
          entityType: 'orderIntent',
          entityId: intent.id,
          payloadJson: {
            previousStatus,
            nextStatus,
            orderIntentId: intent.id,
            brokerOrderId: brokerOrder.brokerOrderId,
            symbol: intent.symbol,
            side: intent.side
          } as Prisma.InputJsonValue
        });

        console.log(
          `Order ${intent.id} changed from ${previousStatus} to ${nextStatus}`
        );
      }
    } catch (error) {
      console.error(`Sync error for intent ${intent.id}`, error);
    }
  }
}