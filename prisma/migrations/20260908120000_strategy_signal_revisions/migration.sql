-- Additive migration: preserve original Signal labels, hashes and delivery bytes.
CREATE TYPE "StrategySignalRevisionStatus" AS ENUM ('PREPARED', 'ACTIVE', 'RETIRED');
CREATE TABLE "StrategySignalRevision" (
  "id" SERIAL NOT NULL,
  "strategySignalBindingId" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "status" "StrategySignalRevisionStatus" NOT NULL,
  "changeNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  CONSTRAINT "StrategySignalRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StrategySignalRevision_strategySignalBindingId_fkey" FOREIGN KEY ("strategySignalBindingId") REFERENCES "StrategySignalBinding"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "StrategySignalRevision_lifecycle_check" CHECK (
    (status = 'PREPARED' AND "activatedAt" IS NULL AND "retiredAt" IS NULL) OR
    (status = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL) OR
    (status = 'RETIRED' AND "retiredAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "StrategySignalRevision_strategySignalBindingId_revision_key" ON "StrategySignalRevision"("strategySignalBindingId", "revision");
CREATE UNIQUE INDEX "StrategySignalRevision_id_strategySignalBindingId_revision_key" ON "StrategySignalRevision"("id", "strategySignalBindingId", "revision");
CREATE UNIQUE INDEX "StrategySignalRevision_one_active" ON "StrategySignalRevision"("strategySignalBindingId") WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX "StrategySignalRevision_one_prepared" ON "StrategySignalRevision"("strategySignalBindingId") WHERE status = 'PREPARED';
INSERT INTO "StrategySignalRevision" ("strategySignalBindingId", revision, status, "activatedAt", "changeNote")
SELECT id, 1, 'ACTIVE', CURRENT_TIMESTAMP, 'Initial numeric revision created during revision lifecycle migration; prior Signals retain their original labels.' FROM "StrategySignalBinding";
ALTER TABLE "StrategySignalBinding" DROP COLUMN "expectedRevision";
ALTER TABLE "Signal" RENAME COLUMN "strategyRevision" TO "legacyStrategyRevision";
ALTER TABLE "Signal" ALTER COLUMN "legacyStrategyRevision" DROP NOT NULL;
ALTER TABLE "Signal" ADD COLUMN "strategyRevision" INTEGER, ADD COLUMN "strategySignalRevisionId" INTEGER;
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_revision_evidence_check" CHECK (
  ("legacyStrategyRevision" IS NOT NULL AND "strategyRevision" IS NULL AND "strategySignalRevisionId" IS NULL) OR
  ("legacyStrategyRevision" IS NULL AND "strategyRevision" > 0 AND "strategyRevision" IS NOT NULL AND "strategySignalRevisionId" IS NOT NULL));
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_strategySignalRevisionId_strategySignalBindingId_st_fkey"
  FOREIGN KEY ("strategySignalRevisionId", "strategySignalBindingId", "strategyRevision")
  REFERENCES "StrategySignalRevision"("id", "strategySignalBindingId", "revision") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "Signal_strategySignalRevisionId_strategySignalBindingId_str_idx" ON "Signal"("strategySignalRevisionId", "strategySignalBindingId", "strategyRevision");
