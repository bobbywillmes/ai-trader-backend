import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { parseSubscriptionKeyFromClientOrderId } from './client-order-id.service.js';

export const BROKER_CLIENT_ORDER_RESOLUTION_EVIDENCE =
  'BROKER_CLIENT_ORDER_RESOLUTION_EVIDENCE';
const LINKED_LIFECYCLE_EVIDENCE = 'LINKED_LIFECYCLE_EVIDENCE';
const NUMERIC_TOLERANCE = 1e-6;

export type RepairArgs = {
  positionId: number;
  expectedAccountId: number;
  expectedCurrentSubscriptionId: number | null;
  expectedCurrentAssignmentId: number | null;
  expectedSubscriptionId: number;
  expectedSubscriptionKey: string;
  expectedAssignmentId: number;
  apply: boolean;
};

type RepairDb = Pick<
  typeof prisma,
  'trackedPosition' | 'tradingAccountSubscription' | 'systemEvent' | '$transaction'
>;

const positionSelect = {
  id: true,
  symbol: true,
  qty: true,
  avgEntryPrice: true,
  status: true,
  tradingAccountId: true,
  subscriptionId: true,
  tradingAccountSubscriptionId: true,
  updatedAt: true,
  configSnapshotJson: true,
  orderIntents: {
    select: {
      id: true,
      symbol: true,
      side: true,
      tradingAccountId: true,
      subscriptionId: true,
      tradingAccountSubscriptionId: true,
      clientOrderId: true,
    },
  },
  entryDecision: {
    select: {
      id: true,
      symbol: true,
      tradingAccountId: true,
      subscriptionId: true,
      tradingAccountSubscriptionId: true,
    },
  },
  brokerOrders: {
    select: {
      id: true,
      symbol: true,
      side: true,
      clientOrderId: true,
      tradingAccountId: true,
      orderIntent: {
        select: {
          id: true,
          tradingAccountId: true,
          subscriptionId: true,
          tradingAccountSubscriptionId: true,
        },
      },
    },
  },
  brokerActivities: {
    select: {
      id: true,
      tradingAccountId: true,
      activityType: true,
      symbol: true,
      side: true,
      qty: true,
      price: true,
      brokerOrderRecordId: true,
      brokerOrderRecord: {
        select: {
          id: true,
          tradingAccountId: true,
          symbol: true,
          side: true,
          clientOrderId: true,
        },
      },
    },
  },
} satisfies Prisma.TrackedPositionSelect;

type PositionEvidence = Prisma.TrackedPositionGetPayload<{
  select: typeof positionSelect;
}>;

function objectValue(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : null;
}

function eventResolution(payload: Prisma.JsonValue) {
  const root = objectValue(payload);
  const nested = root ? objectValue(root.evidence ?? null) : null;
  const ids = [
    ...(typeof root?.clientOrderId === 'string' ? [root.clientOrderId] : []),
    ...(Array.isArray(root?.clientOrderIds)
      ? root.clientOrderIds.filter((item): item is string => typeof item === 'string')
      : []),
    ...(typeof nested?.clientOrderId === 'string' ? [nested.clientOrderId] : []),
    ...(Array.isArray(nested?.clientOrderIds)
      ? nested.clientOrderIds.filter((item): item is string => typeof item === 'string')
      : []),
  ];
  return {
    source: root?.source,
    subscriptionId: root?.subscriptionId,
    subscriptionKey: root?.subscriptionKey,
    clientOrderIds: [...new Set(ids)],
  };
}

function closeEnough(actual: number, expected: number) {
  return Math.abs(actual - expected) <=
    Math.max(NUMERIC_TOLERANCE, Math.abs(expected) * 1e-9);
}

function linkedLifecycleEvidence(position: PositionEvidence, args: RepairArgs) {
  const matches = (value: {
    tradingAccountId: number | null;
    subscriptionId: number | null;
    tradingAccountSubscriptionId: number | null;
  }) =>
    value.tradingAccountId === args.expectedAccountId &&
    value.subscriptionId === args.expectedSubscriptionId &&
    (value.tradingAccountSubscriptionId === null ||
      value.tradingAccountSubscriptionId === args.expectedAssignmentId);

  const evidence = [
    ...position.orderIntents.filter(matches).map((item) => `OrderIntent:${item.id}`),
    ...(position.entryDecision && matches(position.entryDecision)
      ? [`EntryDecision:${position.entryDecision.id}`]
      : []),
    ...position.brokerOrders
      .filter((item) =>
        item.tradingAccountId === args.expectedAccountId &&
        item.orderIntent !== null &&
        matches(item.orderIntent)
      )
      .map((item) => `BrokerOrder:${item.id}/OrderIntent:${item.orderIntent!.id}`),
  ];

  const contradictory =
    position.orderIntents.some((item) => !matches(item)) ||
    (position.entryDecision !== null && !matches(position.entryDecision)) ||
    position.brokerOrders.some((item) =>
      item.tradingAccountId !== args.expectedAccountId ||
      (item.orderIntent !== null && !matches(item.orderIntent))
    );

  return { evidence, contradictory };
}

async function brokerClientOrderEvidence(
  db: RepairDb,
  position: PositionEvidence,
  args: RepairArgs
) {
  const events = await db.systemEvent.findMany({
    where: {
      type: {
        in: ['position.subscription_resolved', 'position.opened'],
      },
      entityType: 'trackedPosition',
      entityId: String(args.positionId),
    },
    select: {
      id: true,
      type: true,
      tradingAccountId: true,
      payloadJson: true,
    },
    orderBy: { id: 'asc' },
  });
  const resolutionEvents = events.filter(
    (event) => event.type === 'position.subscription_resolved'
  );
  const openedEvents = events.filter((event) => event.type === 'position.opened');
  const accountEvents = resolutionEvents.filter(
    (event) => event.tradingAccountId === args.expectedAccountId
  );
  const matchingEvents = accountEvents.filter((event) => {
    const resolved = eventResolution(event.payloadJson);
    return (
      resolved.source === 'broker_client_order_id' &&
      resolved.subscriptionId === args.expectedSubscriptionId &&
      resolved.subscriptionKey === args.expectedSubscriptionKey &&
      resolved.clientOrderIds.some(
        (clientOrderId) =>
          parseSubscriptionKeyFromClientOrderId(clientOrderId) ===
          args.expectedSubscriptionKey
      )
    );
  });
  if (matchingEvents.length === 0) {
    if (resolutionEvents.length > 0) {
      throw new Error('Contradictory position subscription-resolution event evidence exists.');
    }
    return null;
  }
  if (
    resolutionEvents.some((event) => {
      const resolved = eventResolution(event.payloadJson);
      return (
        event.tradingAccountId !== args.expectedAccountId ||
        resolved.source !== 'broker_client_order_id' ||
        resolved.subscriptionId !== args.expectedSubscriptionId ||
        resolved.subscriptionKey !== args.expectedSubscriptionKey ||
        resolved.clientOrderIds.length === 0 ||
        resolved.clientOrderIds.some(
          (clientOrderId) =>
            parseSubscriptionKeyFromClientOrderId(clientOrderId) !==
            args.expectedSubscriptionKey
        )
      );
    })
  ) {
    throw new Error('Contradictory position subscription-resolution event evidence exists.');
  }
  if (
    openedEvents.some((event) => {
      const payload = objectValue(event.payloadJson);
      return (
        event.tradingAccountId !== args.expectedAccountId ||
        payload?.symbol !== position.symbol ||
        payload?.subscriptionId !== args.expectedSubscriptionId ||
        payload?.subscriptionResolutionSource !== 'broker_client_order_id' ||
        payload?.subscriptionResolutionStatus !== 'resolved' ||
        typeof payload.qty !== 'number' ||
        !closeEnough(payload.qty, position.qty) ||
        typeof payload.avgEntryPrice !== 'number' ||
        !closeEnough(payload.avgEntryPrice, position.avgEntryPrice)
      );
    })
  ) {
    throw new Error('Contradictory position-opened event evidence exists.');
  }

  const clientOrderIds = new Set(
    matchingEvents.flatMap((event) => eventResolution(event.payloadJson).clientOrderIds)
  );
  if (clientOrderIds.size !== 1) {
    throw new Error('Broker-client-order evidence must identify exactly one client order ID.');
  }
  const clientOrderId = [...clientOrderIds][0]!;
  const openingFills = position.brokerActivities.filter(
    (activity) =>
      activity.activityType === 'FILL' &&
      activity.side?.toLowerCase() === 'buy' &&
      activity.tradingAccountId === args.expectedAccountId &&
      activity.symbol === position.symbol &&
      activity.brokerOrderRecord?.tradingAccountId === args.expectedAccountId &&
      activity.brokerOrderRecord.symbol === position.symbol &&
      activity.brokerOrderRecord.side.toLowerCase() === 'buy' &&
      activity.brokerOrderRecord.clientOrderId === clientOrderId
  );
  const contradictoryBuyFill = position.brokerActivities.some(
    (activity) =>
      activity.activityType === 'FILL' &&
      activity.side?.toLowerCase() === 'buy' &&
      !openingFills.includes(activity)
  );
  if (contradictoryBuyFill) {
    throw new Error('Contradictory linked opening activity evidence exists.');
  }
  if (openingFills.length === 0) {
    throw new Error('No account-scoped opening fills corroborate the client order ID.');
  }
  const brokerOrderIds = new Set(
    openingFills.map((fill) => fill.brokerOrderRecordId).filter((id) => id !== null)
  );
  if (brokerOrderIds.size !== 1) {
    throw new Error('Opening fills must corroborate exactly one BrokerOrder.');
  }
  const fillQty = openingFills.reduce((sum, fill) => sum + Math.abs(fill.qty ?? 0), 0);
  const fillNotional = openingFills.reduce(
    (sum, fill) => sum + Math.abs(fill.qty ?? 0) * (fill.price ?? 0),
    0
  );
  const weightedAverage = fillQty > 0 ? fillNotional / fillQty : 0;
  if (!closeEnough(fillQty, Math.abs(position.qty))) {
    throw new Error('Opening fill quantity does not match the tracked position.');
  }
  if (!closeEnough(weightedAverage, position.avgEntryPrice)) {
    throw new Error('Opening fill weighted-average price does not match the tracked position.');
  }

  return {
    evidenceClass: BROKER_CLIENT_ORDER_RESOLUTION_EVIDENCE,
    systemEventIds: matchingEvents.map((event) => event.id),
    positionOpenedEventIds: openedEvents.map((event) => event.id),
    clientOrderId,
    subscriptionKey: args.expectedSubscriptionKey,
    brokerOrderRecordId: [...brokerOrderIds][0],
    brokerActivityIds: openingFills.map((fill) => fill.id),
    fillQty,
    weightedAveragePrice: weightedAverage,
  };
}

async function loadPosition(db: RepairDb, positionId: number) {
  return db.trackedPosition.findUnique({
    where: { id: positionId },
    select: positionSelect,
  });
}

export async function repairTrackedPositionAttribution(
  args: RepairArgs,
  db: RepairDb = prisma
) {
  const assignments = await db.tradingAccountSubscription.findMany({
    where: {
      tradingAccountId: args.expectedAccountId,
      subscriptionId: args.expectedSubscriptionId,
    },
    select: {
      id: true,
      tradingAccountId: true,
      subscriptionId: true,
      subscription: { select: { key: true } },
    },
  });
  if (
    assignments.length !== 1 ||
    assignments[0]?.id !== args.expectedAssignmentId ||
    assignments[0].subscription.key !== args.expectedSubscriptionKey
  ) {
    throw new Error('Expected exactly one matching reviewed account assignment.');
  }

  const before = await loadPosition(db, args.positionId);
  if (!before) throw new Error(`TrackedPosition ${args.positionId} was not found.`);
  if (
    before.tradingAccountId !== args.expectedAccountId ||
    before.subscriptionId !== args.expectedCurrentSubscriptionId ||
    before.tradingAccountSubscriptionId !== args.expectedCurrentAssignmentId
  ) {
    throw new Error('TrackedPosition current attribution does not match the reviewed preconditions.');
  }
  if (
    before.subscriptionId !== null &&
    before.subscriptionId !== args.expectedSubscriptionId
  ) {
    throw new Error('Repair refuses to replace a non-null subscriptionId.');
  }
  if (
    before.tradingAccountSubscriptionId !== null &&
    before.tradingAccountSubscriptionId !== args.expectedAssignmentId
  ) {
    throw new Error('Repair refuses to replace a non-null assignment ID.');
  }

  const linked = linkedLifecycleEvidence(before, args);
  if (linked.contradictory) {
    throw new Error('Contradictory linked lifecycle ownership evidence exists.');
  }
  const broker = await brokerClientOrderEvidence(db, before, args);
  const evidenceSummary = broker ?? (
    linked.evidence.length > 0
      ? { evidenceClass: LINKED_LIFECYCLE_EVIDENCE, records: linked.evidence }
      : null
  );
  if (!evidenceSummary) {
    throw new Error('No accepted deterministic ownership evidence class was satisfied.');
  }

  const proposed = {
    ...(before.subscriptionId === null && {
      subscriptionId: args.expectedSubscriptionId,
    }),
    ...(before.tradingAccountSubscriptionId === null && {
      tradingAccountSubscriptionId: args.expectedAssignmentId,
    }),
  };
  if (Object.keys(proposed).length === 0) {
    throw new Error('No missing attribution field requires repair.');
  }
  if (!args.apply) {
    return { mode: 'dry-run' as const, evidenceSummary, before, proposed };
  }

  const after = await db.$transaction(async (tx) => {
    const updated = await tx.trackedPosition.updateMany({
      where: {
        id: args.positionId,
        tradingAccountId: args.expectedAccountId,
        subscriptionId: args.expectedCurrentSubscriptionId,
        tradingAccountSubscriptionId: args.expectedCurrentAssignmentId,
        updatedAt: before.updatedAt,
      },
      data: proposed,
    });
    if (updated.count !== 1) {
      throw new Error('Repair refused because the row changed after review.');
    }
    return loadPosition(tx as RepairDb, args.positionId);
  });
  return { mode: 'apply' as const, evidenceSummary, before, after };
}

function option(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function requiredString(name: string) {
  const value = option(name);
  if (!value) throw new Error(`--${name}=<value> is required.`);
  return value;
}

function requiredInt(name: string) {
  const parsed = Number(requiredString(name));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name}=<positive integer> is required.`);
  }
  return parsed;
}

function nullableInt(name: string) {
  const value = requiredString(name);
  if (value === 'null') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name}=null|<positive integer> is required.`);
  }
  return parsed;
}

export async function runTrackedPositionAttributionRepairCli() {
  const result = await repairTrackedPositionAttribution({
    positionId: requiredInt('position-id'),
    expectedAccountId: requiredInt('expected-account-id'),
    expectedCurrentSubscriptionId: nullableInt('expected-current-subscription-id'),
    expectedCurrentAssignmentId: nullableInt('expected-current-assignment-id'),
    expectedSubscriptionId: requiredInt('expected-subscription-id'),
    expectedSubscriptionKey: requiredString('expected-subscription-key'),
    expectedAssignmentId: requiredInt('expected-assignment-id'),
    apply: process.argv.includes('--apply'),
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function disconnectTrackedPositionAttributionRepairDb() {
  await prisma.$disconnect();
}
