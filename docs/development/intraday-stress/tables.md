# Intraday stress quantitative tables

Generated from the cached dataset. Interpret with [the research report](../intraday-stress-calibration.md). Percentages in these tables are percentage points; CSV fields ending in Pct are decimal fractions. Quantiles use linear interpolation at (n−1)p. Primary state distributions exclude the closing bar; the final table is a separate closing-only diagnostic.

## Measurement distributions

| Symbol | Measurement | n | p50 | p75 | p90 | p95 | p97.5 | p99 | p99.5 | p99.9 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPY | shockAtrRatio | 30905 | 0.136 | 0.198 | 0.282 | 0.348 | 0.420 | 0.538 | 0.647 | 1.023 | 2.205 |
| SPY | downsideExcursionAtrRatio | 30905 | 0.058 | 0.111 | 0.184 | 0.242 | 0.307 | 0.399 | 0.492 | 0.801 | 1.538 |
| SPY | realizedMovement60AtrRatio | 27182 | 0.154 | 0.228 | 0.326 | 0.402 | 0.483 | 0.599 | 0.707 | 1.013 | 2.206 |
| SPY | sessionDrawdownAtrRatio | 30905 | 0.202 | 0.420 | 0.715 | 0.934 | 1.148 | 1.420 | 1.642 | 2.326 | 4.513 |
| RSP | shockAtrRatio | 30905 | 0.126 | 0.186 | 0.271 | 0.345 | 0.419 | 0.530 | 0.616 | 0.856 | 2.396 |
| RSP | downsideExcursionAtrRatio | 30905 | 0.054 | 0.105 | 0.175 | 0.233 | 0.299 | 0.395 | 0.475 | 0.661 | 1.342 |
| RSP | realizedMovement60AtrRatio | 27182 | 0.150 | 0.221 | 0.321 | 0.394 | 0.475 | 0.591 | 0.688 | 1.002 | 2.389 |
| RSP | sessionDrawdownAtrRatio | 30905 | 0.245 | 0.469 | 0.727 | 0.935 | 1.137 | 1.376 | 1.637 | 2.089 | 3.779 |

## Absolute measurements (%)

| Symbol | Measurement | p50 | p95 | p99 | p99.9 | max |
| --- | --- | --- | --- | --- | --- | --- |
| SPY | shockPct | 0.171 | 0.513 | 0.850 | 1.865 | 7.134 |
| SPY | downsideExcursionPct | 0.072 | 0.338 | 0.590 | 1.161 | 3.175 |
| SPY | realizedMovement60Pct | 0.192 | 0.590 | 0.918 | 1.720 | 5.448 |
| SPY | sessionDrawdownPct | 0.249 | 1.302 | 2.235 | 3.599 | 6.548 |
| RSP | shockPct | 0.159 | 0.487 | 0.771 | 1.646 | 6.943 |
| RSP | downsideExcursionPct | 0.066 | 0.320 | 0.556 | 0.981 | 2.943 |
| RSP | realizedMovement60Pct | 0.187 | 0.571 | 0.894 | 1.665 | 5.238 |
| RSP | sessionDrawdownPct | 0.300 | 1.265 | 2.071 | 3.348 | 5.912 |

## Opening and closing sensitivity

| Symbol | Group | Metric | n | p50 | p95 | p99 |
| --- | --- | --- | --- | --- | --- | --- |
| SPY | closing_only | shockAtrRatio | 1241 | 0.184 | 0.412 | 0.760 |
| SPY | closing_only | realizedMovement60AtrRatio | 1241 | 0.160 | 0.438 | 0.695 |
| SPY | closing_only | sessionDrawdownAtrRatio | 1241 | 0.275 | 1.268 | 1.851 |
| SPY | including_close | shockAtrRatio | 32146 | 0.138 | 0.351 | 0.545 |
| SPY | including_close | realizedMovement60AtrRatio | 28423 | 0.155 | 0.404 | 0.607 |
| SPY | including_close | sessionDrawdownAtrRatio | 32146 | 0.205 | 0.945 | 1.448 |
| SPY | opening_1_4 | shockAtrRatio | 4964 | 0.200 | 0.425 | 0.583 |
| SPY | opening_1_4 | realizedMovement60AtrRatio | 1241 | 0.240 | 0.524 | 0.697 |
| SPY | opening_1_4 | sessionDrawdownAtrRatio | 4964 | 0.121 | 0.510 | 0.800 |
| SPY | nonopening_5_plus | shockAtrRatio | 25941 | 0.126 | 0.319 | 0.509 |
| SPY | nonopening_5_plus | realizedMovement60AtrRatio | 25941 | 0.151 | 0.391 | 0.587 |
| SPY | nonopening_5_plus | sessionDrawdownAtrRatio | 25941 | 0.225 | 0.982 | 1.467 |
| RSP | closing_only | shockAtrRatio | 1241 | 0.171 | 0.356 | 0.597 |
| RSP | closing_only | realizedMovement60AtrRatio | 1241 | 0.154 | 0.406 | 0.637 |
| RSP | closing_only | sessionDrawdownAtrRatio | 1241 | 0.312 | 1.243 | 1.847 |
| RSP | including_close | shockAtrRatio | 32146 | 0.128 | 0.345 | 0.534 |
| RSP | including_close | realizedMovement60AtrRatio | 28423 | 0.150 | 0.394 | 0.594 |
| RSP | including_close | sessionDrawdownAtrRatio | 32146 | 0.248 | 0.948 | 1.415 |
| RSP | opening_1_4 | shockAtrRatio | 4964 | 0.220 | 0.485 | 0.654 |
| RSP | opening_1_4 | realizedMovement60AtrRatio | 1241 | 0.292 | 0.590 | 0.765 |
| RSP | opening_1_4 | sessionDrawdownAtrRatio | 4964 | 0.160 | 0.600 | 0.883 |
| RSP | nonopening_5_plus | shockAtrRatio | 25941 | 0.115 | 0.282 | 0.445 |
| RSP | nonopening_5_plus | realizedMovement60AtrRatio | 25941 | 0.146 | 0.372 | 0.559 |
| RSP | nonopening_5_plus | sessionDrawdownAtrRatio | 25941 | 0.267 | 0.978 | 1.437 |

## Candidate state frequencies (%)

| Candidate | Recovery | NORMAL | ELEVATED | HIGH | SEVERE | Valid targets |
| --- | --- | --- | --- | --- | --- | --- |
| A | raw | 84.229 | 13.635 | 1.851 | 0.285 | 30905 |
| A | two | 79.107 | 17.832 | 2.715 | 0.346 | 30905 |
| A | three | 75.480 | 20.735 | 3.398 | 0.388 | 30905 |
| B | raw | 88.966 | 9.905 | 1.019 | 0.110 | 30905 |
| B | two | 85.171 | 13.221 | 1.472 | 0.136 | 30905 |
| B | three | 82.394 | 15.616 | 1.835 | 0.155 | 30905 |
| C | raw | 92.386 | 6.924 | 0.660 | 0.029 | 30905 |
| C | two | 89.685 | 9.319 | 0.955 | 0.042 | 30905 |
| C | three | 87.688 | 11.079 | 1.178 | 0.055 | 30905 |

## Raw state frequencies by period (%)

| Candidate | Period | NORMAL | ELEVATED | HIGH | SEVERE | n |
| --- | --- | --- | --- | --- | --- | --- |
| A | 2021 | 86.895 | 10.685 | 2.218 | 0.202 | 1488 |
| A | 2022 | 86.364 | 12.087 | 1.421 | 0.128 | 6263 |
| A | 2023 | 87.343 | 11.356 | 1.301 | 0.000 | 6226 |
| A | 2024 | 82.822 | 14.895 | 2.075 | 0.208 | 6264 |
| A | 2025 | 81.590 | 15.497 | 2.108 | 0.805 | 6214 |
| A | 2026 | 81.640 | 15.618 | 2.427 | 0.315 | 4450 |
| A | opening_1_4 | 73.731 | 23.550 | 2.699 | 0.020 | 4964 |
| A | nonopening | 86.238 | 11.738 | 1.688 | 0.335 | 25941 |
| A | quiet_ATR_both_lt_1pct | 80.509 | 16.679 | 2.586 | 0.227 | 7039 |
| A | high_ATR_either_ge_2pct | 86.930 | 10.904 | 1.478 | 0.688 | 3925 |
| B | 2021 | 89.785 | 9.341 | 0.806 | 0.067 | 1488 |
| B | 2022 | 90.643 | 8.478 | 0.830 | 0.048 | 6263 |
| B | 2023 | 91.423 | 8.031 | 0.546 | 0.000 | 6226 |
| B | 2024 | 87.979 | 10.840 | 1.165 | 0.016 | 6264 |
| B | 2025 | 86.933 | 11.265 | 1.384 | 0.418 | 6214 |
| B | 2026 | 87.124 | 11.506 | 1.303 | 0.067 | 4450 |
| B | opening_1_4 | 82.272 | 16.720 | 0.987 | 0.020 | 4964 |
| B | nonopening | 90.247 | 8.600 | 1.025 | 0.127 | 25941 |
| B | quiet_ATR_both_lt_1pct | 86.078 | 12.331 | 1.534 | 0.057 | 7039 |
| B | high_ATR_either_ge_2pct | 90.344 | 8.102 | 0.917 | 0.637 | 3925 |
| C | 2021 | 92.204 | 7.258 | 0.470 | 0.067 | 1488 |
| C | 2022 | 93.757 | 5.732 | 0.511 | 0.000 | 6263 |
| C | 2023 | 94.154 | 5.541 | 0.305 | 0.000 | 6226 |
| C | 2024 | 91.715 | 7.567 | 0.702 | 0.016 | 6264 |
| C | 2025 | 90.602 | 8.127 | 1.159 | 0.113 | 6214 |
| C | 2026 | 91.483 | 7.843 | 0.674 | 0.000 | 4450 |
| C | opening_1_4 | 88.417 | 11.019 | 0.544 | 0.020 | 4964 |
| C | nonopening | 93.146 | 6.141 | 0.682 | 0.031 | 25941 |
| C | quiet_ATR_both_lt_1pct | 90.070 | 8.879 | 1.037 | 0.014 | 7039 |
| C | high_ATR_either_ge_2pct | 93.045 | 6.013 | 0.764 | 0.178 | 3925 |

## Persistence

Minutes assume evidence becomes usable exactly target+5 minutes and expires at min(next target+5, session close). Last target therefore contributes 10 minutes; other targets contribute 15. Actual provider latency is not modeled. Episodes never cross sessions or unavailable evidence. Session-end censoring is reported, not treated as observed recovery.

| Candidate | Recovery | Episode state | Episodes | Sessions | Median min | p95 min | Max min | Close-censored |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | raw | highOrSevere | 323 | 219 | 15.0 | 89.5 | 295 | 49 |
| A | raw | severe | 30 | 22 | 25.0 | 118.7 | 175 | 11 |
| A | two | highOrSevere | 284 | 219 | 30.0 | 117.7 | 340 | 64 |
| A | two | severe | 25 | 22 | 30.0 | 170.0 | 195 | 12 |
| A | three | highOrSevere | 264 | 219 | 45.0 | 145.0 | 340 | 74 |
| A | three | severe | 23 | 22 | 45.0 | 202.0 | 210 | 14 |
| B | raw | highOrSevere | 164 | 128 | 15.0 | 100.0 | 295 | 23 |
| B | raw | severe | 14 | 10 | 27.5 | 93.5 | 100 | 6 |
| B | two | highOrSevere | 150 | 128 | 30.0 | 123.2 | 295 | 34 |
| B | two | severe | 12 | 10 | 30.0 | 142.7 | 195 | 6 |
| B | three | highOrSevere | 144 | 128 | 45.0 | 140.5 | 300 | 39 |
| B | three | severe | 11 | 10 | 40.0 | 177.5 | 210 | 7 |
| C | raw | highOrSevere | 107 | 86 | 15.0 | 88.0 | 295 | 15 |
| C | raw | severe | 6 | 4 | 15.0 | 37.5 | 40 | 2 |
| C | two | highOrSevere | 96 | 86 | 30.0 | 111.3 | 295 | 23 |
| C | two | severe | 6 | 4 | 30.0 | 43.8 | 45 | 2 |
| C | three | highOrSevere | 92 | 86 | 45.0 | 124.5 | 300 | 25 |
| C | three | severe | 5 | 4 | 40.0 | 93.0 | 105 | 3 |

## Representative sessions

Maxima below are across SPY/RSP actionable targets and need not come from the same instrument or instant. Daily range and whole-session path selection diagnostics include the close. Four controls are nearest the median normalized daily range; the other sessions are deterministic extremes.

| Date | Selection | Shock / ATR | 60m / ATR | Drawdown / ATR | Max downside % | Max drawdown % | Max raw A/B/C | B HIGH+ min (raw/2/3) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2021-12-01 | range_rank_6 | 0.618 | 0.612 | 2.169 | 0.675 | 2.594 | SEVERE/HIGH/HIGH | 25/25/25 |
| 2021-12-02 | downside | 1.320 | 0.731 | 0.728 | 1.616 | 0.914 | SEVERE/HIGH/HIGH | 30/60/90 |
| 2021-12-07 | downside | 1.525 | 0.388 | 0.407 | 2.035 | 0.618 | SEVERE/SEVERE/SEVERE | 15/40/40 |
| 2022-04-27 | whipsaw | 0.586 | 0.618 | 0.731 | 0.913 | 1.441 | ELEVATED/ELEVATED/ELEVATED | 0/0/0 |
| 2022-05-16 | whipsaw | 0.302 | 0.293 | 0.377 | 0.577 | 0.996 | NORMAL/NORMAL/NORMAL | 0/0/0 |
| 2022-06-17 | whipsaw | 0.330 | 0.390 | 0.596 | 0.815 | 1.641 | NORMAL/NORMAL/NORMAL | 0/0/0 |
| 2022-09-21 | rolling_rank_6 | 1.023 | 1.203 | 1.371 | 1.770 | 2.653 | HIGH/HIGH/HIGH | 90/100/100 |
| 2022-11-04 | whipsaw_rank_5 | 0.906 | 0.600 | 0.972 | 1.724 | 2.191 | HIGH/HIGH/HIGH | 15/30/45 |
| 2022-11-28 | median_range | 0.283 | 0.225 | 0.875 | 0.324 | 1.445 | NORMAL/NORMAL/NORMAL | 0/0/0 |
| 2023-01-12 | whipsaw_rank_6 | 0.547 | 0.634 | 0.546 | 0.838 | 0.911 | ELEVATED/ELEVATED/ELEVATED | 0/0/0 |
| 2023-03-17 | median_range | 0.375 | 0.309 | 0.855 | 0.533 | 1.622 | ELEVATED/NORMAL/NORMAL | 0/0/0 |
| 2023-07-14 | median_range | 0.453 | 0.485 | 0.844 | 0.470 | 0.875 | ELEVATED/ELEVATED/ELEVATED | 0/0/0 |
| 2024-04-04 | drawdown_rank_5 | 0.506 | 0.812 | 2.518 | 0.402 | 2.011 | SEVERE/HIGH/HIGH | 70/70/70 |
| 2024-06-10 | median_range | 0.274 | 0.224 | 0.249 | 0.143 | 0.228 | NORMAL/NORMAL/NORMAL | 0/0/0 |
| 2024-12-18 | range, drawdown, downside, rolling, shock | 1.718 | 1.752 | 4.513 | 1.099 | 3.225 | SEVERE/SEVERE/SEVERE | 100/100/100 |
| 2024-12-20 | shock, downside_rank_6 | 1.700 | 0.732 | 0.747 | 1.146 | 0.713 | HIGH/HIGH/HIGH | 30/60/90 |
| 2025-04-07 | range, downside, rolling, shock | 2.025 | 2.389 | 2.375 | 3.175 | 5.623 | SEVERE/SEVERE/SEVERE | 280/325/340 |
| 2025-04-09 | range, rolling, shock | 2.396 | 1.646 | 0.715 | 1.058 | 2.077 | HIGH/HIGH/HIGH | 60/75/90 |
| 2025-08-22 | rolling_rank_5 | 1.247 | 1.266 | 0.349 | 0.262 | 0.326 | HIGH/HIGH/HIGH | 60/75/90 |
| 2025-10-10 | range, drawdown, rolling, downside_rank_5 | 1.296 | 1.353 | 3.726 | 0.869 | 2.665 | SEVERE/SEVERE/HIGH | 295/295/295 |
| 2025-11-20 | drawdown | 0.770 | 0.776 | 2.626 | 0.760 | 3.286 | SEVERE/SEVERE/HIGH | 220/235/235 |
| 2026-01-30 | whipsaw | 0.522 | 0.582 | 1.172 | 0.426 | 1.077 | ELEVATED/ELEVATED/ELEVATED | 0/0/0 |
| 2026-06-05 | drawdown_rank_6 | 0.462 | 0.475 | 2.396 | 0.342 | 2.071 | SEVERE/HIGH/HIGH | 85/85/85 |
| 2026-06-09 | drawdown, range_rank_5 | 0.913 | 0.944 | 2.882 | 0.917 | 2.974 | SEVERE/SEVERE/HIGH | 180/195/210 |

## Threshold boundary evidence

Nearest observed values on each side; no rounding is used for classification. A measurement crossing does not necessarily change the market state because another measurement may already be worse. Index 1 means 09:45 ET.

| Candidate | Measurement | Boundary | Side | Date | Symbol | Index | Value |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | shockAtrRatio | ELEVATED | below | 2024-04-16 | RSP | 25 | 0.349998 |
| A | shockAtrRatio | ELEVATED | above | 2023-09-26 | RSP | 1 | 0.350019 |
| A | shockAtrRatio | HIGH | below | 2022-12-14 | SPY | 24 | 0.599618 |
| A | shockAtrRatio | HIGH | above | 2025-10-14 | SPY | 2 | 0.600242 |
| A | realizedMovement60AtrRatio | ELEVATED | below | 2021-11-23 | RSP | 12 | 0.399995 |
| A | realizedMovement60AtrRatio | ELEVATED | above | 2024-03-20 | RSP | 22 | 0.400085 |
| A | realizedMovement60AtrRatio | HIGH | below | 2022-12-14 | RSP | 24 | 0.699688 |
| A | realizedMovement60AtrRatio | HIGH | above | 2024-04-09 | SPY | 5 | 0.700646 |
| A | sessionDrawdownAtrRatio | ELEVATED | below | 2023-08-21 | RSP | 10 | 0.899953 |
| A | sessionDrawdownAtrRatio | ELEVATED | above | 2026-07-02 | SPY | 14 | 0.900029 |
| A | sessionDrawdownAtrRatio | HIGH | below | 2026-06-10 | RSP | 24 | 1.496761 |
| A | sessionDrawdownAtrRatio | HIGH | above | 2022-01-26 | RSP | 23 | 1.502121 |
| B | shockAtrRatio | ELEVATED | below | 2025-08-01 | SPY | 6 | 0.399933 |
| B | shockAtrRatio | ELEVATED | above | 2022-11-02 | RSP | 23 | 0.400088 |
| B | shockAtrRatio | HIGH | below | 2024-12-18 | SPY | 24 | 0.698482 |
| B | shockAtrRatio | HIGH | above | 2025-10-10 | SPY | 10 | 0.700147 |
| B | realizedMovement60AtrRatio | ELEVATED | below | 2022-01-28 | RSP | 7 | 0.449916 |
| B | realizedMovement60AtrRatio | ELEVATED | above | 2026-08-28 | SPY | 8 | 0.450004 |
| B | realizedMovement60AtrRatio | HIGH | below | 2025-02-03 | SPY | 4 | 0.798435 |
| B | realizedMovement60AtrRatio | HIGH | above | 2026-06-11 | SPY | 19 | 0.800125 |
| B | sessionDrawdownAtrRatio | ELEVATED | below | 2026-01-29 | SPY | 22 | 0.999908 |
| B | sessionDrawdownAtrRatio | ELEVATED | above | 2026-02-26 | SPY | 15 | 1.000172 |
| B | sessionDrawdownAtrRatio | HIGH | below | 2026-06-09 | SPY | 25 | 1.747716 |
| B | sessionDrawdownAtrRatio | HIGH | above | 2024-07-18 | RSP | 21 | 1.751190 |
| C | shockAtrRatio | ELEVATED | below | 2025-10-10 | SPY | 12 | 0.449944 |
| C | shockAtrRatio | ELEVATED | above | 2021-11-26 | SPY | 11 | 0.450011 |
| C | shockAtrRatio | HIGH | below | 2025-04-09 | SPY | 17 | 0.799307 |
| C | shockAtrRatio | HIGH | above | 2021-11-30 | RSP | 6 | 0.800161 |
| C | realizedMovement60AtrRatio | ELEVATED | below | 2026-01-29 | SPY | 8 | 0.499988 |
| C | realizedMovement60AtrRatio | ELEVATED | above | 2025-04-10 | SPY | 20 | 0.500226 |
| C | realizedMovement60AtrRatio | HIGH | below | 2026-09-16 | RSP | 23 | 0.897848 |
| C | realizedMovement60AtrRatio | HIGH | above | 2025-04-07 | SPY | 11 | 0.900482 |
| C | sessionDrawdownAtrRatio | ELEVATED | below | 2022-09-02 | RSP | 17 | 1.099971 |
| C | sessionDrawdownAtrRatio | ELEVATED | above | 2024-09-18 | RSP | 25 | 1.100081 |
| C | sessionDrawdownAtrRatio | HIGH | below | 2024-05-23 | RSP | 21 | 1.989627 |
| C | sessionDrawdownAtrRatio | HIGH | above | 2024-08-01 | RSP | 20 | 2.000346 |

## Closing-bar state sensitivity (diagnostic only)

| Candidate | Closing targets | NORMAL | ELEVATED | HIGH | SEVERE |
| --- | --- | --- | --- | --- | --- |
| A | 1241 | 78.646 | 16.197 | 4.110 | 1.048 |
| B | 1241 | 84.367 | 12.329 | 2.740 | 0.564 |
| C | 1241 | 88.074 | 10.073 | 1.531 | 0.322 |

<!-- INTRADAY_SEMANTIC_CLARIFICATION_START -->
## Final bounded semantic clarification

Original Candidate B is preserved above. This comparison changes only acute SEVERE to current-close downside, then adds the fixed 1% acute-close / 2.5% session-drawdown HIGH safeguards. No other ladder or recovery rule is recalibrated. All counts below are market targets (SPY/RSP max), not instrument-targets. All effective states use two confirmations and reset at each session.

| Version | States | NORMAL n / % | ELEVATED n / % | HIGH n / % | SEVERE n / % | SEVERE sessions |
| --- | --- | --- | --- | --- | --- | --- |
| originalB | raw | 27495 / 88.9662 | 3061 / 9.9045 | 315 / 1.0193 | 34 / 0.1100 | 10 |
| originalB | effective | 26322 / 85.1707 | 4086 / 13.2212 | 455 / 1.4723 | 42 / 0.1359 | 10 |
| currentClose | raw | 27495 / 88.9662 | 3061 / 9.9045 | 316 / 1.0225 | 33 / 0.1068 | 9 |
| currentClose | effective | 26322 / 85.1707 | 4087 / 13.2244 | 456 / 1.4755 | 40 / 0.1294 | 9 |
| absoluteHigh | raw | 27484 / 88.9306 | 2919 / 9.4451 | 469 / 1.5176 | 33 / 0.1068 | 9 |
| absoluteHigh | effective | 26303 / 85.1092 | 3944 / 12.7617 | 618 / 1.9997 | 40 / 0.1294 | 9 |

### Final behavior by period

Percentages use each row’s valid-target denominator. Year 2021 and 2026 are partial. ATR categories are mutually exclusive: quiet means both below 1%; high means either at least 2%; middle is the remainder. Opening is indices 1–4.

| Period | n | Upgraded targets | Affected sessions | Raw N/E/H/S % | Effective N/E/H/S % |
| --- | --- | --- | --- | --- | --- |
| year_2021 | 1488 | 0 | 0 | 89.7849 / 9.3414 / 0.8737 / 0.0000 | 86.8952 / 11.6935 / 1.4113 / 0.0000 |
| year_2022 | 6263 | 120 | 28 | 90.5796 / 6.6262 / 2.7463 / 0.0479 | 87.6577 / 8.8137 / 3.4648 / 0.0639 |
| year_2023 | 6226 | 1 | 1 | 91.4231 / 8.0148 / 0.5622 / 0.0000 | 88.1625 / 10.8416 / 0.9958 / 0.0000 |
| year_2024 | 6264 | 0 | 0 | 87.9789 / 10.8397 / 1.1654 / 0.0160 | 83.8442 / 14.5434 / 1.5964 / 0.0160 |
| year_2025 | 6214 | 32 | 6 | 86.8201 / 10.8626 / 1.8989 / 0.4184 | 82.5555 / 14.7087 / 2.2369 / 0.4989 |
| year_2026 | 4450 | 0 | 0 | 87.1236 / 11.5056 / 1.3034 / 0.0674 | 82.0000 / 16.1348 / 1.7753 / 0.0899 |
| opening_1_4 | 4964 | 5 | 5 | 82.2522 / 16.6398 / 1.0878 / 0.0201 | 73.4085 / 24.7583 / 1.8131 / 0.0201 |
| nonopening_5_plus | 25941 | 148 | 31 | 90.2086 / 8.0683 / 1.5998 / 0.1234 | 87.3482 / 10.4661 / 2.0354 / 0.1503 |
| quiet_both_ATR_lt_1pct | 7039 | 0 | 0 | 86.0776 / 12.3313 / 1.5343 / 0.0568 | 81.3468 / 16.5506 / 2.0457 / 0.0568 |
| high_either_ATR_ge_2pct | 3925 | 133 | 24 | 90.0637 / 4.9936 / 4.3057 / 0.6369 | 87.4904 / 6.5987 / 5.1210 / 0.7898 |
| middle_ATR | 19941 | 20 | 11 | 89.7147 / 9.3024 / 0.9628 / 0.0201 | 85.9686 / 12.6373 / 1.3690 / 0.0251 |

### SEVERE sessions and requested checks

| Date | Original raw / effective SEVERE | Current-close raw / effective SEVERE | Final raw / effective SEVERE | Original / revised / final maximum raw |
| --- | --- | --- | --- | --- |
| 2021-12-02 | 0 / 0 | 0 / 0 | 0 / 0 | HIGH / HIGH / HIGH |
| 2021-12-07 | 1 / 2 | 0 / 0 | 0 / 0 | SEVERE / HIGH / HIGH |
| 2022-05-20 | 1 / 2 | 1 / 2 | 1 / 2 | SEVERE / SEVERE / SEVERE |
| 2022-11-02 | 2 / 2 | 2 / 2 | 2 / 2 | SEVERE / SEVERE / SEVERE |
| 2024-12-18 | 1 / 1 | 1 / 1 | 1 / 1 | SEVERE / SEVERE / SEVERE |
| 2025-04-07 | 13 / 16 | 13 / 16 | 13 / 16 | SEVERE / SEVERE / SEVERE |
| 2025-04-08 | 8 / 9 | 8 / 9 | 8 / 9 | SEVERE / SEVERE / SEVERE |
| 2025-04-10 | 1 / 2 | 1 / 2 | 1 / 2 | SEVERE / SEVERE / SEVERE |
| 2025-10-10 | 3 / 3 | 3 / 3 | 3 / 3 | SEVERE / SEVERE / SEVERE |
| 2025-11-20 | 1 / 1 | 1 / 1 | 1 / 1 | SEVERE / SEVERE / SEVERE |
| 2026-06-09 | 3 / 4 | 3 / 4 | 3 / 4 | SEVERE / SEVERE / SEVERE |

### Fixed safeguards and original concern set

Safeguards upgrade **153 raw market targets across 35 sessions** compared with current-close SEVERE alone. Acute-only: 6; drawdown-only: 146; both: 1. “Both” can involve different authoritative instruments.

Of the original **164 targets / 41 sessions**, 153 targets reach HIGH, covering 35 sessions; 33 sessions have every original concern resolved. 11 targets in 8 sessions remain below HIGH. The report explains why recovered-low-only observations should not all be upgraded.

Every upgraded target is retained in [semantic-high-upgrades.csv](semantic-high-upgrades.csv), with both instruments’ current and intrabar evidence and all raw/effective comparisons. [semantic-clarification.json](semantic-clarification.json) retains the removed SEVERE target, every unresolved concern, and above-open safeguard examples. Percentage fields in these artifacts are decimal fractions.
