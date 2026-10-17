-- Phase 3C.0 is schema-only on deployment. Existing lifecycle rows are not
-- inferred into claims by this migration; runtime admission fails closed when
-- unresolved pre-claim exposure exists.
CREATE TABLE "EntryExposureClaim" (
    "id" SERIAL NOT NULL,
    "tradingAccountId" INTEGER NOT NULL,
    "securityId" INTEGER NOT NULL,
    "orderIntentId" INTEGER,
    "trackedPositionId" INTEGER,
    "ownerKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ENTRY_PENDING',
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "lastDiagnosedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EntryExposureClaim_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EntryExposureClaimEvent" (
    "id" SERIAL NOT NULL,
    "claimId" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EntryExposureClaimEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EntryExposureClaim_ownerKey_key" ON "EntryExposureClaim"("ownerKey");
CREATE UNIQUE INDEX "EntryExposureClaim_orderIntentId_key" ON "EntryExposureClaim"("orderIntentId");
CREATE UNIQUE INDEX "EntryExposureClaim_trackedPositionId_key" ON "EntryExposureClaim"("trackedPositionId");
CREATE INDEX "EntryExposureClaim_tradingAccountId_securityId_idx" ON "EntryExposureClaim"("tradingAccountId", "securityId");
CREATE INDEX "EntryExposureClaim_status_releasedAt_idx" ON "EntryExposureClaim"("status", "releasedAt");
CREATE UNIQUE INDEX "EntryExposureClaim_active_account_security_key"
  ON "EntryExposureClaim"("tradingAccountId", "securityId")
  WHERE "releasedAt" IS NULL;
CREATE INDEX "EntryExposureClaimEvent_claimId_createdAt_idx" ON "EntryExposureClaimEvent"("claimId", "createdAt");

ALTER TABLE "EntryExposureClaim" ADD CONSTRAINT "EntryExposureClaim_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EntryExposureClaim" ADD CONSTRAINT "EntryExposureClaim_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EntryExposureClaim" ADD CONSTRAINT "EntryExposureClaim_orderIntentId_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EntryExposureClaim" ADD CONSTRAINT "EntryExposureClaim_trackedPositionId_fkey" FOREIGN KEY ("trackedPositionId") REFERENCES "TrackedPosition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EntryExposureClaimEvent" ADD CONSTRAINT "EntryExposureClaimEvent_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "EntryExposureClaim"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "EntryExposureClaim" ADD CONSTRAINT "EntryExposureClaim_owner_check" CHECK (
  "orderIntentId" IS NOT NULL OR "trackedPositionId" IS NOT NULL
);
ALTER TABLE "EntryExposureClaim" ADD CONSTRAINT "EntryExposureClaim_release_check" CHECK (
  ("releasedAt" IS NULL AND "releaseReason" IS NULL) OR
  ("releasedAt" IS NOT NULL AND "releaseReason" IS NOT NULL)
);
