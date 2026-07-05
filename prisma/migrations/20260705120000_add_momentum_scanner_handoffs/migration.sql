CREATE TYPE "MomentumScannerHandoffStatus" AS ENUM ('PENDING', 'SENT', 'ACKNOWLEDGED', 'FAILED', 'CANCELLED');

CREATE TABLE "MomentumScannerHandoff" (
    "id" TEXT NOT NULL,
    "momentumCandidateId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "status" "MomentumScannerHandoffStatus" NOT NULL DEFAULT 'PENDING',
    "payloadVersion" TEXT NOT NULL DEFAULT 'v1',
    "payload" JSONB NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MomentumScannerHandoff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MomentumScannerHandoff_idempotencyKey_key" ON "MomentumScannerHandoff"("idempotencyKey");

CREATE INDEX "MomentumScannerHandoff_momentumCandidateId_idx" ON "MomentumScannerHandoff"("momentumCandidateId");

CREATE INDEX "MomentumScannerHandoff_symbol_status_idx" ON "MomentumScannerHandoff"("symbol", "status");

CREATE INDEX "MomentumScannerHandoff_status_preparedAt_idx" ON "MomentumScannerHandoff"("status", "preparedAt");

ALTER TABLE "MomentumScannerHandoff" ADD CONSTRAINT "MomentumScannerHandoff_momentumCandidateId_fkey" FOREIGN KEY ("momentumCandidateId") REFERENCES "MomentumCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
