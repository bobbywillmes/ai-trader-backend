BEGIN;
CREATE TABLE "MarketSplitCoverage" (
  "id" SERIAL PRIMARY KEY,
  "securityId" INTEGER NOT NULL,
  "fromDate" DATE NOT NULL,
  "throughDate" DATE NOT NULL,
  "provider" "MarketDataProvider" NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketSplitCoverage_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MarketSplitCoverage_dates_check" CHECK ("fromDate" <= "throughDate")
);
CREATE UNIQUE INDEX "MarketSplitCoverage_identity_key" ON "MarketSplitCoverage"("securityId","fromDate","throughDate");
CREATE INDEX "MarketSplitCoverage_securityId_fromDate_idx" ON "MarketSplitCoverage"("securityId","fromDate");
CREATE TRIGGER immutable_market_split_coverage BEFORE UPDATE OR DELETE ON "MarketSplitCoverage"
FOR EACH ROW EXECUTE FUNCTION reject_market_evidence_mutation();
COMMIT;
