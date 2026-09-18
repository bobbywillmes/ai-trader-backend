-- Atomic migration: conflicting enabled assignments fail without altering configuration.
BEGIN;
LOCK TABLE "TradingAccountSubscription", "Subscription" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "TradingAccountSubscription" a JOIN "Subscription" s ON s.id = a."subscriptionId"
    WHERE a.enabled GROUP BY a."tradingAccountId", s."strategyId", s."securityId" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Conflicting enabled TradingAccountSubscriptions for Account + Strategy + Security. Disable conflicting assignments deliberately before migrating; no configuration has been reassigned.';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "SignalAuthorityMode" AS ENUM ('EVIDENCE_ONLY', 'EVALUATION_ONLY', 'TRADE_ELIGIBLE');

-- CreateEnum
CREATE TYPE "SignalRoutingStatus" AS ENUM ('STOPPED', 'COMPLETED');

-- DropForeignKey
ALTER TABLE "TradingAccountSubscription" DROP CONSTRAINT "TradingAccountSubscription_subscriptionId_fkey";

-- AlterTable
ALTER TABLE "StrategySignalRevision" ADD COLUMN     "authorityMode" "SignalAuthorityMode" NOT NULL DEFAULT 'EVIDENCE_ONLY';

-- AlterTable
ALTER TABLE "TradingAccountSubscription" ADD COLUMN     "routingSecurityId" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "routingStrategyId" INTEGER NOT NULL DEFAULT 0;

UPDATE "TradingAccountSubscription" a SET "routingStrategyId" = s."strategyId", "routingSecurityId" = s."securityId"
FROM "Subscription" s WHERE s.id = a."subscriptionId";

-- Mirrors are always derived, including direct SQL writes and FK cascade updates.
CREATE FUNCTION derive_account_subscription_routing_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT "strategyId", "securityId" INTO STRICT NEW."routingStrategyId", NEW."routingSecurityId"
  FROM "Subscription" WHERE id = NEW."subscriptionId" FOR KEY SHARE;
  RETURN NEW;
END $$;
CREATE TRIGGER account_subscription_routing_identity BEFORE INSERT OR UPDATE ON "TradingAccountSubscription"
FOR EACH ROW EXECUTE FUNCTION derive_account_subscription_routing_identity();
CREATE UNIQUE INDEX "TradingAccountSubscription_one_enabled_strategy_security"
ON "TradingAccountSubscription" ("tradingAccountId", "routingStrategyId", "routingSecurityId") WHERE enabled;

-- CreateTable
CREATE TABLE "SignalRoutingRun" (
    "id" SERIAL NOT NULL,
    "signalId" INTEGER NOT NULL,
    "authorityMode" "SignalAuthorityMode" NOT NULL,
    "status" "SignalRoutingStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "routeCount" INTEGER NOT NULL,
    "stopReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignalRoutingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalRoute" (
    "id" SERIAL NOT NULL,
    "signalRoutingRunId" INTEGER NOT NULL,
    "tradingAccountId" INTEGER NOT NULL,
    "tradingAccountSubscriptionId" INTEGER NOT NULL,
    "subscriptionId" INTEGER NOT NULL,
    "targetSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignalRoute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SignalRoutingRun_signalId_key" ON "SignalRoutingRun"("signalId");

-- CreateIndex
CREATE INDEX "SignalRoute_tradingAccountSubscriptionId_idx" ON "SignalRoute"("tradingAccountSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "SignalRoute_signalRoutingRunId_tradingAccountId_key" ON "SignalRoute"("signalRoutingRunId", "tradingAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_id_strategyId_securityId_key" ON "Subscription"("id", "strategyId", "securityId");

-- AddForeignKey
ALTER TABLE "SignalRoutingRun" ADD CONSTRAINT "SignalRoutingRun_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SignalRoute" ADD CONSTRAINT "SignalRoute_signalRoutingRunId_fkey" FOREIGN KEY ("signalRoutingRunId") REFERENCES "SignalRoutingRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SignalRoute" ADD CONSTRAINT "SignalRoute_tradingAccountSubscriptionId_fkey" FOREIGN KEY ("tradingAccountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TradingAccountSubscription" ADD CONSTRAINT "TradingAccountSubscription_subscriptionId_routingStrategyI_fkey" FOREIGN KEY ("subscriptionId", "routingStrategyId", "routingSecurityId") REFERENCES "Subscription"("id", "strategyId", "securityId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION guard_revision_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."authorityMode" IS DISTINCT FROM OLD."authorityMode" AND
    (OLD.status <> 'PREPARED' OR NEW.status <> 'PREPARED') THEN
    RAISE EXCEPTION 'Authority may only change while a revision remains PREPARED';
  END IF;
  -- Prevent reopening a frozen revision to change its historical authority.
  IF (OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED') OR
     (OLD.status = 'ACTIVE' AND NEW.status = 'PREPARED') THEN
    RAISE EXCEPTION 'Frozen revisions cannot be reopened';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revision_authority_guard BEFORE UPDATE ON "StrategySignalRevision"
FOR EACH ROW EXECUTE FUNCTION guard_revision_authority();

ALTER TABLE "SignalRoutingRun" ADD CONSTRAINT "SignalRoutingRun_terminal_check" CHECK (
  "completedAt" >= "startedAt" AND "routeCount" >= 0 AND (
    ("authorityMode" = 'EVIDENCE_ONLY' AND status = 'STOPPED' AND "routeCount" = 0 AND "stopReason" IS NOT NULL) OR
    ("authorityMode" <> 'EVIDENCE_ONLY' AND status = 'COMPLETED' AND "stopReason" IS NULL)
  )
);
CREATE FUNCTION reject_routing_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Signal routing evidence is immutable'; END $$;
CREATE TRIGGER immutable_routing_run BEFORE UPDATE OR DELETE ON "SignalRoutingRun"
FOR EACH ROW EXECUTE FUNCTION reject_routing_evidence_mutation();
CREATE TRIGGER immutable_signal_route BEFORE UPDATE OR DELETE ON "SignalRoute"
FOR EACH ROW EXECUTE FUNCTION reject_routing_evidence_mutation();

-- Deferred checks permit atomic nested inserts but prohibit partial or later fan-out.
CREATE FUNCTION check_routing_evidence_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_id integer; expected integer; actual integer;
BEGIN
  IF TG_TABLE_NAME = 'SignalRoutingRun' THEN run_id := NEW.id;
  ELSE run_id := NEW."signalRoutingRunId"; END IF;
  SELECT "routeCount" INTO expected FROM "SignalRoutingRun" WHERE id = run_id;
  SELECT count(*) INTO actual FROM "SignalRoute" WHERE "signalRoutingRunId" = run_id;
  IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'Routing evidence count mismatch'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER routing_run_count AFTER INSERT ON "SignalRoutingRun"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_routing_evidence_count();
CREATE CONSTRAINT TRIGGER signal_route_count AFTER INSERT ON "SignalRoute"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_routing_evidence_count();
COMMIT;
