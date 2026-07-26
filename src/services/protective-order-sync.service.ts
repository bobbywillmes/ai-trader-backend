import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { getAlpacaOrderById } from '../integrations/alpaca/orders.adapter.js';
import {
  markPositionExitStateAttentionRequired,
  syncTrailingStopOrderStatus,
} from './position-exit-state.service.js';

const TERMINAL_ORDER_STATUSES = [
  'filled',
  'canceled',
  'cancelled',
  'expired',
  'rejected',
  'done_for_day',
] as const;

function sanitizeError(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Unknown protective order synchronization error.';
}

export type ProtectiveOrderSyncResult = {
  found: number;
  synchronized: number;
  partialFills: number;
  terminalOrders: number;
  confirmedMissing: number;
  failed: number;
  failures: Array<{ trackedPositionId: number; brokerOrderId: string; error: string }>;
};

export async function syncProtectiveOrdersForAccount(
  tradingAccountId: number
): Promise<ProtectiveOrderSyncResult> {
  const exitStates = await prisma.positionExitState.findMany({
    where: {
      trailBrokerOrderId: { not: null },
      trailOrderStatus: { notIn: [...TERMINAL_ORDER_STATUSES] },
      trackedPosition: { tradingAccountId },
    },
    include: {
      trackedPosition: {
        select: {
          id: true,
          tradingAccountId: true,
          symbol: true,
        },
      },
    },
    orderBy: { trackedPositionId: 'asc' },
  });
  const result: ProtectiveOrderSyncResult = {
    found: exitStates.length,
    synchronized: 0,
    partialFills: 0,
    terminalOrders: 0,
    confirmedMissing: 0,
    failed: 0,
    failures: [],
  };

  for (const exitState of exitStates) {
    const brokerOrderId = exitState.trailBrokerOrderId!;
    try {
      if (exitState.trackedPosition.tradingAccountId !== tradingAccountId) {
        throw new Error(
          `PositionExitState ${exitState.id} account attribution does not match coordinator account ${tradingAccountId}.`
        );
      }
      if (!exitState.trailClientOrderId) {
        throw new Error(
          `PositionExitState ${exitState.id} has no protective client order identity.`
        );
      }

      const order = await getAlpacaOrderById(
        tradingAccountId,
        brokerOrderId,
        'protective_order_sync'
      );
      if (!order) {
        await markPositionExitStateAttentionRequired({
          trackedPositionId: exitState.trackedPositionId,
          code: 'protective_order_confirmed_missing',
          message:
            'The linked protective order was not found at the broker. Replacement was not submitted; operator review or safe recovery is required.',
        });
        result.confirmedMissing += 1;
        continue;
      }

      const filledQty = Number(order.filled_qty ?? 0);
      const requestedQty = Number(order.qty ?? 0);
      if (
        Number.isFinite(filledQty) &&
        filledQty > 0 &&
        (!Number.isFinite(requestedQty) || filledQty < requestedQty)
      ) {
        result.partialFills += 1;
      }
      if (
        TERMINAL_ORDER_STATUSES.includes(
          order.status as (typeof TERMINAL_ORDER_STATUSES)[number]
        )
      ) {
        result.terminalOrders += 1;
      }

      await syncTrailingStopOrderStatus({
        tradingAccountId,
        clientOrderId: exitState.trailClientOrderId,
        brokerOrderId,
        orderStatus: order.status,
        rawBrokerJson: order as unknown as Prisma.InputJsonValue,
      });
      await prisma.brokerOrder.updateMany({
        where: {
          tradingAccountId,
          broker: 'alpaca',
          brokerOrderId,
          trackedPositionId: exitState.trackedPositionId,
        },
        data: {
          status: order.status,
          rawBrokerJson: order as unknown as Prisma.InputJsonValue,
        },
      });
      result.synchronized += 1;
    } catch (error) {
      result.failed += 1;
      result.failures.push({
        trackedPositionId: exitState.trackedPositionId,
        brokerOrderId,
        error: sanitizeError(error),
      });
    }
  }

  return result;
}
