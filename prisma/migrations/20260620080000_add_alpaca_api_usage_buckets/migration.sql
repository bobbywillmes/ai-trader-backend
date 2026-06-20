-- CreateTable
CREATE TABLE "AlpacaApiUsageBucket" (
    "id" SERIAL NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "bucketSizeMinutes" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "requestClass" TEXT NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "rateLimitCount" INTEGER NOT NULL DEFAULT 0,
    "networkErrorCount" INTEGER NOT NULL DEFAULT 0,
    "totalDurationMs" INTEGER NOT NULL DEFAULT 0,
    "maxDurationMs" INTEGER NOT NULL DEFAULT 0,
    "lastStatusCode" INTEGER,
    "lastRequestAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastRateLimitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlpacaApiUsageBucket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AlpacaApiUsageBucket_bucketStart_operation_endpoint_method_requestClass_key" ON "AlpacaApiUsageBucket"("bucketStart", "operation", "endpoint", "method", "requestClass");

-- CreateIndex
CREATE INDEX "AlpacaApiUsageBucket_bucketStart_idx" ON "AlpacaApiUsageBucket"("bucketStart");

-- CreateIndex
CREATE INDEX "AlpacaApiUsageBucket_operation_idx" ON "AlpacaApiUsageBucket"("operation");

-- CreateIndex
CREATE INDEX "AlpacaApiUsageBucket_endpoint_idx" ON "AlpacaApiUsageBucket"("endpoint");

-- CreateIndex
CREATE INDEX "AlpacaApiUsageBucket_updatedAt_idx" ON "AlpacaApiUsageBucket"("updatedAt");
