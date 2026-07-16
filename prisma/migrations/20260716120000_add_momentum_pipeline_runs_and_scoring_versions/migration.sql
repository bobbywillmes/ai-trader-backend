-- CreateEnum
CREATE TYPE "MomentumPipelineRunSource" AS ENUM ('N8N_SCHEDULED', 'N8N_MANUAL', 'ADMIN_MANUAL');

-- CreateEnum
CREATE TYPE "MomentumPipelineRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "MomentumPipelineStage" AS ENUM ('NEWS', 'EXPIRATION', 'CANDIDATE_GENERATION', 'PRICE_CONFIRMATION', 'HANDOFF_PREPARATION', 'HANDOFF_DELIVERY');

-- AlterTable
ALTER TABLE "MomentumCandidatePriceCheck"
ADD COLUMN "scoringVersion" TEXT,
ADD COLUMN "scoringInputs" JSONB,
ADD COLUMN "scoreExplanation" JSONB;

-- CreateTable
CREATE TABLE "MomentumPipelineRun" (
    "id" TEXT NOT NULL,
    "source" "MomentumPipelineRunSource" NOT NULL,
    "status" "MomentumPipelineRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "currentStage" "MomentumPipelineStage",
    "errorStage" "MomentumPipelineStage",
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "newsResult" JSONB,
    "expirationResult" JSONB,
    "candidateResult" JSONB,
    "priceResult" JSONB,
    "handoffResult" JSONB,
    "deliveryResult" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MomentumPipelineRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MomentumCandidatePriceCheck_scoringVersion_observedAt_idx" ON "MomentumCandidatePriceCheck"("scoringVersion", "observedAt");

-- CreateIndex
CREATE INDEX "MomentumPipelineRun_startedAt_idx" ON "MomentumPipelineRun"("startedAt");

-- CreateIndex
CREATE INDEX "MomentumPipelineRun_status_startedAt_idx" ON "MomentumPipelineRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "MomentumPipelineRun_source_startedAt_idx" ON "MomentumPipelineRun"("source", "startedAt");
