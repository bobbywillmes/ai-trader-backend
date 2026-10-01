# Phase 7A: Tiingo REST intraday cutover

Phase 7A changes only the current-session `MINUTE_15` evidence used by `INTRADAY_STRESS_V1`. Provider research on the Sep 23 and Sep 24 full sessions found complete Tiingo REST SPY/RSP coverage and 50/50 actionable raw-state agreement with both Tiingo WS and the delayed Massive comparator. Production uses REST because the accepted result can be reproduced from explicit snapshots without socket state. No WebSocket is connected in production.

## Evidence contract

The production client requests `/tiingo/equity/intraday/<symbol>/prices` separately for SPY and RSP with `startDate` and `endDate` equal to the New York session date, `resampleFreq=1min`, `afterHours=false`, and `forceFill=false`. It never uses Tiingo's provider-resampled 15-minute response. Each half-open regular-session window, starting at 09:30, requires exactly 15 unique minute timestamps at its expected one-minute grid. Open is the first minute open, high and low are extrema, close is the final minute close, and volume is the Decimal sum. Missing, duplicate, or misaligned minutes leave the window unavailable. No carry-forward or synthetic minute is used.

The existing bar-end plus five-minute grace applies before any canonical insert. The first sufficiently complete accepted snapshot after that boundary is immutable. Later Tiingo REST revisions may exist, as research found, but they do not update the accepted `MarketBar`. `MarketBar` identity remains `(securityId, timeframe, barStartAt)`; provider is provenance, not a second timeline.

## Activation

The default, unset `INTRADAY_STRESS_TIINGO_CUTOVER_SESSION` keeps Massive authority. Set a strict `YYYY-MM-DD` session date outside regular trading hours before the selected session. Before market open, inspect `GET /api/market-data/intraday-stress-provider/status` for the New York session, configured date, expected provider, SPY/RSP counts, eligible gaps and conflicts, and Massive baseline. Confirm the paid Tiingo plan and token, reviewed calendar, and worker health. Bobby explicitly selects and accepts the cutover; deployment alone does not activate it.

Before the date, only Massive is authoritative. On and after it, only Tiingo is authoritative for `MINUTE_15`. There is no runtime fallback. A wrong-provider canonical SPY/RSP row in the session is a conflict: ingestion and assessment fail closed, including if it occupies a timestamp that would otherwise be considered present. Do not delete or overwrite canonical evidence as routine recovery. A provider change after a session has begun cannot safely be rolled back within that session. Once Tiingo bars have been written, select a **future session boundary** for any rollback to Massive.

The current 30-second minute worker retries eligible gaps. Incomplete Tiingo 15/15 windows remain missing and surface through deduplicated worker health; normal pre-eligibility creates no request or event noise. Provider failures and canonical conflicts are distinct errors. The Tiingo retention purge deletes both `DAY_1` and `MINUTE_15` Tiingo MarketBars while preserving Massive bars, and pauses Tiingo acquisition. The minute worker honors that pause.

The prior-session ATR baseline deliberately remains Massive `DAY_1` plus persisted split evidence. New assessment evidence names `intradayMarketData` authority and records `baseline.provider=MASSIVE` with `migrationPhase=LEGACY_DAILY_BASELINE_PENDING`. Existing assessments are untouched, and predecessor hysteresis continues across the session boundary. Phase 8 will address remaining Massive daily consumers.
