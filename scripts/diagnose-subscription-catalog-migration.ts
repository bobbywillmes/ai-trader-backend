/// <reference types="node" />

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  buildSubscriptionCatalogMigrationDiagnostic,
  type LegacySubscriptionMapping,
} from "../src/services/subscription-catalog-migration-diagnostic.js";

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
      environment: true,
      maxDeployableNotional: true,
    },
    orderBy: { id: "asc" },
  });

  const legacySubscriptions = await prisma.$queryRaw<LegacySubscriptionMapping[]>`
    SELECT id, "tradingAccountId", enabled, key
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

  const result = buildSubscriptionCatalogMigrationDiagnostic({
    accounts,
    legacySubscriptions,
    assignments,
  });

  console.log(JSON.stringify({ accounts, ...result }, null, 2));

  if (!result.productionBaselineValid || !result.entryConfigurationValid) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
