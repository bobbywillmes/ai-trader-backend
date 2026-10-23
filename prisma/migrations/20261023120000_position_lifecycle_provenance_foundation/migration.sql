-- Phase 1A is additive evidence only. Existing TrackedPosition rows retain NULL
-- creation authority and all existing lifecycle/exit fields remain untouched.
CREATE TYPE "PositionLifecycleCreationAuthority" AS ENUM ('EXECUTOR', 'OBSERVER');
CREATE TYPE "PositionLifecycleOrigin" AS ENUM ('LOCAL_ORDER_CHAIN', 'BROKER_EXTERNAL', 'UNKNOWN');
CREATE TYPE "PositionLifecycleOwnership" AS ENUM ('LOCAL_LIFECYCLE_OWNED', 'NOT_LOCALLY_OWNED', 'UNKNOWN');
CREATE TYPE "PositionLifecycleDecisionActorType" AS ENUM ('SYSTEM', 'USER');

ALTER TABLE "TrackedPosition"
ADD COLUMN "lifecycleAuthorityAtCreation" "PositionLifecycleCreationAuthority";

-- Required by the exact position/account composite foreign key below. The existing
-- primary key already makes the pair unique; this index makes that identity explicit.
CREATE UNIQUE INDEX "TrackedPosition_id_tradingAccountId_key"
ON "TrackedPosition"("id", "tradingAccountId");

CREATE TABLE "PositionLifecycleProvenanceDecision" (
  "id" SERIAL PRIMARY KEY,
  "trackedPositionId" INTEGER NOT NULL,
  "tradingAccountId" INTEGER NOT NULL,
  "origin" "PositionLifecycleOrigin" NOT NULL,
  "ownership" "PositionLifecycleOwnership" NOT NULL,
  "legacyExitContinuityAuthorized" BOOLEAN NOT NULL DEFAULT false,
  "classifierVersion" TEXT NOT NULL,
  "evidenceFingerprint" TEXT NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "actorType" "PositionLifecycleDecisionActorType" NOT NULL,
  "actorUserId" INTEGER,
  "supersedesDecisionId" INTEGER,
  "decidedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PositionLifecycleProvenanceDecision_position_fkey"
    FOREIGN KEY ("trackedPositionId", "tradingAccountId")
    REFERENCES "TrackedPosition"("id", "tradingAccountId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "PositionLifecycleProvenanceDecision_account_fkey"
    FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "PositionLifecycleProvenanceDecision_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "PositionLifecycleProvenanceDecision_supersedes_fkey"
    FOREIGN KEY ("supersedesDecisionId") REFERENCES "PositionLifecycleProvenanceDecision"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  CONSTRAINT "PositionLifecycleProvenanceDecision_classification_check" CHECK (
    ("origin" = 'LOCAL_ORDER_CHAIN' AND "ownership" = 'LOCAL_LIFECYCLE_OWNED') OR
    ("origin" = 'BROKER_EXTERNAL' AND "ownership" = 'NOT_LOCALLY_OWNED') OR
    ("origin" = 'UNKNOWN' AND "ownership" = 'UNKNOWN')
  ),
  CONSTRAINT "PositionLifecycleProvenanceDecision_actor_check" CHECK (
    ("actorType" = 'SYSTEM' AND "actorUserId" IS NULL) OR
    ("actorType" = 'USER' AND "actorUserId" IS NOT NULL)
  ),
  CONSTRAINT "PositionLifecycleProvenanceDecision_continuity_check" CHECK (
    NOT "legacyExitContinuityAuthorized" OR
    ("actorType" = 'USER' AND "actorUserId" IS NOT NULL AND "origin" <> 'LOCAL_ORDER_CHAIN')
  ),
  CONSTRAINT "PositionLifecycleProvenanceDecision_version_check" CHECK (
    length(btrim("classifierVersion")) BETWEEN 1 AND 120
  ),
  CONSTRAINT "PositionLifecycleProvenanceDecision_fingerprint_check" CHECK (
    "evidenceFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "PositionLifecycleProvenanceDecision_evidence_check" CHECK (
    jsonb_typeof("evidenceJson") = 'object' AND octet_length("evidenceJson"::text) <= 65536
  )
);

CREATE UNIQUE INDEX "PositionLifecycleProvenanceDecision_supersedesDecisionId_key"
ON "PositionLifecycleProvenanceDecision"("supersedesDecisionId");
CREATE UNIQUE INDEX "PositionLifecycleProvenanceDecision_root_key"
ON "PositionLifecycleProvenanceDecision"("trackedPositionId")
WHERE "supersedesDecisionId" IS NULL;
CREATE INDEX "PositionLifecycleProvenanceDecision_position_decided_idx"
ON "PositionLifecycleProvenanceDecision"("trackedPositionId", "decidedAt");
CREATE INDEX "PositionLifecycleProvenanceDecision_account_decided_idx"
ON "PositionLifecycleProvenanceDecision"("tradingAccountId", "decidedAt");
CREATE INDEX "PositionLifecycleProvenanceDecision_actor_idx"
ON "PositionLifecycleProvenanceDecision"("actorUserId");

-- Creation authority is write-once at row insertion. In particular, NULL on a
-- historical row cannot later be replaced with the deployment's current role.
CREATE FUNCTION "guard_tracked_position_creation_authority"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."lifecycleAuthorityAtCreation" IS DISTINCT FROM OLD."lifecycleAuthorityAtCreation" THEN
    RAISE EXCEPTION 'TrackedPosition lifecycle creation authority is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "TrackedPosition_creation_authority_immutable"
BEFORE UPDATE OF "lifecycleAuthorityAtCreation" ON "TrackedPosition"
FOR EACH ROW EXECUTE FUNCTION "guard_tracked_position_creation_authority"();

-- PostgreSQL owns the decision timestamp and enforces one linear append-only chain
-- per position. There is deliberately no mutable current-decision pointer.
CREATE FUNCTION "validate_position_lifecycle_provenance_decision"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous_decision "PositionLifecycleProvenanceDecision"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Position lifecycle provenance decisions are immutable evidence' USING ERRCODE = '23514';
  END IF;

  IF NEW."supersedesDecisionId" IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM "PositionLifecycleProvenanceDecision"
      WHERE "trackedPositionId" = NEW."trackedPositionId"
    ) THEN
      RAISE EXCEPTION 'Position lifecycle provenance must supersede the current decision' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO previous_decision
    FROM "PositionLifecycleProvenanceDecision"
    WHERE id = NEW."supersedesDecisionId"
    FOR UPDATE;

    IF previous_decision.id IS NULL OR
       previous_decision."trackedPositionId" IS DISTINCT FROM NEW."trackedPositionId" OR
       previous_decision."tradingAccountId" IS DISTINCT FROM NEW."tradingAccountId" THEN
      RAISE EXCEPTION 'Position lifecycle provenance supersession identity is inconsistent' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "PositionLifecycleProvenanceDecision"
      WHERE "supersedesDecisionId" = previous_decision.id
    ) THEN
      RAISE EXCEPTION 'Position lifecycle provenance may supersede only the current decision' USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW."decidedAt" := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER "PositionLifecycleProvenanceDecision_validate"
BEFORE INSERT OR UPDATE OR DELETE ON "PositionLifecycleProvenanceDecision"
FOR EACH ROW EXECUTE FUNCTION "validate_position_lifecycle_provenance_decision"();
