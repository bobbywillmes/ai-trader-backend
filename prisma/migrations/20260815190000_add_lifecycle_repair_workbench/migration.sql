CREATE TYPE "LifecycleRepairType" AS ENUM ('RESOLVE_POSITION_ATTRIBUTION');
CREATE TYPE "LifecycleRepairImpact" AS ENUM ('LOCAL_ONLY');
CREATE TYPE "LifecycleRepairSource" AS ENUM ('MANUAL_DIAGNOSIS', 'RECONCILIATION', 'WORKER_FAILURE');
CREATE TYPE "LifecycleRepairConfidence" AS ENUM ('DETERMINISTIC', 'STRONG', 'AMBIGUOUS', 'INSUFFICIENT');
CREATE TYPE "LifecycleRepairExecutionResult" AS ENUM ('SUCCEEDED', 'FAILED');

CREATE TABLE "LifecycleRepairCase" (
    "id" SERIAL NOT NULL,
    "repairType" "LifecycleRepairType" NOT NULL,
    "repairVersion" INTEGER NOT NULL,
    "impact" "LifecycleRepairImpact" NOT NULL,
    "source" "LifecycleRepairSource" NOT NULL,
    "tradingAccountId" INTEGER NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "confidence" "LifecycleRepairConfidence" NOT NULL,
    "resolutionSource" TEXT,
    "diagnosticFingerprint" TEXT NOT NULL,
    "localLifecycleFingerprint" TEXT NOT NULL,
    "configurationFingerprint" TEXT,
    "evidenceJson" JSONB NOT NULL,
    "candidateResolutionsJson" JSONB NOT NULL,
    "rejectedAlternativesJson" JSONB NOT NULL,
    "beforeJson" JSONB NOT NULL,
    "proposedMutationsJson" JSONB NOT NULL,
    "preconditionsJson" JSONB NOT NULL,
    "brokerImpactJson" JSONB NOT NULL,
    "executableAtCreation" BOOLEAN NOT NULL DEFAULT false,
    "nonExecutableReasonsJson" JSONB NOT NULL,
    "createdByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LifecycleRepairCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LifecycleRepairExecution" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "attemptKey" TEXT NOT NULL,
    "result" "LifecycleRepairExecutionResult" NOT NULL,
    "executedByUserId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "confirmation" TEXT NOT NULL,
    "diagnosticFingerprint" TEXT NOT NULL,
    "beforeJson" JSONB NOT NULL,
    "afterJson" JSONB,
    "validationJson" JSONB,
    "failureJson" JSONB,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LifecycleRepairExecution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LifecycleRepairCase_type_target_fingerprint_key"
ON "LifecycleRepairCase"("repairType", "targetType", "targetId", "diagnosticFingerprint");
CREATE INDEX "LifecycleRepairCase_tradingAccountId_createdAt_idx" ON "LifecycleRepairCase"("tradingAccountId", "createdAt");
CREATE INDEX "LifecycleRepairCase_type_target_createdAt_idx" ON "LifecycleRepairCase"("repairType", "targetType", "targetId", "createdAt");
CREATE INDEX "LifecycleRepairCase_confidence_createdAt_idx" ON "LifecycleRepairCase"("confidence", "createdAt");
CREATE INDEX "LifecycleRepairCase_expiresAt_idx" ON "LifecycleRepairCase"("expiresAt");
CREATE INDEX "LifecycleRepairCase_createdByUserId_createdAt_idx" ON "LifecycleRepairCase"("createdByUserId", "createdAt");
CREATE UNIQUE INDEX "LifecycleRepairExecution_attemptKey_key" ON "LifecycleRepairExecution"("attemptKey");
CREATE UNIQUE INDEX "LifecycleRepairExecution_one_success_per_case_key"
ON "LifecycleRepairExecution"("caseId") WHERE "result" = 'SUCCEEDED';
CREATE INDEX "LifecycleRepairExecution_caseId_executedAt_idx" ON "LifecycleRepairExecution"("caseId", "executedAt");
CREATE INDEX "LifecycleRepairExecution_executedByUserId_executedAt_idx" ON "LifecycleRepairExecution"("executedByUserId", "executedAt");

ALTER TABLE "LifecycleRepairCase" ADD CONSTRAINT "LifecycleRepairCase_tradingAccountId_fkey"
FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LifecycleRepairCase" ADD CONSTRAINT "LifecycleRepairCase_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LifecycleRepairExecution" ADD CONSTRAINT "LifecycleRepairExecution_caseId_fkey"
FOREIGN KEY ("caseId") REFERENCES "LifecycleRepairCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LifecycleRepairExecution" ADD CONSTRAINT "LifecycleRepairExecution_executedByUserId_fkey"
FOREIGN KEY ("executedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
