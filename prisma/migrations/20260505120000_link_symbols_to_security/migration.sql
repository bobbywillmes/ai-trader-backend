-- Add nullable foreign keys so existing rows can be backfilled
ALTER TABLE "BrokerOrder" ADD COLUMN "securityId" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN "securityId" INTEGER;
ALTER TABLE "TrackedPosition" ADD COLUMN "securityId" INTEGER;

-- Ensure any symbol values without a matching Security get a placeholder Security row
INSERT INTO "Security" ("symbol", "name", "assetType", "createdAt", "updatedAt")
SELECT DISTINCT symbol, symbol, 'OTHER'::"AssetType", NOW(), NOW()
FROM (
  SELECT "symbol" FROM "BrokerOrder"
  UNION
  SELECT "symbol" FROM "Subscription"
  UNION
  SELECT "symbol" FROM "TrackedPosition"
) AS symbols
WHERE symbol IS NOT NULL
  AND symbol NOT IN (SELECT "symbol" FROM "Security");

-- Backfill the new foreign keys using the Security symbol mapping
UPDATE "BrokerOrder" bo
SET "securityId" = s."id"
FROM "Security" s
WHERE s."symbol" = bo."symbol";

UPDATE "Subscription" sub
SET "securityId" = s."id"
FROM "Security" s
WHERE s."symbol" = sub."symbol";

UPDATE "TrackedPosition" tp
SET "securityId" = s."id"
FROM "Security" s
WHERE s."symbol" = tp."symbol";

-- Enforce required relationships after the backfill
ALTER TABLE "BrokerOrder" ALTER COLUMN "securityId" SET NOT NULL;
ALTER TABLE "Subscription" ALTER COLUMN "securityId" SET NOT NULL;
ALTER TABLE "TrackedPosition" ALTER COLUMN "securityId" SET NOT NULL;

ALTER TABLE "BrokerOrder"
ADD CONSTRAINT "BrokerOrder_securityId_fkey"
FOREIGN KEY ("securityId")
REFERENCES "Security"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "Subscription"
ADD CONSTRAINT "Subscription_securityId_fkey"
FOREIGN KEY ("securityId")
REFERENCES "Security"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "TrackedPosition"
ADD CONSTRAINT "TrackedPosition_securityId_fkey"
FOREIGN KEY ("securityId")
REFERENCES "Security"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;
