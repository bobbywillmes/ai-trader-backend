-- CreateTable
CREATE TABLE "TradingAccountRiskSettings" (
    "id" SERIAL NOT NULL,
    "tradingAccountId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "maxDailyEntryOrders" INTEGER,
    "maxDailyEntryNotional" DOUBLE PRECISION,
    "maxOpenPositions" INTEGER,
    "maxTotalOpenNotional" DOUBLE PRECISION,
    "maxSymbolOpenNotional" DOUBLE PRECISION,
    "maxSubscriptionOpenNotional" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingAccountRiskSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TradingAccountRiskSettings_tradingAccountId_key" ON "TradingAccountRiskSettings"("tradingAccountId");

-- CreateIndex
CREATE INDEX "TradingAccountRiskSettings_enabled_idx" ON "TradingAccountRiskSettings"("enabled");

-- AddForeignKey
ALTER TABLE "TradingAccountRiskSettings" ADD CONSTRAINT "TradingAccountRiskSettings_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
