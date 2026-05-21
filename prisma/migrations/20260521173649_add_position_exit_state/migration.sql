-- CreateTable
CREATE TABLE "PositionExitState" (
    "id" SERIAL NOT NULL,
    "trackedPositionId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'watching',
    "targetUnlocked" BOOLEAN NOT NULL DEFAULT false,
    "targetUnlockedAt" TIMESTAMP(3),
    "targetUnlockedPrice" DOUBLE PRECISION,
    "targetUnlockedPnlPct" DOUBLE PRECISION,
    "highWaterMark" DOUBLE PRECISION,
    "trailStopPrice" DOUBLE PRECISION,
    "exitProfileKey" TEXT,
    "exitMode" TEXT,
    "takeProfitBehavior" TEXT,
    "targetPct" DOUBLE PRECISION,
    "trailingStopPct" DOUBLE PRECISION,
    "trailBroker" TEXT,
    "trailBrokerOrderId" TEXT,
    "trailClientOrderId" TEXT,
    "trailOrderStatus" TEXT,
    "rawBrokerJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PositionExitState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PositionExitState_trackedPositionId_key" ON "PositionExitState"("trackedPositionId");

-- CreateIndex
CREATE INDEX "PositionExitState_status_idx" ON "PositionExitState"("status");

-- CreateIndex
CREATE INDEX "PositionExitState_targetUnlocked_idx" ON "PositionExitState"("targetUnlocked");

-- CreateIndex
CREATE INDEX "PositionExitState_trailOrderStatus_idx" ON "PositionExitState"("trailOrderStatus");

-- AddForeignKey
ALTER TABLE "PositionExitState" ADD CONSTRAINT "PositionExitState_trackedPositionId_fkey" FOREIGN KEY ("trackedPositionId") REFERENCES "TrackedPosition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
