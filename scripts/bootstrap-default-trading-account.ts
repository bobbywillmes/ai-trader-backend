/// <reference types="node" />

import "dotenv/config";
import {
  PrismaClient,
  TradingAccountAccessRole,
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

const BOOTSTRAP_NOTES =
  "Bootstrapped as the legacy single-account paper trading account. Broker credentials remain env-based until account credential storage is implemented.";


function optionalString(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number. Received: ${raw}`);
  }

  return parsed;
}

function optionalTradingEnvironment(
  name: string,
  fallback: TradingAccountEnvironment,
): TradingAccountEnvironment {
  const raw = process.env[name]?.trim().toUpperCase();

  if (!raw) {
    return fallback;
  }

  if (raw === TradingAccountEnvironment.PAPER) {
    return TradingAccountEnvironment.PAPER;
  }

  if (raw === TradingAccountEnvironment.LIVE) {
    return TradingAccountEnvironment.LIVE;
  }

  throw new Error(
    `${name} must be one of: ${Object.values(TradingAccountEnvironment).join(
      ", ",
    )}. Received: ${raw}`,
  );
}

async function main() {
  const ownerEmail = requireEnv("DEFAULT_TRADING_ACCOUNT_OWNER_EMAIL");
  const displayName = optionalString(
    "DEFAULT_TRADING_ACCOUNT_DISPLAY_NAME",
    "Bobby Paper",
  );
  const estimatedTradingCapital = optionalNumber(
    "DEFAULT_TRADING_ACCOUNT_CAPITAL",
    10_000,
  );
  const environment = optionalTradingEnvironment(
    "DEFAULT_TRADING_ACCOUNT_ENVIRONMENT",
    TradingAccountEnvironment.PAPER,
  );

  console.log("Bootstrapping default trading account...");
  console.log(`Owner email: ${ownerEmail}`);
  console.log(`Display name: ${displayName}`);
  console.log(`Broker: ${TradingBroker.ALPACA}`);
  console.log(`Environment: ${environment}`);
  console.log(`Estimated trading capital: ${estimatedTradingCapital}`);

  const owner = await prisma.adminUser.findFirst({
    where: {
      email: {
        equals: ownerEmail,
        mode: "insensitive",
      },
      enabled: true,
    },
  });

  if (!owner) {
    throw new Error(
      `No enabled AdminUser found for DEFAULT_TRADING_ACCOUNT_OWNER_EMAIL=${ownerEmail}`,
    );
  }

  console.log(`Found owner AdminUser id=${owner.id}`);

  const existingTradingAccount = await prisma.tradingAccount.findFirst({
    where: {
      ownerAdminUserId: owner.id,
      displayName,
      broker: TradingBroker.ALPACA,
      environment,
    },
  });

  const tradingAccount = existingTradingAccount
    ? await prisma.tradingAccount.update({
        where: {
          id: existingTradingAccount.id,
        },
        data: {
          estimatedTradingCapital,
          notes: existingTradingAccount.notes ?? BOOTSTRAP_NOTES,
        },
      })
    : await prisma.tradingAccount.create({
        data: {
          ownerAdminUserId: owner.id,
          displayName,
          broker: TradingBroker.ALPACA,
          environment,
          status: TradingAccountStatus.ACTIVE,

          // Safety defaults. The account exists, but the account-scoped runtime
          // should not be allowed to trade until explicitly enabled later.
          tradingEnabled: false,
          killSwitchEnabled: true,

          estimatedTradingCapital,
          baseCurrency: "USD",
          notes: BOOTSTRAP_NOTES,
        },
      });

  console.log(
    existingTradingAccount
      ? `Using existing TradingAccount id=${tradingAccount.id}`
      : `Created TradingAccount id=${tradingAccount.id}`,
  );

  const existingAccess = await prisma.tradingAccountAccess.findUnique({
    where: {
      tradingAccountId_adminUserId: {
        tradingAccountId: tradingAccount.id,
        adminUserId: owner.id,
      },
    },
  });

  const accessData = {
    role: TradingAccountAccessRole.OWNER,
    canView: true,
    canPauseTrading: true,
    canResumeTrading: true,
    canEditRiskSettings: true,
    canEditStrategySettings: true,
    canEditCredentials: true,
    canManageAccess: true,
  };

  if (existingAccess) {
    await prisma.tradingAccountAccess.update({
      where: {
        id: existingAccess.id,
      },
      data: accessData,
    });

    console.log(`Updated TradingAccountAccess id=${existingAccess.id}`);
  } else {
    const access = await prisma.tradingAccountAccess.create({
      data: {
        tradingAccountId: tradingAccount.id,
        adminUserId: owner.id,
        ...accessData,
      },
    });

    console.log(`Created TradingAccountAccess id=${access.id}`);
  }

  console.log("Backfilling existing single-account trading records...");

  const [
    subscriptions,
    orderIntents,
    brokerOrders,
    brokerActivities,
    trackedPositions,
    accountSnapshots,
    entryDecisions,
    alpacaApiUsageBuckets,
  ] = await prisma.$transaction([
    prisma.subscription.updateMany({
      where: {
        tradingAccountId: null,
      },
      data: {
        tradingAccountId: tradingAccount.id,
      },
    }),
    prisma.orderIntent.updateMany({
      where: {
        tradingAccountId: null,
      },
      data: {
        tradingAccountId: tradingAccount.id,
      },
    }),
    prisma.brokerOrder.updateMany({
      where: {
        tradingAccountId: null,
      },
      data: {
        tradingAccountId: tradingAccount.id,
      },
    }),
    prisma.brokerActivity.updateMany({
      where: {
        tradingAccountId: null,
      },
      data: {
        tradingAccountId: tradingAccount.id,
      },
    }),
    prisma.trackedPosition.updateMany({
      where: {
        tradingAccountId: null,
      },
      data: {
        tradingAccountId: tradingAccount.id,
      },
    }),
    prisma.accountSnapshot.updateMany({
      where: {
        tradingAccountId: null,
      },
      data: {
        tradingAccountId: tradingAccount.id,
      },
    }),
    prisma.entryDecision.updateMany({
      where: {
        tradingAccountId: null,
      },
      data: {
        tradingAccountId: tradingAccount.id,
      },
    }),
    prisma.alpacaApiUsageBucket.updateMany({
      where: {
        tradingAccountId: null,
      },
      data: {
        tradingAccountId: tradingAccount.id,
      },
    }),
  ]);

  console.log("Backfill complete:");
  console.log(`- Subscription: ${subscriptions.count}`);
  console.log(`- OrderIntent: ${orderIntents.count}`);
  console.log(`- BrokerOrder: ${brokerOrders.count}`);
  console.log(`- BrokerActivity: ${brokerActivities.count}`);
  console.log(`- TrackedPosition: ${trackedPositions.count}`);
  console.log(`- AccountSnapshot: ${accountSnapshots.count}`);
  console.log(`- EntryDecision: ${entryDecisions.count}`);
  console.log(`- AlpacaApiUsageBucket: ${alpacaApiUsageBuckets.count}`);

  console.log("");
  console.log("Default trading account bootstrap finished successfully.");
  console.log(`TradingAccount id=${tradingAccount.id}`);
  console.log("");
  console.log("SystemEvent rows were intentionally not backfilled.");
  console.log(
    "Many historical SystemEvent rows are global worker/app events rather than account-specific events.",
  );
}

main()
  .catch((error) => {
    console.error("Default trading account bootstrap failed.");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });