-- CreateEnum
CREATE TYPE "StrategyMarketPolicyAuthority" AS ENUM ('SHADOW_ONLY');

CREATE TYPE "StrategyMarketPolicyRevisionStatus" AS ENUM ('PREPARED', 'ACTIVE', 'RETIRED');

CREATE TYPE "StrategyMarketPolicyDimensionRequirement" AS ENUM ('REQUIRED', 'IGNORED');

-- CreateTable
CREATE TABLE "StrategyMarketPolicy" (
    "id" SERIAL NOT NULL,
    "strategyId" INTEGER NOT NULL,
    "authority" "StrategyMarketPolicyAuthority" NOT NULL DEFAULT 'SHADOW_ONLY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StrategyMarketPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StrategyMarketPolicyRevision" (
    "id" SERIAL NOT NULL,
    "policyId" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "StrategyMarketPolicyRevisionStatus" NOT NULL DEFAULT 'PREPARED',
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    CONSTRAINT "StrategyMarketPolicyRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StrategyMarketPolicyRevision_revision_check" CHECK ("revision" > 0),
    CONSTRAINT "StrategyMarketPolicyRevision_lifecycle_check" CHECK (
      ("status" = 'PREPARED' AND "activatedAt" IS NULL AND "retiredAt" IS NULL) OR
      ("status" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL) OR
      ("status" = 'RETIRED' AND "retiredAt" IS NOT NULL)
    )
);

CREATE TABLE "StrategyMarketPolicyDimensionRule" (
    "id" SERIAL NOT NULL,
    "revisionId" INTEGER NOT NULL,
    "dimension" "MarketRegimeDimension" NOT NULL,
    "algorithmVersion" TEXT NOT NULL,
    "requirement" "StrategyMarketPolicyDimensionRequirement" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StrategyMarketPolicyDimensionRule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StrategyMarketPolicyDimensionRule_identity_check" CHECK (
      ("dimension" = 'TREND' AND "algorithmVersion" = 'TREND_V1') OR
      ("dimension" = 'VOLATILITY' AND "algorithmVersion" = 'VOLATILITY_V1') OR
      ("dimension" = 'BREADTH' AND "algorithmVersion" = 'BREADTH_V1') OR
      ("dimension" = 'PARTICIPATION' AND "algorithmVersion" = 'PARTICIPATION_V1') OR
      ("dimension" = 'INTRADAY_STRESS' AND "algorithmVersion" = 'INTRADAY_STRESS_V1')
    )
);

CREATE TABLE "StrategyMarketPolicyAllowedState" (
    "id" SERIAL NOT NULL,
    "ruleId" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StrategyMarketPolicyAllowedState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StrategyMarketPolicy_strategyId_key" ON "StrategyMarketPolicy"("strategyId");
CREATE UNIQUE INDEX "StrategyMarketPolicyRevision_policy_revision_key" ON "StrategyMarketPolicyRevision"("policyId", "revision");
CREATE INDEX "StrategyMarketPolicyRevision_policy_status_idx" ON "StrategyMarketPolicyRevision"("policyId", "status");
CREATE UNIQUE INDEX "StrategyMarketPolicyRevision_one_active_key" ON "StrategyMarketPolicyRevision"("policyId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "StrategyMarketPolicyRevision_one_prepared_key" ON "StrategyMarketPolicyRevision"("policyId") WHERE "status" = 'PREPARED';
CREATE UNIQUE INDEX "StrategyMarketPolicyDimensionRule_revision_dimension_key" ON "StrategyMarketPolicyDimensionRule"("revisionId", "dimension");
CREATE UNIQUE INDEX "StrategyMarketPolicyAllowedState_rule_state_key" ON "StrategyMarketPolicyAllowedState"("ruleId", "state");

ALTER TABLE "StrategyMarketPolicy" ADD CONSTRAINT "StrategyMarketPolicy_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "StrategyMarketPolicyRevision" ADD CONSTRAINT "StrategyMarketPolicyRevision_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "StrategyMarketPolicy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "StrategyMarketPolicyDimensionRule" ADD CONSTRAINT "StrategyMarketPolicyDimensionRule_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "StrategyMarketPolicyRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "StrategyMarketPolicyAllowedState" ADD CONSTRAINT "StrategyMarketPolicyAllowedState_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "StrategyMarketPolicyDimensionRule"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Defense in depth: direct SQL cannot mutate rules or states after their revision leaves PREPARED.
CREATE FUNCTION "assert_strategy_market_policy_prepared"() RETURNS trigger AS $$
DECLARE revision_status "StrategyMarketPolicyRevisionStatus";
BEGIN
  IF TG_TABLE_NAME = 'StrategyMarketPolicyDimensionRule' THEN
    SELECT "status" INTO revision_status FROM "StrategyMarketPolicyRevision" WHERE "id" = COALESCE(NEW."revisionId", OLD."revisionId");
  ELSE
    SELECT r."status" INTO revision_status
      FROM "StrategyMarketPolicyRevision" r
      JOIN "StrategyMarketPolicyDimensionRule" d ON d."revisionId" = r."id"
     WHERE d."id" = COALESCE(NEW."ruleId", OLD."ruleId");
  END IF;
  IF revision_status IS DISTINCT FROM 'PREPARED' THEN
    RAISE EXCEPTION 'Only PREPARED strategy market policy revisions are editable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StrategyMarketPolicyDimensionRule_prepared_only"
BEFORE INSERT OR UPDATE OR DELETE ON "StrategyMarketPolicyDimensionRule"
FOR EACH ROW EXECUTE FUNCTION "assert_strategy_market_policy_prepared"();

CREATE TRIGGER "StrategyMarketPolicyAllowedState_prepared_only"
BEFORE INSERT OR UPDATE OR DELETE ON "StrategyMarketPolicyAllowedState"
FOR EACH ROW EXECUTE FUNCTION "assert_strategy_market_policy_prepared"();

CREATE FUNCTION "validate_strategy_market_policy_allowed_state"() RETURNS trigger AS $$
DECLARE d "MarketRegimeDimension"; v TEXT; req "StrategyMarketPolicyDimensionRequirement";
BEGIN
  SELECT "dimension", "algorithmVersion", "requirement" INTO d, v, req
    FROM "StrategyMarketPolicyDimensionRule" WHERE "id" = NEW."ruleId";
  IF req = 'IGNORED' THEN RAISE EXCEPTION 'IGNORED dimensions cannot have allowed states'; END IF;
  IF NOT (
    (d = 'TREND' AND v = 'TREND_V1' AND NEW."state" IN ('DOWN','NEUTRAL','UP')) OR
    (d = 'VOLATILITY' AND v = 'VOLATILITY_V1' AND NEW."state" IN ('LOW','NORMAL','HIGH','EXTREME')) OR
    (d = 'BREADTH' AND v = 'BREADTH_V1' AND NEW."state" IN ('NEGATIVE','MIXED','POSITIVE')) OR
    (d = 'PARTICIPATION' AND v = 'PARTICIPATION_V1' AND NEW."state" IN ('QUIET','NORMAL','ACTIVE','INTENSE')) OR
    (d = 'INTRADAY_STRESS' AND v = 'INTRADAY_STRESS_V1' AND NEW."state" IN ('NORMAL','ELEVATED','HIGH','SEVERE'))
  ) THEN RAISE EXCEPTION 'Invalid effective state for strategy market policy dimension/version'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StrategyMarketPolicyAllowedState_vocabulary"
BEFORE INSERT OR UPDATE ON "StrategyMarketPolicyAllowedState"
FOR EACH ROW EXECUTE FUNCTION "validate_strategy_market_policy_allowed_state"();

CREATE FUNCTION "protect_strategy_market_policy_revision"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'PREPARED' AND (
    NEW."policyId" IS DISTINCT FROM OLD."policyId" OR NEW."revision" IS DISTINCT FROM OLD."revision" OR
    NEW."changeNote" IS DISTINCT FROM OLD."changeNote" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
    NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" OR
    (OLD."status" = 'RETIRED' AND NEW."status" IS DISTINCT FROM OLD."status") OR
    (OLD."status" = 'ACTIVE' AND NEW."status" <> 'RETIRED')
  ) THEN RAISE EXCEPTION 'ACTIVE and RETIRED strategy market policy revisions are immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StrategyMarketPolicyRevision_immutable"
BEFORE UPDATE ON "StrategyMarketPolicyRevision"
FOR EACH ROW EXECUTE FUNCTION "protect_strategy_market_policy_revision"();
