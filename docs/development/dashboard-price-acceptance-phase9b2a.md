# Phase 9B.2A dashboard ETF reference-price acceptance

This is manual, read-only research for SPY, QQQ, DIA, and IWM. Dashboard API/UI and all production consumers remain Massive-backed. The command calls the Phase 9B.1 normalized `verifyReferencePrice` capability separately for `MASSIVE` and `TIINGO_CONSOLIDATED`; it never falls back between them. No database, broker, worker, or scheduler is involved.

Run one command at each intended New York market phase. Repeating a phase is useful and creates a new immutable output directory each time:

```powershell
npm.cmd run research:dashboard-price:accept -- --phase=PREMARKET
npm.cmd run research:dashboard-price:accept -- --phase=AFTER_OPEN
npm.cmd run research:dashboard-price:accept -- --phase=MIDDAY
npm.cmd run research:dashboard-price:accept -- --phase=NEAR_CLOSE
npm.cmd run research:dashboard-price:accept -- --phase=POSTMARKET
npm.cmd run research:dashboard-price:accept -- --phase=CLOSED
```

Suggested New York sample times are 08:30, 09:35, 12:00, 15:50, 16:30, and 21:00 respectively. On October 2, 2026, these are 05:30, 06:35, 09:00, 12:50, 13:30, and 18:00 in Phoenix. Run the command near the corresponding phase; the phase label records operator intent and does not infer exchange-calendar eligibility. Several commands can be run on different dates. Use the existing application `.env` with Massive credentials and `TIINGO_API_TOKEN`; no trading configuration change is needed.

Each run writes `report.json` and `summary.md` to a unique directory under ignored `.cache/dashboard-price-acceptance/` and prints its path. The JSON includes capture start/end time, intended phase, normalized evidence for both providers, observation age and future-clock skew, per-symbol unaligned comparison metrics, and aggregate Tiingo availability, basis, stale and unavailability counts. Provider errors are bounded status classes such as `HTTP_429` or `REQUEST_FAILED`; raw upstream text and tokens are not saved. Differences are diagnostic only: Massive and Tiingo observations may have different timestamps. The five-minute normalized verification rule alone determines price availability.

Review all four Tiingo basis, age, error and availability records across repeated market-phase samples before any dashboard price-line authority decision. An unavailable price should remain unavailable in the future UI; it must not become a Massive or previous-close substitute.
