-- CreateEnum
CREATE TYPE "MomentumCandidateState" AS ENUM ('DISCOVERED', 'WATCHING', 'ENTRY_READY', 'ENTRY_BLOCKED', 'EXPIRED', 'DISMISSED');

-- CreateTable
CREATE TABLE "MomentumCandidate" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "state" "MomentumCandidateState" NOT NULL DEFAULT 'DISCOVERED',
    "catalystEventId" TEXT,
    "catalystImpactId" TEXT,
    "catalystScore" INTEGER NOT NULL DEFAULT 0,
    "priceActionScore" INTEGER NOT NULL DEFAULT 0,
    "volumeScore" INTEGER NOT NULL DEFAULT 0,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "totalScore" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "blockedReason" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEvaluatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "rawSnapshot" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MomentumCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MomentumCandidate_symbol_catalystImpactId_key" ON "MomentumCandidate"("symbol", "catalystImpactId");

-- CreateIndex
CREATE INDEX "MomentumCandidate_symbol_state_idx" ON "MomentumCandidate"("symbol", "state");

-- CreateIndex
CREATE INDEX "MomentumCandidate_totalScore_idx" ON "MomentumCandidate"("totalScore");

-- CreateIndex
CREATE INDEX "MomentumCandidate_discoveredAt_idx" ON "MomentumCandidate"("discoveredAt");

-- CreateIndex
CREATE INDEX "MomentumCandidate_expiresAt_idx" ON "MomentumCandidate"("expiresAt");

-- CreateIndex
CREATE INDEX "MomentumCandidate_catalystEventId_idx" ON "MomentumCandidate"("catalystEventId");

-- CreateIndex
CREATE INDEX "MomentumCandidate_catalystImpactId_idx" ON "MomentumCandidate"("catalystImpactId");

-- AddForeignKey
ALTER TABLE "MomentumCandidate" ADD CONSTRAINT "MomentumCandidate_catalystEventId_fkey" FOREIGN KEY ("catalystEventId") REFERENCES "CatalystEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MomentumCandidate" ADD CONSTRAINT "MomentumCandidate_catalystImpactId_fkey" FOREIGN KEY ("catalystImpactId") REFERENCES "CatalystTickerImpact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
