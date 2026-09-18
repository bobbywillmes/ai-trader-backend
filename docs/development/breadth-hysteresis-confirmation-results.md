# Breadth hysteresis experiment: STRUCTURAL_V3_MILD_DETERIORATION_CONFIRMATION

Recorded 2026-09-17 on `feat/external-signal-ingestion`. A single hysteresis-only experiment
against the identical cached 2021-09-16..2026-09-16 research dataset used by every prior
Breadth research pass. CANDIDATE_STRUCTURAL_V3's thresholds and raw aggregation rule are
**unchanged** — this variant replays a different effective-state rule over
CANDIDATE_STRUCTURAL_V3's own, unmodified raw-state sequence. No Massive requests were made
(`actualRequests` was `{grouped:0, universe:0}` for all three underlying research runs). This
is evidence for the owner's decision, not a decision, and not permission to try a fifth
definition.

## Run it yourself

```powershell
npm.cmd run compare:breadth-mild-deterioration -- --from 2021-09-16 --to 2026-09-16 --output breadth-mild-deterioration.json
```

Fails closed with `MissingCacheError` if the disk cache is incomplete. The tool also asserts,
before writing any output: the mild variant's raw-state sequence equals STRUCTURAL_V3's
raw-state sequence exactly; every transitioned day moves exactly one severity level (so
`POSITIVE -> NEGATIVE` stays exactly zero); and every genuine-NEGATIVE response-speed check
below is fully verified. Any violation throws instead of reporting a result.

## What changed

Only effective-state hysteresis. `POSITIVE` treats a single raw `MIXED` day as ambiguous, not
deterioration: it holds `POSITIVE` for one supporting `MIXED` day (`mildDeteriorationConfirmation
= 1`), and only drops to `MIXED` on a *second* consecutive raw `MIXED`. A raw `NEGATIVE` reading
is never mild — it still drops one level immediately with no confirmation delay, from either
`POSITIVE` or `MIXED`. Recovery (`NEGATIVE -> MIXED`, `MIXED -> POSITIVE`) is completely
unchanged: two consecutive supporting sessions, exactly one level. Two independent counters
(`recoveryConfirmation`, `mildDeteriorationConfirmation`) are tracked, never conflated.

## 1. Raw-state identity

Confirmed: the mild variant's raw-state sequence is read directly from
`CANDIDATE_STRUCTURAL_V3`'s own `days[].rawState` and never recomputed — identity holds by
construction. The comparison tool additionally asserts byte-identical equality before
reporting anything else.

## 2. Effective state distribution

| State | BASELINE | CANDIDATE_HORIZON_V2 | STRUCTURAL_V3 | MILD_DETERIORATION_CONFIRMATION |
| --- | ---: | ---: | ---: | ---: |
| POSITIVE | 6.00% | 9.98% | 14.92% | **24.09%** |
| MIXED | 58.31% | 37.79% | 46.63% | 37.79% |
| NEGATIVE | 35.69% | 52.23% | 38.44% | 38.12% |

| Year | V3-POS | V3-MIX | V3-NEG | MILD-POS | MILD-MIX | MILD-NEG |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2021 (partial) | 24.53% | 39.62% | 35.85% | 30.19% | 33.96% | 35.85% |
| 2022 | 14.74% | 37.85% | 47.41% | 21.51% | 31.87% | 46.61% |
| 2023 | 20.40% | 41.60% | 38.00% | 31.60% | 30.80% | 37.60% |
| 2024 | 13.89% | 51.59% | 34.52% | 24.60% | 41.27% | 34.13% |
| 2025 | 12.40% | 50.40% | 37.20% | 21.20% | 41.60% | 37.20% |
| 2026 (partial) | 9.60% | 55.93% | 34.46% | 18.64% | 46.89% | 34.46% |

POSITIVE increased materially, not just "somewhat": +9.17pp overall (14.92% -> 24.09%, a 61%
relative increase), and by 7-11pp in every individual year. NEGATIVE is essentially unchanged
(38.44% -> 38.12%) — expected, since NEGATIVE-side hysteresis was not touched at all. **This is
flagged, not assumed acceptable** — see Section 8 for the most extreme instance.

## 3. Transition / run behavior

| Metric | BASELINE | V2 | STRUCTURAL_V3 | MILD_DETERIORATION_CONFIRMATION |
| --- | ---: | ---: | ---: | ---: |
| Total transitions | 264 | 314 | 330 | **286** |
| Median run length | 3 | 2 | 3 | 3 |
| Mean run length | 4.6528 | 3.9143 | 3.7251 | 4.2962 |
| 1-day runs | 43 | 68 | 63 | **35** |
| <=2-day runs | 114 | 166 | 164 | **124** |

The mild-deterioration confirmation **materially reduces churn relative to STRUCTURAL_V3** on
every metric: transitions fall 13.3% (330 -> 286), one-day runs fall 44% (63 -> 35) and now beat
BASELINE outright (35 vs. 43), and <=2-day runs fall 24% (164 -> 124), landing much closer to
BASELINE (114) than STRUCTURAL_V3 ever did. Transitions remain 8.3% above BASELINE (286 vs.
264) — an improvement, not a full match.

## 4. Transition pairs

| Transition | BASELINE | V2 | STRUCTURAL_V3 | MILD_DETERIORATION_CONFIRMATION |
| --- | ---: | ---: | ---: | ---: |
| POSITIVE -> MIXED | 41 | 42 | 72 | **50** |
| MIXED -> POSITIVE | 42 | 51 | 71 | **49** |
| MIXED -> NEGATIVE | 90 | 101 | 94 | 94 |
| NEGATIVE -> MIXED | 90 | 110 | 93 | 93 |
| POSITIVE -> NEGATIVE | 1 | 10 | 0 | **0** |
| NEGATIVE -> POSITIVE | 0 | 0 | 0 | 0 |

The identified mechanism was addressed directly: POSITIVE<->MIXED cycling fell from 143
combined events (72+71) to 99 (50+49), a 31% reduction. MIXED<->NEGATIVE counts are unchanged
(94/93 vs. STRUCTURAL_V3's 94/93) — exactly as expected, since NEGATIVE-side hysteresis was not
touched. Direct POSITIVE -> NEGATIVE is confirmed zero (asserted programmatically).

## 5. Mild-deterioration diagnostic

| Metric | Count |
| --- | ---: |
| Effective POSITIVE encountered raw MIXED | 126 |
| ...of which: first-day mild-deterioration hold (stayed POSITIVE) | 81 |
| ...of which: second consecutive raw MIXED (transitioned to MIXED) | 45 |
| Raw returned to POSITIVE before a second MIXED (reset the hold) | 32 |
| Raw became NEGATIVE from POSITIVE (immediate drop to MIXED, no mild delay) | 5 |

Of the 126 times effective POSITIVE encountered a raw MIXED reading, 81 (64%) were resolved as
a genuine one-day hold (32 of those because raw returned to POSITIVE immediately after — a
real ambiguous blip, not a sustained move), and 45 (36%) were confirmed by a second consecutive
MIXED and correctly transitioned down. The confirmation is filtering isolated ambiguous days,
not merely delaying an inevitable transition: roughly a quarter of all encounters (32/126)
would have been an unnecessary round-trip under STRUCTURAL_V3's rule.

## 6. Genuine-negative response speed

| Metric | Count | Verified |
| --- | ---: | ---: |
| POSITIVE + raw NEGATIVE -> same-assessment MIXED | 5 | 5/5 |
| ...followed by a next-valid-assessment raw NEGATIVE -> effective NEGATIVE | 4 | 4/4 |

Every genuinely negative reading from POSITIVE dropped to MIXED on the same assessment with no
confirmation delay (5/5), and every sustained second raw NEGATIVE reading reached effective
NEGATIVE on that next assessment (4/4). No extra latency was introduced for real deterioration.

## 7. Recovery behavior

| Metric | STRUCTURAL_V3 | MILD_DETERIORATION_CONFIRMATION |
| --- | ---: | ---: |
| NEGATIVE -> MIXED | 93 | 93 |
| MIXED -> POSITIVE | 71 | 49 |

`NEGATIVE -> MIXED` is unchanged (93 = 93), confirming the NEGATIVE-side recovery path is
untouched. `MIXED -> POSITIVE` recoveries fell from 71 to 49 — not because recovery became
easier, but because fewer POSITIVE-to-MIXED *exits* happened in the first place (Section 4),
so fewer re-entries were needed. Every transitioned mild-variant day is asserted to move
exactly one severity level; no recovery occurs on one supporting session, and none jumps two
states.

## 8. Important market periods

| Period | Metric | STRUCTURAL_V3 | MILD_DETERIORATION_CONFIRMATION |
| --- | --- | ---: | ---: |
| 2022 | POSITIVE/MIXED/NEGATIVE | 14.74/37.85/47.41 | 21.51/31.87/46.61 |
| 2022 | Transitions | 68 | 60 |
| 2023 | POSITIVE/MIXED/NEGATIVE | 20.40/41.60/38.00 | 31.60/30.80/37.60 |
| 2023 | Transitions | 69 | 53 |
| 2024 | POSITIVE/MIXED/NEGATIVE | 13.89/51.59/34.52 | 24.60/41.27/34.13 |
| 2024 | Transitions | 72 | 64 |
| 2025-04-01..05-15 | POSITIVE/MIXED/NEGATIVE | 21.88/34.38/43.75 | **40.63/15.63/43.75** |
| 2025-04-01..05-15 | Transitions | 10 | 4 |

Stabilization is broad, not confined to one period — transitions fall in every period examined
(68->60, 69->53, 72->64, 10->4). But the POSITIVE increase is **not uniform and is most extreme
in the shortest, most volatile window**: the 2025-04-01..05-15 recovery period goes from
POSITIVE being the *smallest* of the three states under STRUCTURAL_V3 (21.88%, below MIXED's
34.38%) to being effectively tied with NEGATIVE and nearly triple MIXED under the mild variant
(40.63% POSITIVE vs. 43.75% NEGATIVE vs. only 15.63% MIXED). This specific period is the
clearest instance of the flagged POSITIVE-stickiness effect.

## 9. Dates whose effective state changed

**117 of 1,255 session dates (9.32%)** changed, entirely because of hysteresis (raw evidence is
identical):

| Change (STRUCTURAL_V3 -> MILD_DETERIORATION_CONFIRMATION) | Count |
| --- | --- |
| MIXED -> POSITIVE | 113 |
| NEGATIVE -> MIXED | 4 |

96.6% of all changed dates are MIXED becoming POSITIVE — the direct, expected footprint of no
longer collapsing POSITIVE on a single ambiguous day. The 4 NEGATIVE -> MIXED dates are a
second-order effect: a day that used to register NEGATIVE only because the immediately
preceding day had already (incorrectly, under the old rule) dropped past MIXED. No changed date
showed an obvious data artifact (see the generated report for the full sample).

## 10. Longest runs

| State | STRUCTURAL_V3 | MILD_DETERIORATION_CONFIRMATION |
| --- | ---: | ---: |
| NEGATIVE | 17 | 17 |
| MIXED | 18 | 17 |
| POSITIVE | 16 | **22** |

NEGATIVE is unchanged (17 = 17), consistent with an untouched NEGATIVE-side path. The longest
POSITIVE run grew from 16 to 22 sessions (+38%) — the single clearest "excessive persistence"
signal in this experiment, and the run-length counterpart to the Section 8 finding.

## Answers to the decision questions

1. **Did total transitions materially decline from STRUCTURAL_V3's 330?** Yes — 330 -> 286
   (-13.3%), though still 8.3% above BASELINE's 264.
2. **Did POSITIVE -> MIXED transitions decline materially from 72?** Yes — 72 -> 50 (-30.6%).
3. **Did MIXED -> POSITIVE cycling decline as a consequence?** Yes — 71 -> 49 (-31.0%), driven
   by fewer POSITIVE exits rather than harder recovery.
4. **Did median run length improve?** No change — ties STRUCTURAL_V3 and BASELINE at 3 (already
   better than V2's 2).
5. **Did one-day runs improve?** Yes, substantially — 63 -> 35, now *better than BASELINE*
   (43).
6. **Did <=2-day runs improve?** Yes — 164 -> 124, much closer to BASELINE (114) than
   STRUCTURAL_V3 ever reached.
7. **Were direct POSITIVE -> NEGATIVE flips still zero?** Yes, exactly zero, asserted
   programmatically.
8. **Did genuine raw NEGATIVE evidence still cause immediate deterioration?** Yes — 5/5
   same-assessment drops to MIXED, 4/4 sustained readings reaching NEGATIVE on the very next
   valid assessment; no added latency.
9. **Did NEGATIVE recovery remain conservative?** Yes — `NEGATIVE -> MIXED` count is identical
   (93 = 93) to STRUCTURAL_V3, and every transition is asserted to move exactly one level.
10. **Did effective POSITIVE become excessively sticky or dominant?** Materially stickier, not
    dominant. POSITIVE rose from 14.92% to 24.09% overall (still below both MIXED's 37.79% and
    NEGATIVE's 38.12%, so not the plurality state) but the longest POSITIVE run grew 16 -> 22
    sessions, and in the 2025-04-01..05-15 window POSITIVE (40.63%) overtook MIXED (15.63%)
    entirely — a real, flagged behavioral change, not a marginal one.
11. **Did MIXED remain meaningfully represented?** Yes — 37.79% overall, though down from
    STRUCTURAL_V3's 46.63%.
12. **Did the variant introduce any new pathology?** Yes, the one described in Q10: a
    meaningfully more persistent POSITIVE state, most visible in short volatile windows.
    Otherwise no new pathology — direct POSITIVE->NEGATIVE stays zero, NEGATIVE response speed
    stays immediate, and NEGATIVE-side recovery is provably unchanged.

## Bottom line for the owner

The experiment's core hypothesis holds: treating a single raw MIXED day as ambiguous rather
than deterioration measurably reduces POSITIVE/MIXED churn (transitions -13.3%, one-day runs
-44% and now better than BASELINE, POSITIVE<->MIXED cycling -31%) without weakening the
response to genuine NEGATIVE evidence (verified immediate in every case). The tradeoff is a
materially larger and more persistent effective POSITIVE state (+9.17pp overall, longest run
16 -> 22 sessions), concentrated most heavily in short volatile periods (2025-04-01..05-15).
Total transitions (286) still exceed BASELINE (264); this is an improvement over STRUCTURAL_V3,
not a full resolution. Per the stop condition, no further hysteresis or threshold tweak is
proposed here regardless of this reading — this result is reported as-is for the owner's next
decision on the Breadth state abstraction itself.

See [implementation](breadth-calibration.md), [the first calibration pass results](breadth-calibration-results.md),
[the threshold comparison](breadth-threshold-comparison.md), [the distribution diagnostic](breadth-distribution-diagnostic.md),
and [the structural candidate results](breadth-structural-v3-results.md). No schema, migration,
authoritative BREADTH row, or trading behavior changed. TREND_V1 and VOLATILITY_V1 are
untouched.
