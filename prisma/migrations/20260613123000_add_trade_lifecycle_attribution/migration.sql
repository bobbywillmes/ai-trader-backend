-- Add nullable lifecycle ownership links. These fields are intentionally
-- additive so existing production and local observer databases keep working.

ALTER TABLE "OrderIntent"
ADD COLUMN "trackedPositionId" INTEGER;

ALTER TABLE "BrokerOrder"
ADD COLUMN "trackedPositionId" INTEGER;

ALTER TABLE "BrokerActivity"
ADD COLUMN "trackedPositionId" INTEGER,
ADD COLUMN "trackedPositionLinkSource" TEXT,
ADD COLUMN "trackedPositionLinkedAt" TIMESTAMP(3);

CREATE INDEX "OrderIntent_trackedPositionId_idx" ON "OrderIntent"("trackedPositionId");
CREATE INDEX "BrokerOrder_trackedPositionId_idx" ON "BrokerOrder"("trackedPositionId");
CREATE INDEX "BrokerActivity_trackedPositionId_idx" ON "BrokerActivity"("trackedPositionId");
CREATE INDEX "BrokerActivity_trackedPositionLinkSource_idx" ON "BrokerActivity"("trackedPositionLinkSource");

ALTER TABLE "OrderIntent"
ADD CONSTRAINT "OrderIntent_trackedPositionId_fkey"
FOREIGN KEY ("trackedPositionId") REFERENCES "TrackedPosition"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BrokerOrder"
ADD CONSTRAINT "BrokerOrder_trackedPositionId_fkey"
FOREIGN KEY ("trackedPositionId") REFERENCES "TrackedPosition"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BrokerActivity"
ADD CONSTRAINT "BrokerActivity_trackedPositionId_fkey"
FOREIGN KEY ("trackedPositionId") REFERENCES "TrackedPosition"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
