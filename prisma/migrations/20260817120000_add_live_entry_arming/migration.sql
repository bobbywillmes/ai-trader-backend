ALTER TYPE "TradingAccountReadinessPurpose" ADD VALUE 'LIVE_ENTRY_ARMING';

CREATE TYPE "LiveEntryArmingTerminationType" AS ENUM ('DISARMED', 'INVALIDATED', 'EXPIRED', 'CONSUMED');

CREATE TABLE "LiveEntryArming" (
  "id" SERIAL NOT NULL,
  "tradingAccountId" INTEGER NOT NULL,
  "entryApprovalId" INTEGER NOT NULL,
  "entryApprovalRevision" INTEGER NOT NULL,
  "riskReducingApprovalId" INTEGER NOT NULL,
  "riskReducingApprovalRevision" INTEGER NOT NULL,
  "readinessAssessmentId" INTEGER NOT NULL,
  "readinessVersion" INTEGER NOT NULL,
  "tradingAccountSubscriptionId" INTEGER NOT NULL,
  "subscriptionId" INTEGER NOT NULL,
  "securityId" INTEGER NOT NULL,
  "configurationFingerprint" TEXT NOT NULL,
  "credentialFingerprint" TEXT NOT NULL,
  "policyFingerprint" TEXT NOT NULL,
  "entryApprovalExpiresAt" TIMESTAMP(3) NOT NULL,
  "accountUpdatedAtEvidence" TIMESTAMP(3) NOT NULL,
  "armedByUserId" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "typedConfirmation" TEXT NOT NULL,
  "armedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LiveEntryArming_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveEntryArmingTermination" (
  "id" SERIAL NOT NULL,
  "liveEntryArmingId" INTEGER NOT NULL,
  "type" "LiveEntryArmingTerminationType" NOT NULL,
  "actorUserId" INTEGER,
  "reason" TEXT NOT NULL,
  "orderIntentId" INTEGER,
  "clientOrderId" TEXT,
  "evidenceJson" JSONB NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LiveEntryArmingTermination_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TradingAccount" ADD COLUMN "activeLiveEntryArmingId" INTEGER;

CREATE UNIQUE INDEX "TradingAccount_activeLiveEntryArmingId_key" ON "TradingAccount"("activeLiveEntryArmingId");
CREATE INDEX "LiveEntryArming_tradingAccountId_armedAt_idx" ON "LiveEntryArming"("tradingAccountId", "armedAt");
CREATE INDEX "LiveEntryArming_entryApprovalId_entryApprovalRevision_idx" ON "LiveEntryArming"("entryApprovalId", "entryApprovalRevision");
CREATE INDEX "LiveEntryArming_tradingAccountSubscriptionId_armedAt_idx" ON "LiveEntryArming"("tradingAccountSubscriptionId", "armedAt");
CREATE INDEX "LiveEntryArming_entryApprovalExpiresAt_idx" ON "LiveEntryArming"("entryApprovalExpiresAt");
CREATE INDEX "LiveEntryArmingTermination_liveEntryArmingId_occurredAt_idx" ON "LiveEntryArmingTermination"("liveEntryArmingId", "occurredAt");
CREATE INDEX "LiveEntryArmingTermination_type_occurredAt_idx" ON "LiveEntryArmingTermination"("type", "occurredAt");
CREATE INDEX "LiveEntryArmingTermination_orderIntentId_idx" ON "LiveEntryArmingTermination"("orderIntentId");
CREATE UNIQUE INDEX "LiveEntryArmingTermination_liveEntryArmingId_type_key" ON "LiveEntryArmingTermination"("liveEntryArmingId", "type");

ALTER TABLE "LiveEntryArming" ADD CONSTRAINT "LiveEntryArming_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LiveEntryArming" ADD CONSTRAINT "LiveEntryArming_entryApprovalId_fkey" FOREIGN KEY ("entryApprovalId") REFERENCES "TradingAccountLiveWriteApproval"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LiveEntryArming" ADD CONSTRAINT "LiveEntryArming_riskReducingApprovalId_fkey" FOREIGN KEY ("riskReducingApprovalId") REFERENCES "TradingAccountLiveWriteApproval"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LiveEntryArming" ADD CONSTRAINT "LiveEntryArming_readinessAssessmentId_fkey" FOREIGN KEY ("readinessAssessmentId") REFERENCES "TradingAccountReadinessAssessment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LiveEntryArming" ADD CONSTRAINT "LiveEntryArming_tradingAccountSubscriptionId_fkey" FOREIGN KEY ("tradingAccountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LiveEntryArming" ADD CONSTRAINT "LiveEntryArming_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LiveEntryArming" ADD CONSTRAINT "LiveEntryArming_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LiveEntryArming" ADD CONSTRAINT "LiveEntryArming_armedByUserId_fkey" FOREIGN KEY ("armedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_activeLiveEntryArmingId_fkey" FOREIGN KEY ("activeLiveEntryArmingId") REFERENCES "LiveEntryArming"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LiveEntryArmingTermination" ADD CONSTRAINT "LiveEntryArmingTermination_liveEntryArmingId_fkey" FOREIGN KEY ("liveEntryArmingId") REFERENCES "LiveEntryArming"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LiveEntryArmingTermination" ADD CONSTRAINT "LiveEntryArmingTermination_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
