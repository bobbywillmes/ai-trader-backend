DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "TradingAccount"
    GROUP BY "accountHolderUserId", "broker", "environment"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add TradingAccount holder/broker/environment uniqueness: duplicate data exists.';
  END IF;
END $$;

CREATE UNIQUE INDEX "TradingAccount_holder_broker_environment_key"
ON "TradingAccount"("accountHolderUserId", "broker", "environment");
