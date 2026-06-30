/// <reference types="node" />

import "dotenv/config";
import {
  PositionSizingType,
  PrismaClient,
  TradingAccountEnvironment,
  TradingAccountStatus,
  TradingBroker,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const adapter = new PrismaPg({
  connectionString: requireEnv("DATABASE_URL"),
});

const prisma = new PrismaClient({ adapter });

function parseLegacySizing(subscription: {
  sizingType: string;
  sizingValue: number;
}): {
  sizingType: PositionSizingType;
  fixedQty: number | null;
  maxPositionNotional: number | null;
} {
  const legacySizingType = subscription.sizingType.trim().toLowerCase();

  if (
    legacySizingType === "fixed_qty" ||
    legacySizingType === "fixedqty" ||
    legacySizingType === "qty"
  ) {
    return {
      sizingType: PositionSizingType.FIXED_QTY,
      fixedQty: subscription.sizingValue,
      maxPositionNotional: null,
    };
  }

  if (
    legacySizingType === "max_notional" ||
    legacySizingType === "maxnotional" ||
    legacySizingType === "max_capital" ||
    legacySizingType === "maxcapital"
  ) {
    return {
      sizingType: PositionSizingType.MAX_NOTIONAL,
      fixedQty: null,
      maxPositionNotional: subscription.sizingValue,
    };
  }

  console.warn(
    `Unknown legacy sizingType "${subscription.sizingType}". Falling back to FIXED_QTY.`,
  );

  return {
    sizingType: PositionSizingType.FIXED_QTY,
    fixedQty: subscription.sizingValue,
    maxPositionNotional: null,
  };
}

async function resolveDefaultTradingAccount() {
  const rawId = process.env.DEFAULT_TRADING_ACCOUNT_ID?.trim();

  if (rawId) {
    const id = Number(rawId);

    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(
        `DEFAULT_TRADING_ACCOUNT_ID must be a positive integer. Received: ${rawId}`,
      );
    }

    const account = await prisma.tradingAccount.findUnique({
      where: { id },
    });

    if (!account) {
      throw new Error(`No TradingAccount found for id=${id}`);
    }

    return account;
  }

  const account = await prisma.tradingAccount.findFirst({
    where: {
      broker: TradingBroker.ALPACA,
      environment: TradingAccountEnvironment.PAPER,
      displayName: "Bobby Paper",
      status: TradingAccountStatus.ACTIVE,
    },
    orderBy: { id: "asc" },
  });

  if (!account) {
    throw new Error(
      [
        "No default TradingAccount could be resolved.",
        "Set DEFAULT_TRADING_ACCOUNT_ID or run scripts/bootstrap-default-trading-account.ts first.",
      ].join(" "),
    );
  }

  return account;
}

async function main() {
  console.log("Bootstrapping trading account subscriptions...");

  const tradingAccount = await resolveDefaultTradingAccount();

  console.log(
    `Using TradingAccount id=${tradingAccount.id}, displayName="${tradingAccount.displayName}"`,
  );

  const subscriptions = await prisma.subscription.findMany({
    where: {
      OR: [{ tradingAccountId: tradingAccount.id }, { tradingAccountId: null }],
    },
    orderBy: [{ symbol: "asc" }, { key: "asc" }],
  });

  console.log(`Found ${subscriptions.length} Subscription rows to inspect.`);

  let createdCount = 0;
  let existingCount = 0;

  for (const subscription of subscriptions) {
    const existing = await prisma.tradingAccountSubscription.findUnique({
      where: {
        tradingAccountId_subscriptionId: {
          tradingAccountId: tradingAccount.id,
          subscriptionId: subscription.id,
        },
      },
    });

    if (existing) {
      existingCount += 1;
      continue;
    }

    const sizing = parseLegacySizing({
      sizingType: subscription.sizingType,
      sizingValue: subscription.sizingValue,
    });

    await prisma.tradingAccountSubscription.create({
      data: {
        tradingAccountId: tradingAccount.id,
        subscriptionId: subscription.id,
        allocationId: null,

        enabled: subscription.enabled,
        entriesEnabled: subscription.enabled,
        exitsEnabled: true,

        sizingType: sizing.sizingType,
        fixedQty: sizing.fixedQty,
        maxPositionNotional: sizing.maxPositionNotional,

        notes:
          "Bootstrapped from legacy Subscription sizing fields. Allocation intentionally left unset.",
      },
    });

    createdCount += 1;
  }

  console.log(`Created ${createdCount} TradingAccountSubscription rows.`);
  console.log(`Skipped ${existingCount} existing TradingAccountSubscription rows.`);

  const accountSubscriptions =
    await prisma.tradingAccountSubscription.findMany({
      where: {
        tradingAccountId: tradingAccount.id,
      },
      select: {
        id: true,
        tradingAccountId: true,
        subscriptionId: true,
      },
    });

  const accountSubscriptionBySubscriptionId = new Map(
    accountSubscriptions.map((accountSubscription) => [
      accountSubscription.subscriptionId,
      accountSubscription.id,
    ]),
  );

  console.log("Backfilling lifecycle rows with tradingAccountSubscriptionId...");

  let orderIntentBackfillCount = 0;
  let trackedPositionBackfillCount = 0;
  let entryDecisionBackfillCount = 0;

  for (const [
    subscriptionId,
    tradingAccountSubscriptionId,
  ] of accountSubscriptionBySubscriptionId.entries()) {
    const [orderIntents, trackedPositions, entryDecisions] =
      await prisma.$transaction([
        prisma.orderIntent.updateMany({
          where: {
            tradingAccountId: tradingAccount.id,
            subscriptionId,
            tradingAccountSubscriptionId: null,
          },
          data: {
            tradingAccountSubscriptionId,
          },
        }),
        prisma.trackedPosition.updateMany({
          where: {
            tradingAccountId: tradingAccount.id,
            subscriptionId,
            tradingAccountSubscriptionId: null,
          },
          data: {
            tradingAccountSubscriptionId,
          },
        }),
        prisma.entryDecision.updateMany({
          where: {
            tradingAccountId: tradingAccount.id,
            subscriptionId,
            tradingAccountSubscriptionId: null,
          },
          data: {
            tradingAccountSubscriptionId,
          },
        }),
      ]);

    orderIntentBackfillCount += orderIntents.count;
    trackedPositionBackfillCount += trackedPositions.count;
    entryDecisionBackfillCount += entryDecisions.count;
  }

  console.log("Lifecycle backfill complete:");
  console.log(`- OrderIntent: ${orderIntentBackfillCount}`);
  console.log(`- TrackedPosition: ${trackedPositionBackfillCount}`);
  console.log(`- EntryDecision: ${entryDecisionBackfillCount}`);

  console.log("");
  console.log("Trading account subscription bootstrap finished successfully.");
}

main()
  .catch((error) => {
    console.error("Trading account subscription bootstrap failed.");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });