-- Phase 4A.2A establishes PAPER-only authority and provenance. It does not admit or dispatch orders.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TYPE "ExternalSignalExecutionRolloutAction" AS ENUM ('ACTIVATE', 'DEACTIVATE');
CREATE TYPE "ExternalSignalEntryExecutionAuthorizationStatus" AS ENUM ('AUTHORIZED', 'REVOKED', 'INVALIDATED');
ALTER TYPE "ExternalSignalAccountCycleStatus" ADD VALUE 'ENTRY_INTENT_CREATED';

ALTER TABLE "ExternalSignalExecutionRolloutGeneration"
  DROP CONSTRAINT "ExternalSignalExecutionRolloutGeneration_shadow_only_check",
  ADD CONSTRAINT "ExternalSignalExecutionRolloutGeneration_authority_check" CHECK (
    ("authorityMode" = 'SHADOW') OR
    ("authorityMode" = 'EXECUTE' AND direction = 'ENTRY' AND enabled)
  );

CREATE TABLE "ExternalSignalExecutionRolloutActivation" (
  id SERIAL PRIMARY KEY,
  "rolloutGenerationId" INTEGER NOT NULL REFERENCES "ExternalSignalExecutionRolloutGeneration"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  action "ExternalSignalExecutionRolloutAction" NOT NULL,
  reason TEXT NOT NULL,
  "actorUserId" INTEGER NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ExternalSignalExecutionRolloutActivation_generation_id_idx" ON "ExternalSignalExecutionRolloutActivation"("rolloutGenerationId",id);

CREATE TABLE "ExternalSignalExecutionRolloutState" (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL,
  "activeRolloutGenerationId" INTEGER UNIQUE REFERENCES "ExternalSignalExecutionRolloutGeneration"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "activatedAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ExternalSignalExecutionRolloutState_singleton_check" CHECK (id=1 AND version>0),
  CONSTRAINT "ExternalSignalExecutionRolloutState_active_check" CHECK (("activeRolloutGenerationId" IS NULL)=("activatedAt" IS NULL))
);
INSERT INTO "ExternalSignalExecutionRolloutState" (id,version,"updatedAt") VALUES (1,1,statement_timestamp());

CREATE TABLE "ExternalSignalEntryExecutionAuthorization" (
  id SERIAL PRIMARY KEY,
  "rolloutGenerationId" INTEGER NOT NULL REFERENCES "ExternalSignalExecutionRolloutGeneration"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "authorizationSequence" INTEGER NOT NULL,
  status "ExternalSignalEntryExecutionAuthorizationStatus" NOT NULL,
  "tradingAccountId" INTEGER NOT NULL REFERENCES "TradingAccount"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "tradingAccountSubscriptionId" INTEGER NOT NULL REFERENCES "TradingAccountSubscription"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "subscriptionId" INTEGER NOT NULL REFERENCES "Subscription"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "securityId" INTEGER NOT NULL REFERENCES "Security"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "signalSourceId" INTEGER NOT NULL REFERENCES "ExternalSignalSource"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "strategySignalBindingId" INTEGER NOT NULL REFERENCES "StrategySignalBinding"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "strategySignalRevisionId" INTEGER NOT NULL,
  "strategyRevision" INTEGER NOT NULL,
  "accountHolderUserId" INTEGER NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "assignmentFingerprint" TEXT NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "authorizationFingerprint" TEXT NOT NULL,
  "authorizedByUserId" INTEGER NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "authorizedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "grantReason" TEXT NOT NULL,
  "revokedByUserId" INTEGER REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "revokedAt" TIMESTAMPTZ(3),
  "revocationReason" TEXT,
  "invalidatedAt" TIMESTAMPTZ(3),
  "invalidationReasonCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalSignalEntryExecutionAuthorization_revision_fkey" FOREIGN KEY ("strategySignalRevisionId","strategySignalBindingId","strategyRevision") REFERENCES "StrategySignalRevision"(id,"strategySignalBindingId",revision) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ExternalSignalEntryExecutionAuthorization_sequence_key" UNIQUE ("rolloutGenerationId","tradingAccountSubscriptionId","strategySignalBindingId","authorizationSequence"),
  CONSTRAINT "ExternalSignalEntryExecutionAuthorization_sequence_check" CHECK ("authorizationSequence" > 0),
  CONSTRAINT "ExternalSignalEntryExecutionAuthorization_fingerprint_check" CHECK ("assignmentFingerprint" ~ '^[0-9a-f]{64}$' AND "sourceFingerprint" ~ '^[0-9a-f]{64}$' AND "authorizationFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ExternalSignalEntryExecutionAuthorization_terminal_check" CHECK (
    (status='AUTHORIZED' AND "revokedAt" IS NULL AND "revokedByUserId" IS NULL AND "revocationReason" IS NULL AND "invalidatedAt" IS NULL AND "invalidationReasonCode" IS NULL) OR
    (status='REVOKED' AND "revokedAt" IS NOT NULL AND "revokedByUserId" IS NOT NULL AND "revocationReason" IS NOT NULL AND "invalidatedAt" IS NULL AND "invalidationReasonCode" IS NULL) OR
    (status='INVALIDATED' AND "invalidatedAt" IS NOT NULL AND "invalidationReasonCode" IS NOT NULL AND "revokedAt" IS NULL AND "revokedByUserId" IS NULL AND "revocationReason" IS NULL)
  )
);
CREATE UNIQUE INDEX "ExternalSignalEntryExecutionAuthorization_effective_key" ON "ExternalSignalEntryExecutionAuthorization"("tradingAccountSubscriptionId","strategySignalBindingId") WHERE status='AUTHORIZED';
CREATE INDEX "ExternalSignalEntryExecutionAuthorization_assignment_binding_status_idx" ON "ExternalSignalEntryExecutionAuthorization"("tradingAccountSubscriptionId","strategySignalBindingId",status);

ALTER TABLE "OrderIntent" ADD COLUMN "externalSignalAccountCycleId" INTEGER;
ALTER TABLE "OrderIntent" ADD CONSTRAINT "OrderIntent_externalSignalAccountCycleId_key" UNIQUE ("externalSignalAccountCycleId");
ALTER TABLE "OrderIntent" ADD CONSTRAINT "OrderIntent_externalSignalAccountCycleId_fkey" FOREIGN KEY ("externalSignalAccountCycleId") REFERENCES "ExternalSignalTradeCycleAccount"(id) ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "ExternalSignalEntryExecutionObligation" (
  id SERIAL PRIMARY KEY,
  "orderIntentId" INTEGER NOT NULL UNIQUE REFERENCES "OrderIntent"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "accountCycleId" INTEGER NOT NULL UNIQUE REFERENCES "ExternalSignalTradeCycleAccount"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sourceCycleId" INTEGER NOT NULL REFERENCES "ExternalSignalTradeCycle"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "entrySignalId" INTEGER NOT NULL REFERENCES "Signal"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "entrySignalRouteId" INTEGER NOT NULL REFERENCES "SignalRoute"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "authorizationId" INTEGER NOT NULL REFERENCES "ExternalSignalEntryExecutionAuthorization"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "rolloutGenerationId" INTEGER NOT NULL REFERENCES "ExternalSignalExecutionRolloutGeneration"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "executionEpochAt" TIMESTAMPTZ(3) NOT NULL,
  "authorizationFingerprint" TEXT NOT NULL,
  "obligationFingerprint" TEXT NOT NULL,
  "clientOrderId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalSignalEntryExecutionObligation_fingerprint_check" CHECK ("authorizationFingerprint" ~ '^[0-9a-f]{64}$' AND "obligationFingerprint" ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION external_signal_execution_rollout_activation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE generation_row "ExternalSignalExecutionRolloutGeneration"%ROWTYPE; state_row "ExternalSignalExecutionRolloutState"%ROWTYPE; actor_ok boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'external signal rollout activation history is immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint);
  SELECT * INTO state_row FROM "ExternalSignalExecutionRolloutState" WHERE id=1 FOR UPDATE;
  SELECT enabled AND "platformRole"='SYSTEM_OWNER' INTO actor_ok FROM "User" WHERE id=NEW."actorUserId" FOR UPDATE;
  IF actor_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'SYSTEM_OWNER required'; END IF;
  IF btrim(NEW.reason)='' THEN RAISE EXCEPTION 'activation reason required'; END IF;
  SELECT * INTO generation_row FROM "ExternalSignalExecutionRolloutGeneration" WHERE id=NEW."rolloutGenerationId" FOR UPDATE;
  IF generation_row."authorityMode" IS DISTINCT FROM 'EXECUTE' OR generation_row.direction IS DISTINCT FROM 'ENTRY' OR generation_row.enabled IS DISTINCT FROM true OR generation_row."effectiveAt">statement_timestamp() THEN RAISE EXCEPTION 'only an effective enabled ENTRY EXECUTE generation may be activated'; END IF;
  NEW."createdAt":=statement_timestamp();
  IF NEW.action='ACTIVATE' THEN
    IF state_row."activeRolloutGenerationId" IS NOT NULL THEN RAISE EXCEPTION 'an execution generation is already active'; END IF;
    IF EXISTS (SELECT 1 FROM "ExternalSignalExecutionRolloutGeneration" g WHERE g.direction='ENTRY' AND g."authorityMode"='EXECUTE' AND g.generation>generation_row.generation) THEN RAISE EXCEPTION 'only latest executable generation may activate'; END IF;
  ELSE
    IF state_row."activeRolloutGenerationId" IS DISTINCT FROM NEW."rolloutGenerationId" THEN RAISE EXCEPTION 'only the active execution generation may deactivate'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalExecutionRolloutActivation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ExternalSignalExecutionRolloutActivation" FOR EACH ROW EXECUTE FUNCTION external_signal_execution_rollout_activation_guard();

CREATE FUNCTION external_signal_execution_rollout_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE activation_row "ExternalSignalExecutionRolloutActivation"%ROWTYPE;
BEGIN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'external signal execution rollout state is database-owned'; END IF;
  IF ROW(NEW.id,NEW.version,NEW."activeRolloutGenerationId",NEW."activatedAt",NEW."updatedAt") IS NOT DISTINCT FROM ROW(OLD.id,OLD.version,OLD."activeRolloutGenerationId",OLD."activatedAt",OLD."updatedAt") THEN RETURN NEW; END IF;
  IF pg_trigger_depth() IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'external signal execution rollout state is database-owned'; END IF;
  SELECT * INTO activation_row FROM "ExternalSignalExecutionRolloutActivation" ORDER BY id DESC LIMIT 1;
  IF activation_row.id IS NULL OR NEW.version IS DISTINCT FROM OLD.version+1 OR NEW."updatedAt" IS DISTINCT FROM activation_row."createdAt" OR (
    activation_row.action='ACTIVATE' AND ROW(NEW."activeRolloutGenerationId",NEW."activatedAt") IS DISTINCT FROM ROW(activation_row."rolloutGenerationId",activation_row."createdAt")
  ) OR (
    activation_row.action='DEACTIVATE' AND ROW(NEW."activeRolloutGenerationId",NEW."activatedAt") IS DISTINCT FROM ROW(NULL::integer,NULL::timestamptz)
  ) THEN RAISE EXCEPTION 'rollout state does not match the latest activation event'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalExecutionRolloutState_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ExternalSignalExecutionRolloutState" FOR EACH ROW EXECUTE FUNCTION external_signal_execution_rollout_state_guard();

CREATE FUNCTION external_signal_execution_rollout_activation_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action='ACTIVATE' THEN
    UPDATE "ExternalSignalExecutionRolloutState" SET version=version+1,"activeRolloutGenerationId"=NEW."rolloutGenerationId","activatedAt"=NEW."createdAt","updatedAt"=NEW."createdAt" WHERE id=1;
  ELSE
    UPDATE "ExternalSignalExecutionRolloutState" SET version=version+1,"activeRolloutGenerationId"=NULL,"activatedAt"=NULL,"updatedAt"=NEW."createdAt" WHERE id=1;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "ExternalSignalExecutionRolloutActivation_apply" AFTER INSERT ON "ExternalSignalExecutionRolloutActivation" FOR EACH ROW EXECUTE FUNCTION external_signal_execution_rollout_activation_apply();

-- Every accepted v2 EXIT creates a new source-cycle row version in the same
-- transaction. A concurrent admission that locks the cycle must then observe
-- the EXIT at READ COMMITTED or abort with a serialization failure.
CREATE FUNCTION external_signal_exit_touch_source_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."schemaVersion"=2 AND NEW.event='EXIT_LONG' AND NEW."externalSignalTradeCycleId" IS NOT NULL THEN
    UPDATE "ExternalSignalTradeCycle" SET "updatedAt"=statement_timestamp() WHERE id=NEW."externalSignalTradeCycleId";
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "Signal_external_exit_touch_source_cycle" AFTER INSERT ON "Signal" FOR EACH ROW EXECUTE FUNCTION external_signal_exit_touch_source_cycle();

CREATE FUNCTION external_signal_entry_authorization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a RECORD; state_row "ExternalSignalExecutionRolloutState"%ROWTYPE; assignment_payload text; source_payload text; authorization_payload text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'external signal entry authorization is append-preserving'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.status<>'AUTHORIZED' OR NEW.status NOT IN ('REVOKED','INVALIDATED') THEN RAISE EXCEPTION 'invalid authorization transition'; END IF;
    IF ROW(NEW."rolloutGenerationId",NEW."authorizationSequence",NEW."tradingAccountId",NEW."tradingAccountSubscriptionId",NEW."subscriptionId",NEW."securityId",NEW."signalSourceId",NEW."strategySignalBindingId",NEW."strategySignalRevisionId",NEW."strategyRevision",NEW."accountHolderUserId",NEW."assignmentFingerprint",NEW."sourceFingerprint",NEW."authorizationFingerprint",NEW."authorizedByUserId",NEW."authorizedAt",NEW."grantReason",NEW."createdAt") IS DISTINCT FROM ROW(OLD."rolloutGenerationId",OLD."authorizationSequence",OLD."tradingAccountId",OLD."tradingAccountSubscriptionId",OLD."subscriptionId",OLD."securityId",OLD."signalSourceId",OLD."strategySignalBindingId",OLD."strategySignalRevisionId",OLD."strategyRevision",OLD."accountHolderUserId",OLD."assignmentFingerprint",OLD."sourceFingerprint",OLD."authorizationFingerprint",OLD."authorizedByUserId",OLD."authorizedAt",OLD."grantReason",OLD."createdAt") THEN RAISE EXCEPTION 'authorization identity is immutable'; END IF;
    IF NEW.status='REVOKED' THEN NEW."revokedAt":=statement_timestamp(); ELSE NEW."invalidatedAt":=statement_timestamp(); END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint);
  UPDATE "ExternalSignalExecutionRolloutState" SET version=version WHERE id=1 RETURNING * INTO state_row;
  IF state_row."activeRolloutGenerationId" IS DISTINCT FROM NEW."rolloutGenerationId" OR state_row."activatedAt" IS NULL THEN RAISE EXCEPTION 'execution rollout is not active'; END IF;
  SELECT ta.environment,ta."accountHolderUserId",tas."tradingAccountId",tas."subscriptionId",tas."routingSecurityId",tas."routingStrategyId",s."securityId",s."strategyId",src.provider,src.enabled AS source_enabled,b."signalSourceId",b."strategyId" AS binding_strategy,b.enabled AS binding_enabled,r.status AS revision_status,r."authorityMode",r.revision,u.enabled AND u."platformRole"='SYSTEM_OWNER' AS owner_ok
    INTO a FROM "TradingAccountSubscription" tas JOIN "TradingAccount" ta ON ta.id=tas."tradingAccountId" JOIN "Subscription" s ON s.id=tas."subscriptionId" JOIN "ExternalSignalSource" src ON src.id=NEW."signalSourceId" JOIN "StrategySignalBinding" b ON b.id=NEW."strategySignalBindingId" JOIN "StrategySignalRevision" r ON r.id=NEW."strategySignalRevisionId" JOIN "User" u ON u.id=NEW."authorizedByUserId" WHERE tas.id=NEW."tradingAccountSubscriptionId" FOR UPDATE OF tas,ta,s,src,b,r,u;
  IF a.environment IS DISTINCT FROM 'PAPER' THEN RAISE EXCEPTION 'TradingView execution authorization is PAPER-only'; END IF;
  IF a.owner_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'SYSTEM_OWNER required'; END IF;
  IF ROW(NEW."tradingAccountId",NEW."subscriptionId",NEW."securityId",NEW."accountHolderUserId") IS DISTINCT FROM ROW(a."tradingAccountId",a."subscriptionId",a."securityId",a."accountHolderUserId") OR a."routingSecurityId" IS DISTINCT FROM a."securityId" OR a."routingStrategyId" IS DISTINCT FROM a."strategyId" THEN RAISE EXCEPTION 'exact assignment identity mismatch'; END IF;
  IF a.provider IS DISTINCT FROM 'TRADINGVIEW' OR a.source_enabled IS DISTINCT FROM true OR a."signalSourceId" IS DISTINCT FROM NEW."signalSourceId" OR a.binding_strategy IS DISTINCT FROM a."strategyId" OR a.binding_enabled IS DISTINCT FROM true OR a.revision_status IS DISTINCT FROM 'ACTIVE' OR a."authorityMode" IS DISTINCT FROM 'TRADE_ELIGIBLE' OR NEW."strategyRevision" IS DISTINCT FROM a.revision THEN RAISE EXCEPTION 'exact source binding revision is not executable'; END IF;
  assignment_payload:=(jsonb_build_object('accountHolderUserId',NEW."accountHolderUserId",'securityId',NEW."securityId",'strategyId',a."strategyId",'subscriptionId',NEW."subscriptionId",'tradingAccountId',NEW."tradingAccountId",'tradingAccountSubscriptionId',NEW."tradingAccountSubscriptionId"))::text;
  source_payload:=(jsonb_build_object('provider',a.provider,'signalSourceId',NEW."signalSourceId",'strategyRevision',NEW."strategyRevision",'strategySignalBindingId',NEW."strategySignalBindingId",'strategySignalRevisionId',NEW."strategySignalRevisionId"))::text;
  NEW."authorizedAt":=statement_timestamp(); NEW."createdAt":=statement_timestamp();
  NEW."assignmentFingerprint":=encode(digest(convert_to(assignment_payload,'UTF8'),'sha256'),'hex'); NEW."sourceFingerprint":=encode(digest(convert_to(source_payload,'UTF8'),'sha256'),'hex');
  authorization_payload:=(jsonb_build_object('assignmentFingerprint',NEW."assignmentFingerprint",'authorizationSequence',NEW."authorizationSequence",'authorizedAtEpochMicros',floor(extract(epoch FROM NEW."authorizedAt")*1000000)::numeric,'rolloutGenerationId',NEW."rolloutGenerationId",'sourceFingerprint',NEW."sourceFingerprint"))::text;
  NEW."authorizationFingerprint":=encode(digest(convert_to(authorization_payload,'UTF8'),'sha256'),'hex'); RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalEntryExecutionAuthorization_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ExternalSignalEntryExecutionAuthorization" FOR EACH ROW EXECUTE FUNCTION external_signal_entry_authorization_guard();

CREATE FUNCTION invalidate_external_signal_entry_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ExternalSignalEntryExecutionAuthorization" SET status='INVALIDATED',"invalidationReasonCode"=TG_ARGV[0]
  WHERE status='AUTHORIZED' AND (
    (TG_TABLE_NAME='TradingAccount' AND "tradingAccountId"=OLD.id) OR
    (TG_TABLE_NAME='TradingAccountSubscription' AND "tradingAccountSubscriptionId"=OLD.id) OR
    (TG_TABLE_NAME='Subscription' AND "subscriptionId"=OLD.id) OR
    (TG_TABLE_NAME='Security' AND "securityId"=OLD.id) OR
    (TG_TABLE_NAME='ExternalSignalSource' AND "signalSourceId"=OLD.id) OR
    (TG_TABLE_NAME='StrategySignalBinding' AND "strategySignalBindingId"=OLD.id) OR
    (TG_TABLE_NAME='StrategySignalRevision' AND "strategySignalRevisionId"=OLD.id)
  ); RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalEntryAuthority_account_invalidate" AFTER UPDATE ON "TradingAccount" FOR EACH ROW WHEN (OLD.environment IS DISTINCT FROM NEW.environment OR OLD."accountHolderUserId" IS DISTINCT FROM NEW."accountHolderUserId") EXECUTE FUNCTION invalidate_external_signal_entry_authority('ACCOUNT_IDENTITY_CHANGED');
CREATE TRIGGER "ExternalSignalEntryAuthority_assignment_invalidate" AFTER UPDATE ON "TradingAccountSubscription" FOR EACH ROW WHEN (ROW(OLD."tradingAccountId",OLD."subscriptionId",OLD."routingSecurityId",OLD."routingStrategyId") IS DISTINCT FROM ROW(NEW."tradingAccountId",NEW."subscriptionId",NEW."routingSecurityId",NEW."routingStrategyId")) EXECUTE FUNCTION invalidate_external_signal_entry_authority('ASSIGNMENT_IDENTITY_CHANGED');
CREATE TRIGGER "ExternalSignalEntryAuthority_subscription_invalidate" AFTER UPDATE ON "Subscription" FOR EACH ROW WHEN (ROW(OLD."securityId",OLD."strategyId") IS DISTINCT FROM ROW(NEW."securityId",NEW."strategyId")) EXECUTE FUNCTION invalidate_external_signal_entry_authority('SUBSCRIPTION_IDENTITY_CHANGED');
CREATE TRIGGER "ExternalSignalEntryAuthority_security_invalidate" AFTER UPDATE ON "Security" FOR EACH ROW WHEN (OLD.symbol IS DISTINCT FROM NEW.symbol) EXECUTE FUNCTION invalidate_external_signal_entry_authority('SECURITY_IDENTITY_CHANGED');
CREATE TRIGGER "ExternalSignalEntryAuthority_source_invalidate" AFTER UPDATE ON "ExternalSignalSource" FOR EACH ROW WHEN (ROW(OLD.provider,OLD.enabled) IS DISTINCT FROM ROW(NEW.provider,NEW.enabled)) EXECUTE FUNCTION invalidate_external_signal_entry_authority('SOURCE_IDENTITY_CHANGED');
CREATE TRIGGER "ExternalSignalEntryAuthority_binding_invalidate" AFTER UPDATE ON "StrategySignalBinding" FOR EACH ROW WHEN (ROW(OLD."signalSourceId",OLD."strategyId",OLD.enabled) IS DISTINCT FROM ROW(NEW."signalSourceId",NEW."strategyId",NEW.enabled)) EXECUTE FUNCTION invalidate_external_signal_entry_authority('BINDING_IDENTITY_CHANGED');
CREATE TRIGGER "ExternalSignalEntryAuthority_revision_invalidate" AFTER UPDATE ON "StrategySignalRevision" FOR EACH ROW WHEN (ROW(OLD.status,OLD."authorityMode") IS DISTINCT FROM ROW(NEW.status,NEW."authorityMode")) EXECUTE FUNCTION invalidate_external_signal_entry_authority('REVISION_SUPERSEDED');

CREATE OR REPLACE FUNCTION "protect_external_signal_account_cycle"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'External signal account cycles are append-preserving' USING ERRCODE='23514'; END IF;
  IF ROW(OLD."externalSignalTradeCycleId",OLD."entrySignalRouteId",OLD."tradingAccountId",OLD."tradingAccountSubscriptionId",OLD."subscriptionId",OLD."securityId",OLD."createdAt") IS DISTINCT FROM ROW(NEW."externalSignalTradeCycleId",NEW."entrySignalRouteId",NEW."tradingAccountId",NEW."tradingAccountSubscriptionId",NEW."subscriptionId",NEW."securityId",NEW."createdAt") THEN RAISE EXCEPTION 'External signal account cycle identity is immutable' USING ERRCODE='23514'; END IF;
  IF OLD."entryRolloutGenerationId" IS NOT NULL AND NEW."entryRolloutGenerationId" IS DISTINCT FROM OLD."entryRolloutGenerationId" THEN RAISE EXCEPTION 'External signal account cycle rollout link is write-once' USING ERRCODE='23514'; END IF;
  IF OLD."entryReservationKey" IS NOT NULL AND ROW(NEW."entryReservationKey",NEW."entryReservationCreatedAt") IS DISTINCT FROM ROW(OLD."entryReservationKey",OLD."entryReservationCreatedAt") THEN RAISE EXCEPTION 'External signal entry reservation is write-once' USING ERRCODE='23514'; END IF;
  IF OLD.status IN ('TERMINAL_NO_EXPOSURE','TERMINAL_CLOSED') THEN RAISE EXCEPTION 'External signal terminal account cycle state is immutable and absorbing' USING ERRCODE='23514'; END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='ENTRY_ROUTE_PENDING' AND NEW.status IN ('ENTRY_ADMISSION_PENDING','ENTRY_INTENT_CREATED','ENTRY_SUPPRESSED_BY_EXIT','EXIT_PENDING','BLOCKED','TERMINAL_NO_EXPOSURE')) OR
    (OLD.status='ENTRY_ADMISSION_PENDING' AND NEW.status IN ('ENTRY_SHADOW_ALLOWED','ENTRY_INTENT_CREATED','ENTRY_SUPPRESSED_BY_EXIT','EXIT_PENDING','BLOCKED','TERMINAL_NO_EXPOSURE')) OR
    (OLD.status='ENTRY_SHADOW_ALLOWED' AND NEW.status IN ('EXIT_PENDING','BLOCKED','TERMINAL_NO_EXPOSURE')) OR
    (OLD.status='ENTRY_INTENT_CREATED' AND NEW.status IN ('EXIT_PENDING','BLOCKED','TERMINAL_NO_EXPOSURE','TERMINAL_CLOSED')) OR
    (OLD.status='ENTRY_SUPPRESSED_BY_EXIT' AND NEW.status='TERMINAL_NO_EXPOSURE') OR
    (OLD.status='EXIT_PENDING' AND NEW.status IN ('ENTRY_SUPPRESSED_BY_EXIT','BLOCKED','TERMINAL_NO_EXPOSURE','TERMINAL_CLOSED')) OR
    (OLD.status='BLOCKED' AND NEW.status IN ('EXIT_PENDING','TERMINAL_NO_EXPOSURE','TERMINAL_CLOSED'))
  ) THEN RAISE EXCEPTION 'External signal account cycle state transition is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION external_signal_entry_obligation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x RECORD; state_row "ExternalSignalExecutionRolloutState"%ROWTYPE; obligation_payload text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'external signal execution obligations are immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint);
  UPDATE "ExternalSignalExecutionRolloutState" SET version=version WHERE id=1 RETURNING * INTO state_row;
  IF state_row."activeRolloutGenerationId" IS DISTINCT FROM NEW."rolloutGenerationId" OR state_row."activatedAt" IS NULL THEN RAISE EXCEPTION 'execution rollout is not currently active'; END IF;
  SELECT oi.id AS order_intent_id,oi."externalSignalAccountCycleId",oi.source AS intent_source,oi.side,oi.status AS intent_status,oi.symbol AS intent_symbol,oi."clientOrderId",oi."tradingAccountId",oi."tradingAccountSubscriptionId",oi."subscriptionId",
    ac.id AS ac_id,ac."externalSignalTradeCycleId",ac."entrySignalRouteId",ac."tradingAccountId" AS ac_account,ac."tradingAccountSubscriptionId" AS ac_assignment,ac."subscriptionId" AS ac_subscription,ac."securityId" AS ac_security,ac.status AS ac_status,ac."terminalAt",ac."noExposureProof",ac."createdAt" AS account_cycle_created_at,
    c.status AS cycle_status,c."strategySignalBindingId" AS cycle_binding,c."strategySignalRevisionId" AS cycle_revision_id,c."strategyRevision" AS cycle_revision,c."securityId" AS cycle_security,
    sig."signalSourceId" AS signal_source,sig."strategySignalBindingId" AS signal_binding,sig."strategySignalRevisionId" AS signal_revision_id,sig."strategyRevision" AS signal_revision,sig."securityId" AS signal_security,sig.event AS signal_event,sig.symbol AS signal_symbol,sig."externalSignalTradeCycleId" AS signal_cycle,sig."createdAt" AS signal_created_at,
    sr."signalRoutingRunId",sr."tradingAccountId" AS route_account,sr."tradingAccountSubscriptionId" AS route_assignment,sr."subscriptionId" AS route_subscription,rr."signalId" AS route_signal,
    auth.status AS auth_status,auth."authorizationFingerprint",auth."authorizedAt",auth."rolloutGenerationId" AS auth_rollout,auth."tradingAccountId" AS auth_account,auth."tradingAccountSubscriptionId" AS auth_assignment,auth."subscriptionId" AS auth_subscription,auth."securityId" AS auth_security,auth."signalSourceId" AS auth_source,auth."strategySignalBindingId" AS auth_binding,auth."strategySignalRevisionId" AS auth_revision_id,auth."strategyRevision" AS auth_revision,
    ta.environment,sub."securityId" AS subscription_security,tas."routingSecurityId",sec.symbol AS security_symbol,src.provider,src.enabled AS source_enabled,b.enabled AS binding_enabled,b."signalSourceId" AS binding_source,b."strategyId" AS binding_strategy,sub."strategyId" AS subscription_strategy,rev.status AS revision_status,rev."authorityMode" AS revision_authority,
    gen.direction AS rollout_direction,gen."authorityMode" AS rollout_authority,gen.enabled AS rollout_enabled
  INTO x FROM "OrderIntent" oi
    JOIN "ExternalSignalTradeCycleAccount" ac ON ac.id=NEW."accountCycleId"
    JOIN "ExternalSignalTradeCycle" c ON c.id=NEW."sourceCycleId"
    JOIN "Signal" sig ON sig.id=NEW."entrySignalId"
    JOIN "SignalRoute" sr ON sr.id=NEW."entrySignalRouteId"
    JOIN "SignalRoutingRun" rr ON rr.id=sr."signalRoutingRunId"
    JOIN "ExternalSignalEntryExecutionAuthorization" auth ON auth.id=NEW."authorizationId"
    JOIN "ExternalSignalExecutionRolloutGeneration" gen ON gen.id=NEW."rolloutGenerationId"
    JOIN "TradingAccount" ta ON ta.id=ac."tradingAccountId"
    JOIN "TradingAccountSubscription" tas ON tas.id=ac."tradingAccountSubscriptionId"
    JOIN "Subscription" sub ON sub.id=ac."subscriptionId"
    JOIN "Security" sec ON sec.id=ac."securityId"
    JOIN "ExternalSignalSource" src ON src.id=auth."signalSourceId"
    JOIN "StrategySignalBinding" b ON b.id=auth."strategySignalBindingId"
    JOIN "StrategySignalRevision" rev ON rev.id=auth."strategySignalRevisionId"
  WHERE oi.id=NEW."orderIntentId" FOR UPDATE OF oi,ac,c,sig,sr,rr,auth,gen,ta,tas,sub,sec,src,b,rev;
  IF x.order_intent_id IS NULL OR x."externalSignalAccountCycleId" IS DISTINCT FROM NEW."accountCycleId" OR NEW."accountCycleId" IS DISTINCT FROM x.ac_id THEN RAISE EXCEPTION 'marked OrderIntent identity mismatch'; END IF;
  IF x.intent_source IS DISTINCT FROM 'tradingview' OR lower(x.side) IS DISTINCT FROM 'buy' OR x.intent_status IS DISTINCT FROM 'received' OR x."clientOrderId" IS NULL OR x."clientOrderId" IS DISTINCT FROM NEW."clientOrderId" THEN RAISE EXCEPTION 'OrderIntent initial execution identity is invalid'; END IF;
  IF upper(btrim(x.intent_symbol)) IS DISTINCT FROM upper(btrim(x.security_symbol)) OR upper(btrim(x.signal_symbol)) IS DISTINCT FROM upper(btrim(x.security_symbol)) THEN RAISE EXCEPTION 'canonical OrderIntent symbol mismatch'; END IF;
  IF x.cycle_status NOT IN ('ENTRY_RECEIVED','ROUTED') OR x.ac_status IS DISTINCT FROM 'ENTRY_INTENT_CREATED' OR x."terminalAt" IS NOT NULL OR x."noExposureProof" IS NOT NULL THEN RAISE EXCEPTION 'execution cycle lifecycle is not admissible'; END IF;
  IF EXISTS (SELECT 1 FROM "Signal" exit_signal WHERE exit_signal."externalSignalTradeCycleId"=NEW."sourceCycleId" AND exit_signal.event='EXIT_LONG') THEN RAISE EXCEPTION 'accepted EXIT preempts entry execution'; END IF;
  IF ROW(x."externalSignalTradeCycleId",x.signal_cycle,x."entrySignalRouteId",x.route_signal) IS DISTINCT FROM ROW(NEW."sourceCycleId",NEW."sourceCycleId",NEW."entrySignalRouteId",NEW."entrySignalId") OR x.signal_event IS DISTINCT FROM 'ENTRY_LONG' THEN RAISE EXCEPTION 'Signal and route identity mismatch'; END IF;
  IF ROW(x."tradingAccountId",x."tradingAccountSubscriptionId",x."subscriptionId",x.ac_security) IS DISTINCT FROM ROW(x.ac_account,x.ac_assignment,x.ac_subscription,x.cycle_security) OR ROW(x.route_account,x.route_assignment,x.route_subscription) IS DISTINCT FROM ROW(x.ac_account,x.ac_assignment,x.ac_subscription) OR ROW(x.auth_account,x.auth_assignment,x.auth_subscription,x.auth_security) IS DISTINCT FROM ROW(x.ac_account,x.ac_assignment,x.ac_subscription,x.ac_security) OR ROW(x.subscription_security,x."routingSecurityId") IS DISTINCT FROM ROW(x.ac_security,x.ac_security) THEN RAISE EXCEPTION 'account assignment Subscription or Security mismatch'; END IF;
  IF ROW(x.signal_source,x.signal_binding,x.signal_revision_id,x.signal_revision) IS DISTINCT FROM ROW(x.auth_source,x.auth_binding,x.auth_revision_id,x.auth_revision) OR ROW(x.cycle_binding,x.cycle_revision_id,x.cycle_revision) IS DISTINCT FROM ROW(x.auth_binding,x.auth_revision_id,x.auth_revision) OR x.binding_source IS DISTINCT FROM x.auth_source OR x.binding_strategy IS DISTINCT FROM x.subscription_strategy OR x.provider IS DISTINCT FROM 'TRADINGVIEW' OR x.source_enabled IS DISTINCT FROM true OR x.binding_enabled IS DISTINCT FROM true OR x.revision_status IS DISTINCT FROM 'ACTIVE' OR x.revision_authority IS DISTINCT FROM 'TRADE_ELIGIBLE' THEN RAISE EXCEPTION 'source binding or revision identity mismatch'; END IF;
  IF x.environment IS DISTINCT FROM 'PAPER' OR x.auth_status IS DISTINCT FROM 'AUTHORIZED' OR x.auth_rollout IS DISTINCT FROM NEW."rolloutGenerationId" OR x.rollout_direction IS DISTINCT FROM 'ENTRY' OR x.rollout_authority IS DISTINCT FROM 'EXECUTE' OR x.rollout_enabled IS DISTINCT FROM true THEN RAISE EXCEPTION 'execution authorization or rollout identity mismatch'; END IF;
  IF x.signal_created_at<state_row."activatedAt" OR x.signal_created_at<x."authorizedAt" OR x.account_cycle_created_at<state_row."activatedAt" OR x.account_cycle_created_at<x."authorizedAt" THEN RAISE EXCEPTION 'entry evidence predates execution epoch or authorization'; END IF;
  NEW."executionEpochAt":=state_row."activatedAt"; NEW."authorizationFingerprint":=x."authorizationFingerprint"; NEW."createdAt":=statement_timestamp(); NEW."clientOrderId":=x."clientOrderId";
  obligation_payload:=(jsonb_build_object('accountCycleId',NEW."accountCycleId",'authorizationFingerprint',NEW."authorizationFingerprint",'authorizationId',NEW."authorizationId",'clientOrderId',NEW."clientOrderId",'entrySignalId',NEW."entrySignalId",'entrySignalRouteId',NEW."entrySignalRouteId",'executionEpochMicros',floor(extract(epoch FROM NEW."executionEpochAt")*1000000)::numeric,'orderIntentId',NEW."orderIntentId",'rolloutGenerationId',NEW."rolloutGenerationId",'sourceCycleId',NEW."sourceCycleId"))::text;
  NEW."obligationFingerprint":=encode(digest(convert_to(obligation_payload,'UTF8'),'sha256'),'hex'); RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalEntryExecutionObligation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ExternalSignalEntryExecutionObligation" FOR EACH ROW EXECUTE FUNCTION external_signal_entry_obligation_guard();

CREATE FUNCTION external_signal_order_intent_obligation_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."externalSignalAccountCycleId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ExternalSignalEntryExecutionObligation" o WHERE o."orderIntentId"=NEW.id AND o."accountCycleId"=NEW."externalSignalAccountCycleId") THEN RAISE EXCEPTION 'TradingView-originated OrderIntent requires exact execution obligation'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "OrderIntent_external_signal_obligation_required" AFTER INSERT OR UPDATE OF "externalSignalAccountCycleId" ON "OrderIntent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION external_signal_order_intent_obligation_required();

CREATE FUNCTION external_signal_order_intent_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."externalSignalAccountCycleId" IS DISTINCT FROM OLD."externalSignalAccountCycleId" THEN RAISE EXCEPTION 'OrderIntent external signal origin marker is insert-only and immutable'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER "OrderIntent_external_signal_origin_immutable" BEFORE UPDATE OF "externalSignalAccountCycleId" ON "OrderIntent" FOR EACH ROW EXECUTE FUNCTION external_signal_order_intent_origin_immutable();

CREATE FUNCTION external_signal_order_intent_dispatch_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW."externalSignalAccountCycleId" IS NOT NULL AND NEW.status IS DISTINCT FROM 'received' THEN RAISE EXCEPTION 'marked external signal OrderIntent must be created in received status'; END IF;
  IF TG_OP='UPDATE' AND OLD."externalSignalAccountCycleId" IS NOT NULL AND NEW.status='submitting' AND OLD.status IS DISTINCT FROM 'submitting' THEN RAISE EXCEPTION 'marked external signal OrderIntent dispatch is quarantined'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OrderIntent_external_signal_dispatch_quarantine" BEFORE INSERT OR UPDATE OF status ON "OrderIntent" FOR EACH ROW EXECUTE FUNCTION external_signal_order_intent_dispatch_quarantine();

CREATE FUNCTION external_signal_execution_activation_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action='DEACTIVATE' THEN UPDATE "ExternalSignalEntryExecutionAuthorization" SET status='INVALIDATED',"invalidationReasonCode"='ROLLOUT_DEACTIVATED' WHERE status='AUTHORIZED' AND "rolloutGenerationId"=NEW."rolloutGenerationId"; END IF; RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalExecutionRolloutActivation_invalidate" AFTER INSERT ON "ExternalSignalExecutionRolloutActivation" FOR EACH ROW EXECUTE FUNCTION external_signal_execution_activation_invalidate();
