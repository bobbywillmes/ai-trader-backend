/// <reference types="node" />

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  assessLegacySubscriptionSourceColumns,
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
  const subscriptionColumns = await prisma.$queryRaw<{ columnName: string }[]>`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Subscription'
    ORDER BY ordinal_position ASC
  `;
  const legacySource = assessLegacySubscriptionSourceColumns(
    subscriptionColumns.map((column) => column.columnName)
  );

  if (!legacySource.legacySourceAvailable) {
    console.error(
      JSON.stringify(
        {
          diagnosticStatus: "LEGACY_SOURCE_UNAVAILABLE",
          message:
            "The connected database no longer contains every legacy Subscription source column required to prove migration fidelity.",
          conclusions: {
            schemaDropSafe: false,
            productionBaselineValid: null,
            runtimeEntryReady: null,
            overallDiagnosticPassed: false,
          },
          gateEvaluation: {
            schemaDropSafe:
              "FAILED: exact legacy-to-assignment fidelity cannot be reconstructed after source columns are removed.",
            productionBaselineValid:
              "NOT_EVALUATED: the authoritative preflight stopped at the missing legacy source boundary.",
            runtimeEntryReady:
              "NOT_EVALUATED: the authoritative preflight stopped at the missing legacy source boundary.",
          },
          legacySource,
          nextAction:
            "Run this command against the pre-migration production database before applying the legacy-column removal. Use retained pre-migration diagnostic evidence or a verified pre-migration backup for a database where the columns were already removed.",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

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
