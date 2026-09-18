# Breadth distribution diagnostic

Recorded 2026-09-17 on `feat/external-signal-ingestion`. Descriptive-only diagnostic against
the same already-cached 2021-09-16..2026-09-16 evidence used by
[the calibration pass](breadth-calibration-results.md) and
[the threshold comparison](breadth-threshold-comparison.md). No Massive requests were made
(`actualRequests` was `{grouped:0, universe:0}`; the diagnostic asserts this and refuses to
report otherwise). No thresholds are proposed, no classifier or hysteresis behavior is
touched, and no BREADTH_V1 decision is made here — this only describes where the raw
breadth1/breadth5/breadth20 values actually sit.

## Run it yourself

```powershell
npm.cmd run diagnose:breadth-distribution -- --from 2021-09-16 --to 2026-09-16 --output breadth-distribution-diagnostic.json
```

Fails closed with an exact list of missing dates (`MissingCacheError`) if the disk cache at
`node_modules/.cache/breadth/` is incomplete, rather than silently fetching anything.

**Convention:** percentiles use linear interpolation between closest ranks, `index = p * (n - 1)`
(NumPy's default `"linear"` method / Excel's `PERCENTILE.INC`). Standard deviation uses the
sample convention (`n - 1` divisor), matching the convention already documented for Volatility
(`VOLATILITY_DEFINITION.standardDeviation`).

## 1. Overall distribution

| Horizon | Count | Mean | Median | Stddev | Min | Max | P10 | P25 | P75 | P90 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1-day | 1252 | 0.4887 | 0.4872 | 0.1765 | 0.0661 | 0.9097 | 0.2518 | 0.3475 | 0.6251 | 0.7314 |
| 5-day | 1248 | 0.4886 | 0.4914 | 0.0786 | 0.2052 | 0.7380 | 0.3870 | 0.4384 | 0.5412 | 0.5883 |
| 20-day | 1233 | 0.4888 | 0.4904 | 0.0363 | 0.3788 | 0.5953 | 0.4390 | 0.4632 | 0.5129 | 0.5345 |

Counts fall as expected with warm-up (1252 -> 1248 -> 1233), matching the fail-closed cascade
already documented in the calibration pass. All three overall means land within 0.0002 of each
other (0.4886-0.4888) — smoothing narrows the spread but does not move the center.

## 2. Yearly distribution

### 1-day

| Year | Count | Mean | Median | P10 | P25 | P75 | P90 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2021 (partial) | 72 | 0.4949 | 0.4640 | 0.2443 | 0.3890 | 0.6275 | 0.7453 |
| 2022 | 251 | 0.4782 | 0.4740 | 0.1909 | 0.2969 | 0.6547 | 0.7824 |
| 2023 | 250 | 0.4949 | 0.4878 | 0.2641 | 0.3470 | 0.6552 | 0.7266 |
| 2024 | 252 | 0.4899 | 0.4948 | 0.2664 | 0.3514 | 0.6217 | 0.7188 |
| 2025 | 250 | 0.4883 | 0.4745 | 0.2659 | 0.3545 | 0.6233 | 0.7234 |
| 2026 (partial) | 177 | 0.4911 | 0.5044 | 0.3019 | 0.3869 | 0.5886 | 0.6562 |

### 5-day

| Year | Count | Mean | Median | P10 | P25 | P75 | P90 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2021 (partial) | 68 | 0.4910 | 0.4986 | 0.3668 | 0.4234 | 0.5428 | 0.5784 |
| 2022 | 251 | 0.4778 | 0.4813 | 0.3363 | 0.4216 | 0.5479 | 0.5920 |
| 2023 | 250 | 0.4959 | 0.4979 | 0.3898 | 0.4388 | 0.5550 | 0.5975 |
| 2024 | 252 | 0.4898 | 0.4926 | 0.3958 | 0.4394 | 0.5413 | 0.5960 |
| 2025 | 250 | 0.4891 | 0.4922 | 0.3886 | 0.4454 | 0.5360 | 0.5731 |
| 2026 (partial) | 177 | 0.4904 | 0.4875 | 0.4193 | 0.4523 | 0.5239 | 0.5628 |

### 20-day

| Year | Count | Mean | Median | P10 | P25 | P75 | P90 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2021 (partial) | 53 | 0.4839 | 0.4940 | 0.4200 | 0.4373 | 0.5244 | 0.5314 |
| 2022 | 251 | 0.4799 | 0.4774 | 0.4237 | 0.4465 | 0.5126 | 0.5365 |
| 2023 | 250 | 0.4922 | 0.4881 | 0.4364 | 0.4579 | 0.5240 | 0.5492 |
| 2024 | 252 | 0.4934 | 0.4949 | 0.4565 | 0.4750 | 0.5122 | 0.5277 |
| 2025 | 250 | 0.4887 | 0.4906 | 0.4436 | 0.4655 | 0.5115 | 0.5266 |
| 2026 (partial) | 177 | 0.4921 | 0.4922 | 0.4622 | 0.4778 | 0.5059 | 0.5218 |

No year's mean or median crosses to the positive side of 0.50 at any horizon except 5-day
2023 (median 0.4979, essentially at the boundary). Reported as-is, not scored against returns.

## 3. Centering diagnostic

| Horizon | Mean - 0.50 | Median - 0.50 | <0.45 | [0.45,0.50) | ==0.50 | (0.50,0.55) | >=0.55 | %<0.50 | %>0.50 | %==0.50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1-day | -0.0113 | -0.0128 | 43.13% | 9.19% | 0.00% | 9.03% | 38.66% | 52.32% | 47.68% | 0.00% |
| 5-day | -0.0114 | -0.0086 | 29.09% | 25.72% | 0.00% | 23.40% | 21.79% | 54.81% | 45.19% | 0.00% |
| 20-day | -0.0112 | -0.0096 | 15.73% | 45.17% | 0.00% | 34.79% | 4.30% | 60.91% | 39.09% | 0.00% |

| Horizon | within 49/51 | within 48/52 | within 47/53 | within 45/55 |
| --- | ---: | ---: | ---: | ---: |
| 1-day | 4.23% | 7.35% | 11.10% | 18.21% |
| 5-day | 10.42% | 21.31% | 31.01% | 49.12% |
| 20-day | 21.90% | 41.36% | 57.91% | 79.97% |

The mean offset from 0.50 is essentially identical across all three horizons (-0.0112 to
-0.0114) — smoothing does not change *where* the series is centered, only how tightly it
clusters there. Every horizon has more sessions below 0.50 than above it (52.32%/54.81%/60.91%
below vs. 47.68%/45.19%/39.09% above); the below/above split widens with horizon length because
narrower dispersion pushes a larger share of the already-off-center mass to the correct side of
0.50. No exact 0.50 values occur at any horizon.

## 4. Horizon compression

| Metric | 1-day | 5-day | 20-day |
| --- | ---: | ---: | ---: |
| Standard deviation | 0.1765 | 0.0786 | 0.0363 |
| IQR (P75 - P25) | 0.2776 | 0.1028 | 0.0496 |

5-day stddev / 1-day stddev: **0.4452**. 20-day stddev / 1-day stddev: **0.2059**. The IQR
compresses in the same proportion (0.2776 -> 0.1028 -> 0.0496), roughly 37% and 18% of the
1-day IQR respectively — confirming smoothing sharply narrows dispersion at both horizons,
5-day more than 2x, 20-day nearly 5x tighter than 1-day.

## 5. Relationship between horizons

| Pair | Paired sessions | Pearson correlation | Mean absolute difference |
| --- | ---: | ---: | ---: |
| breadth1 vs breadth5 | 1248 | 0.4335 | 0.1301 |
| breadth1 vs breadth20 | 1233 | 0.1946 | 0.1442 |
| breadth5 vs breadth20 | 1233 | 0.4500 | 0.0554 |

1-day correlates moderately with 5-day but only weakly with 20-day (0.1946) — expected, since
20-day is a much heavier rolling average of the same noisy daily input. 5-day and 20-day
correlate at a similar moderate strength to 1-day/5-day (0.4500) despite one being nested
inside the other's window, and their mean absolute difference (0.0554) is the smallest of the
three pairs, consistent with 5-day and 20-day being the two most-smoothed, closest-together
series.

## 6. Shape summary (histogram buckets)

### 1-day

| Bucket | Count | % |
| --- | ---: | ---: |
| <0.35 | 316 | 25.24% |
| 0.35-<0.40 | 103 | 8.23% |
| 0.40-<0.45 | 121 | 9.66% |
| 0.45-<0.50 | 115 | 9.19% |
| 0.50-<0.55 | 113 | 9.03% |
| 0.55-<0.60 | 114 | 9.11% |
| 0.60-<0.65 | 105 | 8.39% |
| >=0.65 | 265 | 21.17% |

### 5-day

| Bucket | Count | % |
| --- | ---: | ---: |
| <0.35 | 59 | 4.73% |
| 0.35-<0.40 | 100 | 8.01% |
| 0.40-<0.45 | 204 | 16.35% |
| 0.45-<0.50 | 321 | 25.72% |
| 0.50-<0.55 | 292 | 23.40% |
| 0.55-<0.60 | 184 | 14.74% |
| 0.60-<0.65 | 70 | 5.61% |
| >=0.65 | 18 | 1.44% |

### 20-day

| Bucket | Count | % |
| --- | ---: | ---: |
| <0.35 | 0 | 0.00% |
| 0.35-<0.40 | 5 | 0.41% |
| 0.40-<0.45 | 189 | 15.33% |
| 0.45-<0.50 | 557 | 45.17% |
| 0.50-<0.55 | 429 | 34.79% |
| 0.55-<0.60 | 53 | 4.30% |
| 0.60-<0.65 | 0 | 0.00% |
| >=0.65 | 0 | 0.00% |

1-day is bimodal-ish and heavy in its own tails (25.24% below 0.35, 21.17% at or above 0.65) —
expected for a single day's advance/decline share. 20-day is essentially unimodal and entirely
inside [0.35, 0.60); it never once reaches either extreme bucket in five years of sessions.

## 7. Important market periods

| Period | Horizon | Count | Mean | Median | P25 | P75 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 2022 | 1-day | 251 | 0.4782 | 0.4740 | 0.2969 | 0.6547 |
| 2022 | 5-day | 251 | 0.4778 | 0.4813 | 0.4216 | 0.5479 |
| 2022 | 20-day | 251 | 0.4799 | 0.4774 | 0.4465 | 0.5126 |
| 2023 | 1-day | 250 | 0.4949 | 0.4878 | 0.3470 | 0.6552 |
| 2023 | 5-day | 250 | 0.4959 | 0.4979 | 0.4388 | 0.5550 |
| 2023 | 20-day | 250 | 0.4922 | 0.4881 | 0.4579 | 0.5240 |
| 2024 | 1-day | 252 | 0.4899 | 0.4948 | 0.3514 | 0.6217 |
| 2024 | 5-day | 252 | 0.4898 | 0.4926 | 0.4394 | 0.5413 |
| 2024 | 20-day | 252 | 0.4934 | 0.4949 | 0.4750 | 0.5122 |
| 2025-04-01..05-15 | 1-day | 32 | 0.5202 | 0.5529 | 0.3266 | 0.7138 |
| 2025-04-01..05-15 | 5-day | 32 | 0.5084 | 0.5304 | 0.4560 | 0.5758 |
| 2025-04-01..05-15 | 20-day | 32 | 0.4888 | 0.4742 | 0.4430 | 0.5414 |

The short April-May 2025 recovery window is the only period here where 1-day and 5-day means
and medians actually cross above 0.50 — 20-day for the same window stays essentially at the
all-period center (0.4888 mean, matching the five-year overall mean almost exactly), because
its 20-session window still carries the preceding drawdown. 2022, 2023, and 2024 all keep every
horizon's mean and median at or below 0.50.

## Data-quality check

No anomaly found: session counts decline horizon-by-horizon exactly as the 20-session warm-up
and the three known 2021-09-16/17/20 entitlement-gap dates predict, min/max at every horizon
stay within plausible advance-share bounds (20-day never drops below 0.3788 or exceeds
0.5953), and no horizon or year shows an implausible jump.

## Answers to the research questions

1. **Is breadth1 centered close to 0.50?** Close but not exactly: mean 0.4887 (-0.0113),
   median 0.4872 (-0.0128).
2. **Is breadth5 centered close to 0.50?** Same story: mean 0.4886 (-0.0114), median 0.4914
   (-0.0086).
3. **Is breadth20 centered close to 0.50?** Same again: mean 0.4888 (-0.0112), median 0.4904
   (-0.0096).
4. **Is there a persistent downward or upward offset in any horizon?** Yes, and it is not
   confined to one horizon — all three carry essentially the same ~0.011-0.013 downward mean
   offset. Smoothing changes the *spread* around the center, not the center itself.
5. **Is the NEGATIVE skew observed under CANDIDATE_HORIZON_V2 plausibly explained by the
   underlying series being centered below 0.50?** Yes. Because all three horizons sit
   consistently below 0.50, any band drawn symmetrically around 0.50 is asymmetric relative to
   where the data actually falls; narrowing such a band mechanically reallocates more mass to
   the NEGATIVE side than the POSITIVE side, at every horizon, not only at 20-day.
6. **How much does variance compress from 1d -> 5d -> 20d?** Stddev falls from 0.1765 to 0.0786
   (44.52% of 1-day) to 0.0363 (20.59% of 1-day); IQR compresses in the same proportion (0.2776
   -> 0.1028 -> 0.0496).
7. **Does the 20-day series naturally cluster tightly enough around 0.50 that a 45/55 band
   would predictably remain MIXED most of the time?** Yes — 79.97% of all 20-day sessions fall
   within 45/55, and even at 48/52 (a much narrower band) 41.36% still fall inside it. The
   20-day series essentially never reaches the extremes: it is entirely contained in
   [0.3788, 0.5953] across five years.
8. **Do yearly medians move materially enough that a single fixed symmetric threshold around
   0.50 might mischaracterize some years?** Modestly. 1-day yearly medians range from 0.4640
   (2021) to 0.5044 (2026), a ~4pp swing; 20-day yearly medians range more narrowly, 0.4774
   (2022) to 0.4949 (2024), under 2pp. The one clear exception to "everything stays at or below
   0.50" is the short 2025-04-01..05-15 window, where 1-day and 5-day medians move above 0.50
   while 20-day does not.

## Bottom line for the owner

Every horizon — not just 20-day — is persistently centered about 1.1-1.3 percentage points
below 0.50, both by mean and by median, across nearly all of the five-year history and in every
individual year examined except a brief 2025 window. This is offered as evidence for the next
design decision on Breadth aggregation/classification; no threshold, classifier, or BREADTH_V1
selection is proposed here.

See [implementation](breadth-calibration.md), [the first calibration pass results](breadth-calibration-results.md),
and [the threshold comparison](breadth-threshold-comparison.md). No schema, migration,
authoritative BREADTH row, or trading behavior changed. TREND_V1 and VOLATILITY_V1 are
untouched.
