# PARTICIPATION_V1 frozen research calibration

The research algorithm is frozen: SPY/QQQ/DIA/IWM/RSP are five equal sensors; each uses normalized current daily volume divided by the median of its previous 20 eligible completed full-session volumes. The primary measure is their median. All five are required. Thresholds are QUIET <0.75, NORMAL [0.75,1.25), ACTIVE [1.25,1.50), INTENSE >=1.50. No price direction, agreement gate, hysteresis, confirmation or jump restriction enters classification. **Production publishing has NOT been implemented; no trading authority exists.**

## Dataset and reproducibility

- Source dataset ID: `758aa1b843143c1364d9e23f708786b81c318aa633132c47cf84deaa1596b969`.
- Source file SHA-256: `48cfc35573c796ae0e7c1ffd9c4fd3d362c5e3a4e504aaf83e49e015929fcea8`.
- Requested dates: 2021-01-01 through 2026-09-18. Reviewed evidence/session plan starts 2021-01-04; observed evidence begins 2021-09-21.
- Source: `node_modules/.cache/participation-v1/reference-report.json` (kept local, not committed).
- Analysis: `node_modules/.cache/participation-v1/calibration-report.json` (deterministic JSON with source-file and analysis SHA-256 digests).

```bash
npm run analyze:participation -- --input node_modules/.cache/participation-v1/reference-report.json --output node_modules/.cache/participation-v1/calibration-report.json
```

This command uses only the source report; no provider or database calls. All metrics below were recomputed, not embedded as analyzer constants. The analyzer validates the report definition, five-symbol RVOL arithmetic, panel medians and observable baseline windows. It excludes invalid/unavailable rows and does not bridge their gaps. The original artifact was not rewritten.

## State and run behavior

There are **1,224 valid 20-session observations**, from 2021-10-19 through 2026-09-18.

| State | Count | Percentage | Runs | Mean length | Median length | Max | One-day runs | <=2-day runs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| QUIET | 160 | 13.071895% | 77 | 2.077922 | 1 | 7 | 42 | 54 |
| NORMAL | 803 | 65.604575% | 206 | 3.898058 | 3 | 23 | 56 | 89 |
| ACTIVE | 164 | 13.398693% | 124 | 1.322581 | 1 | 5 | 94 | 118 |
| INTENSE | 97 | 7.924837% | 52 | 1.865385 | 1 | 7 | 35 | 43 |

There are **1,223 comparable adjacent pairs**, **458 state changes**, and 459 runs. The descriptive annualized rate is `458 / 1223 * 252 = 94.371218` changes per 252 comparable pairs. Runs include boundary-censored runs; invalid/unavailable observations break runs. Intentionally excluded early-close dates, weekends and holidays are outside the eligible-session sequence.

Full transition matrix (rows = previous state; columns = next state):

| From / To | QUIET | NORMAL | ACTIVE | INTENSE |
| --- | ---: | ---: | ---: | ---: |
| QUIET | 83 | 73 | 4 | 0 |
| NORMAL | 71 | 597 | 101 | 34 |
| ACTIVE | 4 | 101 | 40 | 18 |
| INTENSE | 1 | 32 | 19 | 45 |

The state-change-only matrix is the same with zero diagonal. Direct multi-level jumps include QUIET -> ACTIVE (4), ACTIVE -> QUIET (4), NORMAL -> INTENSE (34), INTENSE -> NORMAL (32), and INTENSE -> QUIET (1). QUIET -> INTENSE did not occur in this sample but is permitted by the stateless definition.

## No hysteresis

One-day-run panel RVOLs:

| State | Count | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: | ---: |
| QUIET | 42 | 0.556043489 | 0.708694381 | 0.741240842 |
| NORMAL | 56 | 0.757606813 | 0.981891748 | 1.249216176 |
| ACTIVE | 94 | 1.254112823 | 1.342655608 | 1.499843546 |
| INTENSE | 35 | 1.500571128 | 1.641538002 | 2.493222235 |

Many one-day ACTIVE/INTENSE observations are materially above their lower thresholds. Their median RVOLs are 1.342656 and 1.641538, respectively. They are not merely tiny boundary crossings that obviously warrant suppression. Likewise, isolated QUIET days have a median of 0.708694.

Participation describes the latest session's activity; volume can be episodic and catalyst-driven. NORMAL -> INTENSE -> NORMAL or NORMAL -> QUIET -> NORMAL can accurately represent real one-session activity. Baseline history defines normal volume, the current completed session defines today's state, and the previous state has no influence. **No hysteresis is frozen; conceptually rawState == effectiveState.** This is a measurement-design conclusion supported by the observed behavior, not a claim that the sample proves every isolated state meaningful.

Threshold-proximity counts (inclusive diagnostic bands, no threshold changes):

| Threshold | +/-0.01 | +/-0.025 | +/-0.05 |
| --- | ---: | ---: | ---: |
| 0.75 | 20 | 74 | 135 |
| 1.25 | 22 | 40 | 82 |
| 1.50 | 15 | 22 | 57 |

Agreement counts and dispersion remain evidence only. The median of five values >= X already guarantees at least three sensors >= X. No redundant 3/5 gate is added. The JSON includes three highest/lowest examples per state with recomputed agreement and range.

## 20 versus 40 sessions

The control has **1,204 paired observations**. Classifications match on **958 (79.56810631229236%)**. There are **243 adjacent-state disagreements** and **3 multi-level disagreements**.

Confusion matrix (rows = 20-session state; columns = 40-session state):

| 20 / 40 | QUIET | NORMAL | ACTIVE | INTENSE |
| --- | ---: | ---: | ---: | ---: |
| QUIET | 110 | 45 | 0 | 0 |
| NORMAL | 57 | 684 | 45 | 3 |
| ACTIVE | 0 | 40 | 91 | 32 |
| INTENSE | 0 | 0 | 24 | 73 |

- Pearson correlation: **0.9439120847991687**.
- Median absolute panel RVOL difference: **0.06063902587982034**.
- Mean absolute panel RVOL difference: **0.08465200717358684**.
- Largest divergence: **2024-08-05**, panel20 **2.074571993468094**, panel40 **2.6902351398540563**, absolute difference **0.6156631463859621** (both INTENSE). The JSON retains the ten largest divergences.

The 40-session control provides useful validation and is strongly correlated with 20 sessions, but does not add enough distinct information to justify slower adaptation and extra historical dependence for V1. Twenty sessions is frozen. Forty-session calculations and evidence are preserved as calibration history and are not part of future V1 production semantics.

## Coverage and limits

All five ETFs share these results in the analyzed target range:

| Coverage diagnostic | Result |
| --- | --- |
| Expected eligible full sessions | 1,424 |
| Observed expected sessions per ETF | 1,244 |
| Missing expected sessions per ETF | 180 |
| Contiguous missing full-session range | 2021-01-04 through 2021-09-20 |
| First / last observed daily evidence | 2021-09-21 / 2026-09-18 |
| First valid RVOL20 and panel20 | 2021-10-19 |
| First valid RVOL40 and panel40 | 2021-11-16 |
| Panel20 available / unavailable | 1,224 / 200 |
| Panel40 available / unavailable | 1,204 / 220 |
| Intentionally excluded early-close dates | 10 |
| Recorded request/cache/provider failures | 0 (`providerGaps: []`) |

The first 20/40 reviewed full sessions also lack baseline history before the calendar boundary (20-session: through 2021-02-01; 40-session: through 2021-03-02). Those warmup categories overlap the initial missing-evidence block and must not be added to it. After evidence begins, another 20/40 preceding observed sessions are needed before RVOL becomes valid.

Missing observations do not establish a reason. In particular, this report does **not** label the 2021 block an entitlement failure: the provider returned no such recorded failure. New `evidenceCoverage` diagnostics keep missing expected evidence, unknown evidence status, reviewed-calendar warmup and excluded early closes separate from `providerGaps`. Range compaction follows consecutive eligible full sessions, not consecutive calendar days. The legacy analyzer cannot inspect raw bars outside the report's target range; it reads no cache files.

Volume remains Massive's unadjusted daily aggregate evidence with explicit split normalization on full-session dates; it is not reconstructed strictly 09:30–16:00 volume. ETF activity includes hedging/arbitrage and is not total underlying-stock participation. Neither limitation changes the frozen definition, but both must carry into future production design. No wider calendar maintenance or Intraday Stress changes are included.

**Research is frozen.** The next step is a separate production-design handoff covering immutable daily evidence, full-session scheduling and missing-evidence behavior, explicit split normalization, publication ordering/idempotency, and stateless raw/effective equality. This phase does not implement that design or grant strategy/trading authority.
