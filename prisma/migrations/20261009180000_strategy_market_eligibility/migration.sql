CREATE TYPE "StrategyMarketEligibilityOutcome" AS ENUM ('ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE');
CREATE TYPE "StrategyMarketEligibilityGateOutcome" AS ENUM ('PASS', 'BLOCKED', 'INSUFFICIENT_EVIDENCE', 'IGNORED');

CREATE TABLE "StrategyMarketEligibilityDecision" (
  "id" SERIAL NOT NULL,
  "strategyId" INTEGER NOT NULL,
  "policyRevisionId" INTEGER,
  "marketRegimeAssessmentId" INTEGER,
  "contextType" TEXT NOT NULL,
  "contextIdentity" TEXT NOT NULL,
  "evaluationVersion" TEXT NOT NULL,
  "outcome" "StrategyMarketEligibilityOutcome" NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "evaluatedAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
  "validUntil" TIMESTAMP(3) WITH TIME ZONE,
  "decisionFingerprint" TEXT NOT NULL,
  "strategyEnabled" BOOLEAN NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StrategyMarketEligibilityDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StrategyMarketEligibilityDecision_composition_contract" CHECK (
    "marketRegimeAssessmentId" IS NOT NULL OR "reasonCode" IN ('NO_COMPOSITION', 'NO_ACTIVE_POLICY')
  ),
  CONSTRAINT "StrategyMarketEligibilityDecision_policy_contract" CHECK (
    "policyRevisionId" IS NOT NULL OR "reasonCode" = 'NO_ACTIVE_POLICY'
  )
);

CREATE TABLE "StrategyMarketEligibilityDecisionGate" (
  "id" SERIAL NOT NULL,
  "decisionId" INTEGER NOT NULL,
  "dimension" "MarketRegimeDimension" NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  "requirement" "StrategyMarketPolicyDimensionRequirement" NOT NULL,
  "outcome" "StrategyMarketEligibilityGateOutcome" NOT NULL,
  "observedState" TEXT,
  "sourceHealth" "MarketRegimeCompositionSourceHealth",
  "sourceAssessmentId" INTEGER,
  "allowedStatesJson" JSONB NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StrategyMarketEligibilityDecisionGate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StrategyMarketEligibilityDecisionGate_ignored_check" CHECK (
    ("requirement" = 'IGNORED' AND "outcome" = 'IGNORED') OR "requirement" = 'REQUIRED'
  )
);

CREATE UNIQUE INDEX "StrategyMarketEligibilityDecision_decisionFingerprint_key" ON "StrategyMarketEligibilityDecision"("decisionFingerprint");
CREATE INDEX "StrategyMarketEligibilityDecision_strategy_time_idx" ON "StrategyMarketEligibilityDecision"("strategyId", "evaluatedAt");
CREATE INDEX "StrategyMarketEligibilityDecision_policy_idx" ON "StrategyMarketEligibilityDecision"("policyRevisionId");
CREATE INDEX "StrategyMarketEligibilityDecision_composition_idx" ON "StrategyMarketEligibilityDecision"("marketRegimeAssessmentId");
CREATE UNIQUE INDEX "StrategyMarketEligibilityGate_decision_dimension_key" ON "StrategyMarketEligibilityDecisionGate"("decisionId", "dimension");
CREATE UNIQUE INDEX "StrategyMarketEligibilityGate_decision_ordinal_key" ON "StrategyMarketEligibilityDecisionGate"("decisionId", "ordinal");
CREATE INDEX "StrategyMarketEligibilityGate_source_idx" ON "StrategyMarketEligibilityDecisionGate"("sourceAssessmentId", "dimension", "algorithmVersion");

ALTER TABLE "StrategyMarketEligibilityDecision" ADD CONSTRAINT "StrategyMarketEligibilityDecision_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "StrategyMarketEligibilityDecision" ADD CONSTRAINT "StrategyMarketEligibilityDecision_policyRevisionId_fkey" FOREIGN KEY ("policyRevisionId") REFERENCES "StrategyMarketPolicyRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "StrategyMarketEligibilityDecision" ADD CONSTRAINT "StrategyMarketEligibilityDecision_marketRegimeAssessmentId_fkey" FOREIGN KEY ("marketRegimeAssessmentId") REFERENCES "MarketRegimeAssessment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "StrategyMarketEligibilityDecisionGate" ADD CONSTRAINT "StrategyMarketEligibilityDecisionGate_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "StrategyMarketEligibilityDecision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "StrategyMarketEligibilityDecisionGate" ADD CONSTRAINT "StrategyMarketEligibilityGate_source_identity_fk" FOREIGN KEY ("sourceAssessmentId", "dimension", "algorithmVersion") REFERENCES "MarketRegimeDimensionAssessment"("id", "dimension", "algorithmVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "protect_strategy_market_eligibility_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Strategy market eligibility evidence is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StrategyMarketEligibilityDecision_immutable" BEFORE UPDATE OR DELETE ON "StrategyMarketEligibilityDecision" FOR EACH ROW EXECUTE FUNCTION "protect_strategy_market_eligibility_immutable"();
CREATE TRIGGER "StrategyMarketEligibilityDecisionGate_immutable" BEFORE UPDATE OR DELETE ON "StrategyMarketEligibilityDecisionGate" FOR EACH ROW EXECUTE FUNCTION "protect_strategy_market_eligibility_immutable"();
