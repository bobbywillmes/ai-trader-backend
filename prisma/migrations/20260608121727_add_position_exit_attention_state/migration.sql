-- AlterTable
ALTER TABLE "PositionExitState" ADD COLUMN     "attentionAt" TIMESTAMP(3),
ADD COLUMN     "attentionClearedAt" TIMESTAMP(3),
ADD COLUMN     "attentionCode" TEXT,
ADD COLUMN     "attentionMessage" TEXT,
ADD COLUMN     "attentionRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "PositionExitState_attentionRequired_idx" ON "PositionExitState"("attentionRequired");

-- CreateIndex
CREATE INDEX "PositionExitState_attentionCode_idx" ON "PositionExitState"("attentionCode");
