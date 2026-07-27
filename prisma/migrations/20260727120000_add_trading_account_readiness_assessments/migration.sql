CREATE TYPE "TradingAccountReadinessPurpose" AS ENUM ('LIVE_ACTIVATION');
CREATE TYPE "TradingAccountReadinessResult" AS ENUM ('PASSED', 'BLOCKED', 'ERROR');

CREATE TABLE "TradingAccountReadinessAssessment" (
    "id" SERIAL NOT NULL,
    "tradingAccountId" INTEGER NOT NULL,
    "purpose" "TradingAccountReadinessPurpose" NOT NULL,
    "result" "TradingAccountReadinessResult" NOT NULL,
    "assessmentVersion" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "configurationFingerprint" TEXT NOT NULL,
    "credentialFingerprint" TEXT NOT NULL,
    "policyFingerprint" TEXT NOT NULL,
    "credentialVerifiedAt" TIMESTAMP(3),
    "accountSnapshotId" INTEGER,
    "brokerAccountId" TEXT,
    "brokerAccountStatus" TEXT,
    "tradingBlocked" BOOLEAN,
    "brokerPositionCount" INTEGER,
    "brokerOpenOrderCount" INTEGER,
    "localOpenPositionCount" INTEGER NOT NULL,
    "localClosingPositionCount" INTEGER NOT NULL,
    "localNonterminalIntentCount" INTEGER NOT NULL,
    "localNonterminalOrderCount" INTEGER NOT NULL,
    "reconciliationSummaryJson" JSONB,
    "stageResultsJson" JSONB NOT NULL,
    "gateResultsJson" JSONB NOT NULL,
    "blockersJson" JSONB NOT NULL,
    "warningsJson" JSONB NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "requestedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TradingAccountReadinessAssessment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TradingAccountReadinessAssessment_tradingAccountId_createdAt_idx" ON "TradingAccountReadinessAssessment"("tradingAccountId", "createdAt");
CREATE INDEX "TradingAccountReadinessAssessment_tradingAccountId_completedAt_idx" ON "TradingAccountReadinessAssessment"("tradingAccountId", "completedAt");
CREATE INDEX "TradingAccountReadinessAssessment_tradingAccountId_purpose_completedAt_idx" ON "TradingAccountReadinessAssessment"("tradingAccountId", "purpose", "completedAt");
CREATE INDEX "TradingAccountReadinessAssessment_result_idx" ON "TradingAccountReadinessAssessment"("result");
CREATE INDEX "TradingAccountReadinessAssessment_expiresAt_idx" ON "TradingAccountReadinessAssessment"("expiresAt");

ALTER TABLE "TradingAccountReadinessAssessment" ADD CONSTRAINT "TradingAccountReadinessAssessment_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TradingAccountReadinessAssessment" ADD CONSTRAINT "TradingAccountReadinessAssessment_accountSnapshotId_fkey" FOREIGN KEY ("accountSnapshotId") REFERENCES "AccountSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TradingAccountReadinessAssessment" ADD CONSTRAINT "TradingAccountReadinessAssessment_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
