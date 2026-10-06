BEGIN;
CREATE FUNCTION reject_market_evidence_mutation_with_tiingo_purge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('ai_trader.tiingo_retention_purge', true) = 'on' AND OLD."provider" = 'TIINGO' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Market evidence is immutable outside Tiingo retention purge';
END $$;
DROP TRIGGER immutable_market_bar ON "MarketBar";
CREATE TRIGGER immutable_market_bar BEFORE UPDATE OR DELETE ON "MarketBar" FOR EACH ROW EXECUTE FUNCTION reject_market_evidence_mutation_with_tiingo_purge();
DROP TRIGGER immutable_market_split_event ON "MarketSplitEvent";
CREATE TRIGGER immutable_market_split_event BEFORE UPDATE OR DELETE ON "MarketSplitEvent" FOR EACH ROW EXECUTE FUNCTION reject_market_evidence_mutation_with_tiingo_purge();
DROP TRIGGER immutable_market_split_coverage ON "MarketSplitCoverage";
CREATE TRIGGER immutable_market_split_coverage BEFORE UPDATE OR DELETE ON "MarketSplitCoverage" FOR EACH ROW EXECUTE FUNCTION reject_market_evidence_mutation_with_tiingo_purge();
COMMIT;
