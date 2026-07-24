DO $$
DECLARE
  invalid_operational_state_count BIGINT;
  invalid_active_state_count BIGINT;
  invalid_non_active_state_count BIGINT;
BEGIN
  SELECT
    COUNT(*) FILTER (
      WHERE "status" = 'ACTIVE'::"TradingAccountStatus"
        AND NOT ("tradingEnabled" = true AND "killSwitchEnabled" = false)
    ),
    COUNT(*) FILTER (
      WHERE "status" <> 'ACTIVE'::"TradingAccountStatus"
        AND NOT ("tradingEnabled" = false AND "killSwitchEnabled" = true)
  )
  INTO invalid_active_state_count, invalid_non_active_state_count
  FROM "TradingAccount";

  invalid_operational_state_count :=
    invalid_active_state_count + invalid_non_active_state_count;

  IF invalid_operational_state_count > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce TradingAccount operational-state invariant: % invalid row(s) found (% ACTIVE row(s), % non-ACTIVE row(s)). Expected ACTIVE/true/false or non-ACTIVE/false/true.',
      invalid_operational_state_count,
      invalid_active_state_count,
      invalid_non_active_state_count;
  END IF;
END
$$;

ALTER TABLE "SystemEvent"
ADD COLUMN "actorUserId" INTEGER;

ALTER TABLE "TradingAccount"
ADD CONSTRAINT "TradingAccount_operational_state_check"
CHECK (
  (
    "status" = 'ACTIVE'::"TradingAccountStatus"
    AND "tradingEnabled" = true
    AND "killSwitchEnabled" = false
  )
  OR
  (
    "status" <> 'ACTIVE'::"TradingAccountStatus"
    AND "tradingEnabled" = false
    AND "killSwitchEnabled" = true
  )
);

CREATE INDEX "SystemEvent_actorUserId_idx"
ON "SystemEvent"("actorUserId");

ALTER TABLE "SystemEvent"
ADD CONSTRAINT "SystemEvent_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
