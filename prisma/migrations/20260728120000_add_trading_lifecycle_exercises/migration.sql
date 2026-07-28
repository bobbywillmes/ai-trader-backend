CREATE TYPE "TradingLifecycleExerciseSelectionMode" AS ENUM ('SELECTED_USERS', 'ALL_ELIGIBLE');
CREATE TYPE "TradingLifecycleExerciseStatus" AS ENUM ('PREVIEWED', 'LAUNCHING', 'RUNNING', 'BLOCKED', 'PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'ATTENTION_REQUIRED');
CREATE TYPE "TradingLifecycleExerciseTargetStatus" AS ENUM ('READY', 'WARNING', 'BLOCKED', 'DISPATCHING', 'INTENT_CREATED', 'DUPLICATE', 'FAILED', 'ACTIVE', 'CLOSED', 'RECONCILED', 'ATTENTION_REQUIRED', 'CANCELLED');

CREATE TABLE "TradingLifecycleExercise" (
  "id" SERIAL NOT NULL, "name" TEXT, "reason" TEXT NOT NULL,
  "subscriptionId" INTEGER NOT NULL, "selectionMode" "TradingLifecycleExerciseSelectionMode" NOT NULL,
  "requestedUserIdsJson" JSONB NOT NULL, "environment" "TradingAccountEnvironment" NOT NULL,
  "status" "TradingLifecycleExerciseStatus" NOT NULL, "previewFingerprint" TEXT NOT NULL,
  "previewVersion" INTEGER NOT NULL DEFAULT 1, "previewedAt" TIMESTAMP(3) NOT NULL,
  "previewExpiresAt" TIMESTAMP(3) NOT NULL, "launchedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3), "cancelledAt" TIMESTAMP(3), "createdByUserId" INTEGER NOT NULL,
  "selectionResultsJson" JSONB NOT NULL, "summaryJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TradingLifecycleExercise_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TradingLifecycleExerciseTarget" (
  "id" SERIAL NOT NULL, "exerciseId" INTEGER NOT NULL, "accountHolderUserId" INTEGER NOT NULL,
  "tradingAccountId" INTEGER NOT NULL, "tradingAccountSubscriptionId" INTEGER NOT NULL,
  "environment" "TradingAccountEnvironment" NOT NULL, "status" "TradingLifecycleExerciseTargetStatus" NOT NULL,
  "previewFingerprint" TEXT NOT NULL, "readinessJson" JSONB NOT NULL, "blockersJson" JSONB NOT NULL,
  "warningsJson" JSONB NOT NULL, "resolvedSizingJson" JSONB, "estimatedPrice" DOUBLE PRECISION,
  "resolvedQuantity" DOUBLE PRECISION, "estimatedNotional" DOUBLE PRECISION, "orderIntentId" INTEGER,
  "dispatchStartedAt" TIMESTAMP(3), "dispatchCompletedAt" TIMESTAMP(3), "intentCreatedAt" TIMESTAMP(3),
  "reconciledAt" TIMESTAMP(3), "reconciliationSummaryJson" JSONB, "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TradingLifecycleExerciseTarget_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TradingLifecycleExercise_createdAt_idx" ON "TradingLifecycleExercise"("createdAt");
CREATE INDEX "TradingLifecycleExercise_status_createdAt_idx" ON "TradingLifecycleExercise"("status", "createdAt");
CREATE INDEX "TradingLifecycleExercise_subscriptionId_createdAt_idx" ON "TradingLifecycleExercise"("subscriptionId", "createdAt");
CREATE INDEX "TradingLifecycleExercise_createdByUserId_createdAt_idx" ON "TradingLifecycleExercise"("createdByUserId", "createdAt");
CREATE UNIQUE INDEX "TradingLifecycleExerciseTarget_orderIntentId_key" ON "TradingLifecycleExerciseTarget"("orderIntentId");
CREATE UNIQUE INDEX "TradingLifecycleExerciseTarget_exerciseId_tradingAccountSubscriptionId_key" ON "TradingLifecycleExerciseTarget"("exerciseId", "tradingAccountSubscriptionId");
CREATE INDEX "TradingLifecycleExerciseTarget_exerciseId_status_idx" ON "TradingLifecycleExerciseTarget"("exerciseId", "status");
CREATE INDEX "TradingLifecycleExerciseTarget_tradingAccountId_createdAt_idx" ON "TradingLifecycleExerciseTarget"("tradingAccountId", "createdAt");
CREATE INDEX "TradingLifecycleExerciseTarget_tradingAccountSubscriptionId_createdAt_idx" ON "TradingLifecycleExerciseTarget"("tradingAccountSubscriptionId", "createdAt");
CREATE INDEX "TradingLifecycleExerciseTarget_orderIntentId_idx" ON "TradingLifecycleExerciseTarget"("orderIntentId");

ALTER TABLE "TradingLifecycleExercise" ADD CONSTRAINT "TradingLifecycleExercise_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TradingLifecycleExercise" ADD CONSTRAINT "TradingLifecycleExercise_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TradingLifecycleExerciseTarget" ADD CONSTRAINT "TradingLifecycleExerciseTarget_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "TradingLifecycleExercise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TradingLifecycleExerciseTarget" ADD CONSTRAINT "TradingLifecycleExerciseTarget_accountHolderUserId_fkey" FOREIGN KEY ("accountHolderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TradingLifecycleExerciseTarget" ADD CONSTRAINT "TradingLifecycleExerciseTarget_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TradingLifecycleExerciseTarget" ADD CONSTRAINT "TradingLifecycleExerciseTarget_tradingAccountSubscriptionId_fkey" FOREIGN KEY ("tradingAccountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TradingLifecycleExerciseTarget" ADD CONSTRAINT "TradingLifecycleExerciseTarget_orderIntentId_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
