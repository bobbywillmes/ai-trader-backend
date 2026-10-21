ALTER TABLE "OrderIntent"
  ADD COLUMN "lastSubmittedOrderSyncAt" TIMESTAMP(3);

CREATE INDEX "OrderIntent_tradingAccountId_lastSubmittedOrderSyncAt_id_idx"
  ON "OrderIntent"("tradingAccountId", "lastSubmittedOrderSyncAt", "id");
