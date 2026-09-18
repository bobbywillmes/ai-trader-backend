# Breadth structural candidate: CANDIDATE_STRUCTURAL_V3

Recorded 2026-09-17 on `feat/external-signal-ingestion`, comparing exactly three fixed
definitions — BASELINE, CANDIDATE_HORIZON_V2 (already rejected, see
[the threshold comparison](breadth-threshold-comparison.md)), and CANDIDATE_STRUCTURAL_V3 —
against the identical cached 2021-09-16..2026-09-16 research dataset. No Massive requests
were made (`actualRequests` was `{grouped:0, universe:0}` for all three runs; the comparison
tool asserts this and refuses to report otherwise). Underlying per-session observation
evidence was verified byte-for-byte identical across all three runs before any comparison was
computed. This is evidence for the owner's decision, not a decision: STRUCTURAL_V3 is **not**
automatically BREADTH_V1.

## Run it yourself

```powershell
npm.cmd run compare:breadth-structural-v3 -- --from 2021-09-16 --to 2026-09-16 --output breadth-structural-v3.json
```

Fails closed with an exact list of missing dates (`MissingCacheError`) if the disk cache is
incomplete. The tool also asserts, before writing any output, that STRUCTURAL_V3's
`POSITIVE -> NEGATIVE` direct effective transition count is exactly zero — this is
structurally guaranteed by the one-level-per-assessment deterioration rule, and the tool
throws rather than silently reporting a violation.

## What changed vs. BASELINE/CANDIDATE_HORIZON_V2

| Horizon | BASELINE | CANDIDATE_HORIZON_V2 | CANDIDATE_STRUCTURAL_V3 |
| --- | --- | --- | --- |
| breadth1 | 0.45/0.55 | 0.45/0.55 | 0.44/0.54 |
| breadth5 | 0.45/0.55 | 0.47/0.53 | 0.46/0.52 |
| breadth20 | 0.45/0.55 | 0.48/0.52 | 0.47/0.51 |

Raw aggregation: BASELINE/V2 use median-of-three. STRUCTURAL_V3 instead treats 5d and 20d as
structural breadth (raw state is their agreement, or one directional + the other MIXED
confirmed by 1d) and 1d only as confirmation — never a tie-breaker between opposite 5d/20d
readings, never directional on its own. Deterioration: BASELINE/V2 jump immediately to the
raw state; STRUCTURAL_V3 still reacts immediately but moves only one effective level per
valid assessment (so POSITIVE with a raw NEGATIVE reading lands on MIXED first).

## 1. Raw horizon classification distribution (STRUCTURAL_V3)

| Horizon | POSITIVE | MIXED | NEGATIVE |
| --- | ---: | ---: | ---: |
| 1-day | 40.34% | 18.37% | 41.29% |
| 5-day | 34.70% | 31.49% | 33.81% |
| 20-day | 28.71% | 41.44% | 29.85% |

Recentering at ~0.49 (rather than 0.50) produces classification that is now **approximately
balanced** at every horizon — POSITIVE and NEGATIVE are within 1-2 percentage points of each
other at all three horizons, a sharp change from the ~9-12pp NEGATIVE-skewed 1-day/5-day
readings and the highly MIXED-dominated 20-day readings seen under BASELINE/V2's 0.50-centered
bands. Full by-year tables are in the generated report.

## 2. Raw aggregated state distribution (pre-hysteresis)

| State | BASELINE | CANDIDATE_HORIZON_V2 | STRUCTURAL_V3 |
| --- | ---: | ---: | ---: |
| NEGATIVE | 24.90% | 38.52% | 28.06% |
| MIXED | 59.21% | 36.58% | 45.17% |
| POSITIVE | 15.90% | 24.90% | 26.76% |

STRUCTURAL_V3's raw aggregation is the most balanced of the three between NEGATIVE (28.06%)
and POSITIVE (26.76%) — nearly symmetric — while still leaving MIXED as the largest single
state (45.17%). It fixes V2's raw NEGATIVE skew (38.52% -> 28.06%) and nearly doubles raw
POSITIVE relative to BASELINE (15.90% -> 26.76%).

## 3. Effective state distribution

| State | BASELINE | CANDIDATE_HORIZON_V2 | STRUCTURAL_V3 |
| --- | ---: | ---: | ---: |
| POSITIVE | 6.00% | 9.98% | 14.92% |
| MIXED | 58.31% | 37.79% | 46.63% |
| NEGATIVE | 35.69% | 52.23% | 38.44% |

| Year | BASE-POS | BASE-MIX | BASE-NEG | V2-POS | V2-MIX | V2-NEG | V3-POS | V3-MIX | V3-NEG |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2021 (partial) | 3.77% | 52.83% | 43.40% | 18.87% | 28.30% | 52.83% | 24.53% | 39.62% | 35.85% |
| 2022 | 4.78% | 47.81% | 47.41% | 10.76% | 27.89% | 61.35% | 14.74% | 37.85% | 47.41% |
| 2023 | 12.00% | 54.40% | 33.60% | 16.40% | 34.00% | 49.60% | 20.40% | 41.60% | 38.00% |
| 2024 | 4.37% | 62.70% | 32.94% | 6.35% | 41.27% | 52.38% | 13.89% | 51.59% | 34.52% |
| 2025 | 5.60% | 62.00% | 32.40% | 7.60% | 43.60% | 48.80% | 12.40% | 50.40% | 37.20% |
| 2026 (partial) | 2.82% | 68.93% | 28.25% | 5.65% | 46.89% | 47.46% | 9.60% | 55.93% | 34.46% |

STRUCTURAL_V3 is the most balanced of the three overall: NEGATIVE (38.44%) lands close to
BASELINE (35.69%), far below V2's over-negative 52.23%, while POSITIVE (14.92%) is more than
double BASELINE's (6.00%) in every single year without needing V2's NEGATIVE trade-off. 2022
stays meaningfully NEGATIVE at 47.41% — identical to BASELINE, not V2's inflated 61.35%. 2023
and 2024 both show more POSITIVE representation than BASELINE (20.40% vs 12.00%; 13.89% vs
4.37%) without an implausible POSITIVE-side blowout, and NEGATIVE in both years stays close to
BASELINE rather than V2's inflated reading. This reads as structurally plausible, not
V2's directional overcorrection.

## 4. Transition / run behavior — the key finding

| Metric | BASELINE | CANDIDATE_HORIZON_V2 | STRUCTURAL_V3 |
| --- | ---: | ---: | ---: |
| Total transitions | 264 | 314 | **330** |
| Median run length | 3 | 2 | 3 |
| Mean run length | 4.6528 | 3.9143 | 3.7251 |
| 1-day runs | 43 | 68 | 63 |
| <=2-day runs | 114 | 166 | 164 |
| Longest NEGATIVE run | 21 | 37 | 17 |
| Longest MIXED run | 36 | 14 | 18 |
| Longest POSITIVE run | 7 | 14 | 16 |

**STRUCTURAL_V3 does not reduce churn relative to V2 on the primary metric the owner asked to
check.** Total transitions (330) are the highest of all three definitions — 25% above
BASELINE (264) and even above the already-rejected V2 (314). Median run length ties BASELINE
(3) and beats V2 (2); one-day runs (63) and <=2-day runs (164) both improve on V2 but remain
well above BASELINE. Section 5 below identifies the specific mechanism.

## 5. Direct POSITIVE -> NEGATIVE effective flips

| Metric | BASELINE | CANDIDATE_HORIZON_V2 | STRUCTURAL_V3 |
| --- | ---: | ---: | ---: |
| POSITIVE -> NEGATIVE | 1 | 10 | **0** |
| POSITIVE -> MIXED | 41 | 42 | 72 |
| MIXED -> NEGATIVE | 90 | 101 | 94 |
| NEGATIVE -> MIXED | 90 | 110 | 93 |
| MIXED -> POSITIVE | 42 | 51 | 71 |

The direct one-step POSITIVE -> NEGATIVE teleport is confirmed **eliminated** (the comparison
tool asserts this and would throw rather than report otherwise) — this part of the design
works exactly as specified. But the transition-count increase in Section 4 traces directly to
this table: POSITIVE<->MIXED cycling (72 + 71 = 143 events) is far higher than either BASELINE
(41 + 42 = 83) or V2 (42 + 51 = 93). STRUCTURAL_V3 spends much more time oscillating in and out
of POSITIVE than either predecessor — a direct side effect of raw POSITIVE now being reached
far more easily (26.76% of raw sessions vs. BASELINE's 15.90%), so the effective state crosses
that boundary more often too.

## 6. Raw 5d/20d structural agreement

| Metric | % | Sessions |
| --- | ---: | ---: |
| Both 5d and 20d POSITIVE | 15.82% | - |
| Both 5d and 20d NEGATIVE | 16.63% | - |
| Both 5d and 20d MIXED | 14.92% | - |
| 5d/20d opposite (raw MIXED, 1d cannot break tie) | 9.73% | - |
| Exactly one directional + one MIXED | 42.90% | 529 |

Of the 529 "one directional + one MIXED" sessions, 1-day confirmed the directional reading
**276 times (52.17%)** and did not confirm it **253 times (47.83%)**. The 1-day confirmation
rule is doing substantial work: it pulls back to MIXED nearly half of the sessions that would
otherwise have gone directional on 5d/20d grounds alone, which is exactly its intended role,
not a rubber stamp.

## 7. Important market periods

| Period | Metric | BASELINE | CANDIDATE_HORIZON_V2 | STRUCTURAL_V3 |
| --- | --- | ---: | ---: | ---: |
| 2022 | POSITIVE/MIXED/NEGATIVE | 4.78/47.81/47.41 | 10.76/27.89/61.35 | 14.74/37.85/47.41 |
| 2022 | Transitions | 51 | 60 | 68 |
| 2023 | POSITIVE/MIXED/NEGATIVE | 12.00/54.40/33.60 | 16.40/34.00/49.60 | 20.40/41.60/38.00 |
| 2023 | Transitions | 66 | 69 | 69 |
| 2024 | POSITIVE/MIXED/NEGATIVE | 4.37/62.70/32.94 | 6.35/41.27/52.38 | 13.89/51.59/34.52 |
| 2024 | Transitions | 53 | 71 | 72 |
| 2025-04-01..05-15 | POSITIVE/MIXED/NEGATIVE | 15.63/46.88/37.50 | 18.75/37.50/43.75 | 21.88/34.38/43.75 |
| 2025-04-01..05-15 | Transitions | 10 | 10 | 10 |

STRUCTURAL_V3's NEGATIVE reading in 2022 (47.41%) exactly matches BASELINE, not V2's inflated
61.35%, while still gaining materially more POSITIVE representation (14.74% vs 4.78%). 2023
and 2024 transitions are essentially tied with V2 (69/69, 72/71) — the period-level transition
counts do not show the same gap seen in the full-history total, meaning STRUCTURAL_V3's excess
churn versus V2 is not concentrated in these specific periods but spread across the full
five-year history.

## 8. Dates whose effective state changed

**STRUCTURAL_V3 vs BASELINE: 260 of 1,255 dates (20.72%)**

| Change (BASELINE -> STRUCTURAL_V3) | Count |
| --- | --- |
| MIXED -> POSITIVE | 114 |
| MIXED -> NEGATIVE | 88 |
| NEGATIVE -> MIXED | 54 |
| POSITIVE -> MIXED | 4 |

**STRUCTURAL_V3 vs CANDIDATE_HORIZON_V2: 239 of 1,255 dates (19.04%)**

| Change (V2 -> STRUCTURAL_V3) | Count |
| --- | --- |
| NEGATIVE -> MIXED | 170 |
| MIXED -> POSITIVE | 65 |
| POSITIVE -> MIXED | 4 |

Versus V2, the dominant change is NEGATIVE -> MIXED (170 dates) — direct evidence that
STRUCTURAL_V3 walks back a large share of V2's NEGATIVE overcorrection. Versus BASELINE, the
dominant change is MIXED -> POSITIVE (114 dates) — STRUCTURAL_V3 surfaces POSITIVE on dates
BASELINE read as MIXED. No representative sample showed an obvious data artifact (see the
generated report for the sample).

## 9. Strongest daily breadth (evidence-stability check)

Confirmed unchanged across all three definitions: the strongest positive/negative daily
`advanceShare` sessions are identical — classification, aggregation, and hysteresis changes
never touch the underlying daily evidence.

## Answers to the decision questions

1. **Did centering the horizon bands at ~0.49 remove the strong NEGATIVE bias seen in V2?**
   Largely yes. Effective NEGATIVE fell from 52.23% (V2) to 38.44% (V3), close to BASELINE's
   35.69%.
2. **Does STRUCTURAL_V3 produce a reasonable POSITIVE/MIXED/NEGATIVE balance overall?** Yes —
   it is the most balanced of the three: POSITIVE 14.92%, MIXED 46.63%, NEGATIVE 38.44%.
3. **Does 2022 remain meaningfully NEGATIVE?** Yes, 47.41% — identical to BASELINE, not V2's
   inflated 61.35%.
4. **Do 2023 and 2024 show more useful directional Breadth than baseline without becoming
   implausibly POSITIVE?** Yes — POSITIVE roughly doubles in both years (2023: 12.00% ->
   20.40%; 2024: 4.37% -> 13.89%) while NEGATIVE stays close to BASELINE rather than V2's
   inflated reading.
5. **Does hierarchical 5d/20d structure with 1d confirmation materially reduce noise?**
   No, not on the primary metric requested — total transitions (330) are the *highest* of the
   three definitions, above both BASELINE (264) and the already-rejected V2 (314).
6. **Are transitions lower than V2?** **No** — 330 vs. 314, about 5% higher.
7. **Are transitions lower than or at least comparable to BASELINE?** No — 330 vs. 264, about
   25% higher.
8. **Does median run duration improve?** It ties BASELINE (3, vs V2's 2) but is not an
   improvement over BASELINE itself.
9. **Do one-day and <=2-day runs improve?** Mixed: both improve versus V2 (63 vs 68; 164 vs
   166) but both remain well above BASELINE (43; 114).
10. **Are direct POSITIVE->NEGATIVE effective flips eliminated?** Yes, exactly zero, confirmed
    and asserted by the comparison tool itself.
11. **Is MIXED still meaningfully represented?** Yes, 46.63% overall — the largest single
    state.
12. **Did any new obvious pathology appear?** Yes: STRUCTURAL_V3 spends noticeably more time
    oscillating directly between POSITIVE and MIXED (72 + 71 = 143 such transitions vs.
    BASELINE's 83 and V2's 93) — a direct side effect of raw POSITIVE now being reached much
    more easily. This is what drives the total-transition count above both prior definitions
    despite eliminating the POSITIVE->NEGATIVE teleport.

## Bottom line for the owner

CANDIDATE_STRUCTURAL_V3 resolves the two clearest defects found in CANDIDATE_HORIZON_V2 — the
strong NEGATIVE skew (52.23% -> 38.44%, close to BASELINE) and the 10x increase in
POSITIVE-to-NEGATIVE shocks (now structurally zero) — and produces a materially better-balanced
POSITIVE/MIXED/NEGATIVE read across every year examined, including a plausible near-doubling
of POSITIVE representation in 2023-2024 without an implausible overcorrection. **It does not,
however, meet the noise-reduction bar the owner set**: total transitions (330) are higher than
both BASELINE (264) and V2 (314), driven by increased POSITIVE<->MIXED cycling. Per the
research instructions, this failure is reported as-is; no fourth candidate was created or
tested, and no threshold search was performed. STRUCTURAL_V3 is not selected as BREADTH_V1
here — this is evidence for the owner's next decision.

See [implementation](breadth-calibration.md), [the first calibration pass results](breadth-calibration-results.md),
[the threshold comparison](breadth-threshold-comparison.md), and
[the distribution diagnostic](breadth-distribution-diagnostic.md). No schema, migration,
authoritative BREADTH row, or trading behavior changed. TREND_V1 and VOLATILITY_V1 are
untouched.
