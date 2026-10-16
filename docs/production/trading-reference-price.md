# Trading reference-price operations

Tiingo consolidated is the sole runtime reference-price authority for subscription sizing and active `FIXED_QTY` TradingAccount Risk Health valuation. There is no Tiingo-to-Massive or previous-close fallback. This authority is separate from broker truth, dashboard market state, Momentum, daily market evidence, Intraday Stress, and order execution.

The architecture decision and migration boundary are recorded in [Tiingo market data migration](../architecture/tiingo-market-data-migration.md).

## Accepted policy

Runtime calls `getTradingReferencePrice`, explicitly requests `TIINGO_CONSOLIDATED`, and evaluates the result with the reviewed New York market calendar.

An actionable price requires:

- the expected symbol and provider;
- a positive Tiingo consolidated reference price;
- an accepted Tiingo basis;
- a valid observation timestamp with bounded future-clock skew;
- freshness within the phase-specific policy window;
- an eligible current market session phase, including reviewed closures and early closes.

Every rejection remains unavailable. Sizing returns HTTP 409 `latest_price_unavailable` with bounded provenance and no actionable quantity. Risk Health treats `OUTSIDE_TRADING_PRICE_SESSION` as temporary non-evaluability; genuine in-session data failures retain PAPER warning and LIVE blocker severity. Whole-share flooring, `maxQty`, minimum-notional behavior, and fixed-quantity semantics are unchanged. The later Alpaca entry-session guard remains an independent authority.

Successful sizing snapshots preserve compatibility price fields and record provider, basis, observation/fetch timestamps, signed age, session phase, and rejection reason. Provider errors must remain bounded classifications; raw upstream bodies and credentials must never be persisted or logged.

## Manual acceptance capture

Use the read-only comparison command only when an operator deliberately wants fresh acceptance evidence:

```powershell
npm.cmd run research:trading-reference-price:accept -- --phase=PREMARKET --symbols=SPY,QQQ,DIA,IWM
```

Accepted labels are `PREMARKET`, `AFTER_OPEN`, `MIDDAY`, `NEAR_CLOSE`, `POSTMARKET`, and `CLOSED`. The label records operator intent; it does not control eligibility. Supply 1–20 explicit, distinct symbols and repeat under representative conditions.

The command reads today's persisted calendar exception, calls `verifyReferencePrice` independently for Massive and Tiingo consolidated, and writes a new report under ignored `.cache/trading-reference-price-acceptance/`. It does not mutate the database, call the broker, or fall back between providers. Massive output is comparison evidence only.

Review:

- Tiingo basis, price, observation and fetch timestamps;
- signed age, future skew, actual session phase, and policy result;
- normalized provider availability and bounded errors;
- absolute differences when both providers return positive prices;
- basis-point differences only when timestamps are aligned within 30 seconds.

An unavailable Tiingo observation must remain unavailable. Any expansion of provider, basis, session, or consumer authority requires a separate reviewed decision.
