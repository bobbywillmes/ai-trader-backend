-- Phase 4A.2A establishes PAPER-only authority and provenance. It does not admit or dispatch orders.
CREATE TYPE "ExternalSignalExecutionRolloutAction" AS ENUM ('ACTIVATE', 'DEACTIVATE');
CREATE TYPE "ExternalSignalEntryExecutionAuthorizationStatus" AS ENUM ('AUTHORIZED', 'REVOKED', 'INVALIDATED');

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
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalSignalEntryExecutionObligation_fingerprint_check" CHECK ("authorizationFingerprint" ~ '^[0-9a-f]{64}$' AND "obligationFingerprint" ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION external_signal_execution_rollout_activation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE generation_row "ExternalSignalExecutionRolloutGeneration"%ROWTYPE; latest RECORD; actor_ok boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'external signal rollout activation history is immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint);
  SELECT enabled AND "platformRole"='SYSTEM_OWNER' INTO actor_ok FROM "User" WHERE id=NEW."actorUserId" FOR UPDATE;
  IF actor_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'SYSTEM_OWNER required'; END IF;
  IF btrim(NEW.reason)='' THEN RAISE EXCEPTION 'activation reason required'; END IF;
  SELECT * INTO generation_row FROM "ExternalSignalExecutionRolloutGeneration" WHERE id=NEW."rolloutGenerationId" FOR UPDATE;
  IF generation_row."authorityMode" <> 'EXECUTE' OR generation_row.direction <> 'ENTRY' OR NOT generation_row.enabled OR generation_row."effectiveAt" > statement_timestamp() THEN
    RAISE EXCEPTION 'only an effective enabled ENTRY EXECUTE generation may be activated';
  END IF;
  SELECT a.action,a."rolloutGenerationId" INTO latest FROM "ExternalSignalExecutionRolloutActivation" a ORDER BY a.id DESC LIMIT 1;
  IF NEW.action='ACTIVATE' THEN
    IF latest.action='ACTIVATE' THEN RAISE EXCEPTION 'an execution generation is already active'; END IF;
    IF EXISTS (SELECT 1 FROM "ExternalSignalExecutionRolloutGeneration" g WHERE g.direction='ENTRY' AND g."authorityMode"='EXECUTE' AND g.generation>generation_row.generation) THEN RAISE EXCEPTION 'only latest executable generation may activate'; END IF;
  ELSIF latest.action IS DISTINCT FROM 'ACTIVATE' OR latest."rolloutGenerationId"<>NEW."rolloutGenerationId" THEN
    RAISE EXCEPTION 'only the active execution generation may deactivate';
  END IF;
  NEW."createdAt" := statement_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalExecutionRolloutActivation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ExternalSignalExecutionRolloutActivation" FOR EACH ROW EXECUTE FUNCTION external_signal_execution_rollout_activation_guard();

CREATE FUNCTION external_signal_entry_authorization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a RECORD; latest RECORD; assignment_fp text; source_fp text; expected_fp text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'external signal entry authorization is append-preserving'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.status<>'AUTHORIZED' OR NEW.status NOT IN ('REVOKED','INVALIDATED') THEN RAISE EXCEPTION 'invalid authorization transition'; END IF;
    IF ROW(NEW."rolloutGenerationId",NEW."authorizationSequence",NEW."tradingAccountId",NEW."tradingAccountSubscriptionId",NEW."subscriptionId",NEW."securityId",NEW."signalSourceId",NEW."strategySignalBindingId",NEW."strategySignalRevisionId",NEW."strategyRevision",NEW."accountHolderUserId",NEW."assignmentFingerprint",NEW."sourceFingerprint",NEW."authorizationFingerprint",NEW."authorizedByUserId",NEW."authorizedAt",NEW."grantReason",NEW."createdAt") IS DISTINCT FROM ROW(OLD."rolloutGenerationId",OLD."authorizationSequence",OLD."tradingAccountId",OLD."tradingAccountSubscriptionId",OLD."subscriptionId",OLD."securityId",OLD."signalSourceId",OLD."strategySignalBindingId",OLD."strategySignalRevisionId",OLD."strategyRevision",OLD."accountHolderUserId",OLD."assignmentFingerprint",OLD."sourceFingerprint",OLD."authorizationFingerprint",OLD."authorizedByUserId",OLD."authorizedAt",OLD."grantReason",OLD."createdAt") THEN RAISE EXCEPTION 'authorization identity is immutable'; END IF;
    IF NEW.status='REVOKED' THEN NEW."revokedAt":=statement_timestamp(); ELSE NEW."invalidatedAt":=statement_timestamp(); END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint);
  SELECT ta.environment,ta."accountHolderUserId",tas."tradingAccountId",tas."subscriptionId",tas."routingSecurityId",tas."routingStrategyId",s."securityId",s."strategyId",src.provider,src.enabled AS source_enabled,b."signalSourceId",b."strategyId" AS binding_strategy,b.enabled AS binding_enabled,r.status AS revision_status,r."authorityMode",u.enabled AND u."platformRole"='SYSTEM_OWNER' AS owner_ok
    INTO a FROM "TradingAccountSubscription" tas JOIN "TradingAccount" ta ON ta.id=tas."tradingAccountId" JOIN "Subscription" s ON s.id=tas."subscriptionId" JOIN "ExternalSignalSource" src ON src.id=NEW."signalSourceId" JOIN "StrategySignalBinding" b ON b.id=NEW."strategySignalBindingId" JOIN "StrategySignalRevision" r ON r.id=NEW."strategySignalRevisionId" JOIN "User" u ON u.id=NEW."authorizedByUserId" WHERE tas.id=NEW."tradingAccountSubscriptionId" FOR UPDATE OF tas,ta,s,src,b,r,u;
  IF a.environment<>'PAPER' THEN RAISE EXCEPTION 'TradingView execution authorization is PAPER-only'; END IF;
  IF a.owner_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'SYSTEM_OWNER required'; END IF;
  IF ROW(NEW."tradingAccountId",NEW."subscriptionId",NEW."securityId",NEW."accountHolderUserId") IS DISTINCT FROM ROW(a."tradingAccountId",a."subscriptionId",a."securityId",a."accountHolderUserId") OR a."routingSecurityId"<>a."securityId" OR a."routingStrategyId"<>a."strategyId" THEN RAISE EXCEPTION 'exact assignment identity mismatch'; END IF;
  IF a.provider<>'TRADINGVIEW' OR NOT a.source_enabled OR a."signalSourceId"<>NEW."signalSourceId" OR a.binding_strategy<>a."strategyId" OR NOT a.binding_enabled OR a.revision_status<>'ACTIVE' OR a."authorityMode"<>'TRADE_ELIGIBLE' OR NEW."strategyRevision"<>(SELECT revision FROM "StrategySignalRevision" WHERE id=NEW."strategySignalRevisionId") THEN RAISE EXCEPTION 'exact source binding revision is not executable'; END IF;
  SELECT action,"rolloutGenerationId" INTO latest FROM "ExternalSignalExecutionRolloutActivation" ORDER BY id DESC LIMIT 1;
  IF latest.action IS DISTINCT FROM 'ACTIVATE' OR latest."rolloutGenerationId"<>NEW."rolloutGenerationId" THEN RAISE EXCEPTION 'execution rollout is not active'; END IF;
  assignment_fp:=md5(concat_ws(':',NEW."tradingAccountId",NEW."tradingAccountSubscriptionId",NEW."subscriptionId",NEW."securityId",NEW."accountHolderUserId",a."strategyId"))||md5(concat_ws(':',NEW."tradingAccountId",NEW."tradingAccountSubscriptionId",NEW."subscriptionId",NEW."securityId",NEW."accountHolderUserId",a."strategyId",'2'));
  source_fp:=md5(concat_ws(':',NEW."signalSourceId",NEW."strategySignalBindingId",NEW."strategySignalRevisionId",NEW."strategyRevision",a.provider))||md5(concat_ws(':',NEW."signalSourceId",NEW."strategySignalBindingId",NEW."strategySignalRevisionId",NEW."strategyRevision",a.provider,'2'));
  NEW."authorizedAt":=statement_timestamp(); NEW."createdAt":=statement_timestamp(); NEW."assignmentFingerprint":=assignment_fp; NEW."sourceFingerprint":=source_fp;
  NEW."authorizationFingerprint":=md5(concat_ws(':',NEW."rolloutGenerationId",NEW."authorizationSequence",assignment_fp,source_fp,NEW."authorizedAt"))||md5(concat_ws(':',NEW."rolloutGenerationId",NEW."authorizationSequence",assignment_fp,source_fp,NEW."authorizedAt",'2'));
  RETURN NEW;
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

CREATE FUNCTION external_signal_entry_obligation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x RECORD; activation_at timestamptz;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'external signal execution obligations are immutable'; END IF;
  SELECT oi."externalSignalAccountCycleId",oi.side,oi."tradingAccountId",oi."tradingAccountSubscriptionId",oi."subscriptionId",ac."externalSignalTradeCycleId",ac."entrySignalRouteId",ac."tradingAccountId" AS ac_account,ac."tradingAccountSubscriptionId" AS ac_assignment,ac."subscriptionId" AS ac_subscription,ac."createdAt" AS account_cycle_created_at,auth.status,auth."authorizationFingerprint",auth."authorizedAt",auth."rolloutGenerationId",auth."tradingAccountId" AS auth_account,auth."tradingAccountSubscriptionId" AS auth_assignment,auth."subscriptionId" AS auth_subscription INTO x
  FROM "OrderIntent" oi JOIN "ExternalSignalTradeCycleAccount" ac ON ac.id=NEW."accountCycleId" JOIN "ExternalSignalEntryExecutionAuthorization" auth ON auth.id=NEW."authorizationId" WHERE oi.id=NEW."orderIntentId";
  SELECT "createdAt" INTO activation_at FROM "ExternalSignalExecutionRolloutActivation" WHERE "rolloutGenerationId"=NEW."rolloutGenerationId" AND action='ACTIVATE' ORDER BY id DESC LIMIT 1;
  IF x."externalSignalAccountCycleId"<>NEW."accountCycleId" OR lower(x.side)<>'buy' OR ROW(x."tradingAccountId",x."tradingAccountSubscriptionId",x."subscriptionId") IS DISTINCT FROM ROW(x.ac_account,x.ac_assignment,x.ac_subscription) OR ROW(x.auth_account,x.auth_assignment,x.auth_subscription) IS DISTINCT FROM ROW(x.ac_account,x.ac_assignment,x.ac_subscription) OR x."externalSignalTradeCycleId"<>NEW."sourceCycleId" OR x."entrySignalRouteId"<>NEW."entrySignalRouteId" OR x.status<>'AUTHORIZED' OR x."rolloutGenerationId"<>NEW."rolloutGenerationId" OR activation_at IS NULL THEN RAISE EXCEPTION 'execution obligation identity or authority mismatch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "Signal" s WHERE s.id=NEW."entrySignalId" AND s.event='ENTRY_LONG' AND s."externalSignalTradeCycleId"=NEW."sourceCycleId" AND s."createdAt">=activation_at AND s."createdAt">=x."authorizedAt") OR x.account_cycle_created_at<activation_at OR x.account_cycle_created_at<x."authorizedAt" THEN RAISE EXCEPTION 'entry signal predates execution epoch or authorization'; END IF;
  NEW."executionEpochAt":=activation_at; NEW."authorizationFingerprint":=x."authorizationFingerprint"; NEW."createdAt":=statement_timestamp();
  NEW."obligationFingerprint":=md5(concat_ws(':',NEW."orderIntentId",NEW."accountCycleId",NEW."sourceCycleId",NEW."entrySignalId",NEW."entrySignalRouteId",NEW."authorizationId",NEW."rolloutGenerationId",activation_at,x."authorizationFingerprint"))||md5(concat_ws(':',NEW."orderIntentId",NEW."accountCycleId",NEW."sourceCycleId",NEW."entrySignalId",NEW."entrySignalRouteId",NEW."authorizationId",NEW."rolloutGenerationId",activation_at,x."authorizationFingerprint",'2')); RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalEntryExecutionObligation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ExternalSignalEntryExecutionObligation" FOR EACH ROW EXECUTE FUNCTION external_signal_entry_obligation_guard();

CREATE FUNCTION external_signal_order_intent_obligation_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."externalSignalAccountCycleId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ExternalSignalEntryExecutionObligation" o WHERE o."orderIntentId"=NEW.id AND o."accountCycleId"=NEW."externalSignalAccountCycleId") THEN RAISE EXCEPTION 'TradingView-originated OrderIntent requires exact execution obligation'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "OrderIntent_external_signal_obligation_required" AFTER INSERT OR UPDATE OF "externalSignalAccountCycleId" ON "OrderIntent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION external_signal_order_intent_obligation_required();

CREATE FUNCTION external_signal_execution_activation_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action='DEACTIVATE' THEN UPDATE "ExternalSignalEntryExecutionAuthorization" SET status='INVALIDATED',"invalidationReasonCode"='ROLLOUT_DEACTIVATED' WHERE status='AUTHORIZED' AND "rolloutGenerationId"=NEW."rolloutGenerationId"; END IF; RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalExecutionRolloutActivation_invalidate" AFTER INSERT ON "ExternalSignalExecutionRolloutActivation" FOR EACH ROW EXECUTE FUNCTION external_signal_execution_activation_invalidate();
