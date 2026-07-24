/// <reference types="node" />

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  buildSubscriptionCatalogMigrationDiagnostic,
  type LegacySubscriptionMapping,
  type MigrationDiagnosticLifecycleReference,
} from "../src/services/subscription-catalog-migration-diagnostic.js";
import { buildCuratedSubscriptionKeys } from "../src/types/subscriptionTemplates.js";
import type { SeedSecurity } from "../src/types/securities.js";
import securitiesData from "../src/db/securities.json" with { type: "json" };

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

async function main() {
  const accounts = await prisma.tradingAccount.findMany({
    select: {
      id: true,
      displayName: true,
      broker: true,
      environment: true,
      maxDeployableNotional: true,
      riskSettings: {
        select: {
          enabled: true,
          maxDailyEntryOrders: true,
          maxDailyEntryNotional: true,
          maxOpenPositions: true,
          maxTotalOpenNotional: true,
          maxSymbolOpenNotional: true,
          maxSubscriptionOpenNotional: true,
        },
      },
    },
    orderBy: { id: "asc" },
  });

  const legacySubscriptions = await prisma.$queryRaw<LegacySubscriptionMapping[]>`
    SELECT
      id,
      key,
      "tradingAccountId",
      enabled,
      broker,
      "brokerMode",
      "sizingType",
      "sizingValue",
      "sizingValue"::text AS "sizingValueRaw"
    FROM "Subscription"
    WHERE "tradingAccountId" IS NOT NULL
    ORDER BY id ASC
  `;

  const assignments = await prisma.tradingAccountSubscription.findMany({
    select: {
      id: true,
      tradingAccountId: true,
      subscriptionId: true,
      allocationId: true,
      enabled: true,
      entriesEnabled: true,
      exitsEnabled: true,
      sizingType: true,
      fixedQty: true,
      maxPositionNotional: true,
      reservedNotional: true,
      subscription: {
        select: {
          key: true,
          enabled: true,
        },
      },
      allocation: {
        select: {
          id: true,
          tradingAccountId: true,
          key: true,
          name: true,
          enabled: true,
          maxAllocatedNotional: true,
          maxOpenPositions: true,
          maxPositionNotional: true,
        },
      },
    },
    orderBy: { id: "asc" },
  });

  const [orderIntents, trackedPositions, entryDecisions] = await Promise.all([
    prisma.orderIntent.findMany({
      where: { tradingAccountSubscriptionId: { not: null } },
      select: {
        id: true,
        tradingAccountSubscriptionId: true,
        tradingAccountId: true,
        subscriptionId: true,
      },
    }),
    prisma.trackedPosition.findMany({
      where: { tradingAccountSubscriptionId: { not: null } },
      select: {
        id: true,
        tradingAccountSubscriptionId: true,
        tradingAccountId: true,
        subscriptionId: true,
      },
    }),
    prisma.entryDecision.findMany({
      where: { tradingAccountSubscriptionId: { not: null } },
      select: {
        id: true,
        tradingAccountSubscriptionId: true,
        tradingAccountId: true,
        subscriptionId: true,
      },
    }),
  ]);

  const lifecycleReferences: MigrationDiagnosticLifecycleReference[] = [
    ...orderIntents.map((record) => ({
      model: "OrderIntent" as const,
      id: record.id,
      tradingAccountSubscriptionId: record.tradingAccountSubscriptionId!,
      tradingAccountId: record.tradingAccountId,
      subscriptionId: record.subscriptionId,
    })),
    ...trackedPositions.map((record) => ({
      model: "TrackedPosition" as const,
      id: record.id,
      tradingAccountSubscriptionId: record.tradingAccountSubscriptionId!,
      tradingAccountId: record.tradingAccountId,
      subscriptionId: record.subscriptionId,
    })),
    ...entryDecisions.map((record) => ({
      model: "EntryDecision" as const,
      id: record.id,
      tradingAccountSubscriptionId: record.tradingAccountSubscriptionId!,
      tradingAccountId: record.tradingAccountId,
      subscriptionId: record.subscriptionId,
    })),
  ];

  const expectedBobbyPaperKeys = buildCuratedSubscriptionKeys(
    securitiesData as SeedSecurity[]
  );

  const result = buildSubscriptionCatalogMigrationDiagnostic({
    accounts,
    legacySubscriptions,
    assignments,
    expectedBobbyPaperKeys,
    lifecycleReferences,
  });

  console.log(
    JSON.stringify(
      {
        conclusions: {
          schemaDropSafe: result.schemaDropSafe,
          productionBaselineValid: result.productionBaselineValid,
          runtimeEntryReady: result.runtimeEntryReady,
          overallDiagnosticPassed: result.overallDiagnosticPassed,
        },
        accounts,
        ...result,
      },
      null,
      2
    )
  );

  if (!result.overallDiagnosticPassed) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
