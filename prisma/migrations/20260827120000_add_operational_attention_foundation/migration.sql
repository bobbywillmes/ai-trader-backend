-- CreateEnum
CREATE TYPE "SystemEventSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "OperationalAttentionStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "OperationalAttentionResolutionPolicy" AS ENUM ('AUTHORITATIVE_ONLY', 'MANUAL_ALLOWED');

-- CreateEnum
CREATE TYPE "OperationalAttentionResolutionMethod" AS ENUM ('AUTHORITATIVE', 'MANUAL');

-- CreateEnum
CREATE TYPE "OperationalAttentionEventRelationKind" AS ENUM ('OPENED', 'OBSERVED', 'ESCALATED', 'ACKNOWLEDGED', 'RESOLVED');

-- AlterTable
ALTER TABLE "SystemEvent"
ADD COLUMN "severity" "SystemEventSeverity" NOT NULL DEFAULT 'INFO';

-- CreateTable
CREATE TABLE "OperationalAttention" (
    "id" SERIAL NOT NULL,
    "tradingAccountId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "OperationalAttentionStatus" NOT NULL DEFAULT 'OPEN',
    "severity" "SystemEventSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detailsJson" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "activeKey" TEXT,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "resolutionPolicy" "OperationalAttentionResolutionPolicy" NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByUserId" INTEGER,
    "acknowledgedByUserIdSnapshot" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" INTEGER,
    "resolvedByUserIdSnapshot" INTEGER,
    "resolutionMethod" "OperationalAttentionResolutionMethod",
    "resolutionReason" TEXT,
    "trackedPositionId" INTEGER,
    "orderIntentId" INTEGER,
    "brokerOrderId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalAttention_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OperationalAttention_occurrenceCount_check" CHECK ("occurrenceCount" >= 1),
    CONSTRAINT "OperationalAttention_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "OperationalAttention_active_severity_check" CHECK (
      "status" = 'RESOLVED' OR "severity" <> 'INFO'
    ),
    CONSTRAINT "OperationalAttention_active_state_check" CHECK (
      ("status" IN ('OPEN', 'ACKNOWLEDGED') AND "activeKey" IS NOT NULL AND "resolvedAt" IS NULL AND "resolutionMethod" IS NULL)
      OR
      ("status" = 'RESOLVED' AND "activeKey" IS NULL AND "resolvedAt" IS NOT NULL AND "resolutionMethod" IS NOT NULL)
    ),
    CONSTRAINT "OperationalAttention_acknowledgement_check" CHECK (
      "status" <> 'ACKNOWLEDGED' OR ("acknowledgedAt" IS NOT NULL AND "acknowledgedByUserIdSnapshot" IS NOT NULL)
    ),
    CONSTRAINT "OperationalAttention_manual_resolution_check" CHECK (
      "resolutionMethod" <> 'MANUAL'
      OR (
        "resolutionPolicy" = 'MANUAL_ALLOWED'
        AND "resolvedByUserIdSnapshot" IS NOT NULL
        AND length(btrim(COALESCE("resolutionReason", ''))) > 0
      )
    ),
    CONSTRAINT "OperationalAttention_resolution_reason_check" CHECK (
      "status" <> 'RESOLVED' OR length(btrim(COALESCE("resolutionReason", ''))) > 0
    )
);

-- CreateTable
CREATE TABLE "OperationalAttentionSystemEvent" (
    "operationalAttentionId" INTEGER NOT NULL,
    "systemEventId" INTEGER NOT NULL,
    "relationKind" "OperationalAttentionEventRelationKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalAttentionSystemEvent_pkey" PRIMARY KEY ("operationalAttentionId", "systemEventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "OperationalAttention_activeKey_key" ON "OperationalAttention"("activeKey");
CREATE INDEX "OperationalAttention_tradingAccountId_status_severity_idx" ON "OperationalAttention"("tradingAccountId", "status", "severity");
CREATE INDEX "OperationalAttention_tradingAccountId_lastObservedAt_idx" ON "OperationalAttention"("tradingAccountId", "lastObservedAt");
CREATE INDEX "OperationalAttention_fingerprint_idx" ON "OperationalAttention"("fingerprint");
CREATE INDEX "OperationalAttention_trackedPositionId_idx" ON "OperationalAttention"("trackedPositionId");
CREATE INDEX "OperationalAttention_orderIntentId_idx" ON "OperationalAttention"("orderIntentId");
CREATE INDEX "OperationalAttention_brokerOrderId_idx" ON "OperationalAttention"("brokerOrderId");
CREATE INDEX "OperationalAttention_acknowledgedByUserId_idx" ON "OperationalAttention"("acknowledgedByUserId");
CREATE INDEX "OperationalAttention_resolvedByUserId_idx" ON "OperationalAttention"("resolvedByUserId");
CREATE INDEX "OperationalAttentionSystemEvent_systemEventId_idx" ON "OperationalAttentionSystemEvent"("systemEventId");

-- AddForeignKey
ALTER TABLE "OperationalAttention" ADD CONSTRAINT "OperationalAttention_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationalAttention" ADD CONSTRAINT "OperationalAttention_acknowledgedByUserId_fkey" FOREIGN KEY ("acknowledgedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OperationalAttention" ADD CONSTRAINT "OperationalAttention_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OperationalAttention" ADD CONSTRAINT "OperationalAttention_trackedPositionId_fkey" FOREIGN KEY ("trackedPositionId") REFERENCES "TrackedPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationalAttention" ADD CONSTRAINT "OperationalAttention_orderIntentId_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationalAttention" ADD CONSTRAINT "OperationalAttention_brokerOrderId_fkey" FOREIGN KEY ("brokerOrderId") REFERENCES "BrokerOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationalAttentionSystemEvent" ADD CONSTRAINT "OperationalAttentionSystemEvent_operationalAttentionId_fkey" FOREIGN KEY ("operationalAttentionId") REFERENCES "OperationalAttention"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationalAttentionSystemEvent" ADD CONSTRAINT "OperationalAttentionSystemEvent_systemEventId_fkey" FOREIGN KEY ("systemEventId") REFERENCES "SystemEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
