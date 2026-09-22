# Intraday Stress Alpaca IEX Phase B

Research only. IEX is **not accepted**. No production classifier, publisher,
threshold, recovery rule, cutoff, schema, worker, account integration or trading
behavior changes. Implementation makes no live provider calls. All tests are offline.

## First Phase A live evidence

Operator-supplied results, preserved here rather than presented as a new measurement:

- Session 2026-09-22; run `bcadcd50-d633-469c-87e6-a7b7125210d7`.
- Started `2026-09-22T13:13:11.355Z`; cutoff `2026-09-22T14:50:41.737Z`.
- 149 observations: 147 initial bars, 2 updatedBars; SPY 81, RSP 68 observations.
- No reconnects, malformed frames, unexpected symbols/channels, duplicates or
  ambiguous minute states; clean shutdown.
- Initial latency median 227 ms, p95 286 ms, p99 663 ms, maximum 677 ms.
- Updates arrived approximately 30.1 seconds after minute end. Complete-window
  latency median 229 ms, maximum 411 ms.
- Over roughly 80 elapsed regular-session minutes, SPY had 80 observed minutes,
  RSP 67. First five elapsed SPY windows were strictly complete; only the first
  RSP window and first paired window were complete. This remained true at
  +30/+60/+90/+120/+300 seconds, so simple delayed arrival did not explain it.
- Seven initial latencies were approximately -4 to -27 ms; `clockUncertain=false`.

Transport latency is excellent in this sample. RSP sparsity requires independent
historical IEX evidence before deciding whether it reflects capture gaps or
provider-no-bar minutes. Strict 15/15 remains a diagnostic, unchanged.

## Official contracts reviewed 2026-09-22

| Official source | Contract used / ambiguity |
|---|---|
| [Alpaca multi-symbol historical bars](https://docs.alpaca.markets/us/reference/stockbars) | `GET https://data.alpaca.markets/v2/stocks/bars`; `symbols=SPY,RSP`, `timeframe=1Min` or `15Min`, explicit `feed=iex`, `adjustment=raw`, `asof=-`, ascending order. Start/end inclusive; convert the internal exclusive end to end minus 1 ms. Limit 10,000 total rows, not per symbol. Follow `next_page_token` even on short pages; sorting is symbol then timestamp. |
| [Single-symbol alternative](https://docs.alpaca.markets/us/reference/stockbarsingle-1) | `/v2/stocks/{symbol}/bars` exists; this implementation uses the multi-symbol endpoint to minimize calls. |
| [Alpaca market-data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq) | Bar timestamps identify interval starts. Higher intraday aggregates derive from minute bars; absence can reflect no price-eligible trade. The unpaid recent-history restriction is stated for SIP, while IEX is the free real-time feed. Never infer feed from subscription defaults. |
| [Alpaca plans](https://docs.alpaca.markets/us/docs/about-market-data-api) | Basic: real-time IEX, 200 historical calls/minute. Its generic table also says latest 15 minutes restricted; the feed-specific FAQ is more precise. Actual key entitlement remains an operator verification, with no SIP fallback. |
| [Streaming stocks](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data) and [minute-bar explanation](https://alpaca.markets/learn/stock-minute-bars) | Late-trade recalculation occurs around the half-minute boundary. This is not a revision-finality guarantee. |
| [Alpaca historical-data tutorial](https://alpaca.markets/learn/fetch-historical-data) | Conflicting tutorial wording describes quote-midpoint bars without trades. Do not adopt synthetic quote/forward-fill rules from this. Validate returned 1m/15m evidence empirically and escalate unresolved inconsistency before authority. |
| [Massive custom aggregates](https://www.massive.com/docs/rest/stocks/aggregates/custom-bars) | `/v2/aggs/ticker/{symbol}/range/15/minute/{from}/{to}`, `adjusted=false`, ascending, limit 50,000 base aggregates; epoch-ms interval-start timestamps. Eligible-trade aggregates may be absent. Requests can span extended hours; keep only fully covered regular-session windows. Follow same-endpoint pagination. |
| [Massive aggregate boundary explanation](https://www.massive.com/blog/aggs-api-updates) | Range snapping/stretching and base-aggregate limits can affect returned intervals. Filter to the explicit comparison horizon rather than assuming a requested end proves completeness. |
| [Massive adjustment explanation](https://massive.com/knowledge-base/article/is-massives-stock-data-adjusted-for-splits-or-dividends) | Explicit `adjusted=false` preserves unadjusted evidence. Daily split normalization is a separate calculation, never a rewrite of raw bars. |

All requests use fixed market-data hosts and sanitized failures. The transport has
a 24-request invocation budget, at most eight pages per query, at least one second
between request starts, 30-second timeouts, no redirects, and **zero automatic
retries**. Alpaca normally needs two requests; Massive intraday two; baseline four.
This bounds a single command below Basic's Alpaca budget; concurrent operator
commands and other applications still share external limits. A failure produces
no completed reference manifest. No credentials, auth headers, raw error bodies or
credential-bearing pagination URLs enter artifacts.

Alpaca requires only `ALPACA_MARKET_DATA_API_KEY`,
`ALPACA_MARKET_DATA_API_SECRET`, `ALPACA_MARKET_DATA_FEED=iex`.
Massive requires the existing global `MASSIVE_API_KEY`, with the fixed official
`https://api.massive.com` host. Neither imports application env or database code.

## Evidence and artifacts

Any archived Phase A directory is accepted via `--run-dir`. The original manifest,
observation segments and event journal are read and validated, never rewritten.

```text
<run-dir>/
  manifest.json                   # existing capture, unchanged
  observations-*.ndjson           # existing capture, unchanged
  events.ndjson                   # existing capture, unchanged
  reference/
    alpaca/<new-uuid>/
      manifest.json
      minute-bars.json
      fifteen-minute-bars.json
    massive/<new-uuid>/
      manifest.json
      bars.json
    baseline/
      manifest.json               # exclusive creation; one frozen baseline
  derived/phase-b-<new-uuid>/
    report.json
    summary.md
```

Every provider artifact explicitly identifies ALPACA/IEX or MASSIVE. Reference
manifests record run/session, exclusive requested horizon, raw adjustment,
fetch identity/time, safe page metadata/status, request endpoint/timeframe/range,
and hashes of normalized safe OHLCV plus optional trade count/VWAP. File payloads
carry provider provenance too. Hashes use SHA-256 of parsed JSON serialized in
stored property order, not bytes/whitespace. Manifests also have a content hash;
reads verify hashes and revalidate bar identities/grid. Fetches use exclusive
directory/file creation. An interrupted directory is not silently repaired;
preserve and review it separately if it prevents `latest` enumeration.

The horizon starts at the later of session open and the first whole minute after
capture start, and ends at the last elapsed whole minute, capped at session close.
Official Alpaca 15m requests further narrow to fully covered aligned windows.
Massive snapped partial boundary intervals are excluded. Late-start captures may
have useful price evidence but cannot invent the missing session prefix required
by the classifier.

`--alpaca-fetch-id` and `--massive-fetch-id` are mandatory for comparison. Each may
explicitly be `latest`, ordered by fetchedAt then fetch ID; reports retain the
resolved identity. Multiple snapshots stay immutable. Massive stability output
compares consecutive fetches, preserving earlier/later values, elapsed time,
identical values, changed OHLC/volume and appearing/disappearing intervals. No
snapshot is labeled final. Alpaca snapshots can likewise be selected independently
and analyzed again; the report compares both minute and 15-minute Alpaca revisions.

## Baseline and classification

Baseline generation fetches Massive raw daily bars from 400 calendar days before
the prior completed session through that prior session, matching the production
V1 baseline window. Split evidence runs through the capture session. It uses the
verified calendar, `normalizeSplits` and `instrumentMeasurements`; missing expected
daily dates remain null and reset Wilder seeding exactly as in the pure helper.
No current-session daily bar is used. Unavailable ATR fails baseline creation.

The frozen artifact includes exact expected dates, safe raw daily evidence with
local IDs/hashes, split evidence, prior SPY/RSP ATR14 fractions, calendar hash,
definition hash, calculation version and source-code hash, fetch times/statuses.
Both providers receive this **same object**. The reader checks integrity and
recalculates baseline values. Re-running baseline refuses to overwrite it before
making any network call.

`measureIntradaySession`, `marketRawState` and `advanceIntradayStress` are reused
directly. No copied thresholds. Both sides follow identical session-prefix,
rolling warmup, gap, immediate escalation and recovery semantics. The closing
interval is diagnostic only. Per-symbol full measurements include shock, rolling
60m movement, drawdown, acute/session collapse predicates and raw state. Reports
also include component deltas, market raw/effective states, transition explanations,
raw confusion matrix and hysteresis-only disagreement flags.

Severity is NORMAL < ELEVATED < HIGH < SEVERE. Agreement/distance and direction
are orthogonal categories: exact, adjacent or multi-level; false-negative or
false-positive **candidate**; unavailable IEX and/or Massive. HIGH/SEVERE Massive
versus NORMAL IEX and SEVERE Massive versus at-most-ELEVATED IEX are flagged.
These are source disagreements, not assertions that delayed Massive is truth.
Effective state paused over a gap is preserved for diagnostics but not counted
as comparable fresh evidence.

## Sparse semantics and time of knowledge

Every whole elapsed minute is CAPTURED when present in the capture. Otherwise:

- PROVIDER_NO_BAR requires absence in a complete, matching historical IEX minute
  reference covering that minute.
- CAPTURE_GAP means historical IEX has the minute while capture does not.
- REFERENCE_UNAVAILABLE means a complete usable covering reference is missing.

Socket continuity alone never proves no-bar. The pure reconstruction accepts an
unavailable reference and reports unavailable slots. The CLI fails on missing or
corrupt selected artifacts instead of silently analyzing them as complete.
Captured minutes retain selected/initial comparison, OHLC absolute/signed/bps
differences, volume deltas/ratios, update convergence, historical absence and
whether historical values differ from every captured version.

STRICT_15_OF_15 stays unchanged. PROVIDER_SPARSE uses first available open, maximum
high, minimum low, last available close, sum of available volumes and at least
one minute. It preserves every omitted no-bar slot and constituent provenance.
Gaps and ambiguous minutes invalidate it. No synthesized prices or zero-volume
minutes. A minute present later in the capture cannot be omitted at an earlier
cutoff, even if historical REST lacks it.

Each reconstruction is compared to official historical IEX 15m OHLCV. This first
implementation conservatively requires **exact OHLCV equality** to mark a window
validated for classification, reporting all differences rather than tuning a
tolerance. Volume equality here tests same-provider reconstruction; cross-provider
volume fidelity remains diagnostic and is not a primary acceptance criterion.
Official absence or mismatch leaves classification unavailable. Reports show
omitted slots, update count and whether hindsight equality required updates.
Discrepancies require review before treating sparse aggregation as valid semantics.

Hindsight and +30/+60/+90/+120/+300-second replay are separate. Replay filters
`receivedAt <= cutoff`; REST never supplies a live price. Each target's own cutoff
measurement is frozen for chronological effective replay, so future corrections
cannot rewrite past decisions. The exact-equality gate can conservatively exclude
an earlier live version that differs from later official evidence; reports retain
that version and its discrepancy for review. These are **hindsight-labeled live
replays**, not evidence that an operator could know a no-bar minute live. Targets
whose cutoff exceeds the capture horizon are censored and excluded from completeness.

## Partial denominators and latency

Full-session expected minutes and scheduled windows remain visible. Phase A now
also reports elapsedExpectedMinutes, elapsedObservedMinutes, elapsedMissingMinutes,
elapsedCoveragePct, uncensoredScheduledWindows, uncensoredCompleteWindows and
uncensoredCompletePct. Phase B reports per-symbol minute categories and cutoff
denominators. Zero denominators have no meaningful percentage.

Negative initial/update latency remains unchanged forensic evidence. Small negative
values can reflect relative clock offset, timestamp precision or emission near the
minute boundary; they do not independently trigger the existing one-second clock
jump detector. `latestCorrectionOffsetFromTargetMs` explicitly describes a window
correction relative to its 15m target. A correction to an interior minute can
legitimately arrive before that target. The old `latestCorrectionLatencyMs` alias
remains for Phase A compatibility. Per-minute update latency is still measured
from **minute end**, while correction lag is measured from initial receipt.

## Exact manual commands for the existing capture

Set `$runDir` to the archived directory if it moved. No recapture is needed.
Credentials must already be injected into the process; these commands do not load
application `.env`. A dedicated ignored env file can be supplied through Node's
explicit `--env-file` loader as shown below.

```powershell
$runDir = 'C:\Users\bobby\Desktop\AI Trader Backend\node_modules\.cache\intraday-stress-alpaca-iex\2026-09-22\bcadcd50-d633-469c-87e6-a7b7125210d7'
npm.cmd run research:intraday-stress:alpaca-iex:fetch-reference -- --run-dir "$runDir" --timeframes 1Min,15Min
npm.cmd run research:intraday-stress:massive:fetch-reference -- --run-dir "$runDir"
npm.cmd run research:intraday-stress:baseline -- --run-dir "$runDir"
npm.cmd run research:intraday-stress:compare -- --run-dir "$runDir" --alpaca-fetch-id latest --massive-fetch-id latest
```

Alternatively, with an ignored `.env.iex` containing the three dedicated Alpaca
variables and a separately provisioned ignored `.env.massive-research` containing
only MASSIVE_API_KEY:

```powershell
node --env-file=.env.iex --import tsx scripts/compare-alpaca-iex-intraday.ts alpaca --run-dir "$runDir" --timeframes 1Min,15Min
node --env-file=.env.massive-research --import tsx scripts/compare-alpaca-iex-intraday.ts massive --run-dir "$runDir"
node --env-file=.env.massive-research --import tsx scripts/compare-alpaca-iex-intraday.ts baseline --run-dir "$runDir"
node --import tsx scripts/compare-alpaca-iex-intraday.ts compare --run-dir "$runDir" --alpaca-fetch-id latest --massive-fetch-id latest
```

Repeat only the Massive fetch later/post-session, then compare again. Each fetch
prints its new artifact directory; replace `latest` with the printed directory's
UUID to pin a particular snapshot. Comparison prints the derived directory holding
JSON and Markdown. Preserve the run outside node_modules before dependency cleanup.

## Sampling and decision plan

Live captures establish latency, corrections, capture gaps and operational
availability. Collect several sessions with the full first hour, eventually at
least one full session. For full sessions, continue capture at least two minutes
after close to observe the documented half-minute update cycle plus margin;
this is a research horizon, not finality or a production deadline.

Take Massive snapshots after delayed availability and again later/post-session.
Choose dates before reviewing provider agreement: ordinary sessions, elevated
volatility, large opening moves, and sessions where existing Massive research
shows HIGH/SEVERE. Record the selection reason and unavailable/failed samples.
Do not cherry-pick agreement or freeze a 95% acceptance rule. Sparse adverse
examples leave authority INCONCLUSIVE.

Bounded historical IEX 15m versus Massive 15m is technically supported by the
verified endpoints, subject to entitlement/history coverage. The pure fetch,
measurements, stateComparison and revisionComparison functions accept independent
session inputs and can serve a later bounded historical runner. This task does
not add a sweep or fabricate capture journals. Historical evidence must be labeled
SOURCE_FIDELITY_ONLY and cannot establish live latency/availability. Live evidence
is explicitly labeled LIVE_CAPTURE_WITH_HINDSIGHT_REFERENCE_LABELS.

Immediate stop/reject signals for promotion: reproducible dangerous false-negative
candidates (especially the highlighted HIGH/SEVERE cases), systematic inability
to reproduce official IEX aggregates, unresolved capture gaps/ambiguity, or unusable
RSP availability at all reviewed horizons. Investigate revisions/clock/integrity
before attributing a discrepancy to IEX itself. One ordinary partial session and
excellent transport latency cannot establish source fidelity or safe authority.

Before any authority decision: inspect actual reference results, establish
same-provider sparse semantics, quantify revisions and price/classification
differences across independently selected sessions including adverse regimes,
review live no-bar detectability and cutoff censoring, and resolve documentation
ambiguities/entitlement. Any production integration requires a separate approved
design; this phase stops at tooling.

## Implementation and validation

New research modules: reference client/artifacts, baseline, comparison, manual CLI
and offline tests in `src/dev/alpaca-iex/`. Existing journal loading is shared;
capture transport and strict replay are unchanged. The static transitive boundary
now allows only the three additional pure calculation modules. Production sources
are still forbidden from importing the harness. No new dependency or UI build.

Required checks: `npm.cmd run check`, `npm.cmd run build`, focused
`npm.cmd exec vitest run src/dev/alpaca-iex`, full `npm.cmd test`,
and `git diff --check`. Tests use injected HTTP fixtures and temporary directories;
no live calls, database writes or original run mutation.

Validated 2026-09-22: TypeScript check and backend build passed; 61 focused offline
tests passed; full suite with `--maxWorkers=4` passed 2,198 tests in 199 files,
with 150 database-gated tests skipped in nine files. `git diff --check` passed.
An offline read of the actual existing capture reproduced 149 observations and
clean shutdown, SPY 80/80 elapsed minutes (100%), RSP 67/80 (83.75%), and six of ten
elapsed symbol-windows strictly complete (52 full-session symbol-windows retained).
No reference fetch or live classification result was produced during implementation.
