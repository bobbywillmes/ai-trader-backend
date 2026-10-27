import type { Prisma } from '@prisma/client';

import {
  BROKER_ACTIVE_ENTRY_STATUSES,
  TERMINAL_ENTRY_ORDER_STATUSES,
} from './entry-lifecycle-status.service.js';

export const SUBMITTED_ORDER_SYNC_INTENT_STATUSES = [
  ...BROKER_ACTIVE_ENTRY_STATUSES.filter(
    (status) => !['received', 'pending', 'submitting'].includes(status)
  ),
  ...TERMINAL_ENTRY_ORDER_STATUSES.filter((status) =>
    ['done_for_day', 'calculated', 'replaced'].includes(status)
  ),
];

/**
 * A submitted intent is coherently historical only when its linked position is
 * closed, at least one local broker order is filled, and every other local
 * order is either that fill or a replaced predecessor. Anything incomplete or
 * contradictory remains eligible for broker synchronization.
 */
export function submittedOrderSyncIntentWhere(
  tradingAccountId: number
): Prisma.OrderIntentWhereInput {
  return {
    status: { in: SUBMITTED_ORDER_SYNC_INTENT_STATUSES },
    tradingAccountId,
    NOT: {
      AND: [
        { trackedPosition: { is: { status: 'closed' } } },
        { brokerOrders: { some: { status: 'filled' } } },
        {
          brokerOrders: {
            none: { status: { notIn: ['filled', 'replaced'] } },
          },
        },
      ],
    },
  };
}
