CREATE TYPE "LiveWriteCapability" AS ENUM ('RISK_REDUCING', 'ENTRY');
CREATE TYPE "LiveWriteApprovalStatus" AS ENUM ('GRANTED', 'REVOKED', 'INVALIDATED');
CREATE TYPE "LiveWriteApprovalAction" AS ENUM ('GRANT', 'REVOKE', 'INVALIDATE');

CREATE TABLE "TradingAccountLiveWriteApproval" (
  "id" SERIAL NOT NULL,
  "tradingAccountId" INTEGER NOT NULL,
  "capability" "LiveWriteCapability" NOT NULL,
  "status" "LiveWriteApprovalStatus" NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "configurationFingerprint" TEXT NOT NULL,
  "credentialFingerprint" TEXT NOT NULL,
  "readinessAssessmentId" INTEGER,
  "grantedByUserId" INTEGER,
  "grantedAt" TIMESTAMP(3),
  "grantReason" TEXT,
  "revokedByUserId" INTEGER,
  "revokedAt" TIMESTAMP(3),
  "invalidationReason" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TradingAccountLiveWriteApproval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TradingAccountLiveWriteApprovalDecision" (
  "id" SERIAL NOT NULL,
  "tradingAccountId" INTEGER NOT NULL,
  "capability" "LiveWriteCapability" NOT NULL,
  "action" "LiveWriteApprovalAction" NOT NULL,
  "actorUserId" INTEGER,
  "reason" TEXT NOT NULL,
  "configurationFingerprint" TEXT NOT NULL,
  "credentialFingerprint" TEXT NOT NULL,
  "readinessAssessmentId" INTEGER,
  "deploymentEnvironment" TEXT NOT NULL,
  "priorRevision" INTEGER NOT NULL,
  "resultingRevision" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradingAccountLiveWriteApprovalDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TradingAccountLiveWriteApproval_tradingAccountId_capability_key"
ON "TradingAccountLiveWriteApproval"("tradingAccountId", "capability");
CREATE INDEX "TradingAccountLiveWriteApproval_status_idx" ON "TradingAccountLiveWriteApproval"("status");
CREATE INDEX "TradingAccountLiveWriteApproval_expiresAt_idx" ON "TradingAccountLiveWriteApproval"("expiresAt");
CREATE INDEX "TradingAccountLiveWriteApprovalDecision_account_capability_created_idx"
ON "TradingAccountLiveWriteApprovalDecision"("tradingAccountId", "capability", "createdAt");
CREATE INDEX "TradingAccountLiveWriteApprovalDecision_actorUserId_idx"
ON "TradingAccountLiveWriteApprovalDecision"("actorUserId");

ALTER TABLE "TradingAccountLiveWriteApproval"
ADD CONSTRAINT "TradingAccountLiveWriteApproval_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "TradingAccountLiveWriteApproval_readinessAssessmentId_fkey" FOREIGN KEY ("readinessAssessmentId") REFERENCES "TradingAccountReadinessAssessment"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "TradingAccountLiveWriteApproval_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "TradingAccountLiveWriteApproval_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TradingAccountLiveWriteApprovalDecision"
ADD CONSTRAINT "TradingAccountLiveWriteApprovalDecision_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "TradingAccountLiveWriteApprovalDecision_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "TradingAccountLiveWriteApprovalDecision_readinessAssessmentId_fkey" FOREIGN KEY ("readinessAssessmentId") REFERENCES "TradingAccountReadinessAssessment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
