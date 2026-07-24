DO $$
DECLARE
  missing_allocation_count integer;
  cross_account_allocation_count integer;
BEGIN
  SELECT COUNT(*)
  INTO missing_allocation_count
  FROM "TradingAccountSubscription" AS assignment
  LEFT JOIN "TradingAccountAllocation" AS allocation
    ON allocation."id" = assignment."allocationId"
  WHERE assignment."allocationId" IS NOT NULL
    AND allocation."id" IS NULL;

  IF missing_allocation_count > 0 THEN
    RAISE EXCEPTION
      'Account-owned subscription allocation migration aborted: % assignment(s) reference a missing TradingAccountAllocation.',
      missing_allocation_count;
  END IF;

  SELECT COUNT(*)
  INTO cross_account_allocation_count
  FROM "TradingAccountSubscription" AS assignment
  INNER JOIN "TradingAccountAllocation" AS allocation
    ON allocation."id" = assignment."allocationId"
  WHERE assignment."allocationId" IS NOT NULL
    AND assignment."tradingAccountId" <> allocation."tradingAccountId";

  IF cross_account_allocation_count > 0 THEN
    RAISE EXCEPTION
      'Account-owned subscription allocation migration aborted: % assignment(s) reference a TradingAccountAllocation owned by another TradingAccount.',
      cross_account_allocation_count;
  END IF;
END
$$;

ALTER TABLE "TradingAccountAllocation"
ADD CONSTRAINT "TradingAccountAllocation_id_tradingAccountId_key"
UNIQUE ("id", "tradingAccountId");

ALTER TABLE "TradingAccountSubscription"
DROP CONSTRAINT "TradingAccountSubscription_allocationId_fkey";

ALTER TABLE "TradingAccountSubscription"
ADD CONSTRAINT "TradingAccountSubscription_allocationId_tradingAccountId_fkey"
FOREIGN KEY ("allocationId", "tradingAccountId")
REFERENCES "TradingAccountAllocation"("id", "tradingAccountId")
ON DELETE RESTRICT
ON UPDATE RESTRICT;
