-- CreateTable
CREATE TABLE "Strategy" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "allowedSymbolsJson" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExitProfile" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "targetPct" DOUBLE PRECISION,
    "stopLossPct" DOUBLE PRECISION,
    "trailingStopPct" DOUBLE PRECISION,
    "maxHoldDays" INTEGER,
    "exitMode" TEXT NOT NULL,
    "takeProfitBehavior" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExitProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "broker" TEXT NOT NULL DEFAULT 'alpaca',
    "brokerMode" TEXT NOT NULL DEFAULT 'paper',
    "sizingType" TEXT NOT NULL,
    "sizingValue" DOUBLE PRECISION NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "strategyId" INTEGER NOT NULL,
    "exitProfileId" INTEGER NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Strategy_key_key" ON "Strategy"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ExitProfile_key_key" ON "ExitProfile"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_key_key" ON "Subscription"("key");

-- CreateIndex
CREATE INDEX "Subscription_symbol_idx" ON "Subscription"("symbol");

-- CreateIndex
CREATE INDEX "Subscription_strategyId_idx" ON "Subscription"("strategyId");

-- CreateIndex
CREATE INDEX "Subscription_exitProfileId_idx" ON "Subscription"("exitProfileId");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_exitProfileId_fkey" FOREIGN KEY ("exitProfileId") REFERENCES "ExitProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
