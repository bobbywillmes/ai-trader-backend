CREATE TYPE "ExternalSignalCorrelationWorkStatus" AS ENUM ('PENDING', 'CLAIMED', 'RETRY_WAIT', 'COMPLETED', 'FAILED');
CREATE TYPE "ExternalSignalCorrelationDecisionType" AS ENUM ('ENTRY_RESERVATION', 'ENTRY_SHADOW_AUTHORITY', 'EXIT_PENDING', 'ENTRY_SUPPRESSED', 'CYCLE_BLOCKED');

CREATE TABLE "ExternalSignalCorrelationWork" (
  "id" SERIAL PRIMARY KEY,
  "signalId" INTEGER NOT NULL,
  "status" "ExternalSignalCorrelationWorkStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMPTZ(3),
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastErrorCode" TEXT,
  "completedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ExternalSignalCorrelationWork_signalId_key" UNIQUE ("signalId"),
  CONSTRAINT "ExternalSignalCorrelationWork_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalCorrelationWork_lease_check" CHECK (
    ("status" = 'CLAIMED' AND "leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
    OR ("status" <> 'CLAIMED' AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)
  ),
  CONSTRAINT "ExternalSignalCorrelationWork_completion_check" CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)),
  CONSTRAINT "ExternalSignalCorrelationWork_attempt_check" CHECK ("attemptCount" >= 0)
);
CREATE INDEX "ExternalSignalCorrelationWork_status_nextAttemptAt_id_idx" ON "ExternalSignalCorrelationWork"("status", "nextAttemptAt", "id");
CREATE INDEX "ExternalSignalCorrelationWork_leaseExpiresAt_idx" ON "ExternalSignalCorrelationWork"("leaseExpiresAt");

-- Phase 4A.1A may already have accepted v2 evidence. Backfill only a durable
-- shadow work pointer; immutable Signal and Delivery rows remain untouched.
INSERT INTO "ExternalSignalCorrelationWork" ("signalId", "updatedAt")
SELECT id, statement_timestamp() FROM "Signal" WHERE "schemaVersion" = 2
ON CONFLICT ("signalId") DO NOTHING;

CREATE TABLE "ExternalSignalCorrelationDecision" (
  "id" SERIAL PRIMARY KEY,
  "externalSignalTradeCycleId" INTEGER NOT NULL,
  "accountCycleId" INTEGER,
  "signalId" INTEGER NOT NULL,
  "decisionType" "ExternalSignalCorrelationDecisionType" NOT NULL,
  "authorityMode" "ExternalSignalExecutionAuthorityMode" NOT NULL DEFAULT 'SHADOW',
  "rolloutGenerationId" INTEGER,
  "reservationKey" TEXT,
  "reasonCode" TEXT NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalSignalCorrelationDecision_cycle_fkey" FOREIGN KEY ("externalSignalTradeCycleId") REFERENCES "ExternalSignalTradeCycle"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalCorrelationDecision_account_fkey" FOREIGN KEY ("accountCycleId") REFERENCES "ExternalSignalTradeCycleAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalCorrelationDecision_signal_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalCorrelationDecision_rollout_fkey" FOREIGN KEY ("rolloutGenerationId") REFERENCES "ExternalSignalExecutionRolloutGeneration"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalCorrelationDecision_shadow_only_check" CHECK ("authorityMode" = 'SHADOW'),
  CONSTRAINT "ExternalSignalCorrelationDecision_signal_account_type_key" UNIQUE NULLS NOT DISTINCT ("signalId", "accountCycleId", "decisionType")
);
CREATE INDEX "ExternalSignalCorrelationDecision_cycle_created_idx" ON "ExternalSignalCorrelationDecision"("externalSignalTradeCycleId", "createdAt");
CREATE INDEX "ExternalSignalCorrelationDecision_account_created_idx" ON "ExternalSignalCorrelationDecision"("accountCycleId", "createdAt");

CREATE FUNCTION "protect_external_signal_correlation_decision"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'External signal correlation decisions are append-only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER "ExternalSignalCorrelationDecision_immutable"
  BEFORE UPDATE OR DELETE ON "ExternalSignalCorrelationDecision"
  FOR EACH ROW EXECUTE FUNCTION "protect_external_signal_correlation_decision"();

-- A queued v2 signal and its terminal delivery must commit together. The worker may
-- complete later, but accepted evidence can never be left without durable work.
CREATE FUNCTION "check_external_signal_v2_work_handoff"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."schemaVersion" = 2 AND NOT EXISTS (
    SELECT 1 FROM "ExternalSignalCorrelationWork" w WHERE w."signalId" = NEW.id
  ) THEN
    RAISE EXCEPTION 'Accepted v2 signal requires durable correlation work' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "Signal_v2_work_handoff_check"
  AFTER INSERT ON "Signal" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_external_signal_v2_work_handoff"();
