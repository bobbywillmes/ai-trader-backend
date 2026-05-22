-- DropIndex
DROP INDEX "TrackedPosition_symbol_key";

-- CreateIndex
CREATE INDEX "TrackedPosition_broker_symbol_idx" ON "TrackedPosition"("broker", "symbol");

-- CreateIndex
CREATE INDEX "TrackedPosition_broker_symbol_status_idx" ON "TrackedPosition"("broker", "symbol", "status");

-- CreateIndex
CREATE INDEX "TrackedPosition_subscriptionId_idx" ON "TrackedPosition"("subscriptionId");

CREATE UNIQUE INDEX "TrackedPosition_active_broker_symbol_key"
ON "TrackedPosition"("broker", "symbol")
WHERE "status" IN ('open', 'closing');