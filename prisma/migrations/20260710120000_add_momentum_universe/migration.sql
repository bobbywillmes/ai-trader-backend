CREATE TYPE "MomentumUniverseReason" AS ENUM ('MANUAL', 'SUBSCRIPTION', 'OPEN_POSITION', 'DISCOVERY', 'IMPORTED');

CREATE TABLE "MomentumUniverseMember" (
    "id" TEXT NOT NULL,
    "securityId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "newsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "priceScanningEnabled" BOOLEAN NOT NULL DEFAULT true,
    "pullIntervalMin" INTEGER NOT NULL DEFAULT 15,
    "addedReason" "MomentumUniverseReason" NOT NULL DEFAULT 'MANUAL',
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MomentumUniverseMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MomentumUniverseMember_securityId_key" ON "MomentumUniverseMember"("securityId");
CREATE INDEX "MomentumUniverseMember_enabled_idx" ON "MomentumUniverseMember"("enabled");
CREATE INDEX "MomentumUniverseMember_priority_idx" ON "MomentumUniverseMember"("priority");
CREATE INDEX "MomentumUniverseMember_addedReason_idx" ON "MomentumUniverseMember"("addedReason");

ALTER TABLE "MomentumUniverseMember" ADD CONSTRAINT "MomentumUniverseMember_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SOFI and SNOW were part of the original hard-coded news universe but were not
-- present in the repository's Security seed. Ensure they exist without changing
-- any Security rows that may already have been created operationally.
INSERT INTO "Security" ("symbol", "name", "enabled", "assetType", "sector", "industry", "createdAt", "updatedAt")
VALUES
    ('SOFI', 'SoFi Technologies Inc', true, 'STOCK', 'Financials', 'Consumer Finance', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('SNOW', 'Snowflake Inc', true, 'STOCK', 'Information Technology', 'Application Software', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("symbol") DO NOTHING;

-- Preserve the complete initial Massive news universe as explicit, imported
-- research membership linked to the canonical Security rows.
INSERT INTO "MomentumUniverseMember" ("id", "securityId", "addedReason", "metadata", "createdAt", "updatedAt")
SELECT
    'initial_momentum_' || lower("symbol"),
    "id",
    'IMPORTED'::"MomentumUniverseReason",
    jsonb_build_object('seedUniverse', 'initial_massive_news_symbols'),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Security"
WHERE "symbol" IN (
    'AAPL', 'AMZN', 'GOOG', 'GOOGL', 'META', 'MSFT', 'NVDA', 'TSLA',
    'AMD', 'MU', 'DELL', 'AVGO', 'PLTR', 'SOFI', 'SNOW'
)
ON CONFLICT ("securityId") DO NOTHING;
