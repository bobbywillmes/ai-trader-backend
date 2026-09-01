import { prisma } from '../db/prisma.js';
import { getAlpacaOrderByClientOrderId } from '../integrations/alpaca/orders.adapter.js';
import { NONTERMINAL_BROKER_ORDER_PRISMA_FILTER } from './broker-order-lifecycle-status.service.js';

type StaleCloseIntent = {
  id: number;
  tradingAccountId: number | null;
  trackedPositionId: number | null;
  source: string;
  status: string;
  clientOrderId: string | null;
};

export async function recoverDeterministicallyAbsentStaleCloseIntents(
  intents: StaleCloseIntent[],
) {
  const recoveredIntentIds = new Set<number>();
  for (const intent of intents) {
    if (
      intent.source !== 'close-position' ||
      intent.status !== 'submitting' ||
      !intent.tradingAccountId ||
      !intent.trackedPositionId ||
      !intent.clientOrderId
    ) {
      continue;
    }
    let brokerOrder;
    try {
      brokerOrder = await getAlpacaOrderByClientOrderId(
        intent.tradingAccountId,
        intent.clientOrderId,
        'pending_order_idempotency_check',
      );
    } catch {
      continue;
    }
    if (brokerOrder) continue;
    const trackedPositionId = intent.trackedPositionId;
    const finalized = await prisma.$transaction(async (tx) => {
      const updated = await tx.orderIntent.updateMany({
        where: { id: intent.id, status: 'submitting' },
        data: {
          status: 'failed',
          blockReason: 'RECONCILIATION:DETERMINISTIC_BROKER_ABSENCE_CONFIRMED',
        },
      });
      if (updated.count !== 1) return false;
      const [otherIntent, activeOrder] = await Promise.all([
        tx.orderIntent.findFirst({
          where: {
            trackedPositionId,
            id: { not: intent.id },
            source: 'close-position',
            status: { in: ['pending', 'submitting', 'submitted'] },
          },
          select: { id: true },
        }),
        tx.brokerOrder.findFirst({
          where: {
            trackedPositionId,
            status: NONTERMINAL_BROKER_ORDER_PRISMA_FILTER,
          },
          select: { id: true },
        }),
      ]);
      if (!otherIntent && !activeOrder) {
        await tx.trackedPosition.updateMany({
          where: { id: trackedPositionId, status: 'closing' },
          data: { status: 'open', lastSyncedAt: new Date() },
        });
      }
      return true;
    });
    if (finalized) recoveredIntentIds.add(intent.id);
  }
  return recoveredIntentIds;
}
