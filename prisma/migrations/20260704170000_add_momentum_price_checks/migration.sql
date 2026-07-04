CREATE TABLE "MomentumCandidatePriceCheck" (
    "id" TEXT NOT NULL,
    "momentumCandidateId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPrice" DECIMAL(65,30),
    "previousClose" DECIMAL(65,30),
    "pctFromPreviousClose" DECIMAL(65,30),
    "intradayHigh" DECIMAL(65,30),
    "intradayLow" DECIMAL(65,30),
    "distanceFromHighPct" DECIMAL(65,30),
    "sessionVwap" DECIMAL(65,30),
    "aboveVwap" BOOLEAN,
    "dayVolume" BIGINT,
    "dollarVolume" DECIMAL(65,30),
    "relativeVolume" DECIMAL(65,30),
    "recentMovePct" DECIMAL(65,30),
    "recentVolume" BIGINT,
    "priceActionScore" INTEGER NOT NULL DEFAULT 0,
    "volumeScore" INTEGER NOT NULL DEFAULT 0,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "totalConfirmationScore" INTEGER NOT NULL DEFAULT 0,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "decision" TEXT,
    "blockedReason" TEXT,
    "rawPayload" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MomentumCandidatePriceCheck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MomentumCandidatePriceCheck_momentumCandidateId_observedAt_idx" ON "MomentumCandidatePriceCheck"("momentumCandidateId", "observedAt");

CREATE INDEX "MomentumCandidatePriceCheck_symbol_observedAt_idx" ON "MomentumCandidatePriceCheck"("symbol", "observedAt");

CREATE INDEX "MomentumCandidatePriceCheck_confirmed_totalConfirmationScore_idx" ON "MomentumCandidatePriceCheck"("confirmed", "totalConfirmationScore");

ALTER TABLE "MomentumCandidatePriceCheck" ADD CONSTRAINT "MomentumCandidatePriceCheck_momentumCandidateId_fkey" FOREIGN KEY ("momentumCandidateId") REFERENCES "MomentumCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
