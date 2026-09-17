# Breadth threshold comparison: BASELINE vs CANDIDATE_HORIZON_V2

Recorded 2026-09-17 on `feat/external-signal-ingestion`, comparing exactly two candidate
band definitions against the identical cached 2021-09-16..2026-09-16 research dataset from
[the first calibration pass](breadth-calibration-results.md). No Massive requests were made
(`actualRequests` was `{grouped:0, universe:0}` for both runs; the comparison tool asserts
this and refuses to report otherwise). Universe, observation, warm-up, median-of-three, and
hysteresis mechanics are byte-for-byte identical between the two runs — verified by comparing
every `days[].observation` before computing anything else. This is evidence for the owner's
decision, not a decision, and not a wider threshold search: exactly one candidate was tested.

## Run it yourself

```powershell
npm.cmd run compare:breadth-thresholds -- --from 2021-09-16 --to 2026-09-16 --output breadth-threshold-comparison.json
```

Fails closed with an exact list of missing dates (`MissingCacheError`) if the disk cache at
`node_modules/.cache/breadth/` is incomplete, rather than silently fetching anything.

## Definitions compared

| Horizon | BASELINE | CANDIDATE_HORIZON_V2 |
| --- | --- | --- |
| breadth1 | 0.45 / 0.55 | 0.45 / 0.55 (unchanged) |
| breadth5 | 0.45 / 0.55 | 0.47 / 0.53 |
| breadth20 | 0.45 / 0.55 | 0.48 / 0.52 |

## 1. Effective state distribution

| State | BASELINE | CANDIDATE | Change |
| --- | ---: | ---: | ---: |
| POSITIVE | 6.00% | 9.98% | +3.98pp |
| MIXED | 58.31% | 37.79% | -20.52pp |
| NEGATIVE | 35.69% | 52.23% | +16.54pp |

MIXED shrank sharply as hypothesized, but **the freed-up share went overwhelmingly to
NEGATIVE, not POSITIVE** — roughly 4x more of the reduction landed in NEGATIVE than in
POSITIVE. Every single year shows the same lopsided pattern (e.g. 2024: POSITIVE 4.37% ->
6.35%, NEGATIVE 32.94% -> 52.38%; full year-by-year table in the generated report).

## 2. Raw horizon classification distribution

The 1-day distribution is identical by construction (its band is unchanged: 43.13% NEGATIVE
/ 18.21% MIXED / 38.66% POSITIVE, both definitions). The smoothed horizons show why the
distribution above skews negative:

| Horizon | | BASELINE | CANDIDATE |
| --- | --- | ---: | ---: |
| 5d | POSITIVE | 21.79% | 30.05% |
| 5d | MIXED | 49.12% | 31.01% |
| 5d | NEGATIVE | 29.09% | 38.94% |
| 20d | POSITIVE | 4.30% | 19.30% |
| 20d | MIXED | 79.97% | 41.36% |
| 20d | NEGATIVE | 15.73% | 39.33% |

The 20-day baseline band was indeed functioning as a near-permanent MIXED vote (79.97% of
all sessions) — the hypothesis's core premise is confirmed. But narrowing it moved roughly
2.5x as much mass into NEGATIVE (+23.6pp) as into POSITIVE (+15.0pp), because the underlying
20-session mean advanceShare is centered close to ~0.487-0.49 (per the first calibration
pass), not 0.50. Placing `negativeMax` at 0.48 sits almost exactly on that center, so nearly
half of all 20-day readings already fall at or below it; placing `positiveMin` at 0.52 is
still a full 3+ points above the center, a comparatively rarer deviation. The bands look
symmetric around 0.50 but are not symmetric around where the data actually sits.

## 3. Horizon agreement

| Metric | BASELINE | CANDIDATE |
| --- | ---: | ---: |
| All three agree | 16.87% | 25.30% |
| Exactly two of three agree | 73.56% | 60.58% |
| 1d disagrees with both 5d and 20d | 37.31% | 23.03% |
| 5d and 20d agree with each other | 54.18% | 48.34% |
| Both 5d and 20d NEGATIVE | 9.16% | 22.79% |
| Both 5d and 20d MIXED | 42.42% | 15.33% |
| Both 5d and 20d POSITIVE | 2.60% | 10.22% |

Overall three-way agreement improved (16.87% -> 25.30%) and the 1-day outlier rate dropped
(37.31% -> 23.03%), both in the hypothesized direction. But **5d/20d mutual agreement did not
improve** (54.18% -> 48.34%, slightly worse) — narrowing both bands did not make the two
smoothed horizons agree with each other more often, only with the raw 1-day reading somewhat
more often.

## 4. Transition / run behavior — the key negative finding

| Metric | BASELINE | CANDIDATE |
| --- | ---: | ---: |
| Total transitions | 264 | **314** |
| Median run length | 3 | **2** |
| 1-day runs | 43 | **68** |
| <=2-day runs | 114 | **166** |
| Longest NEGATIVE run | 21 | 37 |
| Longest MIXED run | 36 | 14 |
| Longest POSITIVE run | 7 | 14 |

**The candidate does not reduce churn — it increases it.** Every churn metric moved the
wrong way relative to the stated hypothesis ("reduce unnecessary effective-state churn"):
more transitions, a shorter median run, and more one- and two-day runs. Narrower bands make
the raw classification more sensitive to normal day-to-day drift in the smoothed averages,
which shows up directly as more frequent effective-state flips despite the unchanged
hysteresis mechanics.

## 5. Deterioration vs. recovery transitions

| Metric | BASELINE | CANDIDATE |
| --- | ---: | ---: |
| Immediate deterioration | 132 | 153 |
| Confirmed recovery | 132 | 161 |
| MIXED -> NEGATIVE | 90 | 101 |
| NEGATIVE -> MIXED | 90 | 110 |
| MIXED -> POSITIVE | 42 | 51 |
| POSITIVE -> MIXED | 41 | 42 |
| **POSITIVE -> NEGATIVE** | **1** | **10** |
| NEGATIVE -> POSITIVE | impossible under hysteresis (one-step recovery only) | impossible under hysteresis |

The one-step, multi-severity-level immediate drop from POSITIVE straight to NEGATIVE (no
MIXED pause) is **10x more common** under the candidate (1 -> 10 occurrences across 5 years).
This is a direct, mechanical consequence of the narrower bands combined with the unchanged
"any drop is immediate" deterioration rule: a smaller dip in the smoothed averages is now
enough to cross both the POSITIVE and NEGATIVE boundaries in a single session.

## 6. Important market periods

| Period | Metric | BASELINE | CANDIDATE |
| --- | --- | ---: | ---: |
| 2022 | POSITIVE / MIXED / NEGATIVE | 4.78 / 47.81 / 47.41 | 10.76 / 27.89 / 61.35 |
| 2022 | Transitions | 51 | 60 |
| 2023 | POSITIVE / MIXED / NEGATIVE | 12.00 / 54.40 / 33.60 | 16.40 / 34.00 / 49.60 |
| 2023 | Transitions | 66 | 69 |
| 2024 | POSITIVE / MIXED / NEGATIVE | 4.37 / 62.70 / 32.94 | 6.35 / 41.27 / 52.38 |
| 2024 | Transitions | 53 | 71 |
| 2025-04-01..05-15 | POSITIVE / MIXED / NEGATIVE | 15.63 / 46.88 / 37.50 | 18.75 / 37.50 / 43.75 |
| 2025-04-01..05-15 | Transitions | 10 | 10 |

2022 (the bear-market year) reads more decisively NEGATIVE under the candidate — arguably a
sharper, more useful signal for that specific year. But 2023 and especially 2024 (both
positive-index-return years) also become *more* NEGATIVE, not more POSITIVE, under the
candidate: 2024 NEGATIVE nearly doubles (32.94% -> 52.38%) while POSITIVE barely moves (4.37%
-> 6.35%). The candidate does not resolve the original finding that POSITIVE stays rare
through the narrow, mega-cap-led 2023-2024 rally — if anything, 2024 now reads as more
broadly negative than before, which is a harder claim to support given the index's actual
2024 return.

## 7. Strongest daily breadth (evidence-stability check)

Confirmed unchanged: the strongest positive/negative daily `advanceShare` sessions are
identical between definitions — thresholds affect classification only, never the underlying
per-session evidence.

## 8. Dates whose effective state changed

**269 of 1,255 session dates (21.43%)** have a different effective state under
CANDIDATE_HORIZON_V2:

| Change | Count | Share of changes |
| --- | ---: | ---: |
| MIXED -> NEGATIVE | 204 | 75.8% |
| MIXED -> POSITIVE | 57 | 21.2% |
| POSITIVE -> MIXED | 8 | 3.0% |

Three of every four changed dates moved from MIXED to NEGATIVE, confirming the same skew
found in every other section. A representative sample of changed dates is in the full
generated report/JSON; none showed an obvious data artifact.

## Answers to the decision questions

1. **Does narrowing longer-horizon bands materially reduce MIXED?** Yes, substantially
   (58.31% -> 37.79% overall; 20-day raw MIXED 79.97% -> 41.36%).
2. **Does POSITIVE become meaningfully represented in 2023-2024?** No. 2023 improves modestly
   (12.00% -> 16.40%); 2024 barely moves (4.37% -> 6.35%) and remains rare.
3. **Does NEGATIVE remain prominent during 2022?** Yes, more so (47.41% -> 61.35%).
4. **Do 5d/20d directional states occur often enough to carry structural information?** Yes —
   both horizons leave near-permanent-MIXED behind and register NEGATIVE/POSITIVE far more
   often. Whether that added information is *correctly weighted* is a separate question (see 7).
5. **Does all-three-horizon agreement improve?** Partially. All-three-agree and the 1-day
   outlier rate both improve; 5d/20d mutual agreement does not (54.18% -> 48.34%).
6. **Does effective-state churn improve?** **No — it gets worse on every measure**: more
   transitions (264 -> 314), a shorter median run (3 -> 2), and more one-day (43 -> 68) and
   <=2-day (114 -> 166) runs.
7. **Does the candidate introduce any obvious pathology?** Yes, two: (a) a strong, consistent
   skew toward NEGATIVE rather than a balanced three-way redistribution — the underlying
   advance-share series is centered below 0.50, so bands drawn symmetrically around 0.50 are
   not symmetric relative to the data; (b) a 10x increase in one-step POSITIVE-to-NEGATIVE
   shocks (1 -> 10 occurrences), a direct side effect of narrower bands combined with the
   unchanged immediate-deterioration rule.
8. **Is the remaining MIXED share plausibly useful, or a consequence of threshold
   compression?** Largely the latter, for the negative side specifically: the reduction in
   MIXED is not a clean three-way rebalancing so much as a mechanical reallocation into
   NEGATIVE, because the bands were centered on 0.50 rather than on the data's own center.

## Bottom line for the owner

CANDIDATE_HORIZON_V2 achieves some of its intended goals (less MIXED, somewhat better
three-way agreement, more informative 5d/20d readings) but fails its most explicitly stated
goal — reducing churn — and introduces a real distributional skew toward NEGATIVE plus a much
higher rate of one-step POSITIVE-to-NEGATIVE shocks. No third candidate was created or tested,
per the request; these results are reported as-is for the next decision.

See [implementation](breadth-calibration.md) and [the first calibration pass results](breadth-calibration-results.md).
No schema, migration, authoritative BREADTH row, or trading behavior changed. TREND_V1 and
VOLATILITY_V1 are untouched.
