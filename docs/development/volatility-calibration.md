# Daily Volatility candidate calibration

This is a background daily Volatility behavior report, separate from future
INTRADAY_STRESS. Thresholds remain candidates awaiting the owner's final
VOLATILITY_V1 decision. Nothing here publishes authoritative assessments.

## Run locally

```powershell
npm.cmd run research:volatility -- volatility-evidence.json
```

The optional positional argument saves complete per-session structured evidence;
stdout prints source provenance, constants, summary, all runs and transitions.
The runner uses the existing DATABASE_URL and Massive configuration. It reads
only stored SPY/RSP DAY_1 MarketBars, with no bar backfill or Alpaca fallback.
Snapshot loading uses a PostgreSQL repeatable-read, read-only transaction.
The only network requests obtain existing Massive split evidence. Split lookup
failure aborts the report rather than assuming no splits.

See [the recorded full-history results](volatility-calibration-results.md).

## Exact calculations

For each instrument independently, OHLC values are normalized in memory using
Trend's unchanged `normalizeSplits`: each pre-execution bar is multiplied by the
product of Massive `splitFrom / splitTo` factors through the report end date.
Stored bars remain unadjusted. No dividend adjustment is applied. Ratios and
percentage volatility are invariant to the common scaling of earlier history.

- Daily return: `r[t] = ln(close[t] / close[t-1])`.
- RV10/RV20: for the latest N returns, compute their mean, then
  `sqrt(sum((r - mean)^2) / (N - 1)) * sqrt(252) * 100`.
- TR: `max(high-low, abs(high-previousClose), abs(low-previousClose))`.
- ATR14: mean of the first 14 valid true ranges; thereafter
  `(previousATR * 13 + TR) / 14`. The first bar has no TR.
- ATR14Pct: `ATR14 / currentClose * 100`.

| State / severity | RV10 and RV20 (annualized percentage points) | ATR14Pct |
| --- | --- | --- |
| LOW / 0 | x < 12 | x < 1.00 |
| NORMAL / 1 | 12 <= x < 20 | 1.00 <= x < 1.50 |
| HIGH / 2 | 20 <= x < 30 | 1.50 <= x < 2.50 |
| EXTREME / 3 | x >= 30 | x >= 2.50 |

Classification uses unrounded values. Instrument raw severity is the median of
the three measurement severities. Market raw severity is max(SPY, RSP), without
overrides. All constants and thresholds accompany each day's evidence.

Minimum warm-up is **21 consecutive usable bars per instrument**: RV10 needs 11
closes, RV20 needs 21, and ATR14 seeds after 15 bars. Missing/invalid OHLC resets
that instrument's rolling returns and ATR seed. Both instruments must have all
three measurements before the market assessment is VALID; otherwise it is
UNAVAILABLE, with no effective classification exposed for that date.

Hysteresis bootstraps from the first valid raw state. Any raw severity above the
effective severity jumps immediately to raw. Two valid assessments with raw at
or below the next lower target reduce effective severity exactly one step.
Equal raw/effective resets confirmation. A raw rise that remains below effective
still supports the next lower target; a rise above effective interrupts recovery.
Unavailable assessments pause both effective history and confirmation. This means
consecutive *valid assessments*, with unavailable sessions ignored for confirmation,
as requested. Paused state is retained explicitly in hysteresis evidence.

## Research calendar and integrity

The local database had no calendar exceptions. Treating every weekday as an
expected session falsely reset metrics on 50 exchange closures, yielding only
455 valid observations. The final run uses a small, explicit **research-only**
2021–2026 NYSE full-day closure list, verified independently of stored prices:

- [2021 calendar](https://ir.theice.com/press/news-details/2020/NYSE-Group-Announces-2021-2022-and-2023-Holiday-and-Early-Closings-Calendar/default.aspx)
- [2022–2024 calendar, including Juneteenth](https://ir.theice.com/press/news-details/2021/NYSE-Group-Announces-2022-2023-and-2024-Holiday-and-Early-Closings-Calendar/default.aspx)
- [2024–2026 calendar](https://ir.theice.com/press/news-details/2023/NYSE-Group-Announces-2024-2025-and-2026-Holiday-and-Early-Closings-Calendar/default.aspx)
- [January 9, 2025 closure](https://ir.theice.com/press/news-details/2024/The-New-York-Stock-Exchange-Will-Close-Markets-on-January-9-to-Honor-the-Passing-of-Former-President-Jimmy-Carter-on-National-Day-of-Mourning/default.aspx)

The runner combines this list with stored operator exceptions in memory. It
never updates the production calendar. Conflicting closed-date bars or operator
early-close overrides fail explicitly. Early closes count as sessions; without
a stored early-close entry, today's completion conservatively waits until
16:30 ET. History outside 2021–2026 requires extending the sourced list first.
Unexpected absent-both sessions remain gaps; holidays are never inferred from
the absence of prices. Report scope ends at the latest completed stored bar, not
today, so it does not claim to monitor ingestion freshness beyond stored coverage.

State distributions count only valid effective days. Yearly slices retain the
continuous full-history hysteresis. Run lengths count valid sessions, pausing on
unavailable days; boundary runs may be censored. Bootstrap is not a transition.
The dataset hash includes normalized source bars and IDs, split evidence,
expected dates, calendar exceptions and the candidate definition.

## Validation and scope

Focused Volatility, Trend, market-bar/calendar/worker and Massive split tests:
163 passed across 11 files, including 48 new tests across two files. Full backend
suite: 1,780 passed, 85 skipped across 167 passed / 6 skipped files. Backend type
check, build and `git diff --check` passed. Existing opt-in integration suites
remain skipped by their normal configuration.

Regression tests run the research loader against a database proxy that rejects
all assessment/trading model access and every model operation except the three
required `findMany` reads. They also require PostgreSQL's read-only declaration
before the first read. Tests cover absent-both gaps, calendar boundaries, split
failure, deterministic replay and split-only price discontinuities.

No schema, migration, DBML, frontend, Strategy policy, composition, SignalEvaluation
gate, trading path, or TREND_V1 publisher/worker changes. No VOLATILITY assessment
rows are inserted. No returns, P&L, Sharpe ratios, outcome analysis, optimization,
extra threshold profiles or calibration matrix were added. Deployment is not
needed for this local research pass; a production publisher remains a separate
decision.
