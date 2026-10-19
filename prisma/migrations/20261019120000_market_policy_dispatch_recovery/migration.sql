-- Phase 3C.3 corrections (Hermes HIGH-1, MEDIUM-1).
--
-- Additive. It creates no authorizations, releases no claims, and changes no consumption.
--
-- 1. MarketPolicyBrokerUnenforcedDispatch: the final serialized broker-time authorization of an
--    un-obligated PAPER entry BUY. It is inserted immediately before the Alpaca adapter, in a short
--    READ COMMITTED transaction that holds the rollout row FOR SHARE and the assignment's latest
--    authorization FOR SHARE. PostgreSQL independently refuses it when enforcement now applies, so a
--    grant or activation that commits first always quarantines the entry. Like a consumption, it is
--    durable evidence that a POST may have started, never proof of broker receipt, and at most one
--    exists per OrderIntent.
-- 2. EntryExposureClaimEvent becomes append-only: dispatch outcome classifications, recovery
--    diagnostics, operator authorizations and release evidence are immutable once written.

CREATE TABLE "MarketPolicyBrokerUnenforcedDispatch" (
  "id" SERIAL PRIMARY KEY,
  "orderIntentId" INTEGER NOT NULL,
  "clientOrderId" TEXT NOT NULL,
  "environment" "TradingAccountEnvironment" NOT NULL,
  "tradingAccountId" INTEGER NOT NULL,
  "accountSubscriptionId" INTEGER,
  "securityId" INTEGER NOT NULL,
  "securitySymbol" TEXT NOT NULL,
  "basis" TEXT NOT NULL,
  "latestAuthorizationId" INTEGER,
  "latestAuthorizationStatus" TEXT,
  "rolloutEnabled" BOOLEAN NOT NULL,
  "rolloutVersion" INTEGER NOT NULL,
  "brokerPostOpportunityId" INTEGER,
  "authorizedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "evidenceJson" JSONB NOT NULL,
  CONSTRAINT "UnenforcedDispatch_orderIntent_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "UnenforcedDispatch_account_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "UnenforcedDispatch_assignment_fkey" FOREIGN KEY ("accountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "UnenforcedDispatch_security_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "UnenforcedDispatch_authorization_fkey" FOREIGN KEY ("latestAuthorizationId") REFERENCES "AssignmentMarketPolicyEnforcementAuthorization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "UnenforcedDispatch_opportunity_fkey" FOREIGN KEY ("brokerPostOpportunityId") REFERENCES "OrderIntentBrokerPostOpportunity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "UnenforcedDispatch_scope_check" CHECK ("environment" = 'PAPER' AND "rolloutVersion" >= 0),
  CONSTRAINT "UnenforcedDispatch_basis_check" CHECK (
    ("basis" = 'RUNTIME_INACTIVE' AND NOT "rolloutEnabled")
    OR ("basis" = 'NO_ASSIGNMENT' AND "rolloutEnabled" AND "accountSubscriptionId" IS NULL AND "latestAuthorizationId" IS NULL)
    OR ("basis" = 'NEVER_AUTHORIZED' AND "rolloutEnabled" AND "accountSubscriptionId" IS NOT NULL AND "latestAuthorizationId" IS NULL)
    OR ("basis" = 'OWNER_REVOKED' AND "rolloutEnabled" AND "latestAuthorizationStatus" = 'REVOKED')
    OR ("basis" = 'OWNER_OPTED_OUT' AND "rolloutEnabled" AND "latestAuthorizationStatus" = 'INVALIDATED')
  ),
  CONSTRAINT "UnenforcedDispatch_authorization_check" CHECK (("latestAuthorizationId" IS NULL) = ("latestAuthorizationStatus" IS NULL))
);
-- At most one new-POST authorization per un-obligated OrderIntent, ever.
CREATE UNIQUE INDEX "UnenforcedDispatch_orderIntent_key" ON "MarketPolicyBrokerUnenforcedDispatch" ("orderIntentId");
CREATE INDEX "UnenforcedDispatch_account_idx" ON "MarketPolicyBrokerUnenforcedDispatch" ("tradingAccountId", "authorizedAt");
CREATE INDEX "UnenforcedDispatch_assignment_idx" ON "MarketPolicyBrokerUnenforcedDispatch" ("accountSubscriptionId");

CREATE FUNCTION "validate_market_policy_broker_unenforced_dispatch"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rollout "MarketPolicyEnforcementRuntimeRollout"%ROWTYPE;
  latest "AssignmentMarketPolicyEnforcementAuthorization"%ROWTYPE;
  oi "OrderIntent"%ROWTYPE;
  c "EntryExposureClaim"%ROWTYPE;
  account_environment "TradingAccountEnvironment";
  security_symbol TEXT;
  opportunity_intent INTEGER;
  opted_out BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Un-enforced broker dispatch authorizations are immutable' USING ERRCODE = '23514'; END IF;
  SELECT environment INTO account_environment FROM "TradingAccount" WHERE id = NEW."tradingAccountId";
  IF account_environment IS DISTINCT FROM 'PAPER' THEN RAISE EXCEPTION 'UNENFORCED_DISPATCH_SCOPE: PAPER entries only' USING ERRCODE = '23514'; END IF;
  SELECT * INTO oi FROM "OrderIntent" WHERE id = NEW."orderIntentId";
  SELECT symbol INTO security_symbol FROM "Security" WHERE id = NEW."securityId";
  IF oi.id IS NULL OR ROW(oi."tradingAccountId", oi."clientOrderId") IS DISTINCT FROM ROW(NEW."tradingAccountId", NEW."clientOrderId")
     OR oi."tradingAccountSubscriptionId" IS DISTINCT FROM NEW."accountSubscriptionId"
     OR upper(btrim(oi.symbol)) IS DISTINCT FROM NEW."securitySymbol" OR security_symbol IS DISTINCT FROM NEW."securitySymbol"
     OR NOT "order_intent_is_entry_buy"(oi.side, oi."trackedPositionId", oi."rawRequestJson"::jsonb) THEN
    RAISE EXCEPTION 'UNENFORCED_DISPATCH_IDENTITY: must mirror its exact entry BUY OrderIntent, Security and stable client order ID' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "OrderIntentMarketPolicyEnforcementObligation" x WHERE x."orderIntentId" = NEW."orderIntentId")
     OR EXISTS (SELECT 1 FROM "MarketPolicyBrokerDispatchConsumption" x WHERE x."orderIntentId" = NEW."orderIntentId") THEN
    RAISE EXCEPTION 'UNENFORCED_DISPATCH_OBLIGATED: an obligated entry is dispatched only through its consumed ALLOWED decision' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO c FROM "EntryExposureClaim" WHERE "orderIntentId" = NEW."orderIntentId";
  IF oi.status IS DISTINCT FROM 'submitting' OR c.id IS NULL OR c."releasedAt" IS NOT NULL OR c.status IS DISTINCT FROM 'ENTRY_SUBMITTING'
     OR c."tradingAccountId" IS DISTINCT FROM NEW."tradingAccountId" OR c."securityId" IS DISTINCT FROM NEW."securityId" THEN
    RAISE EXCEPTION 'UNENFORCED_DISPATCH_NOT_EXECUTABLE: the intent or its claim is no longer executable' USING ERRCODE = '23514';
  END IF;

  -- The authoritative non-enforced decision, serialized against activation (rollout FOR UPDATE) and
  -- grants/revocations/lapse resolution (assignment FOR UPDATE, then the authorization row).
  SELECT * INTO rollout FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id = 1 FOR SHARE;
  IF COALESCE(rollout.enabled, false) IS DISTINCT FROM NEW."rolloutEnabled" OR COALESCE(rollout.version, 0) IS DISTINCT FROM NEW."rolloutVersion" THEN
    RAISE EXCEPTION 'UNENFORCED_DISPATCH_ROLLOUT_CHANGED: the runtime rollout changed before the final authorization' USING ERRCODE = '23514';
  END IF;
  IF NEW."accountSubscriptionId" IS NOT NULL THEN
    SELECT * INTO latest FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE "accountSubscriptionId" = NEW."accountSubscriptionId" ORDER BY id DESC LIMIT 1 FOR SHARE;
  END IF;
  IF latest.id IS DISTINCT FROM NEW."latestAuthorizationId" OR latest.status::text IS DISTINCT FROM NEW."latestAuthorizationStatus" THEN
    RAISE EXCEPTION 'UNENFORCED_DISPATCH_AUTHORIZATION_CHANGED: the assignment authorization changed before the final authorization' USING ERRCODE = '23514';
  END IF;
  IF COALESCE(rollout.enabled, false) THEN
    opted_out := latest.id IS NOT NULL AND latest.status = 'INVALIDATED'
      AND EXISTS (SELECT 1 FROM "AssignmentMarketPolicyEnforcementLapseResolution" r WHERE r."authorizationId" = latest.id);
    IF latest.id IS NOT NULL AND NOT (latest.status = 'REVOKED' OR opted_out) THEN
      RAISE EXCEPTION 'UNENFORCED_DISPATCH_ENFORCEMENT_REQUIRED: the assignment now requires enforcement; the entry must be quarantined' USING ERRCODE = '23514';
    END IF;
    IF (latest.id IS NULL AND NEW.basis NOT IN ('NEVER_AUTHORIZED', 'NO_ASSIGNMENT'))
       OR (latest.status = 'REVOKED' AND NEW.basis <> 'OWNER_REVOKED') OR (opted_out AND NEW.basis <> 'OWNER_OPTED_OUT') THEN
      RAISE EXCEPTION 'UNENFORCED_DISPATCH_BASIS: the recorded basis does not match the current disposition' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."brokerPostOpportunityId" IS NOT NULL THEN
    SELECT "orderIntentId" INTO opportunity_intent FROM "OrderIntentBrokerPostOpportunity" WHERE id = NEW."brokerPostOpportunityId";
    IF opportunity_intent IS DISTINCT FROM NEW."orderIntentId" THEN
      RAISE EXCEPTION 'UNENFORCED_DISPATCH_IDENTITY: may cite only its own intent''s broker opportunity' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW."authorizedAt" := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER "UnenforcedDispatch_validate" BEFORE INSERT OR UPDATE OR DELETE ON "MarketPolicyBrokerUnenforcedDispatch" FOR EACH ROW EXECUTE FUNCTION "validate_market_policy_broker_unenforced_dispatch"();

-- Claim history is evidence: append-only at the database boundary.
CREATE FUNCTION "entry_exposure_claim_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'EntryExposureClaimEvent rows are immutable evidence' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER "EntryExposureClaimEvent_append_only" BEFORE UPDATE OR DELETE ON "EntryExposureClaimEvent" FOR EACH ROW EXECUTE FUNCTION "entry_exposure_claim_event_append_only"();
