BEGIN;

ALTER TYPE "MarketDataProvider" ADD VALUE 'TIINGO';
ALTER TABLE "MarketBar" ADD COLUMN "splitFactor" DECIMAL(24,10);
ALTER TABLE "MarketBar" ADD CONSTRAINT "MarketBar_splitFactor_check" CHECK (
  "splitFactor" IS NULL OR ("splitFactor" > 0 AND "splitFactor"::text NOT IN ('NaN','Infinity','-Infinity'))
);

CREATE TABLE "SecurityUniverse" (
  "id" SERIAL PRIMARY KEY, "code" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityUniverse_label_check" CHECK (length(trim("code")) BETWEEN 1 AND 80 AND length(trim("name")) BETWEEN 1 AND 160)
);
CREATE TABLE "SecurityUniverseMembership" (
  "id" SERIAL PRIMARY KEY, "universeId" INTEGER NOT NULL, "securityId" INTEGER NOT NULL,
  "effectiveFrom" DATE NOT NULL, "effectiveTo" DATE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityUniverseMembership_dates_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"),
  CONSTRAINT "SecurityUniverseMembership_universeId_fkey" FOREIGN KEY ("universeId") REFERENCES "SecurityUniverse"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SecurityUniverseMembership_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "SecurityUniverseMembership_identity_key" ON "SecurityUniverseMembership"("universeId","securityId","effectiveFrom");
CREATE INDEX "SecurityUniverseMembership_securityId_effectiveFrom_idx" ON "SecurityUniverseMembership"("securityId","effectiveFrom");
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "SecurityUniverseMembership" ADD CONSTRAINT "SecurityUniverseMembership_no_overlap" EXCLUDE USING gist (
  "universeId" WITH =, "securityId" WITH =,
  daterange("effectiveFrom", "effectiveTo", '[)') WITH &&
);

CREATE TABLE "BreadthUniverseRevision" (
  "id" SERIAL PRIMARY KEY, "effectiveFrom" DATE NOT NULL UNIQUE,
  "memberCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BreadthUniverseRevision_count_check" CHECK ("memberCount" > 0)
);
CREATE TABLE "BreadthUniverseRevisionMember" (
  "revisionId" INTEGER NOT NULL, "securityId" INTEGER NOT NULL,
  CONSTRAINT "BreadthUniverseRevisionMember_pkey" PRIMARY KEY ("revisionId","securityId"),
  CONSTRAINT "BreadthUniverseRevisionMember_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "BreadthUniverseRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BreadthUniverseRevisionMember_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TRIGGER immutable_breadth_universe_revision BEFORE UPDATE OR DELETE ON "BreadthUniverseRevision" FOR EACH ROW EXECUTE FUNCTION reject_market_evidence_mutation();
CREATE TRIGGER immutable_breadth_universe_revision_member BEFORE UPDATE OR DELETE ON "BreadthUniverseRevisionMember" FOR EACH ROW EXECUTE FUNCTION reject_market_evidence_mutation();

CREATE TABLE "MarketSplitEvent" (
  "id" SERIAL PRIMARY KEY, "securityId" INTEGER NOT NULL, "executionDate" DATE NOT NULL,
  "splitFactor" DECIMAL(24,10) NOT NULL, "provider" "MarketDataProvider" NOT NULL,
  "provenance" TEXT NOT NULL, "receivedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketSplitEvent_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MarketSplitEvent_factor_check" CHECK ("splitFactor" > 0 AND "splitFactor" <> 1 AND "splitFactor"::text NOT IN ('NaN','Infinity','-Infinity') AND length(trim("provenance")) BETWEEN 1 AND 240)
);
CREATE UNIQUE INDEX "MarketSplitEvent_securityId_executionDate_key" ON "MarketSplitEvent"("securityId","executionDate");
CREATE TRIGGER immutable_market_split_event BEFORE UPDATE OR DELETE ON "MarketSplitEvent" FOR EACH ROW EXECUTE FUNCTION reject_market_evidence_mutation();

ALTER TABLE "MarketBreadthObservation" ADD COLUMN "breadthUniverseRevisionId" INTEGER;
ALTER TABLE "MarketBreadthObservation" ADD CONSTRAINT "MarketBreadthObservation_breadthUniverseRevisionId_fkey"
  FOREIGN KEY ("breadthUniverseRevisionId") REFERENCES "BreadthUniverseRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
