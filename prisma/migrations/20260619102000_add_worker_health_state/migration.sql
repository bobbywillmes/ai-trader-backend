CREATE TABLE "WorkerHealthState" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "processInstanceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "expectedIntervalMs" INTEGER NOT NULL,
    "currentRunStartedAt" TIMESTAMP(3),
    "lastTickStartedAt" TIMESTAMP(3),
    "lastTickCompletedAt" TIMESTAMP(3),
    "lastSucceededAt" TIMESTAMP(3),
    "lastWorkSucceededAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "lastDurationMs" INTEGER,
    "lastOutcome" TEXT,
    "lastSkipReason" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "totalRuns" INTEGER NOT NULL DEFAULT 0,
    "totalFailures" INTEGER NOT NULL DEFAULT 0,
    "totalSkips" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerHealthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkerHealthState_key_key" ON "WorkerHealthState"("key");
CREATE INDEX "WorkerHealthState_processInstanceId_idx" ON "WorkerHealthState"("processInstanceId");
CREATE INDEX "WorkerHealthState_updatedAt_idx" ON "WorkerHealthState"("updatedAt");
CREATE INDEX "WorkerHealthState_enabled_idx" ON "WorkerHealthState"("enabled");
