CREATE TYPE "SignalRouteMarketEligibilityStatus" AS ENUM ('COMPLETED', 'FAILED', 'NOT_APPLICABLE');
CREATE TABLE "SignalRouteMarketEligibilityAttempt" (
  "id" SERIAL NOT NULL, "signalRouteId" INTEGER NOT NULL, "attempt" INTEGER NOT NULL,
  "integrationVersion" TEXT NOT NULL, "status" "SignalRouteMarketEligibilityStatus" NOT NULL,
  "strategyId" INTEGER NOT NULL, "eligibilityDecisionId" INTEGER, "reasonCode" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL, "completedAt" TIMESTAMPTZ(3) NOT NULL,
  "evidenceJson" JSONB NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignalRouteMarketEligibilityAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignalRouteMarketEligibilityAttempt_terminal_check" CHECK (
    "attempt" > 0 AND length("integrationVersion") BETWEEN 1 AND 80 AND "completedAt" >= "startedAt" AND
    jsonb_typeof("evidenceJson") = 'object' AND
    (("status" = 'COMPLETED' AND "eligibilityDecisionId" IS NOT NULL) OR
     ("status" IN ('FAILED','NOT_APPLICABLE') AND "eligibilityDecisionId" IS NULL))
  )
);
CREATE UNIQUE INDEX "SignalRouteMarketEligibilityAttempt_route_attempt_key" ON "SignalRouteMarketEligibilityAttempt"("signalRouteId","attempt");
CREATE UNIQUE INDEX "SignalRouteMarketEligibilityAttempt_one_terminal_key" ON "SignalRouteMarketEligibilityAttempt"("signalRouteId") WHERE "status" IN ('COMPLETED','NOT_APPLICABLE');
CREATE INDEX "SignalRouteMarketEligibilityAttempt_decision_idx" ON "SignalRouteMarketEligibilityAttempt"("eligibilityDecisionId");
CREATE INDEX "SignalRouteMarketEligibilityAttempt_status_time_idx" ON "SignalRouteMarketEligibilityAttempt"("status","completedAt");
ALTER TABLE "SignalRouteMarketEligibilityAttempt" ADD CONSTRAINT "SignalRouteMarketEligibilityAttempt_signalRouteId_fkey" FOREIGN KEY ("signalRouteId") REFERENCES "SignalRoute"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SignalRouteMarketEligibilityAttempt" ADD CONSTRAINT "SignalRouteMarketEligibilityAttempt_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SignalRouteMarketEligibilityAttempt" ADD CONSTRAINT "SignalRouteMarketEligibilityAttempt_eligibilityDecisionId_fkey" FOREIGN KEY ("eligibilityDecisionId") REFERENCES "StrategyMarketEligibilityDecision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE FUNCTION "protect_signal_route_market_eligibility_attempt"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Signal route market eligibility attempts are immutable'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "SignalRouteMarketEligibilityAttempt_immutable" BEFORE UPDATE OR DELETE ON "SignalRouteMarketEligibilityAttempt" FOR EACH ROW EXECUTE FUNCTION "protect_signal_route_market_eligibility_attempt"();
