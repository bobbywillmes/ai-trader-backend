# Phase 8: shared market DAY_1 Tiingo cutover

The account-independent daily market-evidence panel is SPY, QQQ, DIA, IWM, and RSP. Its existing `market_daily_evidence_sync` worker remains the acquisition path. These ETFs are market sensors, not members of the frozen common-stock `BreadthUniverseRevision`; the Phase 4/BREADTH_V2 ingestion and shadow worker are independent.

## Authority and canonical history

`MARKET_DAILY_TIINGO_CUTOVER_SESSION` is unset by default, so Massive remains authoritative. Configure a strict `YYYY-MM-DD` New York market session outside regular trading hours before the selected future session. Dates before it require Massive `DAY_1`; the cutover date and later sessions require Tiingo `DAY_1`. This decision is independent of `INTRADAY_STRESS_TIINGO_CUTOVER_SESSION`, which selects SPY/RSP `MINUTE_15`. No deployment-time inference, Breadth state inference, or runtime fallback exists.

The canonical key remains `(securityId, timeframe, barStartAt)`. Massive's stored DAY_1 timestamp is New York midnight; Tiingo's is UTC midnight. The shared production reader converts each provider timestamp to a logical New York session date, validates the expected provider for that date, and rejects malformed timestamps, wrong providers, or duplicate logical sessions. It returns one chronological history across the seam. Existing Massive history remains immutable. A wrong-provider row or conflicting immutable contents must be reviewed; do not overwrite it or switch provider within the same session. Once Tiingo DAY_1 evidence has been accepted, rollback uses a **future session boundary**.

## Acquisition and calculations

For eligible missing cutover sessions, the daily worker calls Tiingo REST `/tiingo/daily/<symbol>/prices` for each of the five symbols, with the same `startDate` and `endDate`. Tiingo DAY_1 becomes eligible at 20:15 ET, including early closes. Closed dates create no request. No request is made when eligible canonical rows already exist. Stored rows have raw OHLCV, positive `splitFactor`, `provider=TIINGO`, and `adjustmentMode=UNADJUSTED`. Tiingo's aggregate daily volume is stored at canonical Decimal precision exactly as supplied; Participation does not reconstruct regular-hours volume.

Non-unit Tiingo split factors create or validate one immutable `MarketSplitEvent`. The persisted split reader requires Massive split coverage before the seam and complete Tiingo DAY_1 split-factor evidence on expected sessions after it. It checks each Tiingo event against its bar. Trend, Volatility, Participation, and Intraday Stress ATR continue to normalize through the persisted event reader only; the Tiingo bar factor is coverage and verification, not a second calculation factor. Participation waits until Tiingo's 20:15 evidence boundary for a Tiingo target while retaining its target time and next-session validity rule.

New assessment evidence records a bounded `dailyMarketData` authority version, cutover session, providers present, and provider segments so a historical lookback can show both Massive and Tiingo. Existing assessments, formulas, thresholds, algorithm versions, hysteresis, and trading authority stay unchanged. Intraday Stress can independently have Tiingo minute/Massive daily, Massive minute/Tiingo daily, or Tiingo for both, according to the two configured session dates.

The fixed Trend, Volatility, and Participation validity windows may expire at the next session's close plus 30 minutes before that session's Tiingo DAY_1 bar becomes eligible at 20:15 ET. This produces an expected observation gap; Phase 8 does not extend assessment validity or grant trading authority during it.

## Readiness, retention, and rollback

Before activation, inspect `GET /api/market-data/status` for `dailyAuthority` and the five symbol rows: current New York session, configured cutover, expected provider, latest canonical session/provider, coverage within seven days of the boundary, missing eligible dates, conflicts, and retention pause. Confirm the paid Tiingo plan, token, reviewed calendar, completed Massive split bootstrap through the pre-cutover session, and a future cutover date. Bobby performs acquisition/backfill and acceptance separately; implementation does not set a cutover date.

The paid-plan retention purge deletes all Tiingo `DAY_1` bars, including these ETF sensors, and Tiingo split events while preserving Massive history. It pauses Tiingo acquisition. A consumer requiring purged Tiingo evidence fails closed rather than reading Massive. Do not change the daily cutover back to Massive for a session with accepted Tiingo bars. Choose a future session boundary for rollback and inspect canonical conflicts before resuming.
