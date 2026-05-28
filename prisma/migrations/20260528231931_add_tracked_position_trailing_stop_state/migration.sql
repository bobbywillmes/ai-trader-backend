-- AlterTable
ALTER TABLE "TrackedPosition" ADD COLUMN     "trailingStopClientOrderId" TEXT,
ADD COLUMN     "trailingStopHwm" DOUBLE PRECISION,
ADD COLUMN     "trailingStopLastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "trailingStopOrderId" TEXT,
ADD COLUMN     "trailingStopStatus" TEXT,
ADD COLUMN     "trailingStopStopPrice" DOUBLE PRECISION,
ADD COLUMN     "trailingStopSubmittedAt" TIMESTAMP(3),
ADD COLUMN     "trailingStopTrailPercent" DOUBLE PRECISION,
ADD COLUMN     "trailingUnlocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trailingUnlockedAt" TIMESTAMP(3),
ADD COLUMN     "trailingUnlockedPrice" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "TrackedPosition_trailingStopOrderId_idx" ON "TrackedPosition"("trailingStopOrderId");

-- CreateIndex
CREATE INDEX "TrackedPosition_trailingStopStatus_idx" ON "TrackedPosition"("trailingStopStatus");
