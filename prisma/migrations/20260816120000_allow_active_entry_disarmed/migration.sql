ALTER TABLE "TradingAccount"
DROP CONSTRAINT "TradingAccount_operational_state_check";

ALTER TABLE "TradingAccount"
ADD CONSTRAINT "TradingAccount_operational_state_check"
CHECK (
  (
    "status" = 'ACTIVE'::"TradingAccountStatus"
    AND (
      ("tradingEnabled" = false AND "killSwitchEnabled" = true)
      OR
      ("tradingEnabled" = true AND "killSwitchEnabled" = false)
    )
  )
  OR
  (
    "status" <> 'ACTIVE'::"TradingAccountStatus"
    AND "tradingEnabled" = false
    AND "killSwitchEnabled" = true
  )
);
