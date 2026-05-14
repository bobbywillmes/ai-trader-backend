-- CreateTable
CREATE TABLE "AccountSnapshot" (
    "id" SERIAL NOT NULL,
    "broker" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "accountStatus" TEXT,
    "currency" TEXT,
    "accountNumber" TEXT,
    "reason" TEXT NOT NULL,
    "runKey" TEXT,
    "sourceEntityType" TEXT,
    "sourceEntityId" TEXT,
    "cash" DOUBLE PRECISION NOT NULL,
    "buyingPower" DOUBLE PRECISION NOT NULL,
    "equity" DOUBLE PRECISION NOT NULL,
    "portfolioValue" DOUBLE PRECISION NOT NULL,
    "lastEquity" DOUBLE PRECISION,
    "dayPnL" DOUBLE PRECISION,
    "dayPnLPct" DOUBLE PRECISION,
    "tradingBlocked" BOOLEAN NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "changed" BOOLEAN NOT NULL DEFAULT true,
    "rawJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountSnapshot_runKey_key" ON "AccountSnapshot"("runKey");

-- CreateIndex
CREATE INDEX "AccountSnapshot_createdAt_idx" ON "AccountSnapshot"("createdAt");

-- CreateIndex
CREATE INDEX "AccountSnapshot_reason_idx" ON "AccountSnapshot"("reason");

-- CreateIndex
CREATE INDEX "AccountSnapshot_broker_mode_idx" ON "AccountSnapshot"("broker", "mode");

-- CreateIndex
CREATE INDEX "AccountSnapshot_changed_idx" ON "AccountSnapshot"("changed");
