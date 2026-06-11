import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { getOpenAlpacaOrders } from '../integrations/alpaca/orders.adapter.js';
import { createSystemEvent } from './system-event.service.js';
import { getNormalizedPositions } from './positions.service.js';
import { markPositionExitStateAttentionRequired } from './position-exit-state.service.js';

export type ReconciliationSeverity = 'info' | 'warn' | 'critical';

export type ReconciliationFindingCode =
  | 'tracked_position_missing_at_broker'
  | 'broker_position_untracked'
  | 'trail_order_missing_after_unlock'
  | 'trail_order_problem_status'
  | 'trail_order_status_mismatch';

export type ReconciliationFinding = {
  code: ReconciliationFindingCode;
  severity: ReconciliationSeverity;
  entityType: 'trackedPosition' | 'brokerPosition' | 'brokerOrder';
  entityId: string;
  symbol: string;
  message: string;
  attentionCode?: string;
  details?: Record<string, unknown>;
};

export type ReconciliationExitState = {
  targetUnlocked?: boolean | null;
  trailClientOrderId?: string | null;
  trailBrokerOrderId?: string | null;
  trailOrderStatus?: string | null;
  attentionRequired?: boolean | null;
};

export type ReconciliationTrackedPosition = {
  id: number;
  broker: string;
  symbol: string;
  status: string;
  side?: string | null;
  qty?: number | null;
  exitState?: ReconciliationExitState | null;
};

export type ReconciliationBrokerPosition = {
  broker?: string | null;
  symbol: string;
  qty?: string | number | null;
  side?: string | null;
};

export type ReconciliationBrokerOrder = {
  broker?: string | null;
  id?: string | null;
  client_order_id?: string | null;
  clientOrderId?: string | null;
  symbol: string;
  side?: string | null;
  qty?: string | number | null;
  type?: string | null;
  status?: string | null;
};

export type ReconciliationInput = {
  trackedPositions: ReconciliationTrackedPosition[];
  brokerPositions: ReconciliationBrokerPosition[];
  brokerOrders?: ReconciliationBrokerOrder[];
  defaultBroker?: string;
};

const ACTIVE_TRACKED_POSITION_STATUSES = new Set(['open', 'closing']);

const PROBLEM_TRAILING_ORDER_STATUSES = new Set([
  'rejected',
  'canceled',
  'expired',
  'suspended',
]);

function normalizeBroker(value: string | null | undefined, fallback: string) {
  return (value ?? fallback).trim().toLowerCase();
}

function normalizeSymbol(symbol: string) {
  return symbol.trim().toUpperCase();
}

function positionKey(args: {
  broker: string | null | undefined;
  symbol: string;
  defaultBroker: string;
}) {
  return `${normalizeBroker(args.broker, args.defaultBroker)}:${normalizeSymbol(
    args.symbol
  )}`;
}

function getBrokerOrderClientId(order: ReconciliationBrokerOrder) {
  return order.client_order_id ?? order.clientOrderId ?? null;
}

function getBrokerOrderId(order: ReconciliationBrokerOrder) {
  return order.id ?? null;
}

function getOrderLookupKey(order: ReconciliationBrokerOrder) {
  const clientOrderId = getBrokerOrderClientId(order);

  if (clientOrderId) {
    return `client:${clientOrderId}`;
  }

  const orderId = getBrokerOrderId(order);

  if (orderId) {
    return `broker:${orderId}`;
  }

  return null;
}

function findBrokerOrderForExitState(args: {
  exitState: ReconciliationExitState;
  brokerOrdersByLookupKey: Map<string, ReconciliationBrokerOrder>;
}) {
  const clientOrderId = args.exitState.trailClientOrderId;
  const brokerOrderId = args.exitState.trailBrokerOrderId;

  if (clientOrderId) {
    const order = args.brokerOrdersByLookupKey.get(`client:${clientOrderId}`);

    if (order) {
      return order;
    }
  }

  if (brokerOrderId) {
    const order = args.brokerOrdersByLookupKey.get(`broker:${brokerOrderId}`);

    if (order) {
      return order;
    }
  }

  return null;
}

function getTrailProblemAttentionCode(status: string) {
  switch (status) {
    case 'rejected':
      return 'trail_order_rejected';
    case 'canceled':
      return 'trail_order_canceled';
    case 'expired':
      return 'trail_order_expired';
    default:
      return 'trail_order_problem_status';
  }
}

export function reconcileSnapshots(input: ReconciliationInput) {
  const defaultBroker = input.defaultBroker ?? 'alpaca';
  const findings: ReconciliationFinding[] = [];

  const activeTrackedPositions = input.trackedPositions.filter((position) =>
    ACTIVE_TRACKED_POSITION_STATUSES.has(position.status)
  );

  const brokerPositionKeys = new Set(
    input.brokerPositions.map((position) =>
      positionKey({
        broker: position.broker,
        symbol: position.symbol,
        defaultBroker,
      })
    )
  );

  const activeTrackedPositionKeys = new Set(
    activeTrackedPositions.map((position) =>
      positionKey({
        broker: position.broker,
        symbol: position.symbol,
        defaultBroker,
      })
    )
  );

  const brokerOrdersByLookupKey = new Map<string, ReconciliationBrokerOrder>();

  for (const order of input.brokerOrders ?? []) {
    const lookupKey = getOrderLookupKey(order);

    if (lookupKey) {
      brokerOrdersByLookupKey.set(lookupKey, order);
    }
  }

  for (const position of activeTrackedPositions) {
    const key = positionKey({
      broker: position.broker,
      symbol: position.symbol,
      defaultBroker,
    });

    if (!brokerPositionKeys.has(key)) {
      findings.push({
        code: 'tracked_position_missing_at_broker',
        severity: 'warn',
        entityType: 'trackedPosition',
        entityId: String(position.id),
        symbol: normalizeSymbol(position.symbol),
        message: `${position.symbol} is active in the backend but missing from broker open positions.`,
        details: {
          broker: position.broker,
          status: position.status,
        },
      });
    }

    const exitState = position.exitState;

    if (!exitState?.targetUnlocked) {
      continue;
    }

    if (!exitState.trailClientOrderId && !exitState.trailBrokerOrderId) {
      findings.push({
        code: 'trail_order_missing_after_unlock',
        severity: 'critical',
        entityType: 'trackedPosition',
        entityId: String(position.id),
        symbol: normalizeSymbol(position.symbol),
        attentionCode: 'trail_order_missing_after_unlock',
        message: `${position.symbol} target is unlocked, but no protective trailing-stop order is linked.`,
        details: {
          targetUnlocked: exitState.targetUnlocked,
          trailClientOrderId: exitState.trailClientOrderId ?? null,
          trailBrokerOrderId: exitState.trailBrokerOrderId ?? null,
        },
      });

      continue;
    }

    const brokerOrder = findBrokerOrderForExitState({
      exitState,
      brokerOrdersByLookupKey,
    });

    if (!brokerOrder) {
      continue;
    }

    const brokerStatus = brokerOrder.status ?? null;
    const localStatus = exitState.trailOrderStatus ?? null;

    if (brokerStatus && PROBLEM_TRAILING_ORDER_STATUSES.has(brokerStatus)) {
      findings.push({
        code: 'trail_order_problem_status',
        severity: 'critical',
        entityType: 'trackedPosition',
        entityId: String(position.id),
        symbol: normalizeSymbol(position.symbol),
        attentionCode: getTrailProblemAttentionCode(brokerStatus),
        message: `${position.symbol} protective trailing-stop order has broker status: ${brokerStatus}.`,
        details: {
          brokerOrderId: getBrokerOrderId(brokerOrder),
          clientOrderId: getBrokerOrderClientId(brokerOrder),
          localStatus,
          brokerStatus,
        },
      });
    }

    if (localStatus && brokerStatus && localStatus !== brokerStatus) {
      findings.push({
        code: 'trail_order_status_mismatch',
        severity: 'warn',
        entityType: 'trackedPosition',
        entityId: String(position.id),
        symbol: normalizeSymbol(position.symbol),
        message: `${position.symbol} trailing-stop status differs between backend and broker.`,
        details: {
          localStatus,
          brokerStatus,
          brokerOrderId: getBrokerOrderId(brokerOrder),
          clientOrderId: getBrokerOrderClientId(brokerOrder),
        },
      });
    }
  }

  for (const brokerPosition of input.brokerPositions) {
    const key = positionKey({
      broker: brokerPosition.broker,
      symbol: brokerPosition.symbol,
      defaultBroker,
    });

    if (activeTrackedPositionKeys.has(key)) {
      continue;
    }

    findings.push({
      code: 'broker_position_untracked',
      severity: 'critical',
      entityType: 'brokerPosition',
      entityId: key,
      symbol: normalizeSymbol(brokerPosition.symbol),
      message: `${brokerPosition.symbol} is open at the broker but has no active tracked position.`,
      details: {
        broker: normalizeBroker(brokerPosition.broker, defaultBroker),
        qty: brokerPosition.qty ?? null,
        side: brokerPosition.side ?? null,
      },
    });
  }

  return findings;
}

export type RunReconciliationCheckOptions = {
  persistEvents?: boolean;
  persistAttention?: boolean;
  dedupeEvents?: boolean;
  dedupeWindowMinutes?: number;
};

export type RunReconciliationCheckResult = {
  findings: ReconciliationFinding[];
  eventCount: number;
  skippedDuplicateEventCount: number;
  attentionUpdateCount: number;
  persistedEvents: boolean;
  persistedAttention: boolean;
};

function buildReconciliationEventType(code: ReconciliationFindingCode) {
  return `reconciliation.${code}`;
}

function buildReconciliationEventPayload(
  finding: ReconciliationFinding
): Prisma.InputJsonValue {
  return {
    code: finding.code,
    severity: finding.severity,
    symbol: finding.symbol,
    attentionCode: finding.attentionCode ?? null,
    details: finding.details ?? {},
  } as Prisma.InputJsonValue;
}

const DEFAULT_RECONCILIATION_EVENT_DEDUPE_WINDOW_MINUTES = 60;

function getDedupeSince(windowMinutes: number) {
  return new Date(Date.now() - windowMinutes * 60_000);
}

async function hasRecentReconciliationEvent(
  finding: ReconciliationFinding,
  dedupeSince: Date
) {
  const existing = await prisma.systemEvent.findFirst({
    where: {
      type: buildReconciliationEventType(finding.code),
      entityType: finding.entityType,
      entityId: finding.entityId,
      createdAt: {
        gte: dedupeSince,
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return Boolean(existing);
}

export async function runReconciliationCheck(
  options: RunReconciliationCheckOptions = {}
): Promise<RunReconciliationCheckResult> {
  const [trackedPositions, brokerPositions, brokerOrders] = await Promise.all([
    prisma.trackedPosition.findMany({
      where: {
        status: {
          in: ['open', 'closing'],
        },
      },
      include: {
        exitState: true,
      },
      orderBy: {
        symbol: 'asc',
      },
    }),
    getNormalizedPositions(),
    getOpenAlpacaOrders(),
  ]);

  const findings = reconcileSnapshots({
    trackedPositions: trackedPositions.map((position) => ({
      id: position.id,
      broker: position.broker,
      symbol: position.symbol,
      status: position.status,
      side: position.side,
      qty: position.qty,
      exitState: position.exitState
        ? {
            targetUnlocked: position.exitState.targetUnlocked,
            trailClientOrderId: position.exitState.trailClientOrderId,
            trailBrokerOrderId: position.exitState.trailBrokerOrderId,
            trailOrderStatus: position.exitState.trailOrderStatus,
            attentionRequired: position.exitState.attentionRequired,
          }
        : null,
    })),
    brokerPositions: brokerPositions.map((position) => ({
      broker: position.broker ?? null,
      symbol: position.symbol,
      qty: position.qty ?? null,
      side: position.side ?? null,
    })),
    brokerOrders: brokerOrders.map((order) => ({
      broker: 'alpaca',
      id: order.id ?? null,
      client_order_id: order.client_order_id ?? null,
      symbol: order.symbol,
      side: order.side ?? null,
      qty: order.qty ?? null,
      type: order.type ?? null,
      status: order.status ?? null,
    })),
    defaultBroker: 'alpaca',
  });

  const persistEvents = options.persistEvents ?? true;
  const persistAttention = options.persistAttention ?? persistEvents;
  const dedupeEvents = options.dedupeEvents ?? true;
  const dedupeWindowMinutes =
    options.dedupeWindowMinutes ??
    DEFAULT_RECONCILIATION_EVENT_DEDUPE_WINDOW_MINUTES;
  const dedupeSince = getDedupeSince(dedupeWindowMinutes);

let eventCount = 0;
let skippedDuplicateEventCount = 0;

  if (persistEvents) {
    for (const finding of findings) {
      if (dedupeEvents) {
        const duplicateExists = await hasRecentReconciliationEvent(
          finding,
          dedupeSince
        );

        if (duplicateExists) {
          skippedDuplicateEventCount += 1;
          continue;
        }
      }

      await createSystemEvent({
        type: buildReconciliationEventType(finding.code),
        entityType: finding.entityType,
        entityId: finding.entityId,
        message: finding.message,
        payloadJson: buildReconciliationEventPayload(finding),
      });

      eventCount += 1;
    }
  }

  let attentionUpdateCount = 0;

  if (persistAttention) {
    for (const finding of findings) {
      if (
        finding.entityType !== 'trackedPosition' ||
        !finding.attentionCode ||
        finding.severity !== 'critical'
      ) {
        continue;
      }

      const trackedPositionId = Number(finding.entityId);

      if (!Number.isFinite(trackedPositionId)) {
        continue;
      }

      await markPositionExitStateAttentionRequired({
        trackedPositionId,
        code: finding.attentionCode,
        message: finding.message,
      });

      attentionUpdateCount += 1;
    }
  }

  return {
    findings,
    eventCount,
    skippedDuplicateEventCount,
    attentionUpdateCount,
    persistedEvents: persistEvents,
    persistedAttention: persistAttention,
  };
}