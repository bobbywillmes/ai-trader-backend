CREATE TYPE "ExternalSignalExecutionDirection" AS ENUM ('ENTRY', 'EXIT');
CREATE TYPE "ExternalSignalExecutionAuthorityMode" AS ENUM ('SHADOW', 'EXECUTE');
CREATE TYPE "ExternalSignalTradeCycleStatus" AS ENUM (
  'AWAITING_ENTRY', 'ENTRY_RECEIVED', 'ROUTED', 'ACTIVE',
  'TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED', 'CONFLICT'
);
CREATE TYPE "ExternalSignalAccountCycleStatus" AS ENUM (
  'ENTRY_ROUTE_PENDING', 'ENTRY_ADMISSION_PENDING', 'ENTRY_SHADOW_ALLOWED',
  'ENTRY_SUPPRESSED_BY_EXIT', 'EXIT_PENDING', 'BLOCKED',
  'TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED'
);
CREATE TYPE "ExternalSignalNoExposureProof" AS ENUM (
  'ENTRY_SUPPRESSED_BEFORE_ADMISSION', 'ENTRY_REJECTED_WITHOUT_INTENT',
  'INTENT_DEFINITELY_NOT_SENT_AND_CLAIM_RELEASED',
  'BROKER_REJECTED_SETTLED_AND_VERIFIED_ABSENT',
  'ENTRY_CANCELED_BEFORE_FILL_AND_VERIFIED_ABSENT'
);

ALTER TABLE "Signal"
  ADD COLUMN "externalEventId" TEXT,
  ADD COLUMN "externalTradeCycleRef" TEXT,
  ADD COLUMN "externalSignalTradeCycleId" INTEGER;

ALTER TABLE "Signal" DROP CONSTRAINT "Signal_event_identity_check";
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_event_identity_check" CHECK (
  (
    "schemaVersion" = 1
    AND "externalEventId" IS NULL
    AND "externalTradeCycleRef" IS NULL
    AND "externalSignalTradeCycleId" IS NULL
    AND (
      ("externalEventKey" IS NOT NULL AND "eventFingerprint" IS NULL)
      OR ("externalEventKey" IS NULL AND "eventFingerprint" IS NOT NULL)
    )
  )
  OR
  (
    "schemaVersion" = 2
    AND "externalEventKey" IS NULL
    AND "eventFingerprint" IS NOT NULL
    AND "externalEventId" IS NOT NULL
    AND "externalTradeCycleRef" IS NOT NULL
    AND "externalSignalTradeCycleId" IS NOT NULL
  )
);
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_v2_identifier_syntax_check" CHECK (
  "schemaVersion" <> 2 OR (
    octet_length("externalEventId") BETWEEN 1 AND 128
    AND octet_length("externalTradeCycleRef") BETWEEN 1 AND 128
    AND "externalEventId" COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
    AND "externalTradeCycleRef" COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
  )
);
CREATE UNIQUE INDEX "Signal_signalSourceId_externalEventId_key"
  ON "Signal"("signalSourceId", "externalEventId");
CREATE INDEX "Signal_externalSignalTradeCycleId_event_idx"
  ON "Signal"("externalSignalTradeCycleId", "event");

CREATE TABLE "ExternalSignalExecutionRolloutGeneration" (
  "id" SERIAL PRIMARY KEY,
  "direction" "ExternalSignalExecutionDirection" NOT NULL,
  "generation" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "authorityMode" "ExternalSignalExecutionAuthorityMode" NOT NULL,
  "supersedesGenerationId" INTEGER,
  "configurationJson" JSONB NOT NULL,
  "configurationFingerprint" TEXT NOT NULL,
  "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
  "createdByUserId" INTEGER,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalSignalExecutionRolloutGeneration_shadow_only_check" CHECK ("authorityMode" = 'SHADOW'),
  CONSTRAINT "ExternalSignalExecutionRolloutGeneration_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "ExternalSignalExecutionRolloutGeneration_fingerprint_check" CHECK ("configurationFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ExternalSignalExecutionRolloutGeneration_supersedes_fkey" FOREIGN KEY ("supersedesGenerationId") REFERENCES "ExternalSignalExecutionRolloutGeneration"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalExecutionRolloutGeneration_creator_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalExecutionRolloutGeneration_direction_generation_key" UNIQUE ("direction", "generation"),
  CONSTRAINT "ExternalSignalExecutionRolloutGeneration_supersedesGenerationId_key" UNIQUE ("supersedesGenerationId")
);
CREATE INDEX "ExternalSignalExecutionRolloutGeneration_direction_effectiveAt_idx" ON "ExternalSignalExecutionRolloutGeneration"("direction", "effectiveAt");
CREATE INDEX "ExternalSignalExecutionRolloutGeneration_createdByUserId_idx" ON "ExternalSignalExecutionRolloutGeneration"("createdByUserId");

CREATE TABLE "ExternalSignalTradeCycle" (
  "id" SERIAL PRIMARY KEY,
  "strategySignalBindingId" INTEGER NOT NULL,
  "strategySignalRevisionId" INTEGER NOT NULL,
  "strategyRevision" INTEGER NOT NULL,
  "securityId" INTEGER NOT NULL,
  "externalTradeCycleRef" TEXT NOT NULL,
  "status" "ExternalSignalTradeCycleStatus" NOT NULL,
  "terminalAt" TIMESTAMPTZ(3),
  "terminalReasonCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ExternalSignalTradeCycle_reference_syntax_check" CHECK (
    octet_length("externalTradeCycleRef") BETWEEN 1 AND 128
    AND "externalTradeCycleRef" COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
  ),
  CONSTRAINT "ExternalSignalTradeCycle_terminal_check" CHECK (
    ("status" IN ('TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED', 'CONFLICT') AND "terminalAt" IS NOT NULL AND "terminalReasonCode" IS NOT NULL)
    OR
    ("status" NOT IN ('TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED', 'CONFLICT') AND "terminalAt" IS NULL AND "terminalReasonCode" IS NULL)
  ),
  CONSTRAINT "ExternalSignalTradeCycle_binding_fkey" FOREIGN KEY ("strategySignalBindingId") REFERENCES "StrategySignalBinding"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalTradeCycle_revision_fkey" FOREIGN KEY ("strategySignalRevisionId", "strategySignalBindingId", "strategyRevision") REFERENCES "StrategySignalRevision"("id", "strategySignalBindingId", "revision") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalTradeCycle_security_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalTradeCycle_binding_reference_key" UNIQUE ("strategySignalBindingId", "externalTradeCycleRef"),
  CONSTRAINT "ExternalSignalTradeCycle_identity_key" UNIQUE ("id", "strategySignalBindingId", "strategySignalRevisionId", "securityId")
);
CREATE INDEX "ExternalSignalTradeCycle_revision_idx" ON "ExternalSignalTradeCycle"("strategySignalRevisionId", "strategySignalBindingId", "strategyRevision");
CREATE INDEX "ExternalSignalTradeCycle_security_status_idx" ON "ExternalSignalTradeCycle"("securityId", "status");
CREATE INDEX "ExternalSignalTradeCycle_status_updatedAt_idx" ON "ExternalSignalTradeCycle"("status", "updatedAt");

ALTER TABLE "Signal" ADD CONSTRAINT "Signal_externalSignalTradeCycleId_fkey"
  FOREIGN KEY ("externalSignalTradeCycleId") REFERENCES "ExternalSignalTradeCycle"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "Signal_externalSignalTradeCycle_entry_key"
  ON "Signal"("externalSignalTradeCycleId") WHERE "event" = 'ENTRY_LONG';

ALTER TABLE "SignalRoute" ADD CONSTRAINT "SignalRoute_account_cycle_identity_key"
  UNIQUE ("id", "tradingAccountId", "tradingAccountSubscriptionId", "subscriptionId");

CREATE TABLE "ExternalSignalTradeCycleAccount" (
  "id" SERIAL PRIMARY KEY,
  "externalSignalTradeCycleId" INTEGER NOT NULL,
  "entrySignalRouteId" INTEGER NOT NULL,
  "tradingAccountId" INTEGER NOT NULL,
  "tradingAccountSubscriptionId" INTEGER NOT NULL,
  "subscriptionId" INTEGER NOT NULL,
  "securityId" INTEGER NOT NULL,
  "entryRolloutGenerationId" INTEGER,
  "status" "ExternalSignalAccountCycleStatus" NOT NULL,
  "entryReservationKey" TEXT,
  "entryReservationCreatedAt" TIMESTAMPTZ(3),
  "entryOrderIntentId" INTEGER,
  "trackedPositionId" INTEGER,
  "pendingExitAcceptedAt" TIMESTAMPTZ(3),
  "terminalAt" TIMESTAMPTZ(3),
  "terminalReasonCode" TEXT,
  "noExposureProof" "ExternalSignalNoExposureProof",
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ExternalSignalTradeCycleAccount_shadow_links_check" CHECK ("entryOrderIntentId" IS NULL AND "trackedPositionId" IS NULL),
  CONSTRAINT "ExternalSignalTradeCycleAccount_reservation_check" CHECK (
    ("entryReservationKey" IS NULL AND "entryReservationCreatedAt" IS NULL)
    OR ("entryReservationKey" IS NOT NULL AND "entryReservationCreatedAt" IS NOT NULL)
  ),
  CONSTRAINT "ExternalSignalTradeCycleAccount_terminal_check" CHECK (
    (
      "status" = 'TERMINAL_NO_EXPOSURE'
      AND "terminalAt" IS NOT NULL AND "terminalReasonCode" IS NOT NULL AND "noExposureProof" IS NOT NULL
    ) OR (
      "status" = 'TERMINAL_CLOSED'
      AND "terminalAt" IS NOT NULL AND "terminalReasonCode" IS NOT NULL AND "noExposureProof" IS NULL
      AND "trackedPositionId" IS NOT NULL
    ) OR (
      "status" NOT IN ('TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED')
      AND "terminalAt" IS NULL AND "terminalReasonCode" IS NULL AND "noExposureProof" IS NULL
    )
  ),
  CONSTRAINT "ExternalSignalTradeCycleAccount_cycle_fkey" FOREIGN KEY ("externalSignalTradeCycleId") REFERENCES "ExternalSignalTradeCycle"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalTradeCycleAccount_route_fkey" FOREIGN KEY ("entrySignalRouteId", "tradingAccountId", "tradingAccountSubscriptionId", "subscriptionId") REFERENCES "SignalRoute"("id", "tradingAccountId", "tradingAccountSubscriptionId", "subscriptionId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalTradeCycleAccount_account_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalTradeCycleAccount_assignment_fkey" FOREIGN KEY ("tradingAccountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalTradeCycleAccount_subscription_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalTradeCycleAccount_security_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalTradeCycleAccount_rollout_fkey" FOREIGN KEY ("entryRolloutGenerationId") REFERENCES "ExternalSignalExecutionRolloutGeneration"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalTradeCycleAccount_order_intent_fkey" FOREIGN KEY ("entryOrderIntentId") REFERENCES "OrderIntent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalTradeCycleAccount_position_fkey" FOREIGN KEY ("trackedPositionId") REFERENCES "TrackedPosition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalTradeCycleAccount_cycle_account_key" UNIQUE ("externalSignalTradeCycleId", "tradingAccountId"),
  CONSTRAINT "ExternalSignalTradeCycleAccount_entrySignalRouteId_key" UNIQUE ("entrySignalRouteId"),
  CONSTRAINT "ExternalSignalTradeCycleAccount_route_identity_key" UNIQUE ("entrySignalRouteId", "tradingAccountId", "tradingAccountSubscriptionId", "subscriptionId"),
  CONSTRAINT "ExternalSignalTradeCycleAccount_entryReservationKey_key" UNIQUE ("entryReservationKey"),
  CONSTRAINT "ExternalSignalTradeCycleAccount_entryOrderIntentId_key" UNIQUE ("entryOrderIntentId"),
  CONSTRAINT "ExternalSignalTradeCycleAccount_trackedPositionId_key" UNIQUE ("trackedPositionId")
);
CREATE INDEX "ExternalSignalTradeCycleAccount_assignment_status_idx" ON "ExternalSignalTradeCycleAccount"("tradingAccountSubscriptionId", "status");
CREATE INDEX "ExternalSignalTradeCycleAccount_subscription_status_idx" ON "ExternalSignalTradeCycleAccount"("subscriptionId", "status");
CREATE INDEX "ExternalSignalTradeCycleAccount_security_status_idx" ON "ExternalSignalTradeCycleAccount"("securityId", "status");
CREATE INDEX "ExternalSignalTradeCycleAccount_status_updatedAt_idx" ON "ExternalSignalTradeCycleAccount"("status", "updatedAt");

CREATE FUNCTION "prevent_external_signal_rollout_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'External signal execution rollout generations are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER "ExternalSignalExecutionRolloutGeneration_immutable"
  BEFORE UPDATE OR DELETE ON "ExternalSignalExecutionRolloutGeneration"
  FOR EACH ROW EXECUTE FUNCTION "prevent_external_signal_rollout_mutation"();

CREATE FUNCTION "check_external_signal_rollout_chain"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior "ExternalSignalExecutionRolloutGeneration"%ROWTYPE;
BEGIN
  IF NEW."supersedesGenerationId" IS NULL THEN
    IF NEW."generation" <> 1 THEN
      RAISE EXCEPTION 'First external signal rollout generation must be generation 1' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO prior FROM "ExternalSignalExecutionRolloutGeneration" WHERE id = NEW."supersedesGenerationId";
    IF prior.id IS NULL OR prior.direction <> NEW.direction OR NEW.generation <> prior.generation + 1 THEN
      RAISE EXCEPTION 'External signal rollout supersession identity is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ExternalSignalExecutionRolloutGeneration_chain_check"
  AFTER INSERT ON "ExternalSignalExecutionRolloutGeneration" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_external_signal_rollout_chain"();

CREATE FUNCTION "protect_external_signal_cycle"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'External signal trade cycles are append-preserving' USING ERRCODE = '23514';
  END IF;
  IF ROW(OLD."strategySignalBindingId", OLD."strategySignalRevisionId", OLD."strategyRevision", OLD."securityId", OLD."externalTradeCycleRef", OLD."createdAt")
    IS DISTINCT FROM ROW(NEW."strategySignalBindingId", NEW."strategySignalRevisionId", NEW."strategyRevision", NEW."securityId", NEW."externalTradeCycleRef", NEW."createdAt") THEN
    RAISE EXCEPTION 'External signal trade cycle identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED', 'CONFLICT') THEN
    RAISE EXCEPTION 'External signal terminal trade cycle state is immutable and absorbing' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'AWAITING_ENTRY' AND NEW.status IN ('ENTRY_RECEIVED', 'CONFLICT', 'TERMINAL_NO_EXPOSURE'))
    OR (OLD.status = 'ENTRY_RECEIVED' AND NEW.status IN ('ROUTED', 'CONFLICT', 'TERMINAL_NO_EXPOSURE'))
    OR (OLD.status = 'ROUTED' AND NEW.status IN ('ACTIVE', 'CONFLICT', 'TERMINAL_NO_EXPOSURE'))
    OR (OLD.status = 'ACTIVE' AND NEW.status IN ('TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED', 'CONFLICT'))
  ) THEN
    RAISE EXCEPTION 'External signal trade cycle state transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalTradeCycle_protected"
  BEFORE UPDATE OR DELETE ON "ExternalSignalTradeCycle"
  FOR EACH ROW EXECUTE FUNCTION "protect_external_signal_cycle"();

CREATE FUNCTION "protect_external_signal_account_cycle"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'External signal account cycles are append-preserving' USING ERRCODE = '23514';
  END IF;
  IF ROW(OLD."externalSignalTradeCycleId", OLD."entrySignalRouteId", OLD."tradingAccountId", OLD."tradingAccountSubscriptionId", OLD."subscriptionId", OLD."securityId", OLD."createdAt")
    IS DISTINCT FROM ROW(NEW."externalSignalTradeCycleId", NEW."entrySignalRouteId", NEW."tradingAccountId", NEW."tradingAccountSubscriptionId", NEW."subscriptionId", NEW."securityId", NEW."createdAt") THEN
    RAISE EXCEPTION 'External signal account cycle identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."entryRolloutGenerationId" IS NOT NULL AND NEW."entryRolloutGenerationId" IS DISTINCT FROM OLD."entryRolloutGenerationId" THEN
    RAISE EXCEPTION 'External signal account cycle rollout link is write-once' USING ERRCODE = '23514';
  END IF;
  IF OLD."entryReservationKey" IS NOT NULL AND ROW(NEW."entryReservationKey", NEW."entryReservationCreatedAt") IS DISTINCT FROM ROW(OLD."entryReservationKey", OLD."entryReservationCreatedAt") THEN
    RAISE EXCEPTION 'External signal entry reservation is write-once' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED') THEN
    RAISE EXCEPTION 'External signal terminal account cycle state is immutable and absorbing' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'ENTRY_ROUTE_PENDING' AND NEW.status IN ('ENTRY_ADMISSION_PENDING', 'ENTRY_SUPPRESSED_BY_EXIT', 'EXIT_PENDING', 'BLOCKED', 'TERMINAL_NO_EXPOSURE'))
    OR (OLD.status = 'ENTRY_ADMISSION_PENDING' AND NEW.status IN ('ENTRY_SHADOW_ALLOWED', 'ENTRY_SUPPRESSED_BY_EXIT', 'EXIT_PENDING', 'BLOCKED', 'TERMINAL_NO_EXPOSURE'))
    OR (OLD.status = 'ENTRY_SHADOW_ALLOWED' AND NEW.status IN ('EXIT_PENDING', 'BLOCKED', 'TERMINAL_NO_EXPOSURE'))
    OR (OLD.status = 'ENTRY_SUPPRESSED_BY_EXIT' AND NEW.status = 'TERMINAL_NO_EXPOSURE')
    OR (OLD.status = 'EXIT_PENDING' AND NEW.status IN ('ENTRY_SUPPRESSED_BY_EXIT', 'BLOCKED', 'TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED'))
    OR (OLD.status = 'BLOCKED' AND NEW.status IN ('EXIT_PENDING', 'TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED'))
  ) THEN
    RAISE EXCEPTION 'External signal account cycle state transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalTradeCycleAccount_protected"
  BEFORE UPDATE OR DELETE ON "ExternalSignalTradeCycleAccount"
  FOR EACH ROW EXECUTE FUNCTION "protect_external_signal_account_cycle"();

CREATE FUNCTION "protect_signal_contract_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD."schemaVersion", OLD."externalEventKey", OLD."externalEventId", OLD."externalTradeCycleRef", OLD."eventFingerprint", OLD."externalSignalTradeCycleId")
    IS DISTINCT FROM ROW(NEW."schemaVersion", NEW."externalEventKey", NEW."externalEventId", NEW."externalTradeCycleRef", NEW."eventFingerprint", NEW."externalSignalTradeCycleId") THEN
    RAISE EXCEPTION 'Signal contract identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Signal_contract_identity_immutable"
  BEFORE UPDATE ON "Signal" FOR EACH ROW EXECUTE FUNCTION "protect_signal_contract_identity"();

CREATE FUNCTION "check_signal_trade_cycle_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cycle_row "ExternalSignalTradeCycle"%ROWTYPE;
BEGIN
  IF NEW."schemaVersion" <> 2 THEN RETURN NULL; END IF;
  SELECT * INTO cycle_row FROM "ExternalSignalTradeCycle" WHERE id = NEW."externalSignalTradeCycleId";
  IF cycle_row.id IS NULL
    OR cycle_row."strategySignalBindingId" <> NEW."strategySignalBindingId"
    OR cycle_row."strategySignalRevisionId" <> NEW."strategySignalRevisionId"
    OR cycle_row."strategyRevision" <> NEW."strategyRevision"
    OR cycle_row."securityId" <> NEW."securityId"
    OR cycle_row."externalTradeCycleRef" <> NEW."externalTradeCycleRef" THEN
    RAISE EXCEPTION 'Signal does not match its external trade cycle identity' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "Signal_trade_cycle_identity_check"
  AFTER INSERT OR UPDATE ON "Signal" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_signal_trade_cycle_identity"();

CREATE FUNCTION "check_external_signal_account_cycle_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cycle_row "ExternalSignalTradeCycle"%ROWTYPE;
DECLARE route_row RECORD;
DECLARE rollout_row "ExternalSignalExecutionRolloutGeneration"%ROWTYPE;
BEGIN
  SELECT * INTO cycle_row FROM "ExternalSignalTradeCycle" WHERE id = NEW."externalSignalTradeCycleId";
  SELECT sr.*, s."externalSignalTradeCycleId" AS signal_cycle_id, s.event, s."schemaVersion"
    INTO route_row
    FROM "SignalRoute" sr
    JOIN "SignalRoutingRun" rr ON rr.id = sr."signalRoutingRunId"
    JOIN "Signal" s ON s.id = rr."signalId"
    WHERE sr.id = NEW."entrySignalRouteId";
  IF cycle_row.id IS NULL OR route_row.id IS NULL
    OR route_row.event <> 'ENTRY_LONG' OR route_row."schemaVersion" <> 2
    OR route_row.signal_cycle_id <> cycle_row.id
    OR route_row."tradingAccountId" <> NEW."tradingAccountId"
    OR route_row."tradingAccountSubscriptionId" <> NEW."tradingAccountSubscriptionId"
    OR route_row."subscriptionId" <> NEW."subscriptionId"
    OR cycle_row."securityId" <> NEW."securityId" THEN
    RAISE EXCEPTION 'External signal account cycle does not match its original entry route' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "TradingAccountSubscription" tas
    WHERE tas.id = NEW."tradingAccountSubscriptionId"
      AND tas."tradingAccountId" = NEW."tradingAccountId"
      AND tas."subscriptionId" = NEW."subscriptionId"
      AND tas."routingSecurityId" = NEW."securityId"
  ) THEN
    RAISE EXCEPTION 'External signal account cycle assignment identity is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW."entryRolloutGenerationId" IS NOT NULL THEN
    SELECT * INTO rollout_row FROM "ExternalSignalExecutionRolloutGeneration" WHERE id = NEW."entryRolloutGenerationId";
    IF rollout_row.id IS NULL OR rollout_row.direction <> 'ENTRY' OR rollout_row."authorityMode" <> 'SHADOW' THEN
      RAISE EXCEPTION 'External signal account cycle entry rollout identity is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ExternalSignalTradeCycleAccount_identity_check"
  AFTER INSERT OR UPDATE ON "ExternalSignalTradeCycleAccount" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_external_signal_account_cycle_identity"();

CREATE FUNCTION "check_external_signal_source_cycle_terminal"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE nonterminal_count INTEGER;
DECLARE closed_count INTEGER;
DECLARE incompatible_count INTEGER;
BEGIN
  IF NEW.status NOT IN ('TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED', 'CONFLICT') THEN RETURN NULL; END IF;
  SELECT
    count(*) FILTER (WHERE status NOT IN ('TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED')),
    count(*) FILTER (WHERE status = 'TERMINAL_CLOSED'),
    count(*) FILTER (WHERE NEW.status = 'TERMINAL_NO_EXPOSURE' AND status <> 'TERMINAL_NO_EXPOSURE')
  INTO nonterminal_count, closed_count, incompatible_count
  FROM "ExternalSignalTradeCycleAccount" WHERE "externalSignalTradeCycleId" = NEW.id;
  IF nonterminal_count > 0 OR incompatible_count > 0 OR (NEW.status = 'TERMINAL_CLOSED' AND closed_count = 0) THEN
    RAISE EXCEPTION 'Source trade cycle cannot become terminal while an account cycle is unresolved or incompatible' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ExternalSignalTradeCycle_terminal_accounts_check"
  AFTER INSERT OR UPDATE ON "ExternalSignalTradeCycle" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_external_signal_source_cycle_terminal"();

CREATE FUNCTION "check_external_signal_account_terminal_parent"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status "ExternalSignalTradeCycleStatus";
BEGIN
  SELECT status INTO parent_status FROM "ExternalSignalTradeCycle" WHERE id = NEW."externalSignalTradeCycleId";
  IF parent_status = 'TERMINAL_NO_EXPOSURE' AND NEW.status <> 'TERMINAL_NO_EXPOSURE' THEN
    RAISE EXCEPTION 'Terminal no-exposure source cycle requires compatible account cycles' USING ERRCODE = '23514';
  END IF;
  IF parent_status = 'TERMINAL_CLOSED' AND NEW.status NOT IN ('TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED') THEN
    RAISE EXCEPTION 'Terminal closed source cycle requires terminal account cycles' USING ERRCODE = '23514';
  END IF;
  IF parent_status = 'CONFLICT' THEN
    RAISE EXCEPTION 'Terminal conflict source cycle cannot accept or mutate account cycles' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ExternalSignalTradeCycleAccount_terminal_parent_check"
  AFTER INSERT OR UPDATE ON "ExternalSignalTradeCycleAccount" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_external_signal_account_terminal_parent"();
