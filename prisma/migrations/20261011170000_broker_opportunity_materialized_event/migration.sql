ALTER TYPE "OrderIntentBrokerOpportunityEventType" ADD VALUE 'BROKER_ORDER_MATERIALIZED' AFTER 'BROKER_REJECTED';

ALTER TABLE "OrderIntentBrokerOpportunityEvent" ADD COLUMN "orderIntentId" INTEGER;
UPDATE "OrderIntentBrokerOpportunityEvent" e SET "orderIntentId"=o."orderIntentId" FROM "OrderIntentBrokerPostOpportunity" o WHERE o.id=e."opportunityId";
ALTER TABLE "OrderIntentBrokerOpportunityEvent" ALTER COLUMN "orderIntentId" SET NOT NULL, ALTER COLUMN "opportunityId" DROP NOT NULL;
ALTER TABLE "OrderIntentBrokerOpportunityEvent" ADD CONSTRAINT "OrderIntentBrokerOpportunityEvent_orderIntentId_fkey" FOREIGN KEY("orderIntentId") REFERENCES "OrderIntent"(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "OrderIntentBrokerOpportunityEvent_intent_created_idx" ON "OrderIntentBrokerOpportunityEvent"("orderIntentId","createdAt");

CREATE FUNCTION "validate_broker_opportunity_event"() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE intent_id INTEGER; BEGIN
 IF NEW."opportunityId" IS NULL THEN
   IF NEW."eventType"<>'MISSING_OBSERVATION' THEN RAISE EXCEPTION 'Only missing-observation events may omit opportunity identity' USING ERRCODE='23514'; END IF;
 ELSE
   SELECT "orderIntentId" INTO intent_id FROM "OrderIntentBrokerPostOpportunity" WHERE id=NEW."opportunityId";
   IF intent_id IS DISTINCT FROM NEW."orderIntentId" OR NEW."eventType"='MISSING_OBSERVATION' THEN RAISE EXCEPTION 'Broker opportunity event identity is inconsistent' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW; END $$;
CREATE TRIGGER "OrderIntentBrokerOpportunityEvent_validate" BEFORE INSERT ON "OrderIntentBrokerOpportunityEvent" FOR EACH ROW EXECUTE FUNCTION "validate_broker_opportunity_event"();
