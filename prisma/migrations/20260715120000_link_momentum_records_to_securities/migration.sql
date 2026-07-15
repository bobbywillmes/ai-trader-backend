-- Security becomes the authoritative identity for resolvable momentum records.
-- Relations remain nullable so unknown or ambiguous historical symbols are
-- preserved for reconciliation instead of being deleted or guessed.
ALTER TABLE "CatalystTickerImpact" ADD COLUMN "securityId" INTEGER;
ALTER TABLE "MomentumCandidate" ADD COLUMN "securityId" INTEGER;

CREATE INDEX "CatalystTickerImpact_securityId_idx" ON "CatalystTickerImpact"("securityId");
CREATE INDEX "MomentumCandidate_securityId_idx" ON "MomentumCandidate"("securityId");
CREATE INDEX "MomentumCandidate_securityId_state_expiresAt_idx" ON "MomentumCandidate"("securityId", "state", "expiresAt");

ALTER TABLE "CatalystTickerImpact" ADD CONSTRAINT "CatalystTickerImpact_securityId_fkey"
FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MomentumCandidate" ADD CONSTRAINT "MomentumCandidate_securityId_fkey"
FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill only normalized symbols having exactly one Security match. BTRIM and
-- UPPER avoid whitespace and case mismatches. Symbols with no match or multiple
-- normalized matches remain NULL for explicit reconciliation reporting.
WITH "UniqueNormalizedSecurity" AS (
    SELECT
        UPPER(BTRIM("symbol")) AS "normalizedSymbol",
        MIN("id") AS "securityId"
    FROM "Security"
    GROUP BY UPPER(BTRIM("symbol"))
    HAVING COUNT(*) = 1
)
UPDATE "CatalystTickerImpact" AS "impact"
SET "securityId" = "mapping"."securityId"
FROM "UniqueNormalizedSecurity" AS "mapping"
WHERE UPPER(BTRIM("impact"."symbol")) = "mapping"."normalizedSymbol"
  AND "impact"."securityId" IS NULL;

WITH "UniqueNormalizedSecurity" AS (
    SELECT
        UPPER(BTRIM("symbol")) AS "normalizedSymbol",
        MIN("id") AS "securityId"
    FROM "Security"
    GROUP BY UPPER(BTRIM("symbol"))
    HAVING COUNT(*) = 1
)
UPDATE "MomentumCandidate" AS "candidate"
SET "securityId" = "mapping"."securityId"
FROM "UniqueNormalizedSecurity" AS "mapping"
WHERE UPPER(BTRIM("candidate"."symbol")) = "mapping"."normalizedSymbol"
  AND "candidate"."securityId" IS NULL;

-- Production verification queries (read-only):
--
-- Resolved and unmatched totals by record type:
-- SELECT COUNT(*) AS "total", COUNT("securityId") AS "resolved",
--        COUNT(*) FILTER (WHERE "securityId" IS NULL) AS "unmatchedOrAmbiguous"
-- FROM "CatalystTickerImpact";
-- SELECT COUNT(*) AS "total", COUNT("securityId") AS "resolved",
--        COUNT(*) FILTER (WHERE "securityId" IS NULL) AS "unmatchedOrAmbiguous"
-- FROM "MomentumCandidate";
--
-- Ambiguous normalized Security symbols:
-- SELECT UPPER(BTRIM("symbol")) AS "normalizedSymbol", COUNT(*) AS "matches",
--        ARRAY_AGG("id" ORDER BY "id") AS "securityIds"
-- FROM "Security"
-- GROUP BY UPPER(BTRIM("symbol"))
-- HAVING COUNT(*) > 1;
--
-- Unresolved symbols with their possible match count:
-- SELECT "recordType", "symbol", COUNT(*) AS "records",
--        (SELECT COUNT(*) FROM "Security" AS "security"
--         WHERE UPPER(BTRIM("security"."symbol")) = UPPER(BTRIM("unresolved"."symbol"))) AS "securityMatches"
-- FROM (
--   SELECT 'CatalystTickerImpact' AS "recordType", "impact"."symbol"
--   FROM "CatalystTickerImpact" AS "impact"
--   WHERE "impact"."securityId" IS NULL
--   UNION ALL
--   SELECT 'MomentumCandidate', "candidate"."symbol"
--   FROM "MomentumCandidate" AS "candidate"
--   WHERE "candidate"."securityId" IS NULL
-- ) AS "unresolved"
-- GROUP BY "recordType", "symbol"
-- ORDER BY "recordType", "symbol";
