-- CreateEnum
CREATE TYPE "ExternalSignalProvider" AS ENUM ('TRADINGVIEW', 'TRENDSPIDER', 'GENERIC_WEBHOOK');

-- CreateEnum
CREATE TYPE "ExternalSignalAuthMethod" AS ENUM ('URL_TOKEN');

-- CreateEnum
CREATE TYPE "SignalDeliveryStatus" AS ENUM ('NORMALIZED', 'DUPLICATE', 'REJECTED');

-- CreateEnum
CREATE TYPE "SignalEvent" AS ENUM ('ENTRY_LONG', 'EXIT_LONG');

-- CreateEnum
CREATE TYPE "SignalDeliveryRejectionCode" AS ENUM ('SOURCE_DISABLED', 'INVALID_CONTENT_TYPE', 'INVALID_JSON', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_SCHEMA_VERSION', 'INVALID_ENVELOPE', 'UNKNOWN_STRATEGY_BINDING', 'STRATEGY_BINDING_DISABLED', 'STRATEGY_REVISION_MISMATCH', 'UNKNOWN_SYMBOL', 'INVALID_EVENT', 'INVALID_TIMEFRAME', 'INVALID_TIMESTAMP', 'EVENT_KEY_CONFLICT');

-- CreateTable
CREATE TABLE "ExternalSignalSource" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "ExternalSignalProvider" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "authMethod" "ExternalSignalAuthMethod" NOT NULL DEFAULT 'URL_TOKEN',
    "webhookTokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalSignalSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategySignalBinding" (
    "id" SERIAL NOT NULL,
    "signalSourceId" INTEGER NOT NULL,
    "strategyId" INTEGER NOT NULL,
    "externalStrategyKey" TEXT NOT NULL,
    "expectedRevision" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StrategySignalBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalDelivery" (
    "id" SERIAL NOT NULL,
    "signalSourceId" INTEGER NOT NULL,
    "signalId" INTEGER,
    "requestId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "status" "SignalDeliveryStatus" NOT NULL,
    "contentType" TEXT,
    "bodySizeBytes" INTEGER NOT NULL,
    "rawPayloadHash" TEXT NOT NULL,
    "rawPayloadRedacted" JSONB NOT NULL,
    "rejectionCode" "SignalDeliveryRejectionCode",
    "rejectionDetails" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignalDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" SERIAL NOT NULL,
    "signalSourceId" INTEGER NOT NULL,
    "strategySignalBindingId" INTEGER NOT NULL,
    "strategyId" INTEGER NOT NULL,
    "securityId" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "externalEventKey" TEXT NOT NULL,
    "strategyRevision" TEXT NOT NULL,
    "event" "SignalEvent" NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "signalTime" TIMESTAMP(3) NOT NULL,
    "barTime" TIMESTAMP(3),
    "metadata" JSONB,
    "canonicalPayloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalSignalSource_webhookTokenHash_key" ON "ExternalSignalSource"("webhookTokenHash");

-- CreateIndex
CREATE INDEX "StrategySignalBinding_strategyId_idx" ON "StrategySignalBinding"("strategyId");

-- CreateIndex
CREATE UNIQUE INDEX "StrategySignalBinding_signalSourceId_externalStrategyKey_key" ON "StrategySignalBinding"("signalSourceId", "externalStrategyKey");

-- CreateIndex
CREATE INDEX "SignalDelivery_signalSourceId_receivedAt_idx" ON "SignalDelivery"("signalSourceId", "receivedAt");

-- CreateIndex
CREATE INDEX "SignalDelivery_status_receivedAt_idx" ON "SignalDelivery"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "SignalDelivery_signalId_idx" ON "SignalDelivery"("signalId");

-- CreateIndex
CREATE INDEX "SignalDelivery_rejectionCode_receivedAt_idx" ON "SignalDelivery"("rejectionCode", "receivedAt");

-- CreateIndex
CREATE INDEX "SignalDelivery_receivedAt_idx" ON "SignalDelivery"("receivedAt");

-- CreateIndex
CREATE INDEX "Signal_strategySignalBindingId_idx" ON "Signal"("strategySignalBindingId");

-- CreateIndex
CREATE INDEX "Signal_strategyId_signalTime_idx" ON "Signal"("strategyId", "signalTime");

-- CreateIndex
CREATE INDEX "Signal_securityId_signalTime_idx" ON "Signal"("securityId", "signalTime");

-- CreateIndex
CREATE INDEX "Signal_event_signalTime_idx" ON "Signal"("event", "signalTime");

-- CreateIndex
CREATE INDEX "Signal_signalTime_idx" ON "Signal"("signalTime");

-- CreateIndex
CREATE INDEX "Signal_createdAt_idx" ON "Signal"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_signalSourceId_externalEventKey_key" ON "Signal"("signalSourceId", "externalEventKey");

-- AddForeignKey
ALTER TABLE "StrategySignalBinding" ADD CONSTRAINT "StrategySignalBinding_signalSourceId_fkey" FOREIGN KEY ("signalSourceId") REFERENCES "ExternalSignalSource"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StrategySignalBinding" ADD CONSTRAINT "StrategySignalBinding_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SignalDelivery" ADD CONSTRAINT "SignalDelivery_signalSourceId_fkey" FOREIGN KEY ("signalSourceId") REFERENCES "ExternalSignalSource"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SignalDelivery" ADD CONSTRAINT "SignalDelivery_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_signalSourceId_fkey" FOREIGN KEY ("signalSourceId") REFERENCES "ExternalSignalSource"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_strategySignalBindingId_fkey" FOREIGN KEY ("strategySignalBindingId") REFERENCES "StrategySignalBinding"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
