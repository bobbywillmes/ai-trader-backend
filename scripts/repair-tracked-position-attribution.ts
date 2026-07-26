import { prisma } from '../src/db/prisma.js';

function option(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function requiredInt(name: string) {
  const value = option(name);
  const parsed = value === undefined ? NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name}=<positive integer> is required.`);
  }
  return parsed;
}

function nullableInt(name: string) {
  const value = option(name);
  if (value === 'null') return null;
  const parsed = value === undefined ? NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name}=null|<positive integer> is required.`);
  }
  return parsed;
}

const args = {
  positionId: requiredInt('position-id'),
  expectedAccountId: requiredInt('expected-account-id'),
  expectedCurrentSubscriptionId: nullableInt('expected-current-subscription-id'),
  expectedCurrentAssignmentId: nullableInt('expected-current-assignment-id'),
  expectedSubscriptionId: requiredInt('expected-subscription-id'),
  expectedAssignmentId: requiredInt('expected-assignment-id'),
  apply: process.argv.includes('--apply'),
};

const select = {
  id: true,
  symbol: true,
  status: true,
  tradingAccountId: true,
  subscriptionId: true,
  tradingAccountSubscriptionId: true,
  updatedAt: true,
  configSnapshotJson: true,
  orderIntents: {
    select: {
      id: true,
      tradingAccountId: true,
      subscriptionId: true,
      tradingAccountSubscriptionId: true,
      clientOrderId: true,
    },
  },
  entryDecision: {
    select: {
      id: true,
      tradingAccountId: true,
      subscriptionId: true,
      tradingAccountSubscriptionId: true,
    },
  },
  brokerOrders: {
    select: {
      id: true,
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
    select: { id: true, tradingAccountId: true, activityType: true },
  },
} as const;

function matchingOwnershipEvidence(position: Awaited<ReturnType<typeof loadPosition>>) {
  if (!position) return [];
  const matches = (value: {
    tradingAccountId: number | null;
    subscriptionId: number | null;
    tradingAccountSubscriptionId: number | null;
  }) =>
    value.tradingAccountId === args.expectedAccountId &&
    value.subscriptionId === args.expectedSubscriptionId &&
    (value.tradingAccountSubscriptionId === null ||
      value.tradingAccountSubscriptionId === args.expectedAssignmentId);

  return [
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
}

async function loadPosition(client = prisma) {
  return client.trackedPosition.findUnique({
    where: { id: args.positionId },
    select,
  });
}

async function main() {
  const assignment = await prisma.tradingAccountSubscription.findUnique({
    where: { id: args.expectedAssignmentId },
    select: { id: true, tradingAccountId: true, subscriptionId: true },
  });
  if (
    !assignment ||
    assignment.tradingAccountId !== args.expectedAccountId ||
    assignment.subscriptionId !== args.expectedSubscriptionId
  ) {
    throw new Error('Expected assignment does not match the expected account and subscription.');
  }

  const duplicateCount = await prisma.tradingAccountSubscription.count({
    where: {
      tradingAccountId: args.expectedAccountId,
      subscriptionId: args.expectedSubscriptionId,
    },
  });
  if (duplicateCount !== 1) {
    throw new Error(`Expected exactly one account assignment; found ${duplicateCount}.`);
  }

  const before = await loadPosition();
  if (!before) throw new Error(`TrackedPosition ${args.positionId} was not found.`);
  if (
    before.tradingAccountId !== args.expectedAccountId ||
    before.subscriptionId !== args.expectedCurrentSubscriptionId ||
    before.tradingAccountSubscriptionId !== args.expectedCurrentAssignmentId
  ) {
    throw new Error('TrackedPosition current attribution does not match the reviewed preconditions.');
  }

  const evidence = matchingOwnershipEvidence(before);
  if (evidence.length === 0) {
    throw new Error('No linked OrderIntent, EntryDecision, or BrokerOrder provides exact ownership evidence.');
  }

  const proposed = {
    ...(before.subscriptionId === null && {
      subscriptionId: args.expectedSubscriptionId,
    }),
    ...(before.tradingAccountSubscriptionId === null && {
      tradingAccountSubscriptionId: args.expectedAssignmentId,
    }),
  };
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
  if (Object.keys(proposed).length === 0) {
    throw new Error('No missing attribution field requires repair.');
  }

  if (!args.apply) {
    console.log(JSON.stringify({ mode: 'dry-run', evidence, before, proposed }, null, 2));
    return;
  }

  const after = await prisma.$transaction(async (tx) => {
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
    return loadPosition(tx);
  });

  console.log(JSON.stringify({ mode: 'apply', evidence, before, after }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
