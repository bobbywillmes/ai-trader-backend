CREATE TYPE "LiveEntryAcceptanceTerminalOutcome" AS ENUM (
  'CANARY_COMPLETE',
  'FAILED_SAFE',
  'OPERATOR_ABORTED'
);

CREATE TABLE "LiveEntryAcceptanceRun" (
  "id" SERIAL NOT NULL,
  "tradingAccountId" INTEGER NOT NULL,
  "tradingAccountSubscriptionId" INTEGER NOT NULL,
  "subscriptionId" INTEGER NOT NULL,
  "securityId" INTEGER NOT NULL,
  "createdByUserId" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "previewRevision" INTEGER NOT NULL DEFAULT 0,
  "previewFingerprint" TEXT,
  "previewJson" JSONB,
  "previewedAt" TIMESTAMP(3),
  "executionClaimedAt" TIMESTAMP(3),
  "executionRequestedByUserId" INTEGER,
  "executionRequestKey" TEXT,
  "executionUncertainAt" TIMESTAMP(3),
  "executionFailureJson" JSONB,
  "terminalOutcome" "LiveEntryAcceptanceTerminalOutcome",
  "terminalReason" TEXT,
  "terminalEvidenceJson" JSONB,
  "terminalAt" TIMESTAMP(3),
  "terminatedByUserId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LiveEntryAcceptanceRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LiveEntryAcceptanceRun_terminal_pair_check" CHECK (
    ("terminalOutcome" IS NULL AND "terminalAt" IS NULL) OR
    ("terminalOutcome" IS NOT NULL AND "terminalAt" IS NOT NULL)
  ),
  CONSTRAINT "LiveEntryAcceptanceRun_preview_shape_check" CHECK (
    ("previewRevision" = 0 AND "previewFingerprint" IS NULL AND "previewJson" IS NULL AND "previewedAt" IS NULL) OR
    ("previewRevision" > 0 AND "previewFingerprint" IS NOT NULL AND "previewJson" IS NOT NULL AND "previewedAt" IS NOT NULL)
  ),
  CONSTRAINT "LiveEntryAcceptanceRun_execution_preview_check" CHECK (
    "executionClaimedAt" IS NULL OR
    ("previewRevision" > 0 AND "previewFingerprint" IS NOT NULL AND "previewJson" IS NOT NULL AND "previewedAt" IS NOT NULL)
  ),
  CONSTRAINT "LiveEntryAcceptanceRun_uncertainty_execution_check" CHECK (
    "executionUncertainAt" IS NULL OR "executionClaimedAt" IS NOT NULL
  )
);

ALTER TABLE "LiveEntryArming"
  ADD COLUMN "liveEntryAcceptanceRunId" INTEGER;

ALTER TABLE "OrderIntent"
  ADD COLUMN "liveEntryAcceptanceRunId" INTEGER;

CREATE UNIQUE INDEX "LiveEntryAcceptanceRun_active_account_key"
  ON "LiveEntryAcceptanceRun"("tradingAccountId")
  WHERE "terminalAt" IS NULL;

CREATE UNIQUE INDEX "LiveEntryAcceptanceRun_executionRequestKey_key"
  ON "LiveEntryAcceptanceRun"("executionRequestKey");

CREATE INDEX "LiveEntryAcceptanceRun_tradingAccountId_createdAt_idx"
  ON "LiveEntryAcceptanceRun"("tradingAccountId", "createdAt");

CREATE INDEX "LiveEntryAcceptanceRun_tradingAccountSubscriptionId_createdAt_idx"
  ON "LiveEntryAcceptanceRun"("tradingAccountSubscriptionId", "createdAt");

CREATE INDEX "LiveEntryAcceptanceRun_terminalOutcome_terminalAt_idx"
  ON "LiveEntryAcceptanceRun"("terminalOutcome", "terminalAt");

CREATE INDEX "LiveEntryAcceptanceRun_executionUncertainAt_idx"
  ON "LiveEntryAcceptanceRun"("executionUncertainAt");

CREATE UNIQUE INDEX "LiveEntryArming_liveEntryAcceptanceRunId_key"
  ON "LiveEntryArming"("liveEntryAcceptanceRunId");

CREATE UNIQUE INDEX "OrderIntent_liveEntryAcceptanceRunId_key"
  ON "OrderIntent"("liveEntryAcceptanceRunId");

ALTER TABLE "LiveEntryAcceptanceRun"
  ADD CONSTRAINT "LiveEntryAcceptanceRun_tradingAccountId_fkey"
  FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "LiveEntryAcceptanceRun"
  ADD CONSTRAINT "LiveEntryAcceptanceRun_tradingAccountSubscriptionId_fkey"
  FOREIGN KEY ("tradingAccountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "LiveEntryAcceptanceRun"
  ADD CONSTRAINT "LiveEntryAcceptanceRun_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "LiveEntryAcceptanceRun"
  ADD CONSTRAINT "LiveEntryAcceptanceRun_securityId_fkey"
  FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "LiveEntryAcceptanceRun"
  ADD CONSTRAINT "LiveEntryAcceptanceRun_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "LiveEntryAcceptanceRun"
  ADD CONSTRAINT "LiveEntryAcceptanceRun_executionRequestedByUserId_fkey"
  FOREIGN KEY ("executionRequestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "LiveEntryAcceptanceRun"
  ADD CONSTRAINT "LiveEntryAcceptanceRun_terminatedByUserId_fkey"
  FOREIGN KEY ("terminatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "LiveEntryArming"
  ADD CONSTRAINT "LiveEntryArming_liveEntryAcceptanceRunId_fkey"
  FOREIGN KEY ("liveEntryAcceptanceRunId") REFERENCES "LiveEntryAcceptanceRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderIntent"
  ADD CONSTRAINT "OrderIntent_liveEntryAcceptanceRunId_fkey"
  FOREIGN KEY ("liveEntryAcceptanceRunId") REFERENCES "LiveEntryAcceptanceRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "freeze_live_entry_acceptance_executed_preview"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."executionClaimedAt" IS NOT NULL AND (
    NEW."previewRevision" IS DISTINCT FROM OLD."previewRevision" OR
    NEW."previewFingerprint" IS DISTINCT FROM OLD."previewFingerprint" OR
    NEW."previewJson" IS DISTINCT FROM OLD."previewJson" OR
    NEW."previewedAt" IS DISTINCT FROM OLD."previewedAt"
  ) THEN
    RAISE EXCEPTION 'Executed Live-entry acceptance preview is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LiveEntryAcceptanceRun_freeze_executed_preview"
BEFORE UPDATE ON "LiveEntryAcceptanceRun"
FOR EACH ROW
EXECUTE FUNCTION "freeze_live_entry_acceptance_executed_preview"();
