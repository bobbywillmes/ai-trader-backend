# BREADTH_V2 Phase 5A research

This command reads persisted Tiingo `DAY_1` evidence for one explicitly selected frozen `BreadthUniverseRevision`. It writes local research artifacts only. It does not call Tiingo, publish `MarketBreadthObservation`, update Market Regime, or affect trading and Signals. `Security.enabled` does not filter the revision. This is a **current-universe historical backcast** and therefore survivorship-biased; it is not point-in-time constituent reconstruction.

## Acquire history separately

Use the existing Phase 4 backfill preview before every apply. The recommended research window begins around `2021-01-04` and runs through the latest completed session. Keep every request range at or below the existing 370-day limit. Calendar-year chunks work, including leap-year 2024 (366 days):

First apply and verify the reviewed 2021–2026 market-calendar exceptions with `npm.cmd run calendar:bootstrap -- --apply` (see `docs/development/volatility-v1-acceptance.md`). Extend reviewed calendar evidence for any later research years. Missing closure rows would otherwise make holidays look like expected sessions and shift the exact 1/5/20-session anchors.

```powershell
npm.cmd run market-data:tiingo:daily:backfill -- --revision=2 --from=2021-01-04 --through=2021-12-31 --research-history
npm.cmd run market-data:tiingo:daily:backfill -- --revision=2 --from=2021-01-04 --through=2021-12-31 --research-history --apply
# Continue with 2022-01-01..2022-12-31, 2023, 2024, 2025, then 2026-01-01..latest completed session.
```

Revision 2 and its current 2,877 members are an expected operator choice, not a code default. Inspect the selected frozen revision and each preview. Do not launch all chunks automatically. [Tiingo's current Power pricing](https://www.tiingo.com/account/billing/pricing) lists 10,000 requests per hour, 100,000 per day, and 40 GB monthly bandwidth; [Tiingo's API documentation](https://www.tiingo.com/documentation/general) says hourly and daily limits reset on their respective schedules. Check the account's actual entitlement and avoid enough chunks in one hourly window to exceed it. Retrying missing observations and ordinary daily sync also consume requests.

`--research-history` records valid returned bars and split evidence normally, but counts successful-response omissions as `historicalMissing` without creating or advancing the Phase 4 per-session retry state. The preview and run summary identify `acquisitionMode: RESEARCH_HISTORY`. This avoids scheduling retries for pre-listing years in a current-universe backcast. Normal backfill and scheduled daily sync remain `OPERATIONAL` and retain the 1h/4h/24h missing-observation lifecycle. Existing missing states can still resolve if a real bar arrives in a research-history response. `--research-history` cannot be combined with `--retry-terminal`; use a separate focused terminal recheck when that is the operator's intent.

## Run the read-only analysis

```powershell
npm.cmd run research:breadth-v2 -- --revision=2 --from=2021-01-04 --through=2026-09-25
```

Optional `--output=DIR` selects a new, nonexistent directory. By default, artifacts go under ignored `node_modules/.cache/breadth-v2/revision-ID/` in a timestamped run directory. A run is complete only when `summary.json` exists. The files are:

- `summary.json`: revision, evidence hashes, count/distribution summaries, and run metadata.
- `session-breadth.csv`: strict 1/5/20-session breadth metrics.
- `coverage-by-session.csv` and `coverage-by-security.csv`: Tiingo presence and missing-state breakdowns.
- `gap-analysis.csv`: actual runs of missing expected sessions by Security, with independent shape and length-bucket labels.
- `bridge-candidates.csv`: exploratory exclusions potentially recovered with at most one or two missing sessions.

The command uses a repeatable-read, read-only database transaction and batches canonical bars by 100 Securities. It reads no provider response bodies. A frozen population hash and ordered canonical-input hash identify the evidence used. Analytical CSV content is deterministic for the same snapshot and parameters; `runtime.generatedAt` and the default directory name identify the run time.

## Measurement contract

The canonical market calendar defines sessions, including reviewed closures and early closes. For target session T, `DAY_1`, `DAY_5`, and `DAY_20` anchors are exactly 1, 5, and 20 market sessions earlier. Strict eligibility requires real Tiingo raw/unadjusted bars at target and exact anchor **and** every intervening session, because an absent intervening bar leaves its split factor unknown. This is a conservative split-evidence interpretation. An existing Massive canonical bar is a collision/missing Tiingo observation, never a fallback.

The comparison multiplies Tiingo split factors after the anchor through T; `targetRawClose × cumulativeSplitFactor` is compared to `anchorRawClose` with high-precision Decimal arithmetic. This is equivalent to comparing target close with `anchorRawClose ÷ cumulativeSplitFactor` and avoids rounding the anchor before equality checks. Exact equality is `UNCHANGED` with no percentage tolerance. `advanceShare = advancing / (advancing + declining)` and `netBreadth = (advancing - declining) / (advancing + declining)`; both are unavailable when the directional denominator is zero. `coverageRatio = eligibleCount / universeCount`. Unchanged names are eligible but outside directional ratios.

Bridge candidates compare two **real** Tiingo bars. A candidate may reach an earlier actual anchor or cross an intervening missing session, up to one or two missing sessions. The CSV records target, expected anchor, actual anchor, gap length, and observed-factor direction. Missing sessions have **unknown split factors**, so these are potential recoveries only, not strictly verified comparable closes or production eligibility. No bar is synthesized or carried forward. Phase 5B can evaluate split-coverage evidence and a gap policy before any production use.

Missing runs are classified against the **requested target-session range**, excluding warmup sessions. `FULL_RANGE_MISSING` means no real Tiingo bar appears for that Security anywhere in the range. `LEADING_MISSING` precedes its first real bar, `TRAILING_MISSING` follows its last real bar, and `INTERIOR_GAP` is bounded by real bars on both sides. These labels describe observed series geometry, not listing, delisting, or any other cause. Each run also retains its independent length bucket: `ONE`, `TWO`, `THREE_TO_FIVE`, or `OVER_FIVE`. The summary reports counts, missing sessions, affected Securities, and longest run for each shape, plus interior versus non-interior missing-session totals and the top 25 longest interior gaps. Phase 5B will examine interior gaps especially closely when deciding whether bounded bridging is justified; the strict breadth series and exploratory bridge candidates are unchanged.

`summary.json` describes advanceShare and netBreadth distributions separately for each horizon, including tails and their dates. Percentiles use linear interpolation at rank `p × (n - 1)`; standard deviation uses the sample (`n - 1`) convention. Session and Security coverage bands are cumulative except the `<99%` band. The report chooses no thresholds, labels no market state, and changes no BREADTH_V1/V2 publisher behavior.

## Existing evidence model mismatch

`MarketBreadthObservation` has one `previousSessionDate`, one set of counts and ratios, and non-null directional ratios; it is shaped for BREADTH_V1 one-session observations. Phase 5A has three horizons and keeps unavailable ratios as null when no directional names exist. A future publisher must decide how to represent the additional horizons and unavailable values. This research pass does not change that immutable production model.

## Phase 5B: classification calibration

Run the research-only comparison after the Phase 5A strict history is present:

```powershell
npm.cmd run research:breadth-v2:calibrate -- --revision=2 --from=2021-01-04 --through=2026-09-28 --calibration-through=2024-12-31
```

`--output=DIR` chooses a new artifact directory. `--expected-input-hash=SHA256` optionally requires the Phase 5A canonical input hash to match an existing run. The command invokes the same read-only Phase 5A calculation and stores its artifacts in `phase5a-strict/` beside the calibration files. It makes no provider calls or production writes. Version `BREADTH_V2_CALIBRATION_5B_V1` uses the Phase 5A V2 strict Tiingo, raw, split-normalized 1/5/20-session measurements. The current-universe backcast remains survivorship-biased.

The calibration boundary splits market sessions into calibration (through the supplied date) and validation (later sessions). Advance-share thresholds are derived only from calibration samples, separately for each horizon. QUARTILE uses p25/p75, TERTILE p33⅓/p66⅔, and NARROW p40/p60. Percentiles use linear interpolation; full-precision numeric thresholds are frozen for validation. Exact lower/upper boundaries classify NEGATIVE/POSITIVE, respectively; values between them are MIXED. Equivalent net-breadth values are reported via `2 × advanceShare − 1`, without independent calibration. Validation-stability output shows the percentile rank of each frozen threshold in validation using midranks at ties.

Five-day and 20-day states are structural. Agreement yields that state; opposite directional states yield MIXED. When one is directional and the other MIXED, 1-day must confirm the direction or raw remains MIXED. One-day cannot create direction by itself. Each threshold family is replayed with RAW effective state, one-level immediate deterioration plus two-valid-session recovery, and a mild variant that also holds POSITIVE on the first consecutive raw MIXED. Raw NEGATIVE still causes immediate one-level deterioration. Unavailable raw sessions pause smoothed continuation and appear unavailable in the artifact. These are candidate research replays, not BREADTH_V1 changes.

The report includes full, calibration, validation, and calendar-year distributions, structural agreement, transitions, run durations, and coverage diagnostics below 75/80/85/90 percent. `candidate-states.csv` has one session/family/hysteresis row. `thresholds.csv`, `candidate-distributions.csv`, `candidate-transitions.csv`, `candidate-runs.csv`, `structural-agreement.csv`, and `validation-stability.csv` give side-by-side detail. `calibration-summary.json` includes the same summaries and research identity. `coverage-sensitivity.csv` compares the full frozen revision with a **STABLE_CORE** cohort: members with real Tiingo bars on every requested target session. The stable core is a secondary diagnostic; its strict breadth uses the same real-bar comparisons and the full-revision calibration thresholds. The full revision remains the primary research series. Bridge candidates are not used in classification. Phase 5B neither scores candidates nor chooses an authoritative classification or minimum coverage threshold.
