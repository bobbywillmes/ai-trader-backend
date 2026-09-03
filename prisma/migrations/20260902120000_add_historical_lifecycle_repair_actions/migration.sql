ALTER TYPE "LifecycleRepairType" ADD VALUE 'REPAIR_HISTORICAL_ENTRY_LIFECYCLE';

CREATE TYPE "LifecycleRepairActionType" AS ENUM ('TERMINALIZE_ORDER_LIFECYCLE', 'LINK_ENTRY_LIFECYCLE_TO_POSITION');
CREATE TYPE "LifecycleRepairActionClassification" AS ENUM ('DETERMINISTIC', 'OPERATOR_CONFIRMATION_REQUIRED');
CREATE TYPE "LifecycleRepairActionStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REFUSED', 'APPLIED', 'VERIFIED', 'FAILED', 'SUPERSEDED');

ALTER TABLE "OperationalAttention" ADD COLUMN "materialFingerprint" TEXT;

CREATE TABLE "LifecycleRepairAction" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "actionType" "LifecycleRepairActionType" NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "classification" "LifecycleRepairActionClassification" NOT NULL,
    "status" "LifecycleRepairActionStatus" NOT NULL DEFAULT 'PROPOSED',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "actionFingerprint" TEXT NOT NULL,
    "proposedMutationsJson" JSONB NOT NULL,
    "preconditionsJson" JSONB NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "decidedByUserId" INTEGER,
    "decidedByUserIdSnapshot" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "reconsiderationReason" TEXT,
    "reconsideredByUserIdSnapshot" INTEGER,
    "reconsideredAt" TIMESTAMP(3),
    "supersedesActionId" INTEGER,
    "beforeJson" JSONB NOT NULL,
    "afterJson" JSONB,
    "verificationJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LifecycleRepairAction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LifecycleRepairAction_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "LifecycleRepairAction_decision_check" CHECK (
      ("status" = 'PROPOSED' AND "decidedAt" IS NULL AND "decisionReason" IS NULL)
      OR
      ("status" <> 'PROPOSED' AND "decidedAt" IS NOT NULL AND length(btrim(COALESCE("decisionReason", ''))) > 0)
    )
);

ALTER TABLE "LifecycleRepairExecution" ADD COLUMN "actionId" INTEGER;

CREATE UNIQUE INDEX "LifecycleRepairAction_caseId_ordinal_key" ON "LifecycleRepairAction"("caseId", "ordinal");
CREATE UNIQUE INDEX "LifecycleRepairAction_caseId_actionType_generation_key" ON "LifecycleRepairAction"("caseId", "actionType", "generation");
CREATE INDEX "LifecycleRepairAction_actionType_actionFingerprint_idx" ON "LifecycleRepairAction"("actionType", "actionFingerprint");
CREATE INDEX "LifecycleRepairAction_caseId_status_idx" ON "LifecycleRepairAction"("caseId", "status");
CREATE INDEX "LifecycleRepairAction_decidedByUserId_decidedAt_idx" ON "LifecycleRepairAction"("decidedByUserId", "decidedAt");
CREATE INDEX "LifecycleRepairAction_supersedesActionId_idx" ON "LifecycleRepairAction"("supersedesActionId");
CREATE INDEX "LifecycleRepairExecution_actionId_executedAt_idx" ON "LifecycleRepairExecution"("actionId", "executedAt");
CREATE UNIQUE INDEX "LifecycleRepairExecution_one_success_per_action_key" ON "LifecycleRepairExecution"("actionId") WHERE "result" = 'SUCCEEDED' AND "actionId" IS NOT NULL;

ALTER TABLE "LifecycleRepairAction" ADD CONSTRAINT "LifecycleRepairAction_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "LifecycleRepairCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LifecycleRepairAction" ADD CONSTRAINT "LifecycleRepairAction_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LifecycleRepairAction" ADD CONSTRAINT "LifecycleRepairAction_supersedesActionId_fkey" FOREIGN KEY ("supersedesActionId") REFERENCES "LifecycleRepairAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LifecycleRepairExecution" ADD CONSTRAINT "LifecycleRepairExecution_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "LifecycleRepairAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
