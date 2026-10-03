# Phase 9B.4A trading reference-price acceptance

This phase adds a pure trading eligibility policy and a manual comparison. Runtime subscription sizing and trading-account risk health still call Massive directly. No production price authority, broker behavior, or database schema changes.

Run from the repository root with application database and both provider credentials configured:

```powershell
npm.cmd run research:trading-reference-price:accept -- --phase=AFTER_OPEN --symbols=SPY,QQQ,DIA
```

Supply 1–20 explicit, distinct symbols. Valid operator labels are `PREMARKET`, `AFTER_OPEN`, `MIDDAY`, `NEAR_CLOSE`, `POSTMARKET`, and `CLOSED`. Repeat in representative conditions. The label describes when the operator intended to capture; it never controls eligibility. The command reads today's persisted, reviewed `MarketCalendarException` rows and uses the shared New York market-session rules, including closures and early closes. Ensure the production calendar bootstrap and any new exceptions have been reviewed before interpreting results. The command does not mutate the database or call the broker.

The capture uses existing `verifyReferencePrice` separately for Massive and Tiingo consolidated. Each symbol/provider request is independent and bounded. An upstream failure becomes a bounded error class, never a raw body or token. There is no provider fallback. Four symbols are processed concurrently. The command writes `report.json` and `summary.md` under ignored `.cache/trading-reference-price-acceptance/<timestamp>-<phase>-<uuid>/` and prints the directory.

`report.json` retains each provider's symbol, provider, price, basis, observed/fetched times, normalized availability, bounded provider error, and signed age at policy evaluation. Tiingo also includes the trading-policy decision, rejection reason, actual session phase, and positive clock-skew magnitude. It reports an absolute price difference whenever both prices are positive. Basis-point difference is reported only if observation timestamps differ by at most 30 seconds; otherwise the absolute difference is an unaligned diagnostic. `summary.md` counts Tiingo bases, normalized availability, trading usability, rejection reasons, and aligned comparisons.

## Provisional trading policy

`evaluateTradingReferencePrice(symbol, evidence, now, reviewedExceptions)` is pure. It accepts only matching-symbol `TIINGO_CONSOLIDATED` evidence with positive finite price, valid UTC observation/fetch timestamps, no provider error or malformed response, and `TIINGO_TNGO_LAST` basis. `TIINGO_LQ_REF_PRICE` remains visible but is rejected. Previous close is never an accepted basis. Eligibility requires the actual reviewed regular session (`openAt <= now < closeAt`), including an early-close boundary, and the observation itself must be inside that regular session. A fresh premarket print just after the bell is rejected. Maximum age is five minutes at **evaluation** time. An observation up to 30 seconds in the future can pass; its negative signed `ageMs` and positive `clockSkewMs` are preserved. More than 30 seconds future fails. Fetch-time `available` and dashboard stale-display policy do not decide trading eligibility.

Rejection reasons are `OUTSIDE_TRADING_PRICE_SESSION`, `PROVIDER_MISMATCH`, `SYMBOL_MISMATCH`, `PROVIDER_ERROR`, `MALFORMED_EVIDENCE`, `INVALID_PRICE`, `MISSING_OBSERVATION_TIMESTAMP`, `MISSING_FETCH_TIMESTAMP`, `UNACCEPTED_BASIS`, `OBSERVATION_OUTSIDE_TRADING_SESSION`, `FUTURE_OBSERVATION`, and `STALE_OBSERVATION`. The first failed check in that order is reported. Closed-session rejection takes precedence so a routine closed-market capture does not classify an unavailable live price as an operational provider failure; the report still retains the provider's independent error evidence.

For later risk-health integration, report outside-session fixed-quantity valuation as **not currently evaluable**, with an informational or separate session state that does not by itself downgrade overall configuration readiness every night or holiday. Preserve the existing live-blocker/paper-warning behavior for genuine price/data failures during an eligible session. Runtime sizing must always return no actionable quantity on any rejected price. The existing Alpaca entry-session guard remains the authority for whether an entry can proceed.

Live Tiingo evidence must be reviewed across regular-session phases and closed periods for symbol coverage, `TNGO_LAST` presence and age, `LQ_REF_PRICE` occurrence, provider errors, and aligned differences before either consumer changes authority.
