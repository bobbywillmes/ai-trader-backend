-- CreateTable
CREATE TABLE "CurrentMarketState" (
    "id" INTEGER NOT NULL,
    "marketBias" TEXT NOT NULL DEFAULT 'neutral',
    "riskMode" TEXT NOT NULL DEFAULT 'normal',
    "macroSummary" TEXT,
    "watchFor" TEXT,
    "avoidBecause" TEXT,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'system',
    "validUntil" TIMESTAMP(3),
    "lastLlmRunAt" TIMESTAMP(3),
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurrentMarketState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketDiaryEvent" (
    "id" SERIAL NOT NULL,
    "eventType" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'system',
    "symbol" TEXT,
    "summary" TEXT NOT NULL,
    "details" TEXT,
    "symbolsJson" JSONB,
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketDiaryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketDiaryEvent_eventType_idx" ON "MarketDiaryEvent"("eventType");

-- CreateIndex
CREATE INDEX "MarketDiaryEvent_source_idx" ON "MarketDiaryEvent"("source");

-- CreateIndex
CREATE INDEX "MarketDiaryEvent_symbol_idx" ON "MarketDiaryEvent"("symbol");

-- CreateIndex
CREATE INDEX "MarketDiaryEvent_createdAt_idx" ON "MarketDiaryEvent"("createdAt");
