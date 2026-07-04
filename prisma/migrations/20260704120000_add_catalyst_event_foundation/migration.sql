-- CreateEnum
CREATE TYPE "CatalystSource" AS ENUM ('MASSIVE_NEWS', 'MASSIVE_BENZINGA', 'SEC_EDGAR', 'COMPANY_IR', 'MANUAL');

-- CreateEnum
CREATE TYPE "CatalystEventType" AS ENUM ('EARNINGS', 'GUIDANCE', 'ANALYST_UPGRADE', 'ANALYST_DOWNGRADE', 'FDA_REGULATORY', 'CONTRACT_WIN', 'PARTNERSHIP', 'ACQUISITION_MERGER', 'INDEX_ADDITION', 'INDEX_REMOVAL', 'INSIDER_BUYING', 'INSIDER_SELLING', 'OFFERING_DILUTION', 'SEC_FILING', 'PRODUCT_LAUNCH', 'MACRO_MARKET', 'SECTOR_THEME', 'OPINION_ANALYSIS', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CatalystTier" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'IGNORE');

-- CreateEnum
CREATE TYPE "CatalystSentiment" AS ENUM ('POSITIVE', 'NEGATIVE', 'NEUTRAL', 'MIXED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CatalystTickerRole" AS ENUM ('PRIMARY_SUBJECT', 'DIRECT_BENEFICIARY', 'INDIRECT_BENEFICIARY', 'DIRECT_NEGATIVE', 'INDIRECT_NEGATIVE', 'PEER_COMPARISON', 'CUSTOMER', 'SUPPLIER', 'COMPETITOR', 'TANGENTIAL_MENTION');

-- CreateTable
CREATE TABLE "CatalystEvent" (
    "id" TEXT NOT NULL,
    "source" "CatalystSource" NOT NULL,
    "sourceExternalId" TEXT,
    "sourceUrl" TEXT,
    "sourcePublisher" TEXT,
    "sourceAuthor" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "bodyExcerpt" TEXT,
    "language" TEXT,
    "publishedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventType" "CatalystEventType" NOT NULL DEFAULT 'UNKNOWN',
    "eventTier" "CatalystTier" NOT NULL DEFAULT 'LOW',
    "sentiment" "CatalystSentiment" NOT NULL DEFAULT 'UNKNOWN',
    "confidence" DOUBLE PRECISION,
    "isDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "duplicateOfId" TEXT,
    "rawPayload" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalystEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalystTickerImpact" (
    "id" TEXT NOT NULL,
    "catalystEventId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "sentiment" "CatalystSentiment" NOT NULL DEFAULT 'UNKNOWN',
    "sentimentReasoning" TEXT,
    "relevanceScore" INTEGER NOT NULL DEFAULT 0,
    "actionabilityScore" INTEGER NOT NULL DEFAULT 0,
    "freshnessScore" INTEGER NOT NULL DEFAULT 0,
    "sourceQualityScore" INTEGER NOT NULL DEFAULT 0,
    "totalCatalystScore" INTEGER NOT NULL DEFAULT 0,
    "isPrimaryTicker" BOOLEAN NOT NULL DEFAULT false,
    "isCompanySpecific" BOOLEAN NOT NULL DEFAULT false,
    "isMarketWide" BOOLEAN NOT NULL DEFAULT false,
    "isSectorWide" BOOLEAN NOT NULL DEFAULT false,
    "catalystRole" "CatalystTickerRole",
    "blockedReason" TEXT,
    "rawInsight" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalystTickerImpact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsPullCursor" (
    "id" TEXT NOT NULL,
    "source" "CatalystSource" NOT NULL,
    "symbol" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "pullIntervalMin" INTEGER NOT NULL DEFAULT 15,
    "lastPulledAt" TIMESTAMP(3),
    "lastPublishedAt" TIMESTAMP(3),
    "lastSourceCursor" TEXT,
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsPullCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CatalystEvent_source_sourceExternalId_key" ON "CatalystEvent"("source", "sourceExternalId");

-- CreateIndex
CREATE INDEX "CatalystEvent_source_publishedAt_idx" ON "CatalystEvent"("source", "publishedAt");

-- CreateIndex
CREATE INDEX "CatalystEvent_eventType_eventTier_idx" ON "CatalystEvent"("eventType", "eventTier");

-- CreateIndex
CREATE INDEX "CatalystEvent_receivedAt_idx" ON "CatalystEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CatalystTickerImpact_catalystEventId_symbol_key" ON "CatalystTickerImpact"("catalystEventId", "symbol");

-- CreateIndex
CREATE INDEX "CatalystTickerImpact_symbol_totalCatalystScore_idx" ON "CatalystTickerImpact"("symbol", "totalCatalystScore");

-- CreateIndex
CREATE INDEX "CatalystTickerImpact_symbol_createdAt_idx" ON "CatalystTickerImpact"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "CatalystTickerImpact_totalCatalystScore_idx" ON "CatalystTickerImpact"("totalCatalystScore");

-- CreateIndex
CREATE UNIQUE INDEX "NewsPullCursor_source_symbol_key" ON "NewsPullCursor"("source", "symbol");

-- CreateIndex
CREATE INDEX "NewsPullCursor_enabled_priority_lastPulledAt_idx" ON "NewsPullCursor"("enabled", "priority", "lastPulledAt");

-- CreateIndex
CREATE INDEX "NewsPullCursor_source_enabled_idx" ON "NewsPullCursor"("source", "enabled");

-- CreateIndex
CREATE INDEX "NewsPullCursor_symbol_idx" ON "NewsPullCursor"("symbol");

-- AddForeignKey
ALTER TABLE "CatalystTickerImpact" ADD CONSTRAINT "CatalystTickerImpact_catalystEventId_fkey" FOREIGN KEY ("catalystEventId") REFERENCES "CatalystEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
