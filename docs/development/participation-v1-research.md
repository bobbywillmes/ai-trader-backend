# PARTICIPATION_V1 research

Question: **How broadly elevated or subdued is trading activity across a deliberately diverse panel of major U.S. equity index ETFs?**

This is research only. **No thresholds or states are frozen by this tool. No trading authority exists.** QUIET / NORMAL / ACTIVE / INTENSE are conceptual future vocabulary only. There is no classifier, hysteresis, publisher, worker, endpoint, database write, migration, or connection to SignalEvaluation, EntryDecision, OrderIntent, strategy decisions, or trading.

## Panel and measurements

| Sensor | Market lens |
| --- | --- |
| SPY | Cap-weighted large-cap U.S. equities |
| QQQ | Nasdaq-100, modified-cap-weighted growth-heavy large caps |
| DIA | Price-weighted Dow |
| IWM | Cap-weighted small caps |
| RSP | Equal-weighted S&P 500 |

Each ETF is an equal sensor after normalization against its own history. For each target, medianVolume20/40 is the median of exactly the preceding 20/40 eligible full sessions. The target never enters its own baseline. RVOL is normalized target volume / median baseline volume. The **20-session median is the leading candidate**; 40 sessions is the research control, not a selected production setting.

The primary panel measure is the median of all five continuous RVOL values, independently for each horizon. Minimum, maximum and range describe dispersion. Inclusive counts <= 0.70, <= 0.80, >= 1.00, >= 1.25, >= 1.50 and >= 2.00 are **diagnostic cut points, not state thresholds**. Agreement confirms/describes participation and does not replace the continuous median. Per-ETF baselineRatio = medianVolume20 / medianVolume40 describes changing norms; it is not a Participation input.

Measurements are direction-neutral: actual OHLC, returns, green/red sessions, advancing/declining volume, trend, breadth direction, volatility, sectors, leadership, options, news, VIX and dollar-volume weights never enter the math. OHLC is retained and validated only as raw provider evidence.

ETF volume includes ETF-specific hedging/arbitrage and is **not literally total underlying-stock participation**. Research tests whether this diverse five-ETF panel is a useful compact market-activity sensor.

## Evidence and calendar

- Massive is the sole data authority; there is no Alpaca fallback. A research-specific five-symbol adapter reuses `massiveEvidenceGet` without changing production `TrendSymbol`, daily/split parsers, or Breadth.
- Daily requests use `adjusted=false`. Cache entries retain raw provider observations and relevant response metadata, excluding pagination URLs that can contain credentials. The adapter checks status, ticker, adjustment, finite valid OHLCV, Eastern-midnight timestamps, requested dates, duplicates, pagination destination and page limits.
- Explicit split evidence uses `/stocks/v1/splits`. Invalid ratios, dates, identities and duplicate identities/execution dates fail closed. `normalizeSplits` supplies the existing inverse-price-factor volume adjustment. Unit OHLC is passed to that pure helper so price direction cannot influence measurements. All volumes are expressed on the requested end-date share basis; future-to-target splits uniformly rescale target and baseline, leaving RVOL and baselineRatio unchanged.
- `researchCalendar([])` reuses reviewed full closures and Intraday Stress early-close support. No database is accessed, including calendar state. Operator calendar overrides are therefore not part of this dataset; the full reviewed calendar and source choice are in the report. No production calendar horizon changes are made.
- Only normal 09:30–16:00 America/New_York session **dates** qualify. Early closes are excluded from both targets and baseline counts. The last target must be completed, with the existing 30-minute completion grace. Closed/early-close range endpoints are allowed; the last included full session must be complete.
- Daily aggregate volume is provider-defined daily evidence, **not a reconstruction from strictly 09:30–16:00 intraday bars**. Do not interpret the session-date filter as a guarantee that every included trade occurred during regular hours. A strictly regular-hours volume study would require separately scoped intraday evidence.
- Supported calendar range is 2021-01-01 through 2026-12-31. The runner includes up to 40 prior eligible full sessions for warmup within that boundary. Targets at the beginning of 2021 necessarily have unavailable warmup; no pre-2021 calendar or provider history is assumed.
- Missing expected full dates are retained as missing; the baseline never reaches further back to replace them. Each horizon fails independently. Zero median baselines, invalid/duplicate volume, unavailable splits and insufficient warmup have explicit reasons. Zero target volume is valid when its baseline is positive. Any missing ETF RVOL makes that panel/horizon unavailable. Missing split evidence conservatively invalidates that ETF for the entire run.

## Commands and cache

From the repo root (use `npm.cmd` on PowerShell if necessary):

```bash
# Offline/cache-only, no DB or provider access; writes an unavailable report if empty.
npm run research:participation -- --from 2021-01-01 --to 2026-09-18

# First bounded real fetch for the reference window.
npm run research:participation -- --from 2021-01-01 --to 2026-09-18 --fetch --max-requests 100 --output node_modules/.cache/participation-v1/reference-report.json

# Resume: repeat the same command. Cached successes AND failures are reused.
# Deliberately retry failures / replace provider evidence:
npm run research:participation -- --from 2021-01-01 --to 2026-09-18 --fetch --refresh --max-requests 100

npm run research:participation -- --help
```

Without `--to`, the last completed full session is selected, capped at the reviewed 2026 boundary. Default `--from` is 2021-01-01. `--output PATH` controls the full JSON artifact; default is `node_modules/.cache/participation-v1/report.json`. `--cache-dir PATH` changes the evidence cache (output remains independently configurable). Default cache is `node_modules/.cache/participation-v1`, gitignored by the repository convention.

Fetching requires `--fetch`. `--refresh` requires `--fetch` and replaces all requested cache units, including successes. Each ETF has one daily and one split request per calendar-year segment. The reference window has **60 cache units / approximately 60 cold requests without pagination** (five ETFs × six years × two evidence types). Pagination counts against the default **100 actual HTTP attempts**; each cache unit has a five-page maximum. `--max-requests` accepts 1–300. Requests are sequential with no automatic retries. Cache hits consume no requests; provider errors including HTTP entitlement failures are cached. Local budget exhaustion is not cached, allowing resume. Corrupt caches fail closed with a refresh instruction.

Partial-year keys include their end date: advancing that date fetches a new partial-year unit; complete-year units remain reusable. Each cache write is atomic via a temporary file and rename. Cache envelopes contain fetch time and SHA-256 integrity digests. Reports contain a stable dataset digest over the calculation definition/version, ranges, calendar and evidence manifest, excluding runtime timestamps/request counts. Provider failures and missing dates are visible rather than manufactured as empty valid evidence. The first real fetch must establish actual history entitlement and provider coverage.

Fetch mode uses the existing application environment configuration, including `MASSIVE_API_KEY` / `MASSIVE_BASE_URL` and its existing required environment variables. Cache-only mode does not load provider/environment modules or connect to Postgres.

## Reports and validation

JSON retains every full-session target, per-ETF normalized volume, both baselines/RVOL values, baseline ratios, both panels and exact unavailable reasons. Summary includes per-ETF and panel percentiles (p1/p5/p10/p25/p50/p75/p90/p95/p99), availability, agreement-count frequencies, baseline-ratio distributions, high/low dates, largest paired divergence dates, paired mean/median absolute difference and Pearson correlation. Percentiles linearly interpolate at `(N-1)*p`; correlation uses centered cross-products and is null for constant/empty data. Paired comparisons use only dates with both complete panels. Console output is compact; full diagnostics stay in JSON.

```bash
npx vitest run src/dev/participation-calculation.test.ts src/dev/participation-research.test.ts
npm run check
npm run build
npm test
```

Deterministic tests cover baseline exclusion, split adjustment, calendar exclusions, independent horizon gaps, all-five evidence, robustness to isolated volume extremes, agreement counts, direction neutrality, statistics, explicit/bounded fetch, cache resume/refresh/corruption, dataset identity and absence of database/trading dependencies. Synthetic fixtures do not justify final state thresholds.

Follow-up only: a generic strict daily/split observation primitive and cache envelope could eventually support Participation and Leadership. It should preserve production contracts with regression tests and be driven by concrete consumers. This task does not refactor production evidence or Breadth. Strict regular-hours volume, provider history coverage and any later thresholds remain separate research decisions.
