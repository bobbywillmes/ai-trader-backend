-- Phase 1 preflight: fail before replacing any global identity constraint.
DO $$
DECLARE
  duplicate_count BIGINT;
  unattributed_activity_count BIGINT;
  unattributed_order_count BIGINT;
  unattributed_snapshot_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO unattributed_activity_count
  FROM "BrokerActivity"
  WHERE "tradingAccountId" IS NULL;

  SELECT COUNT(*) INTO unattributed_order_count
  FROM "BrokerOrder"
  WHERE "tradingAccountId" IS NULL;

  SELECT COUNT(*) INTO unattributed_snapshot_count
  FROM "AccountSnapshot"
  WHERE "tradingAccountId" IS NULL;

  RAISE NOTICE
    'Historical unattributed rows: BrokerActivity=%, BrokerOrder=%, AccountSnapshot=%',
    unattributed_activity_count,
    unattributed_order_count,
    unattributed_snapshot_count;

  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT "tradingAccountId", "broker", "mode", "activityId"
    FROM "BrokerActivity"
    WHERE "tradingAccountId" IS NOT NULL
    GROUP BY "tradingAccountId", "broker", "mode", "activityId"
    HAVING COUNT(*) > 1
  ) duplicates;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'BrokerActivity has % duplicate attributed account/broker/mode/activityId identities',
      duplicate_count;
  END IF;

  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT "tradingAccountId", "broker", "brokerOrderId"
    FROM "BrokerOrder"
    WHERE "tradingAccountId" IS NOT NULL
    GROUP BY "tradingAccountId", "broker", "brokerOrderId"
    HAVING COUNT(*) > 1
  ) duplicates;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'BrokerOrder has % duplicate attributed account/broker/brokerOrderId identities',
      duplicate_count;
  END IF;

  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT "tradingAccountId", "broker", "clientOrderId"
    FROM "BrokerOrder"
    WHERE "tradingAccountId" IS NOT NULL
    GROUP BY "tradingAccountId", "broker", "clientOrderId"
    HAVING COUNT(*) > 1
  ) duplicates;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'BrokerOrder has % duplicate attributed account/broker/clientOrderId identities',
      duplicate_count;
  END IF;

  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT "tradingAccountId", "runKey"
    FROM "AccountSnapshot"
    WHERE "tradingAccountId" IS NOT NULL
      AND "runKey" IS NOT NULL
    GROUP BY "tradingAccountId", "runKey"
    HAVING COUNT(*) > 1
  ) duplicates;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'AccountSnapshot has % duplicate attributed account/runKey identities',
      duplicate_count;
  END IF;

  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT "tradingAccountId", "bucketStart", "operation", "endpoint", "method", "requestClass"
    FROM "AlpacaApiUsageBucket"
    WHERE "tradingAccountId" IS NOT NULL
    GROUP BY "tradingAccountId", "bucketStart", "operation", "endpoint", "method", "requestClass"
    HAVING COUNT(*) > 1
  ) duplicates;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'AlpacaApiUsageBucket has % duplicate attributed account-scoped aggregate identities',
      duplicate_count;
  END IF;

  SELECT COUNT(*) INTO duplicate_count
  FROM "BrokerActivity" activity
  JOIN "TradingAccount" account ON account."id" = activity."tradingAccountId"
  WHERE LOWER(activity."broker") <> LOWER(account."broker"::text)
     OR LOWER(activity."mode") <> LOWER(account."environment"::text);
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'BrokerActivity has % rows whose broker/mode contradicts the owning TradingAccount',
      duplicate_count;
  END IF;

  SELECT COUNT(*) INTO duplicate_count
  FROM "BrokerOrder" broker_order
  JOIN "TradingAccount" account ON account."id" = broker_order."tradingAccountId"
  WHERE LOWER(broker_order."broker") <> LOWER(account."broker"::text);
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'BrokerOrder has % rows whose broker contradicts the owning TradingAccount',
      duplicate_count;
  END IF;
END $$;

CREATE UNIQUE INDEX "BrokerActivity_account_broker_mode_activityId_key"
  ON "BrokerActivity" ("tradingAccountId", "broker", "mode", "activityId")
  WHERE "tradingAccountId" IS NOT NULL;

CREATE UNIQUE INDEX "BrokerActivity_legacy_broker_mode_activityId_key"
  ON "BrokerActivity" ("broker", "mode", "activityId")
  WHERE "tradingAccountId" IS NULL;

CREATE UNIQUE INDEX "BrokerOrder_account_broker_brokerOrderId_key"
  ON "BrokerOrder" ("tradingAccountId", "broker", "brokerOrderId")
  WHERE "tradingAccountId" IS NOT NULL;

CREATE UNIQUE INDEX "BrokerOrder_legacy_broker_brokerOrderId_key"
  ON "BrokerOrder" ("broker", "brokerOrderId")
  WHERE "tradingAccountId" IS NULL;

CREATE UNIQUE INDEX "BrokerOrder_account_broker_clientOrderId_key"
  ON "BrokerOrder" ("tradingAccountId", "broker", "clientOrderId")
  WHERE "tradingAccountId" IS NOT NULL;

CREATE UNIQUE INDEX "BrokerOrder_legacy_broker_clientOrderId_key"
  ON "BrokerOrder" ("broker", "clientOrderId")
  WHERE "tradingAccountId" IS NULL;

CREATE UNIQUE INDEX "AccountSnapshot_account_runKey_key"
  ON "AccountSnapshot" ("tradingAccountId", "runKey")
  WHERE "tradingAccountId" IS NOT NULL AND "runKey" IS NOT NULL;

CREATE UNIQUE INDEX "AccountSnapshot_legacy_runKey_key"
  ON "AccountSnapshot" ("runKey")
  WHERE "tradingAccountId" IS NULL AND "runKey" IS NOT NULL;

CREATE UNIQUE INDEX "AlpacaApiUsageBucket_account_scope_key"
  ON "AlpacaApiUsageBucket" (
    "tradingAccountId",
    "bucketStart",
    "operation",
    "endpoint",
    "method",
    "requestClass"
  )
  WHERE "tradingAccountId" IS NOT NULL;

CREATE UNIQUE INDEX "AlpacaApiUsageBucket_legacy_scope_key"
  ON "AlpacaApiUsageBucket" (
    "bucketStart",
    "operation",
    "endpoint",
    "method",
    "requestClass"
  )
  WHERE "tradingAccountId" IS NULL;

DROP INDEX "BrokerActivity_activityId_key";
DROP INDEX "BrokerOrder_broker_brokerOrderId_key";
DROP INDEX "BrokerOrder_broker_clientOrderId_key";
DROP INDEX "AccountSnapshot_runKey_key";
DROP INDEX "AlpacaApiUsageBucket_bucketStart_operation_endpoint_method_requestClass_key";
