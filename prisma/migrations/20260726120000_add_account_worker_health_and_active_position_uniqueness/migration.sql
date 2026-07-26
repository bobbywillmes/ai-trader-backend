CREATE TABLE "TradingAccountWorkerHealthState" (
    "id" SERIAL NOT NULL,
    "tradingAccountId" INTEGER NOT NULL,
    "workerKey" TEXT NOT NULL,
    "processInstanceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "applicable" BOOLEAN NOT NULL DEFAULT true,
    "eligible" BOOLEAN NOT NULL DEFAULT true,
    "eligibilityReason" TEXT,
    "expectedIntervalMs" INTEGER NOT NULL,
    "currentRunStartedAt" TIMESTAMP(3),
    "lastTickStartedAt" TIMESTAMP(3),
    "lastTickCompletedAt" TIMESTAMP(3),
    "lastSucceededAt" TIMESTAMP(3),
    "lastWorkSucceededAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "lastDurationMs" INTEGER,
    "lastOutcome" TEXT,
    "lastSkipReason" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "totalRuns" INTEGER NOT NULL DEFAULT 0,
    "totalFailures" INTEGER NOT NULL DEFAULT 0,
    "totalSkips" INTEGER NOT NULL DEFAULT 0,
    "totalLockSkips" INTEGER NOT NULL DEFAULT 0,
    "lastLockSkippedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "backoffUntil" TIMESTAMP(3),
    "lastSummaryJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TradingAccountWorkerHealthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TradingAccountWorkerHealthState_tradingAccountId_workerKey_key"
ON "TradingAccountWorkerHealthState"("tradingAccountId", "workerKey");
CREATE INDEX "TradingAccountWorkerHealthState_workerKey_idx" ON "TradingAccountWorkerHealthState"("workerKey");
CREATE INDEX "TradingAccountWorkerHealthState_updatedAt_idx" ON "TradingAccountWorkerHealthState"("updatedAt");
CREATE INDEX "TradingAccountWorkerHealthState_backoffUntil_idx" ON "TradingAccountWorkerHealthState"("backoffUntil");
CREATE INDEX "TradingAccountWorkerHealthState_currentRunStartedAt_idx" ON "TradingAccountWorkerHealthState"("currentRunStartedAt");
ALTER TABLE "TradingAccountWorkerHealthState"
ADD CONSTRAINT "TradingAccountWorkerHealthState_tradingAccountId_fkey"
FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
DECLARE duplicate_count integer;
DECLARE duplicate_identifiers text;
BEGIN
  SELECT COUNT(*), string_agg(format('account=%s broker=%s symbol=%s count=%s',
    "tradingAccountId", broker, symbol, cycle_count), '; ')
  INTO duplicate_count, duplicate_identifiers
  FROM (
    SELECT "tradingAccountId", lower(broker) AS broker, upper(symbol) AS symbol, COUNT(*) AS cycle_count
    FROM "TrackedPosition"
    WHERE "tradingAccountId" IS NOT NULL AND status IN ('open', 'closing')
    GROUP BY "tradingAccountId", lower(broker), upper(symbol)
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'Active tracked-position uniqueness preflight failed: % duplicate group(s): %',
      duplicate_count, duplicate_identifiers;
  END IF;
END $$;

CREATE UNIQUE INDEX "TrackedPosition_active_account_broker_symbol_key"
ON "TrackedPosition"("tradingAccountId", lower(broker), upper(symbol))
WHERE "tradingAccountId" IS NOT NULL AND status IN ('open', 'closing');
