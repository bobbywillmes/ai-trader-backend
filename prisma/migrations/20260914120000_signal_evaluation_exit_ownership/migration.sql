BEGIN;
-- CreateEnum
CREATE TYPE "ExitManagementMode" AS ENUM ('BACKEND_MANAGED', 'EXTERNAL_SIGNAL');

-- CreateEnum
CREATE TYPE "SignalEvaluationStatus" AS ENUM ('COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SignalEvaluationOutcome" AS ENUM ('ELIGIBLE', 'BLOCKED', 'NO_ACTION');

-- CreateEnum
CREATE TYPE "SignalEvaluationGateResult" AS ENUM ('PASS', 'BLOCKED', 'NO_ACTION', 'FAILED');

-- AlterTable
ALTER TABLE "SignalRoute" ADD COLUMN     "evaluationVersion" INTEGER;

-- AlterTable
ALTER TABLE "PositionExitState" ADD COLUMN     "exitManagementModeSnapshot" "ExitManagementMode" NOT NULL DEFAULT 'BACKEND_MANAGED';
ALTER TABLE "PositionExitState" ADD COLUMN "exitOwnershipProvenance" JSONB;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "exitManagementMode" "ExitManagementMode" NOT NULL DEFAULT 'BACKEND_MANAGED';

-- CreateTable
CREATE TABLE "SignalEvaluation" (
    "id" SERIAL NOT NULL,
    "signalRouteId" INTEGER NOT NULL,
    "evaluationVersion" INTEGER NOT NULL,
    "event" "SignalEvent" NOT NULL,
    "intent" TEXT NOT NULL,
    "riskDirection" TEXT NOT NULL,
    "status" "SignalEvaluationStatus" NOT NULL,
    "outcome" "SignalEvaluationOutcome",
    "reasonCode" TEXT,
    "prospectiveExitManagementMode" "ExitManagementMode",
    "positionExitManagementMode" "ExitManagementMode",
    "trackedPositionId" INTEGER,
    "positionExitStateId" INTEGER,
    "gateCount" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignalEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalEvaluationGate" (
    "id" SERIAL NOT NULL,
    "signalEvaluationId" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "gateKey" TEXT NOT NULL,
    "result" "SignalEvaluationGateResult" NOT NULL,
    "reasonCode" TEXT,
    "evidenceJson" JSONB,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignalEvaluationGate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SignalEvaluation_signalRouteId_key" ON "SignalEvaluation"("signalRouteId");

-- CreateIndex
CREATE UNIQUE INDEX "SignalEvaluationGate_signalEvaluationId_sequence_key" ON "SignalEvaluationGate"("signalEvaluationId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "SignalEvaluationGate_signalEvaluationId_gateKey_key" ON "SignalEvaluationGate"("signalEvaluationId", "gateKey");

-- AddForeignKey
ALTER TABLE "SignalEvaluation" ADD CONSTRAINT "SignalEvaluation_signalRouteId_fkey" FOREIGN KEY ("signalRouteId") REFERENCES "SignalRoute"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SignalEvaluationGate" ADD CONSTRAINT "SignalEvaluationGate_signalEvaluationId_fkey" FOREIGN KEY ("signalEvaluationId") REFERENCES "SignalEvaluation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Freeze existing positions, including those whose exit-state creation was interrupted.
INSERT INTO "PositionExitState" ("trackedPositionId", status, "exitProfileKey", "exitMode", "takeProfitBehavior", "targetPct", "trailingStopPct", "updatedAt")
SELECT p.id, CASE WHEN p.status = 'closed' THEN 'closed' ELSE 'watching' END,
  e.key, e."exitMode", e."takeProfitBehavior", e."targetPct", e."trailingStopPct", CURRENT_TIMESTAMP
FROM "TrackedPosition" p LEFT JOIN "Subscription" s ON s.id = p."subscriptionId"
LEFT JOIN "ExitProfile" e ON e.id = s."exitProfileId"
WHERE NOT EXISTS (SELECT 1 FROM "PositionExitState" x WHERE x."trackedPositionId" = p.id);

CREATE FUNCTION guard_position_exit_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "TrackedPosition" WHERE id = OLD."trackedPositionId") THEN
      RAISE EXCEPTION 'Position exit ownership cannot be deleted while its position exists';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."exitManagementModeSnapshot" IS DISTINCT FROM OLD."exitManagementModeSnapshot" OR
     NEW."exitOwnershipProvenance" IS DISTINCT FROM OLD."exitOwnershipProvenance" OR
     NEW."trackedPositionId" IS DISTINCT FROM OLD."trackedPositionId" THEN
    RAISE EXCEPTION 'Position exit ownership is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER position_exit_ownership_guard BEFORE UPDATE OR DELETE ON "PositionExitState"
FOR EACH ROW EXECUTE FUNCTION guard_position_exit_ownership();

CREATE FUNCTION reject_evaluation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Signal evaluation evidence is immutable'; END $$;
CREATE TRIGGER immutable_signal_evaluation BEFORE UPDATE OR DELETE ON "SignalEvaluation"
FOR EACH ROW EXECUTE FUNCTION reject_evaluation_mutation();
CREATE TRIGGER immutable_signal_evaluation_gate BEFORE UPDATE OR DELETE ON "SignalEvaluationGate"
FOR EACH ROW EXECUTE FUNCTION reject_evaluation_mutation();

ALTER TABLE "SignalEvaluation" ADD CONSTRAINT "SignalEvaluation_terminal_check" CHECK (
  "gateCount" > 0 AND "completedAt" >= "startedAt" AND
  ((status = 'COMPLETED' AND outcome IS NOT NULL) OR
   (status = 'FAILED' AND outcome IS NULL AND "reasonCode" IS NOT NULL)) AND
  ((event = 'ENTRY_LONG' AND intent = 'ENTRY' AND "riskDirection" = 'RISK_INCREASING') OR
   (event = 'EXIT_LONG' AND intent = 'EXIT' AND "riskDirection" = 'RISK_REDUCING'))
);
ALTER TABLE "SignalEvaluationGate" ADD CONSTRAINT "SignalEvaluationGate_bounded_check"
CHECK (sequence > 0 AND length("gateKey") <= 80 AND length("reasonCode") <= 120 AND
  ("evidenceJson" IS NULL OR octet_length("evidenceJson"::text) <= 4096));

CREATE FUNCTION check_signal_evaluation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evaluation_id integer; expected integer; actual integer; max_sequence integer;
BEGIN
  IF TG_TABLE_NAME = 'SignalEvaluation' THEN evaluation_id := NEW.id;
  ELSE evaluation_id := NEW."signalEvaluationId"; END IF;
  SELECT "gateCount" INTO expected FROM "SignalEvaluation" WHERE id = evaluation_id;
  SELECT count(*), max(sequence) INTO actual, max_sequence FROM "SignalEvaluationGate" WHERE "signalEvaluationId" = evaluation_id;
  IF expected IS DISTINCT FROM actual OR actual IS DISTINCT FROM max_sequence THEN
    RAISE EXCEPTION 'Evaluation gates must be complete and ordered';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "SignalEvaluation" e JOIN "SignalRoute" r ON r.id = e."signalRouteId"
    JOIN "SignalRoutingRun" rr ON rr.id = r."signalRoutingRunId" JOIN "Signal" s ON s.id = rr."signalId"
    WHERE e.id = evaluation_id AND r."evaluationVersion" = e."evaluationVersion" AND s.event = e.event) THEN
    RAISE EXCEPTION 'Evaluation requires a versioned route with matching immutable event';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signal_evaluation_evidence AFTER INSERT ON "SignalEvaluation"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_signal_evaluation_evidence();
CREATE CONSTRAINT TRIGGER signal_evaluation_gate_evidence AFTER INSERT ON "SignalEvaluationGate"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_signal_evaluation_evidence();
COMMIT;
