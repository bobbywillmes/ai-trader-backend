-- Add the optional global catalog description before removing legacy
-- account-specific Subscription columns.
ALTER TABLE "Subscription"
ADD COLUMN "description" TEXT;

-- Abort if an account-owned legacy Subscription has no corresponding
-- account assignment. This makes the destructive portion deterministic.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Subscription" s
    WHERE s."tradingAccountId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "TradingAccountSubscription" tas
        WHERE tas."tradingAccountId" = s."tradingAccountId"
          AND tas."subscriptionId" = s.id
      )
  ) THEN
    RAISE EXCEPTION
      'Subscription catalog migration aborted: legacy account-owned subscriptions are missing TradingAccountSubscription rows. Run the diagnostic/bootstrap verification before deploying.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "TradingAccountSubscription" tas
    JOIN "Subscription" s ON s.id = tas."subscriptionId"
    WHERE s."tradingAccountId" IS NOT NULL
      AND tas."tradingAccountId" = s."tradingAccountId"
      AND (
        (tas."sizingType" = 'FIXED_QTY' AND
          (tas."fixedQty" IS NULL OR tas."fixedQty" <= 0))
        OR
        (tas."sizingType" = 'MAX_NOTIONAL' AND
          (tas."maxPositionNotional" IS NULL OR
           tas."maxPositionNotional" <= 0))
      )
  ) THEN
    RAISE EXCEPTION
      'Subscription catalog migration aborted: migrated account assignments contain invalid sizing.';
  END IF;
END $$;

DROP INDEX IF EXISTS "Subscription_tradingAccountId_enabled_idx";
DROP INDEX IF EXISTS "Subscription_tradingAccountId_symbol_idx";
DROP INDEX IF EXISTS "Subscription_tradingAccountId_idx";

ALTER TABLE "Subscription"
DROP CONSTRAINT IF EXISTS "Subscription_tradingAccountId_fkey";

ALTER TABLE "Subscription"
DROP COLUMN "tradingAccountId",
DROP COLUMN "broker",
DROP COLUMN "brokerMode",
DROP COLUMN "sizingType",
DROP COLUMN "sizingValue";
