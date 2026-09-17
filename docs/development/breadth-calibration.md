# Daily Breadth candidate calibration

Research/calibration record only. `BREADTH_V1` is **not** productionized by this pass:
no `MarketRegimeDimensionAssessment` rows are written, no schema/migration changed, and
nothing here affects `SignalEvaluation` or trading. See the [market-regime context](../architecture/market-data-trend.md)
for how `TREND_V1` and `VOLATILITY_V1` were productionized after their own calibration passes.

Breadth answers "how much of the stock market is participating directionally?" — a
genuinely cross-sectional measure, deliberately distinct from Trend's SPY/RSP pair and
from the future PARTICIPATION (volume intensity) and LEADERSHIP (concentration) dimensions.

## Provider feasibility (read this before running)

Two Massive (Polygon-compatible) endpoints are used, both live-probed against the actual
subscription before any implementation was written:

- **Grouped daily bars**: `GET /v2/aggs/grouped/locale/us/market/stocks/{date}?adjusted=true`
  — one unpaginated response with every ticker (any type) that traded that day (~10,500-11,200
  rows). `adjusted=true` is essential: it keeps a stock's adjacent-session close comparison
  continuous across a split (verified directly against NVDA's real 10-for-1 split on
  2024-06-10 — see below), without fetching per-symbol split evidence for thousands of names.
- **Point-in-time common-stock reference**: `GET /v3/reference/tickers?locale=us&market=stocks&type=CS&active=true&date={date}&sort=ticker&limit=1000`
  — cursor-paginated (1000/page, ~5,250-5,260 pages... rows, ~6 pages/session as of this
  probe). This **is** genuinely point-in-time, not today's list filtered by date: verified
  directly by querying Rivian (RIVN, IPO'd 2021-11-10) — absent for `date=2021-01-01`, present
  for `date=2024-01-01` — and Twitter (TWTR, went private 2022-10-27) — present for
  `date=2022-01-01`, absent for `date=2024-01-01`. **No survivorship bias.**

### Entitlement finding

Individual-ticker daily aggregates (used by Trend/Volatility) are entitled back to
2021-09-16. **Grouped daily** has a *shorter* rolling entitlement window: probing bisected
the exact boundary to **2021-09-20** (2021-09-16 and 2021-09-17 both return
`403 NOT_AUTHORIZED — Attempted to request data past historical entitlements`; 2021-09-20
onward succeeds). The entitlement window is rolling relative to the request date (roughly
"the last ~5 years"), not a fixed calendar cutoff, so this boundary will itself move forward
on every later research run. The runner does not special-case this: an out-of-entitlement
date simply becomes a cached, non-retried provider gap (see below), and continuity resumes
normally once dates return to inside the window.

### Other verified findings

- Maximum page size is 1000; requesting more (e.g. `limit=5000`) is rejected with `400`.
- No rate-limit throttling was observed on this plan: 15 parallel requests completed in
  ~200ms with no `429`s. The runner still bounds concurrency (default 6) and retries
  transient failures, out of general courtesy to a shared production API key.
- A quick calculation from the verified numbers: **~1,255 expected sessions x (1 grouped
  request + ~6 universe pages) &asymp; 8,700 total requests** for the full 2021-09-16..2026-09-16
  range, comfortably feasible with disk caching and bounded concurrency.

No survivorship-biased proxy, ETF/fund substitution, SPY/RSP substitution, or other
provider was needed — the exact requested semantics are supported.

## Run locally

```powershell
# Print the request estimate only; makes no provider calls.
npm.cmd run research:breadth -- --from 2021-09-16 --to 2026-09-16

# Perform the (cached, resumable) fetch and produce the full report.
npm.cmd run research:breadth -- --from 2021-09-16 --to 2026-09-16 --fetch --output breadth-evidence.json
```

- `--from`/`--to` default to `2021-09-16` and yesterday's ET date.
- `--fetch` is required to make any new provider request; without it, the runner only
  reports what is already cached (everything else becomes a "provider gap" for that date).
- `--refresh` ignores existing cache entries and re-fetches (needed to pick up a split that
  occurred after a date was cached — see below).
- `--output file.json` writes the full per-session evidence to `file.json` and the Markdown
  behavior report to `file.md`; without it, only the Markdown report prints to stdout.

The disk cache lives at `node_modules/.cache/breadth/{grouped,universe}/{date}.json` — the
same gitignored convention already used by the Volatility research cache. It is never
read or written by any production worker, and is safe to delete at any time.

## Exact calculation

For each expected session `T` (weekday, not a persisted/verified-static `CLOSED` date;
early closes remain sessions):

1. Universe(T) = the point-in-time CS/active list for `T`.
2. A stock in Universe(T) participates in direction only if it also has a valid close on
   `T` *and* on the immediately previous **expected** session (looked up by calendar
   position, never by searching backward past a gap, and never carried forward).
3. `close[T] > close[T-1]` &rarr; ADVANCING; `<` &rarr; DECLINING; `==` &rarr; UNCHANGED.
   UNCHANGED is excluded from the directional denominator.
4. `directionalCount = advancingCount + decliningCount`; if zero, the day is `UNAVAILABLE`.
5. `advanceShare = advancingCount / directionalCount`; `netBreadth = (advancingCount - decliningCount) / directionalCount`.

Three horizons, arithmetic mean only (no EMA, no cumulative A/D line):

- `breadth1 = advanceShare[T]`
- `breadth5` = mean of the latest 5 consecutive valid `advanceShare` values ending at `T`
- `breadth20` = mean of the latest 20 consecutive valid `advanceShare` values ending at `T`

A gap (missing expected evidence, *or* a resolved zero-directional day) restarts the
consecutive count identically for both horizons; a legitimate `CLOSED` date or a weekend is
never in the expected-session list in the first place, so neither breaks continuity.
Warm-up is therefore **20 consecutive valid sessions** before any classification exists.

Bands (unrounded values; lower bound inclusive, upper bound exclusive of the interior):

| State / severity | Any of breadth1/5/20 |
| --- | --- |
| NEGATIVE / -1 | value <= 0.45 |
| MIXED / 0 | 0.45 < value < 0.55 |
| POSITIVE / 1 | value >= 0.55 |

Raw market state = median severity of the three horizon states (always well-defined with
exactly three values). Hysteresis is asymmetric and intentionally the mirror image of
Volatility's: NEGATIVE < MIXED < POSITIVE, so *dropping* is immediate (including a
multi-level drop) while *rising* requires two consecutive valid sessions supporting at least
the next-higher state, then recovers **exactly one level**, then resets confirmation.
Unavailable evidence pauses both effective state and confirmation without incrementing or
resetting it. The first valid raw state bootstraps the effective state directly.

## Split handling and cache staleness

`adjusted=true` on the grouped-daily endpoint applies Massive's own point-in-time split
adjustment, verified directly: requesting NVDA's 2024-06-06/07/10/11 grouped bars with
`adjusted=false` shows a fake ~10x drop across its real 2024-06-10 split (1209.98 -> 121.79),
while `adjusted=true` shows a continuous ~1% move (120.888 -> 121.79) that matches the
`historical_adjustment_factor: 0.1` Massive's own splits endpoint records for the same event.
This is a deliberate deviation from Trend/Volatility's manual per-symbol split-normalization
convention: fetching split evidence for the thousands of distinct symbols that appear across
a 5-year universe is not practical, and Massive's own adjustment is the standard mechanism
for exactly this comparison. Because that adjustment is computed relative to *today's* share
structure, a **newly announced split retroactively changes the adjusted value of every older
cached session for that ticker**. The disk cache does not detect this on its own; re-run with
`--refresh` after a meaningful amount of time has passed to pick up any such change.

## Calendar dependency

The runner reuses the exact same verified, sourced 2021-2026 NYSE full-day closure list and
merge behavior already used by Volatility's research runner (`volatilityResearchExceptions`,
sourced from `market-calendar-bootstrap.definition.ts`) plus any persisted operator
`MarketCalendarException` rows — the only database access this runner performs, inside a
`SET TRANSACTION READ ONLY` transaction. It never seeds the production calendar and never
writes to Postgres.

## No trading effect

No `MarketRegimeDimensionAssessment` row, migration, or trading-path file was touched. See
[the recorded run](breadth-calibration-results.md) for the actual historical behavior.
