CREATE TYPE "TradingLifecycleExerciseType" AS ENUM ('SUBSCRIPTION_ENTRY');
CREATE TYPE "TradingLifecycleExerciseLaunchOutcome" AS ENUM ('INTENT_CREATED', 'DUPLICATE', 'BLOCKED', 'FAILED', 'RECOVERED', 'ATTENTION_REQUIRED');

ALTER TYPE "TradingLifecycleExerciseSelectionMode" ADD VALUE 'EXPLICIT_ASSIGNMENTS';

ALTER TABLE "TradingLifecycleExercise"
  ADD COLUMN "exerciseType" "TradingLifecycleExerciseType" NOT NULL DEFAULT 'SUBSCRIPTION_ENTRY',
  ADD COLUMN "containsLiveTargets" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "TradingLifecycleExerciseTarget"
  ADD COLUMN "launchOutcome" "TradingLifecycleExerciseLaunchOutcome",
  ADD COLUMN "launchResultCode" TEXT,
  ADD COLUMN "launchResultMessage" TEXT,
  ADD COLUMN "launchEvidenceJson" JSONB,
  ADD COLUMN "launchAttemptedAt" TIMESTAMP(3);
