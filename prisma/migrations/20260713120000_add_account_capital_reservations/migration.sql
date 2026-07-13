-- AlterTable
ALTER TABLE "TradingAccount" ADD COLUMN     "maxDeployableNotional" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "TradingAccountSubscription" ADD COLUMN     "reservedNotional" DOUBLE PRECISION;

-- Backfill deterministic subscription reservations wherever an existing
-- maxPositionNotional value is available. Other rows remain unresolved.
UPDATE "TradingAccountSubscription"
SET "reservedNotional" = "maxPositionNotional"
WHERE "maxPositionNotional" IS NOT NULL;

-- Backfill an account ceiling only when every enabled allocation has a known
-- budget. Accounts with incomplete enabled allocation budgets remain unresolved.
UPDATE "TradingAccount" AS account
SET "maxDeployableNotional" = allocation_totals."enabledAllocatedNotional"
FROM (
    SELECT
        allocation."tradingAccountId",
        SUM(allocation."maxAllocatedNotional") AS "enabledAllocatedNotional"
    FROM "TradingAccountAllocation" AS allocation
    WHERE allocation."enabled" = true
    GROUP BY allocation."tradingAccountId"
    HAVING COUNT(*) = COUNT(allocation."maxAllocatedNotional")
) AS allocation_totals
WHERE account."id" = allocation_totals."tradingAccountId";
