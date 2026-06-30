-- CreateEnum
CREATE TYPE "PositionSizingType" AS ENUM ('FIXED_QTY', 'MAX_NOTIONAL');

-- AlterTable
ALTER TABLE "EntryDecision" ADD COLUMN     "tradingAccountSubscriptionId" INTEGER;

-- AlterTable
ALTER TABLE "OrderIntent" ADD COLUMN     "tradingAccountSubscriptionId" INTEGER;

-- AlterTable
ALTER TABLE "TrackedPosition" ADD COLUMN     "tradingAccountSubscriptionId" INTEGER;

-- CreateTable
CREATE TABLE "TradingAccountAllocation" (
    "id" SERIAL NOT NULL,
    "tradingAccountId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "maxAllocatedNotional" DOUBLE PRECISION,
    "maxOpenPositions" INTEGER,
    "maxPositionNotional" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingAccountAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingAccountSubscription" (
    "id" SERIAL NOT NULL,
    "tradingAccountId" INTEGER NOT NULL,
    "subscriptionId" INTEGER NOT NULL,
    "allocationId" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "entriesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "exitsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sizingType" "PositionSizingType" NOT NULL DEFAULT 'FIXED_QTY',
    "fixedQty" DOUBLE PRECISION,
    "maxPositionNotional" DOUBLE PRECISION,
    "minPositionNotional" DOUBLE PRECISION,
    "maxQty" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingAccountSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TradingAccountAllocation_tradingAccountId_idx" ON "TradingAccountAllocation"("tradingAccountId");

-- CreateIndex
CREATE INDEX "TradingAccountAllocation_enabled_idx" ON "TradingAccountAllocation"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "TradingAccountAllocation_tradingAccountId_key_key" ON "TradingAccountAllocation"("tradingAccountId", "key");

-- CreateIndex
CREATE INDEX "TradingAccountSubscription_tradingAccountId_idx" ON "TradingAccountSubscription"("tradingAccountId");

-- CreateIndex
CREATE INDEX "TradingAccountSubscription_subscriptionId_idx" ON "TradingAccountSubscription"("subscriptionId");

-- CreateIndex
CREATE INDEX "TradingAccountSubscription_allocationId_idx" ON "TradingAccountSubscription"("allocationId");

-- CreateIndex
CREATE INDEX "TradingAccountSubscription_enabled_idx" ON "TradingAccountSubscription"("enabled");

-- CreateIndex
CREATE INDEX "TradingAccountSubscription_entriesEnabled_idx" ON "TradingAccountSubscription"("entriesEnabled");

-- CreateIndex
CREATE INDEX "TradingAccountSubscription_exitsEnabled_idx" ON "TradingAccountSubscription"("exitsEnabled");

-- CreateIndex
CREATE INDEX "TradingAccountSubscription_tradingAccountId_enabled_idx" ON "TradingAccountSubscription"("tradingAccountId", "enabled");

-- CreateIndex
CREATE INDEX "TradingAccountSubscription_tradingAccountId_entriesEnabled_idx" ON "TradingAccountSubscription"("tradingAccountId", "entriesEnabled");

-- CreateIndex
CREATE INDEX "TradingAccountSubscription_tradingAccountId_exitsEnabled_idx" ON "TradingAccountSubscription"("tradingAccountId", "exitsEnabled");

-- CreateIndex
CREATE INDEX "TradingAccountSubscription_allocationId_enabled_idx" ON "TradingAccountSubscription"("allocationId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "TradingAccountSubscription_tradingAccountId_subscriptionId_key" ON "TradingAccountSubscription"("tradingAccountId", "subscriptionId");

-- CreateIndex
CREATE INDEX "EntryDecision_tradingAccountSubscriptionId_idx" ON "EntryDecision"("tradingAccountSubscriptionId");

-- CreateIndex
CREATE INDEX "EntryDecision_tradingAccountId_tradingAccountSubscriptionId_idx" ON "EntryDecision"("tradingAccountId", "tradingAccountSubscriptionId");

-- CreateIndex
CREATE INDEX "EntryDecision_tradingAccountSubscriptionId_evaluatedAt_idx" ON "EntryDecision"("tradingAccountSubscriptionId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "OrderIntent_tradingAccountSubscriptionId_idx" ON "OrderIntent"("tradingAccountSubscriptionId");

-- CreateIndex
CREATE INDEX "OrderIntent_tradingAccountId_tradingAccountSubscriptionId_idx" ON "OrderIntent"("tradingAccountId", "tradingAccountSubscriptionId");

-- CreateIndex
CREATE INDEX "OrderIntent_tradingAccountSubscriptionId_createdAt_idx" ON "OrderIntent"("tradingAccountSubscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "TrackedPosition_tradingAccountSubscriptionId_idx" ON "TrackedPosition"("tradingAccountSubscriptionId");

-- CreateIndex
CREATE INDEX "TrackedPosition_tradingAccountId_tradingAccountSubscription_idx" ON "TrackedPosition"("tradingAccountId", "tradingAccountSubscriptionId");

-- CreateIndex
CREATE INDEX "TrackedPosition_tradingAccountSubscriptionId_status_idx" ON "TrackedPosition"("tradingAccountSubscriptionId", "status");

-- AddForeignKey
ALTER TABLE "TradingAccountAllocation" ADD CONSTRAINT "TradingAccountAllocation_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccountSubscription" ADD CONSTRAINT "TradingAccountSubscription_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccountSubscription" ADD CONSTRAINT "TradingAccountSubscription_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccountSubscription" ADD CONSTRAINT "TradingAccountSubscription_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "TradingAccountAllocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderIntent" ADD CONSTRAINT "OrderIntent_tradingAccountSubscriptionId_fkey" FOREIGN KEY ("tradingAccountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntryDecision" ADD CONSTRAINT "EntryDecision_tradingAccountSubscriptionId_fkey" FOREIGN KEY ("tradingAccountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedPosition" ADD CONSTRAINT "TrackedPosition_tradingAccountSubscriptionId_fkey" FOREIGN KEY ("tradingAccountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
