/// <reference types="node" />

import "dotenv/config";
import { PrismaClient, TradingAccountEnvironment } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

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
      _count: { select: { accountSubscriptions: true } },
    },
    orderBy: { id: "asc" },
  });

  const invalidAssignments = await prisma.tradingAccountSubscription.findMany({
    where: {
      OR: [
        { allocationId: null },
        { allocation: { enabled: false } },
        {
          sizingType: "FIXED_QTY",
          OR: [{ fixedQty: null }, { fixedQty: { lte: 0 } }],
        },
        {
          sizingType: "MAX_NOTIONAL",
          OR: [
            { maxPositionNotional: null },
            { maxPositionNotional: { lte: 0 } },
          ],
        },
      ],
    },
    select: {
      id: true,
      tradingAccountId: true,
      subscriptionId: true,
      allocationId: true,
      sizingType: true,
      fixedQty: true,
      maxPositionNotional: true,
    },
  });

  const liveAssignmentCount = accounts
    .filter((account) => account.environment === TradingAccountEnvironment.LIVE)
    .reduce((total, account) => total + account._count.accountSubscriptions, 0);
  const bobbyPaper = accounts.find(
    (account) =>
      account.displayName === "Bobby Paper" &&
      account.environment === TradingAccountEnvironment.PAPER
  );
  const bobbyLive = accounts.find(
    (account) =>
      account.displayName === "Bobby Live" &&
      account.environment === TradingAccountEnvironment.LIVE
  );
  const bobbyPaperAssignmentCount =
    bobbyPaper?._count.accountSubscriptions ?? null;
  const bobbyLiveAssignmentCount =
    bobbyLive?._count.accountSubscriptions ?? null;
  const productionBaselineValid =
    bobbyPaperAssignmentCount === 25 &&
    bobbyLiveAssignmentCount === 0;

  console.log(JSON.stringify({
    accounts,
    invalidAssignments,
    liveAssignmentCount,
    bobbyPaperAssignmentCount,
    bobbyLiveAssignmentCount,
    productionBaselineValid,
    safeToDropLegacyFields:
      invalidAssignments.length === 0 && productionBaselineValid,
  }, null, 2));

  if (invalidAssignments.length > 0 || !productionBaselineValid) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
