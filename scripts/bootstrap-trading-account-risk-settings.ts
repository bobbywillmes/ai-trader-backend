/// <reference types="node" />

import "dotenv/config";
import {
  PrismaClient,
  TradingAccountEnvironment,
  TradingAccountStatus,
  TradingBroker,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const GLOBAL_RISK_LIMIT_DEFAULTS = {
  maxDailyEntryOrders: 5,
  maxDailyEntryNotional: 10_000,
  maxOpenPositions: 5,
  maxTotalOpenNotional: 25_000,
  maxSymbolOpenNotional: 5_000,
  maxSubscriptionOpenNotional: 5_000,
} as const;

const BOOTSTRAP_NOTES =
  "Bootstrapped from global entry risk settings. Global settings remain backend-wide emergency caps.";

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

function parseNullableNumber(
  value: string | undefined,
  fallback: number | null,
): number | null {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "" || normalized === "null") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

async function getGlobalRiskLimits() {
  const settings = await prisma.setting.findMany({
    where: {
      key: {
        in: Object.keys(GLOBAL_RISK_LIMIT_DEFAULTS),
      },
    },
  });
  const settingMap = new Map(settings.map((setting) => [setting.key, setting.value]));

  return {
    maxDailyEntryOrders: parseNullableNumber(
      settingMap.get("maxDailyEntryOrders"),
      GLOBAL_RISK_LIMIT_DEFAULTS.maxDailyEntryOrders,
    ),
    maxDailyEntryNotional: parseNullableNumber(
      settingMap.get("maxDailyEntryNotional"),
      GLOBAL_RISK_LIMIT_DEFAULTS.maxDailyEntryNotional,
    ),
    maxOpenPositions: parseNullableNumber(
      settingMap.get("maxOpenPositions"),
      GLOBAL_RISK_LIMIT_DEFAULTS.maxOpenPositions,
    ),
    maxTotalOpenNotional: parseNullableNumber(
      settingMap.get("maxTotalOpenNotional"),
      GLOBAL_RISK_LIMIT_DEFAULTS.maxTotalOpenNotional,
    ),
    maxSymbolOpenNotional: parseNullableNumber(
      settingMap.get("maxSymbolOpenNotional"),
      GLOBAL_RISK_LIMIT_DEFAULTS.maxSymbolOpenNotional,
    ),
    maxSubscriptionOpenNotional: parseNullableNumber(
      settingMap.get("maxSubscriptionOpenNotional"),
      GLOBAL_RISK_LIMIT_DEFAULTS.maxSubscriptionOpenNotional,
    ),
  };
}

async function main() {
  console.log("Bootstrapping trading account risk settings...");

  const tradingAccount = await resolveDefaultTradingAccount();

  console.log(
    `Using TradingAccount id=${tradingAccount.id}, displayName="${tradingAccount.displayName}"`,
  );

  const globalRiskLimits = await getGlobalRiskLimits();

  const riskSettings = await prisma.tradingAccountRiskSettings.upsert({
    where: {
      tradingAccountId: tradingAccount.id,
    },
    update: {
      enabled: true,
      ...globalRiskLimits,
      notes: BOOTSTRAP_NOTES,
    },
    create: {
      tradingAccountId: tradingAccount.id,
      enabled: true,
      ...globalRiskLimits,
      notes: BOOTSTRAP_NOTES,
    },
  });

  console.log(`Upserted TradingAccountRiskSettings id=${riskSettings.id}.`);
  console.log("Copied global risk limits:");
  console.log(`- maxDailyEntryOrders: ${riskSettings.maxDailyEntryOrders}`);
  console.log(`- maxDailyEntryNotional: ${riskSettings.maxDailyEntryNotional}`);
  console.log(`- maxOpenPositions: ${riskSettings.maxOpenPositions}`);
  console.log(`- maxTotalOpenNotional: ${riskSettings.maxTotalOpenNotional}`);
  console.log(`- maxSymbolOpenNotional: ${riskSettings.maxSymbolOpenNotional}`);
  console.log(
    `- maxSubscriptionOpenNotional: ${riskSettings.maxSubscriptionOpenNotional}`,
  );
  console.log("");
  console.log("Trading account risk settings bootstrap finished successfully.");
}

main()
  .catch((error) => {
    console.error("Trading account risk settings bootstrap failed.");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
