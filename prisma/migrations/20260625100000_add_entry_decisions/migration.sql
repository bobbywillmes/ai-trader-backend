-- CreateTable
CREATE TABLE "EntryDecision" (
    "id" SERIAL NOT NULL,
    "decisionKey" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decisionState" TEXT NOT NULL,
    "decisionReason" TEXT,
    "signalAction" TEXT,
    "signalEligible" BOOLEAN,
    "signalCreated" BOOLEAN NOT NULL DEFAULT false,
    "signalBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockingReason" TEXT,
    "currentPrice" DOUBLE PRECISION,
    "previousClose" DOUBLE PRECISION,
    "dayLow" DOUBLE PRECISION,
    "dayChangePercent" DOUBLE PRECISION,
    "dipPercent" DOUBLE PRECISION,
    "dipThresholdPercent" DOUBLE PRECISION,
    "retraceFraction" DOUBLE PRECISION,
    "cooldownActive" BOOLEAN,
    "cooldownUntil" TIMESTAMP(3),
    "minutesSinceLastSignal" DOUBLE PRECISION,
    "allowOrderSignals" BOOLEAN,
    "dryRun" BOOLEAN,
    "eventRisk" TEXT,
    "marketSession" TEXT,
    "tradingEnabled" BOOLEAN,
    "killSwitchEnabled" BOOLEAN,
    "paperMode" BOOLEAN,
    "persistenceReason" TEXT NOT NULL,
    "decisionFingerprint" TEXT NOT NULL,
    "marketSnapshotJson" JSONB,
    "runtimeSnapshotJson" JSONB,
    "strategySnapshotJson" JSONB,
    "indicatorSnapshotJson" JSONB,
    "rawDecisionJson" JSONB NOT NULL,
    "securityId" INTEGER,
    "subscriptionId" INTEGER,
    "subscriptionKey" TEXT,
    "strategyId" INTEGER,
    "strategyKey" TEXT,
    "exitProfileId" INTEGER,
    "exitProfileKey" TEXT,
    "orderIntentId" INTEGER,
    "brokerOrderRecordId" INTEGER,
    "trackedPositionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntryDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EntryDecision_decisionKey_key" ON "EntryDecision"("decisionKey");

-- CreateIndex
CREATE UNIQUE INDEX "EntryDecision_orderIntentId_key" ON "EntryDecision"("orderIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "EntryDecision_brokerOrderRecordId_key" ON "EntryDecision"("brokerOrderRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "EntryDecision_trackedPositionId_key" ON "EntryDecision"("trackedPositionId");

-- CreateIndex
CREATE INDEX "EntryDecision_evaluatedAt_idx" ON "EntryDecision"("evaluatedAt");

-- CreateIndex
CREATE INDEX "EntryDecision_symbol_evaluatedAt_idx" ON "EntryDecision"("symbol", "evaluatedAt");

-- CreateIndex
CREATE INDEX "EntryDecision_decisionState_evaluatedAt_idx" ON "EntryDecision"("decisionState", "evaluatedAt");

-- CreateIndex
CREATE INDEX "EntryDecision_subscriptionId_evaluatedAt_idx" ON "EntryDecision"("subscriptionId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "EntryDecision_strategyId_evaluatedAt_idx" ON "EntryDecision"("strategyId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "EntryDecision_exitProfileId_evaluatedAt_idx" ON "EntryDecision"("exitProfileId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "EntryDecision_securityId_idx" ON "EntryDecision"("securityId");

-- AddForeignKey
ALTER TABLE "EntryDecision" ADD CONSTRAINT "EntryDecision_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntryDecision" ADD CONSTRAINT "EntryDecision_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntryDecision" ADD CONSTRAINT "EntryDecision_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntryDecision" ADD CONSTRAINT "EntryDecision_exitProfileId_fkey" FOREIGN KEY ("exitProfileId") REFERENCES "ExitProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntryDecision" ADD CONSTRAINT "EntryDecision_orderIntentId_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntryDecision" ADD CONSTRAINT "EntryDecision_brokerOrderRecordId_fkey" FOREIGN KEY ("brokerOrderRecordId") REFERENCES "BrokerOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntryDecision" ADD CONSTRAINT "EntryDecision_trackedPositionId_fkey" FOREIGN KEY ("trackedPositionId") REFERENCES "TrackedPosition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
