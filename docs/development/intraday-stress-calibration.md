# INTRADAY_STRESS_V1 research and calibration

Research recorded **2026-09-18**, on `research/intraday-stress-v1`. This is descriptive market-data research, not a production definition or trading backtest. No publisher, assessment writes, schema changes, migrations, UI, or trading integrations were added.

**Recommendation:** retain all three measurements, SPY + RSP, one all-session threshold ladder, and two-assessment recovery. **Candidate B is the preferred provisional V1 candidate. Do not freeze its SEVERE interpretation yet.** The experiment exposed two material limitations: isolated intrabar extremes can label an already-recovered market SEVERE, and a high prior ATR can leave objectively large, sub-emergency drawdowns ELEVATED. These are findings of the bounded hypothesis test, not reasons to silently introduce an untested fourth candidate.

The full quantitative appendix is [tables.md](intraday-stress/tables.md). [coverage.json](intraday-stress/coverage.json), [distributions.csv](intraday-stress/distributions.csv), [representative-targets.csv](intraday-stress/representative-targets.csv), and [diagnostics.json](intraday-stress/diagnostics.json) provide inspectable evidence. The appendix is part of this report: it contains every requested quantile, the 24-session table, all candidate frequencies, boundary examples, and persistence results.

## Repository infrastructure and boundaries

The repository inspection established:

- `MarketBar` is immutable, unadjusted MASSIVE evidence, keyed by Security/timeframe/start. Both `DAY_1` and `MINUTE_15` already exist. Daily timestamps are Eastern midnight; intraday timestamps identify interval starts.
- `src/integrations/massive/evidence.client.ts` provides authenticated, credential-safe, timeout-bounded transport and explicit split evidence. Research reuses that transport and the SPY/RSP split reader. The new generic aggregate reader remains under `src/dev/`, including diagnostic QQQ/IWM handling.
- `normalizeSplits` applies `splitFrom/splitTo` to pre-execution prices without changing stored observations. `instrumentMeasurements` supplies the existing VOLATILITY_V1 Wilder ATR semantics. No VOLATILITY assessment row is read.
- `marketSession`, `etInstant`, `etDate`, and calendar exceptions supply Eastern session boundaries and DST behavior. Existing intraday grace is five minutes. The old daily research calendar did not supply early closes; this study adds a sourced **research-only** overlay and rejects conflicts with persisted configuration.
- Earlier Volatility research used a PostgreSQL read-only snapshot; Breadth used a resumable `node_modules/.cache` provider cache. This study follows both conventions. The existing production BREADTH implementation and all other production regime behavior remain untouched; the older AGENTS description of Breadth is not used as the implementation authority.

Database reads run inside `RepeatableRead` transactions with `SET TRANSACTION READ ONLY`. No backfill inserts are performed. Existing DAY_1 observations own overlapping dates; newly downloaded daily observations are compared, not used to rewrite them. All new intraday observations remain local files.

## Coverage and evidence quality

Requested period: **2021-01-01 through the latest fully completed session**. At collection time September 18 was still open. SPY and RSP both have complete regular-session evidence through **2026-09-17**, including their final closing bars. That is the observed complete-data boundary, not an assumed availability date.

| Coverage item | Result |
| --- | --- |
| Expected sessions in requested period | 1,433 |
| Expected actionable market targets | 35,705 |
| Persisted daily SPY/RSP history reused | 2021-09-16–2026-09-17; 1,256 bars each |
| Downloaded intraday SPY/RSP history | 2021-09-20–2026-09-17; 1,254 sessions each |
| ATR-ready research sessions | 1,241; 2021-10-07–2026-09-17 |
| Valid actionable market targets | 30,905 (61,810 instrument-targets) |
| Valid four-return windows | 27,182 per instrument |
| Structurally unavailable opening windows | 3,723 per instrument: three per ATR-ready session |
| Excluded requested targets | 4,800 per instrument: 4,475 without intraday history and 325 additional ATR warm-up targets |
| Unexpected missing regular intervals after history begins | 0 |
| Invalid OHLC or misaligned regular bars detected | 0 |
| Valid closing-bar diagnostics | 1,241 per instrument, excluded from primary calibration |
| QQQ/IWM challenge sample | 56 sessions, 1,400 actionable targets each, no missing selected targets |
| Split events in queried history | None for SPY, RSP, QQQ, or IWM |

Massive returned entitlement errors for January–August 2021 (eight cached monthly failures per authoritative instrument). September requests succeeded but began September 20. The first 179 requested sessions therefore lack intraday evidence; a further 13 observed sessions lack a seeded prior ATR. There is no claim to complete calendar-2021 coverage. Missing periods are neither dropped from coverage accounting nor manufactured as NORMAL.

Regular-session filtering excludes 47,545 SPY and 11,772 RSP extended-hours bars. Ten early-close sessions occur inside the covered intraday period. Their expected interval count is 14, of which 13 produce intended actionable targets. No afternoon intervals after 13:00 ET are treated as missing on those dates.

Fresh daily responses differ from immutable stored data **only in volume** on September 14–17, 2026, for both symbols. There are eight revisions, no OHLC differences, and no effect on ATR or stress measurements. Raw observations are retained. All inspected regular intraday highs/lows fall within the corresponding daily envelope, allowing a $0.01 comparison tolerance; this cross-timeframe diagnostic does **not** establish that every extreme print reflects a sustained, executable broad-market move.

Dataset identifier: `c8b6e45297524c1d81d757b865b19143b8eedc984cfcc9421c7fdc65ab642154`. Per-symbol hashes cover ordered daily/intraday observations and explicit splits; `coverage.json` retains those hashes. The calendar is preserved in the local measurement artifact. Historical responses are final/revised evidence, not a reconstruction of what the provider had delivered at target+5 minutes in real time.

## Exact formulas and target semantics

All fields ending in `Pct` in JSON/CSV use **fractions**: `0.02` means 2%. The existing Volatility helper emits ATR percentage points, so research divides its `ATR14Pct.value` by 100 before normalization.

For each symbol, align daily bars to **every expected session**, inserting null evidence for absent/invalid sessions. Explicitly split-normalize OHLC. Define daily true range using the previous daily close; seed ATR from the first 14 valid true ranges, requiring 15 consecutive daily bars. Thereafter:

```text
dailyTR[d] = max(high[d]-low[d], abs(high[d]-close[d-1]), abs(low[d]-close[d-1]))
ATR14[d] = (13 * ATR14[d-1] + dailyTR[d]) / 14
priorAtr14Pct[s] = ATR14[previousSession(s)] / close[previousSession(s)]
```

Missing daily evidence resets the existing helper's seed. The prior-session baseline is frozen throughout the current session. The current day's DAY_1 bar is never an input to that baseline. Research normalizes daily history to a common final split basis: any later split rescales every price in an earlier prefix equally, leaving ATR/close invariant. This does not introduce future OHLC into the baseline. Tests cover split invariance and current-day isolation.

For completed regular-session interval `t`:

```text
referencePrice = first regular bar.open, if t is the first bar
                 immediately previous expected regular bar.close, otherwise
trueRange15 = max(high-low, abs(high-referencePrice), abs(low-referencePrice))
shockPct = trueRange15 / referencePrice
shockAtrRatio = shockPct / priorAtr14Pct
downsideExcursionPct = max(0, referencePrice-low) / referencePrice
downsideExcursionAtrRatio = downsideExcursionPct / priorAtr14Pct

return15[t] = close[t] / referencePrice - 1
realizedMovement60Pct = sqrt(sum(return15[t-i]^2, i=0..3))
realizedMovement60AtrRatio = realizedMovement60Pct / priorAtr14Pct
pathLength60 = sum(abs(return15[t-i]), i=0..3)     # diagnostic only

sessionPeak = max(sessionOpen, all regular highs through t)
sessionDrawdownPct = max(0, sessionPeak-close[t]) / sessionPeak
sessionDrawdownAtrRatio = sessionDrawdownPct / priorAtr14Pct
openToCurrentPct = close[t]/sessionOpen - 1       # diagnostic only
```

The first return and shock explicitly exclude the overnight gap. The first three rolling windows are `NOT_APPLICABLE_SESSION_WARMUP`, even if a separate bar/baseline failure also exists. At index 4, four returns are required. A later four-return window needs the bar preceding its first return as well. No computation bridges absent intervals. A missing session prefix makes peak drawdown unavailable for the rest of that session, even after shock/rolling evidence becomes locally complete again. The aggregate state remains unavailable when a required measurement fails; warm-up is the sole structural rolling exception.

Validation checks finite positive OHLC, nonnegative finite volume, OHLC relationships, symbol, requested timeframe/endpoint, Eastern date, exact interval alignment, duplicates, adjustment mode, and provider pagination identity. Malformed provider responses fail the relevant cached request; malformed expected bars are unavailable, never interpolated. Diagnostic challenges follow the same formulas using each challenger's own prior ATR.

Regular targets are **09:45 through 15:45 ET**, or 09:45 through 12:45 on a 13:00 close. Index 1 means 09:45. The final interval ending at session close is retained only for separately labeled diagnostics. Primary distributions, thresholds, candidate state frequencies, and recovery simulations exclude it.

Opening period is fixed at indices 1–4 (targets 09:45–10:30); non-opening is index 5 onward. This is an analysis grouping, not a separate threshold regime. `distributions.csv` also contains every individual index, all actionable targets, closing-only, and including-close groups.

Simulated usable state duration begins at target+5 minutes and ends at `min(nextTarget+5 minutes, regularSessionClose)`. Thus an ordinary target contributes 15 minutes and the last actionable target contributes 10. Episodes ending at session close are explicitly censored. No live validity or publication logic was implemented.

## Distribution findings

The measurement scales are materially different, while SPY and RSP are similar enough to share thresholds.

| Symbol / ratio | p50 | p95 | p99 | p99.9 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| SPY shock | 0.136 | 0.348 | 0.538 | 1.023 | 2.205 |
| RSP shock | 0.126 | 0.345 | 0.530 | 0.856 | 2.396 |
| SPY rolling60 | 0.154 | 0.402 | 0.599 | 1.013 | 2.206 |
| RSP rolling60 | 0.150 | 0.394 | 0.591 | 1.002 | 2.389 |
| SPY drawdown | 0.202 | 0.934 | 1.420 | 2.326 | 4.513 |
| RSP drawdown | 0.245 | 0.935 | 1.376 | 2.089 | 3.779 |

The appendix includes p75, p90, p97.5, and p99.5 as well as absolute forms and denominators. Quantiles use linear interpolation, not rounded rank buckets. Pooling does not make overlapping targets statistically independent; no significance tests or synthetic optimization scores are claimed.

The three channels detect distinct behavior. At Candidate B HIGH thresholds, **125 market targets are uniquely detected by shock, 42 by rolling60, and 131 by drawdown**, considering general channels before SEVERE overrides. Pearson correlations are 0.668/0.692 for shock versus rolling, 0.391/0.336 for shock versus drawdown, and 0.402/0.317 for rolling versus drawdown (SPY/RSP). These are descriptive correlations, not proof of causal independence. There is no evidence supporting removal of a channel.

ATR normalization substantially stabilizes typical movement across daily environments. SPY shock p95 is about 0.345 ATR with prior ATR below 1% and 0.344 with prior ATR at least 2%. Its drawdown p95 is about 0.931 versus 0.953. For RSP, shock p95 is about 0.358 versus 0.333; drawdown p95 about 0.989 versus 0.929. This distinguishes acute *relative* instability from persistently turbulent daily conditions.

It also has an explicit blind spot: **164 actionable market targets across 41 sessions** remain below raw HIGH in Candidate B despite at least one symbol showing a 1% 15-minute downside excursion or 2.5% session drawdown. Those round absolute cutoffs are diagnostic screens, not a fourth candidate. Example: **2022-05-20 13:15 ET**, SPY is 3.851% below its session peak but only 1.434 ATR; RSP is 2.855% below its peak. Both raw states remain ELEVATED. A rule based on relative surprise cannot be described as recognizing every objectively large move. Candidate B's 4% drawdown emergency handles the most extreme version, but leaves this sub-emergency gray area.

## Bounded candidate ladders

Numbers were chosen **after** inspecting the empirical distributions and deterministic representatives. A is more sensitive, B separates unusual instability from ordinary session variation more strongly, and C tests a more restrictive interpretation. They are simple rounded ladders, not fitted quantiles or optimized parameter combinations. No fourth ladder was evaluated.

All boundaries are inclusive. Below the ELEVATED bound is NORMAL; at or above HIGH is HIGH. A structurally warming-up rolling channel does not raise the state. Instrument general state is the worst of the three channels; market general state is the worse of SPY/RSP. No averaging, median, or voting is used.

| Candidate | Shock ELEVATED / HIGH | Rolling60 ELEVATED / HIGH | Drawdown ELEVATED / HIGH |
| --- | ---: | ---: | ---: |
| A | 0.35 / 0.60 ATR | 0.40 / 0.70 ATR | 0.90 / 1.50 ATR |
| **B** | **0.40 / 0.70 ATR** | **0.45 / 0.80 ATR** | **1.00 / 1.75 ATR** |
| C | 0.45 / 0.80 ATR | 0.50 / 0.90 ATR | 1.10 / 2.00 ATR |

For **either** SPY or RSP, each collapse channel is `(normalized >= extreme AND absolute >= floor) OR absolute >= emergency`. Either channel overrides the general state to SEVERE. Upside shock or direction-neutral rolling movement cannot independently produce SEVERE.

| Candidate | Acute downside: extreme / absolute floor / emergency | Session drawdown: extreme / absolute floor / emergency |
| --- | --- | --- |
| A | 1.00 ATR / 1.5% / 2.5% | 2.00 ATR / 2.0% / 4.0% |
| **B** | **1.20 ATR / 2.0% / 3.0%** | **2.50 ATR / 2.5% / 4.0%** |
| C | 1.30 ATR / 2.0% / 3.0% | 3.00 ATR / 3.0% / 5.0% |

| Candidate | Raw NORMAL | Raw ELEVATED | Raw HIGH | Raw SEVERE | Sessions with raw SEVERE |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 84.229% | 13.635% | 1.851% | 0.285% | 22 |
| **B** | **88.966%** | **9.905%** | **1.019%** | **0.110%** | **10** |
| C | 92.386% | 6.924% | 0.660% | 0.029% | 4 |

All denominators are 30,905 valid market targets. Candidate JSON files and the appendix include recovery-adjusted frequencies, per-year counts, and nearest observed values above/below every measurement boundary. For example, B's shock HIGH boundary is bracketed by SPY 0.698482 on 2024-12-18 index 24 and 0.700147 on 2025-10-10 index 10. These are measurement-boundary observations; other channels may already determine the market state.

### Candidate interpretation and limitations

**A:** finds weaker instability earlier, but calls a roughly 2% drawdown SEVERE in quiet backgrounds: 2024-04-04 and 2026-06-05 are examples. It also calls the already-recovered 1.616% SPY low excursion on 2021-12-02 SEVERE, and has another recovered excursion on 2025-05-27. These are conceptual false-positive concerns for the word “collapse,” even though the input bars pass integrity checks. It still has absolute-move underrecognition in high-ATR environments below its emergency bound.

**B:** retains HIGH for those approximately 2% drawdown sessions and SEVERE for more substantial collapse evidence, including 2024-12-18, 2025-10-10, 2025-11-20, and 2026-06-09. It recognizes extreme upside/rebound sessions, including 2025-04-09 and 2025-08-22, as HIGH without declaring SEVERE. The 2021-12-07 recovered low remains an important false-positive concern. The 2022-05-20 13:15 example above is a concrete missed/understated objectively large drawdown at that target, even though the session becomes SEVERE elsewhere.

**C:** suppresses more moderate triggers but does not fix the recovered-low problem. It leaves 2025-10-10, 2025-11-20, and 2026-06-09 below SEVERE despite substantial peak drawdowns, and entirely removes raw SEVERE in the 2022 sample. This is an overly restrictive collapse boundary for the stated hypothesis, not superior behavior simply because its frequency is lower.

## SEVERE: absolute safeguards and a failed interpretation edge

For B, 50 instrument-targets trigger SEVERE, combining to 34 market targets. Of those instrument-targets, 40 satisfy the session absolute emergency while **not** satisfying the session normalized-plus-floor conjunction. Absolute emergency behavior therefore matters in the observed sample; it is not a decorative clause. The absolute floors screen out 23 instrument-targets that exceed a normalized extreme but fail its minimum absolute magnitude. Channel counts can overlap, and floor-screened targets may qualify through another channel; they must not be added as mutually exclusive market counts.

The B acute emergency is not independently identified by this sample: its zero additional acute-emergency-only instrument-targets do not establish 3% as a validated universal cutoff. The 4% session emergency has substantially more empirical support. Both emergency numbers remain descriptive choices, not calibrated tail probabilities.

The **2021-12-07 15:00–15:15 ET SPY bar** opens 468.17, has low 458.6546, and closes 467.925. The resulting downside excursion is 2.035% / 1.471 ATR, while current drawdown is only 0.204%. All three candidates declare SEVERE. A bounded one-minute audit finds the extreme in the 15:04 minute: open 468.23, low 458.6546, close 468.315. The next minute trades around 468.3–468.47. This is direct evidence that the rule can flag an already-recovered excursion as current collapse.

That audit does **not** prove the low is an invalid trade. The daily and one-minute aggregates repeat it. No trade-condition adjudication, deletion, interpolation, or price rewriting was done. The provider explains that aggregate eligibility depends on trade conditions and that corrections can change bars: [Massive trade eligibility](https://www.massive.com/blog/understanding-trade-eligibility) and [aggregate documentation](https://www.massive.com/docs/rest/stocks/aggregates/custom-bars). Those general documents do not resolve this particular print.

The four-query audit is in [extreme-minute-audit.json](intraday-stress/extreme-minute-audit.json). It also shows isolated high prints in QQQ on 2024-08-07 and IWM on 2025-02-21. No one-minute series enters the candidate classifier. The next freeze decision must explicitly decide whether any brief intrabar downside excursion qualifies as SEVERE even when already recovered by assessment time, or whether the hypothesis needs a separately authorized, narrow persistence/data-quality clarification. This task stops at that research conclusion.

## Time of day and ordinary-rally drawdown

Opening bars differ systematically: RSP shock p95 is 0.485 ATR in indices 1–4 versus 0.282 later; SPY is 0.425 versus 0.319. Only index 4 supplies an opening rolling60 observation, so its distribution must not be confused with four independent opening windows. Session drawdown naturally accumulates later in the day.

| Candidate | Opening raw HIGH+SEVERE | Non-opening raw HIGH+SEVERE | Quiet background HIGH+SEVERE | High background HIGH+SEVERE |
| --- | ---: | ---: | ---: | ---: |
| A | 2.720% | 2.024% | 2.813% | 2.166% |
| **B** | **1.007%** | **1.153%** | **1.591%** | **1.554%** |
| C | 0.564% | 0.713% | 1.051% | 0.943% |

Quiet background means **both** prior ATRs below 1%; high background means **either** at least 2%. These are descriptive strata, not VOLATILITY_V1 classifications or dependencies. Denominators are 4,964 opening, 25,941 non-opening, 7,039 quiet, and 3,925 high-background targets. Other background targets remain in overall distributions.

B ELEVATED is more common at the open (16.720% versus 8.600%), but HIGH+SEVERE is comparable. **Keep one all-session threshold set.** The data do not justify per-bar ladders or a separate opening state machine. Closing-only tails are larger, especially drawdown; the appendix reports them separately and confirms why they must not silently enter the actionable calibration denominator.

For B, only **13 market targets on one session**, 2025-04-07, have a HIGH-level drawdown while the triggering instrument is still above its session open. Its maximum such SPY example is a 5.623% peak drawdown after a 6.946% rise from the open: this is not an ordinary healthy morning rally. A and C produce the same sole session under their respective HIGH bounds (15 and 5 targets). The audit searches all above-open drawdowns, a superset of morning-rally reversals, and finds no ordinary-rally HIGH false positive in this sample. It does not prove none can occur; ELEVATED intentionally includes smaller givebacks. Retain peak drawdown rather than substituting open-to-current return.

## Representative sessions

Selection is deterministic and independent of candidate states: top four sessions by each of normalized daily range, peak drawdown, 15-minute downside excursion, rolling60, shock, and whipsaw; four sessions nearest median normalized daily range; overlapping dates deduplicated; additional ranked extremes fill to **24** unique sessions. Whipsaw ranks whole-session close-to-close path divided by `0.001 + max absolute open-to-close return`; it is a selection diagnostic, not an authoritative metric. Daily range uses `(dailyHigh-dailyLow)/dailyOpen/priorAtr`, taking the maximum across the two instruments.

The [24-row table](intraday-stress/tables.md#representative-sessions) contains selection reasons, measurement maxima, each candidate's maximum raw state, and B's raw/two/three HIGH+ duration. The [target CSV](intraday-stress/representative-targets.csv) retains every actionable target for all 24 sessions, with per-instrument values and both recovery paths.

Useful contrasts include 2022-04-27 and 2022-06-17 (large path, small terminal return); 2024-04-04 (persistent drawdown without an extreme single shock); 2024-12-18 (multiple stress channels and downside collapse); 2025-04-07 (large whipsaw plus actual downside from peak); 2025-04-09 and 2025-08-22 (upside instability, HIGH rather than SEVERE); and 2021-12-07 (transient-print interpretation defect). Median-range controls are 2022-11-28, 2023-03-17, 2023-07-14, and 2024-06-10. None reaches HIGH in B; only 2023-07-14 reaches ELEVATED.

## QQQ / IWM diagnostic challenge

The final 56-session sample combines the 24 representatives with independently selected top-three daily ranges and top-three open-to-low excursions **per challenger per year**, deduplicated. This reduces the selection blind spot of testing only SPY/RSP extremes without downloading every challenger intraday session. There are 1,400 eligible market targets in the sample and 2,800 challenger instrument-targets. All challenger ATR baselines use their daily history through the prior session. No missing selected intervals or splits were observed.

With B, **62 challenger instrument-targets on 57 distinct market targets across 18 sessions** are HIGH/SEVERE while contemporaneous SPY/RSP raw market state is NORMAL/ELEVATED. That is 4.071% of the deliberately stress-enriched sampled market targets, **not** an estimate of full-history incremental frequency. Details for every session are in `diagnostics.json`.

- **2021-12-03 15:15 ET:** QQQ drawdown 3.186% / 1.878 ATR; SPY 2.215% / 1.725 and RSP 1.764% / 1.221. This reveals stronger technology-heavy drawdown, while SPY already sits immediately below B's HIGH drawdown boundary. It is not evidence of an entirely unobserved broad-market mechanism.
- **2023-08-24 15:45 ET:** QQQ 2.919% / 1.977 ATR versus SPY 1.642% / 1.600 and RSP 1.357% / 1.350. A legitimate concentration difference, but adding QQQ would change whose instability defines the broad market.
- **2025-02-21:** IWM adds 11 targets. The largest shock example, 11:15 ET, contains a high of 226.3576 in a minute otherwise opening 221.74 and closing 221.69. Its stronger small-cap drawdown deserves inspection, but the largest isolated trigger is not compelling independent broad-market evidence.
- **2024-08-07 14:30 ET:** QQQ's extra shock comes from a minute high of 447.5094 with open 436.01 and close 436.27. SPY/RSP are already ELEVATED. The data do not establish a new broad-market collapse.
- Several April 2025 and May 2022 extras reflect larger challenger absolute drawdowns crossing emergency bounds while SPY/RSP are just below their respective boundaries. This reinforces the absolute-magnitude caveat rather than demonstrating that four authoritative instruments solve it.

**Leave QQQ/IWM out of V1.** This bounded sample shows additional signals but not strong enough incremental broad-market evidence to expand authority. It cannot prove SPY/RSP capture every event outside the selected sessions. No news explanations or event causality are inferred from the dates.

## Recovery comparison

Both simulations start every session from its first available raw assessment, worsen immediately to any worse raw state, and require consecutive lower raw assessments before moving exactly one state toward raw. The counter resets after each recovery step and on raw equality/worsening. Unavailable assessments emit unavailable and break consecutive confirmation; they do not become neutral evidence. No observed interior gaps exercised that policy in the usable sample, so it remains a research convention to document before productionization.

| B simulation | HIGH frequency | SEVERE frequency | HIGH+ episodes / sessions | HIGH+ median / p95 min | SEVERE episodes / median min |
| --- | ---: | ---: | --- | --- | --- |
| Raw | 1.019% | 0.110% | 164 / 128 | 15 / 100 | 14 / 27.5 |
| **Two** | **1.472%** | **0.136%** | **150 / 128** | **30 / 123.25** | **12 / 30** |
| Three | 1.835% | 0.155% | 144 / 128 | 45 / 140.5 | 11 / 40 |

Two-confirmation SEVERE lasts at most 195 minutes; three reaches 210. HIGH+ episodes reaching session end increase from 23 raw to 34 with two and 39 with three. SEVERE reaches close in 6/6/7 episodes, respectively. These are censored, not observed recoveries. The appendix provides the same statistics for A and C.

For an isolated SEVERE followed only by NORMAL, two confirmations require six subsequent targets to reach NORMAL; three require nine. On the late 2021-12-07 questionable excursion, two leaves 30 minutes of SEVERE followed by 10 minutes of HIGH until close; three leaves SEVERE until close. Neither confirmation rule repairs erroneous raw interpretation. **Prefer two**: it reduces chatter with less persistence, and the third confirmation has no demonstrated compensating benefit. No other recovery counts or cross-session rules were searched.

## Answers to the thirteen research questions

1. **Distinct instability forms?** Yes: local range shock, sustained four-return movement, and accumulated peak loss each uniquely contribute HIGH detections.
2. **Removable redundancy?** None supported by the observed unique contributions and moderate correlations.
3. **Prior ATR normalization sensible?** Yes for relative instability across quiet/turbulent backgrounds; not a complete absolute-severity detector.
4. **Absolute safeguards needed?** Yes. Floors protect against small absolute moves in quiet backgrounds; a session emergency prevents large moves being normalized away. Sub-emergency understatement remains unresolved.
5. **One all-session ladder?** Supported for the provisional B candidate.
6. **Opening distinction?** Systematic measurement differences exist, but aggregate severe/high behavior does not justify an extra threshold regime here.
7. **Ordinary rally drawdown false positives?** None at candidate HIGH thresholds in this sample; above-open HIGH drawdown occurs only on the exceptional 2025-04-07 reversal.
8. **SPY/RSP sufficient?** Sufficient for the tested broad-market definition and provisional recommendation, not proven universally exhaustive.
9. **QQQ/IWM material improvement?** Extra triggers exist; the bounded audit does not justify authoritative inclusion.
10. **HIGH versus SEVERE?** HIGH may be upside or whipsaw instability. SEVERE requires actual downside magnitude, with normalized-plus-absolute or emergency collapse evidence. Already-recovered excursions remain a conceptual defect to settle.
11. **How frequent/how long?** B raw HIGH/SEVERE is 1.019%/0.110%; two-confirmation effective HIGH/SEVERE is 1.472%/0.136%; HIGH+ occurs on 128 of 1,241 valid sessions. See duration table and censoring counts.
12. **Two versus three recovery?** Prefer two. Three increases HIGH+ median duration by 15 minutes and prolongs false/transient events without established benefit.
13. **Provider/coverage concerns?** Yes: rolling entitlement truncation, unavailable early-2021 history, final historical bars versus real-time availability, extreme transient prints, and daily volume revisions. Interior expected regular-session continuity is complete in the usable sample.

## Recommended provisional algorithm and freeze conditions

The proposed V1 shape is **SPY/RSP, MINUTE_15, prior-session split-normalized Wilder ATR14, the exact three formulas above, Candidate B's independent ladders, max aggregation, downside-only dual collapse channels, and two-assessment per-step recovery with a daily reset**. Keep one ladder across the session. Exclude the closing bar from authoritative targets. Warm-up is structurally inapplicable; other missing evidence fails closed. Keep path length, open return, QQQ/IWM, and one-minute audits diagnostic only.

This is a recommendation for review, **not an algorithm freeze**. Before freezing, resolve whether the intended meaning of “collapse RIGHT NOW” permits the demonstrated recovered extreme and whether the 2.5–4% high-ATR drawdown gray area is acceptable. Trade-condition review of the identified prints and a narrowly specified semantic decision would address those questions; no broad parameter search is warranted. The sample lacks a pre-September-2021 crisis and is not an out-of-sample validation. Historical one-minute corroboration is not proof that a print was broadly tradable.

No fifth instrument, alternative data provider, execution gate, assessment consumer, or trading authority is proposed or implemented here. Productionization is explicitly outside this task.

## Reproduction, artifacts, and validation

Raw provider envelopes, calendar/database snapshots, full target measurements, and complete candidate paths remain under gitignored `node_modules/.cache/intraday-stress/`. Successful and failed requests are cached; rerunning without `--fetch` does not issue provider requests. The first run still needs a local read-only DB snapshot if it is not cached. Deliberate cache replacement is required to inspect provider revisions; failures are not automatically retried indefinitely. The authoritative fetch used 152 requests, challenger daily history 14, challenger intraday 112 plus eight updated-control cache misses, and minute audit four; one separate availability probe also succeeded. No unbounded fan-out was used. The final challenge contains 56 dates; four superseded control dates remain harmlessly cached.

```powershell
npm.cmd run research:intraday-stress -- --fetch --to 2026-09-17
npm.cmd run research:intraday-stress -- --fetch --challengers --daily-only --to 2026-09-17
npm.cmd run analyze:intraday-stress
# Inspect distributions and representatives before selecting/updating any candidate numbers.
npm.cmd run research:intraday-stress -- --fetch --challengers --to 2026-09-17
npm.cmd run analyze:intraday-stress -- docs/development/intraday-stress/candidates.json
node --import tsx scripts/inspect-intraday-stress.ts
node --import tsx scripts/audit-intraday-stress-extremes.ts --fetch
node --import tsx scripts/tabulate-intraday-stress.ts
```

The last two analysis scripts consume existing measurements/candidate artifacts; the four-case audit fetches only its explicitly listed diagnostics. Frozen report prose requires human review if a new dataset changes the findings. The cache does not belong in Git; compact summaries and representative evidence do.

Files created: `src/dev/intraday-stress-*` calculation/data/calendar/analysis modules and tests, five `scripts/*intraday-stress*.ts` research commands, this report, and its `docs/development/intraday-stress/` evidence directory. `package.json` adds collection and analysis commands. README and AGENTS add research navigation/boundaries. No production service, Prisma schema, migration, web UI, broker integration, or trading path changed.

Validation: targeted formula/provider tests; `npm.cmd run check`; `npm.cmd test -- --maxWorkers=2`; `npm.cmd run build`; cache-only replay and all artifact-generation commands. The full suite passed **189 files / 2,057 tests**, with **8 files / 134 tests skipped** by existing test guards. Database-gated suites were not enabled for this research change. No web build was needed.

### Calendar sources

The existing verified closure list is reused, including the separately sourced January 9, 2025 closure. Early-close times were checked against NYSE's published releases: [2021–2023](https://ir.theice.com/press/news-details/2020/NYSE-Group-Announces-2021-2022-and-2023-Holiday-and-Early-Closings-Calendar/default.aspx) and [2024–2026](https://ir.theice.com/press/news-details/2023/NYSE-Group-Announces-2024-2025-and-2026-Holiday-and-Early-Closings-Calendar/default.aspx). They supply the 13:00 ET early-close overlay; no calendar records were inserted or updated.
