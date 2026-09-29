CREATE TYPE "TiingoDailyObservationStatus" AS ENUM ('RETRYING', 'NO_EOD_COVERAGE', 'RESOLVED');

CREATE TABLE "TiingoDailyObservationState" (
    "id" SERIAL NOT NULL,
    "securityId" INTEGER NOT NULL,
    "sessionDate" DATE NOT NULL,
    "status" "TiingoDailyObservationStatus" NOT NULL,
    "attemptCount" INTEGER NOT NULL,
    "firstAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "lastAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "reasonCode" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "TiingoDailyObservationState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TiingoDailyObservationState_attemptCount_check" CHECK ("attemptCount" > 0),
    CONSTRAINT "TiingoDailyObservationState_status_check" CHECK (
      ("status" = 'RETRYING' AND "nextAttemptAt" IS NOT NULL AND "resolvedAt" IS NULL) OR
      ("status" = 'NO_EOD_COVERAGE' AND "nextAttemptAt" IS NULL AND "resolvedAt" IS NULL) OR
      ("status" = 'RESOLVED' AND "nextAttemptAt" IS NULL AND "resolvedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "TiingoDailyObservationState_securityId_sessionDate_key" ON "TiingoDailyObservationState"("securityId", "sessionDate");
CREATE INDEX "TiingoDailyObservationState_status_nextAttemptAt_idx" ON "TiingoDailyObservationState"("status", "nextAttemptAt");
ALTER TABLE "TiingoDailyObservationState" ADD CONSTRAINT "TiingoDailyObservationState_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
