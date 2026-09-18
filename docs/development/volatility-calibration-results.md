# Volatility calibration: full locally available history

Recorded 2026-09-17 on `feat/external-signal-ingestion`. Candidate thresholds are unchanged. This is a behavior report, not a trading backtest.

Dataset SHA-256: `a25d1236bffd37e6cb07a9b5015992e9b20226d9d225b023d20c90055099b656`.

Each instrument has 1,255 immutable DAY_1 bars from **2021-09-16 through 2026-09-16**. Massive returned an empty split list for both SPY and RSP over this range. There are no missing expected sessions after applying the separately sourced research calendar. The 50 full-day exchange closures within coverage are excluded, not filled. The local production calendar has zero exceptions and was not changed.

**1,235 valid / 20 unavailable sessions**, all unavailability from initial warm-up. Valid classifications span 2021-10-14 through 2026-09-16. No earlier history, including the 2020 shock, is available locally.

| Period | Valid | Unavailable | LOW % | NORMAL % | HIGH % | EXTREME % | Transitions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2021 (partial) | 55 | 20 | 34.55 | 54.55 | 10.91 | 0.00 | 6 |
| 2022 | 251 | 0 | 0.00 | 17.13 | 67.73 | 15.14 | 17 |
| 2023 | 250 | 0 | 19.20 | 72.00 | 8.80 | 0.00 | 15 |
| 2024 | 252 | 0 | 50.00 | 45.63 | 4.37 | 0.00 | 16 |
| 2025 | 250 | 0 | 26.00 | 53.20 | 12.40 | 8.40 | 23 |
| 2026 (partial) | 177 | 0 | 35.59 | 59.89 | 4.52 | 0.00 | 14 |
| Overall | 1235 | 20 | 25.99 | 49.15 | 20.08 | 4.78 | 91 |

Percentages use valid effective-state days, without rounding before classification. Year boundaries do not reset calculations or hysteresis.

There are **91 effective transitions and 92 runs**. Median duration is **9 valid sessions**. **4 runs last one day**; **15 last two days or fewer** (including those four). Bootstrap is excluded from transitions; first/last runs are included and may be censored. Unavailable sessions pause run lengths.

## EXTREME periods

| First effective date | Last effective date | Valid sessions |
| --- | --- | ---: |
| 2022-05-05 | 2022-06-02 | 20 |
| 2022-06-13 | 2022-06-16 | 4 |
| 2022-06-21 | 2022-07-01 | 9 |
| 2022-10-14 | 2022-10-18 | 3 |
| 2022-11-10 | 2022-11-11 | 2 |
| 2025-04-04 | 2025-05-05 | 21 |

## Behavior and items for the final decision

- **2022 distinguishes itself:** HIGH/EXTREME occupies 82.87%, versus 8.80% in 2023 and 4.37% in 2024.
- **LOW/NORMAL dominates calmer comparison years:** 91.20% in 2023, 95.63% in 2024, and 95.48% in partial 2026. Overall LOW/NORMAL is 75.14%.
- **EXTREME is uncommon overall:** 59 sessions (4.78%), concentrated in six runs during 2022 and April–May 2025. It is not a once-per-crisis marker: late-2022 includes two short EXTREME runs. Whether that frequency matches the intended background dimension remains an owner decision; this report does not establish external event causality.
- **Escalation is immediate:** all 45 worsening effective transitions match raw on the same valid session. This history contains no multi-state raw jump from a lower effective state; NORMAL-to-EXTREME is proven by the synthetic regression test.
- **Recovery is delayed:** all 46 improving transitions move one state after two supporting assessments. Example: raw HIGH on 2025-05-05 leaves effective EXTREME (confirmation 1); 2025-05-06 becomes HIGH. Raw NORMAL on 2025-05-15 leaves effective HIGH; 2025-05-16 becomes NORMAL. The tests additionally cover raw LOW while effective EXTREME, requiring six valid supporting sessions to reach LOW.
- **Some boundary chatter remains:** four one-day effective recoveries immediately reverse on the next trading session. This follows the requested immediate-worsening rule; two-session recovery cannot guarantee a minimum effective run length. No thresholds or overrides were changed.

| One-day run | State | Next-session reversal | Measurement behind reversal |
| --- | --- | --- | --- |
| 2022-06-17 | HIGH | EXTREME on 2022-06-21 | SPY RV10 34.4830, RV20 30.9932, ATR14Pct 2.7019 |
| 2023-01-10 | NORMAL | HIGH on 2023-01-11 | RSP RV10 20.0129 plus ATR14Pct 1.6227 |
| 2024-03-04 | LOW | NORMAL on 2024-03-05 | SPY RV10 12.9475 and RV20 12.0061 |
| 2026-04-30 | LOW | NORMAL on 2026-05-01 | RSP RV20 12.1326 plus ATR14Pct 1.1280 |

The 2023 reversal is especially close to the RV10=20 boundary; the 2024 reversal is close to RV20=12. These are concrete threshold-sensitive examples to review, not reasons for automatic tuning. The remaining dataset limitation is the absence of pre-September-2021 history. ATR uses its exact initial 14-TR seed rather than an extra convergence burn-in.

## Every effective transition

Raw and effective-to happen to match on every transition in this dataset. The full JSON retains previous effective state, recovery target, confirmation before/after, reason and both instruments' measurements for every session, including the first supporting day that holds effective state.

| Date | From | Effective to | Raw |
| --- | --- | --- | --- |
| 2021-10-29 | NORMAL | LOW | LOW |
| 2021-11-26 | LOW | NORMAL | NORMAL |
| 2021-12-06 | NORMAL | HIGH | HIGH |
| 2021-12-09 | HIGH | NORMAL | NORMAL |
| 2021-12-20 | NORMAL | HIGH | HIGH |
| 2021-12-23 | HIGH | NORMAL | NORMAL |
| 2022-01-28 | NORMAL | HIGH | HIGH |
| 2022-04-07 | HIGH | NORMAL | NORMAL |
| 2022-04-22 | NORMAL | HIGH | HIGH |
| 2022-05-05 | HIGH | EXTREME | EXTREME |
| 2022-06-03 | EXTREME | HIGH | HIGH |
| 2022-06-13 | HIGH | EXTREME | EXTREME |
| 2022-06-17 | EXTREME | HIGH | HIGH |
| 2022-06-21 | HIGH | EXTREME | EXTREME |
| 2022-07-05 | EXTREME | HIGH | HIGH |
| 2022-08-03 | HIGH | NORMAL | NORMAL |
| 2022-08-22 | NORMAL | HIGH | HIGH |
| 2022-08-24 | HIGH | NORMAL | NORMAL |
| 2022-08-26 | NORMAL | HIGH | HIGH |
| 2022-10-14 | HIGH | EXTREME | EXTREME |
| 2022-10-19 | EXTREME | HIGH | HIGH |
| 2022-11-10 | HIGH | EXTREME | EXTREME |
| 2022-11-14 | EXTREME | HIGH | HIGH |
| 2023-01-03 | HIGH | NORMAL | NORMAL |
| 2023-01-06 | NORMAL | HIGH | HIGH |
| 2023-01-10 | HIGH | NORMAL | NORMAL |
| 2023-01-11 | NORMAL | HIGH | HIGH |
| 2023-01-13 | HIGH | NORMAL | NORMAL |
| 2023-03-14 | NORMAL | HIGH | HIGH |
| 2023-04-10 | HIGH | NORMAL | NORMAL |
| 2023-04-21 | NORMAL | LOW | LOW |
| 2023-04-25 | LOW | NORMAL | NORMAL |
| 2023-07-06 | NORMAL | LOW | LOW |
| 2023-08-24 | LOW | NORMAL | NORMAL |
| 2023-09-08 | NORMAL | LOW | LOW |
| 2023-09-21 | LOW | NORMAL | NORMAL |
| 2023-12-11 | NORMAL | LOW | LOW |
| 2023-12-13 | LOW | NORMAL | NORMAL |
| 2024-01-11 | NORMAL | LOW | LOW |
| 2024-02-05 | LOW | NORMAL | NORMAL |
| 2024-02-09 | NORMAL | LOW | LOW |
| 2024-02-13 | LOW | NORMAL | NORMAL |
| 2024-03-04 | NORMAL | LOW | LOW |
| 2024-03-05 | LOW | NORMAL | NORMAL |
| 2024-03-08 | NORMAL | LOW | LOW |
| 2024-04-10 | LOW | NORMAL | NORMAL |
| 2024-05-14 | NORMAL | LOW | LOW |
| 2024-07-18 | LOW | NORMAL | NORMAL |
| 2024-08-05 | NORMAL | HIGH | HIGH |
| 2024-08-20 | HIGH | NORMAL | NORMAL |
| 2024-10-02 | NORMAL | LOW | LOW |
| 2024-11-06 | LOW | NORMAL | NORMAL |
| 2024-11-25 | NORMAL | LOW | LOW |
| 2024-12-18 | LOW | NORMAL | NORMAL |
| 2025-02-14 | NORMAL | LOW | LOW |
| 2025-02-21 | LOW | NORMAL | NORMAL |
| 2025-02-25 | NORMAL | LOW | LOW |
| 2025-02-27 | LOW | NORMAL | NORMAL |
| 2025-03-10 | NORMAL | HIGH | HIGH |
| 2025-04-04 | HIGH | EXTREME | EXTREME |
| 2025-05-06 | EXTREME | HIGH | HIGH |
| 2025-05-16 | HIGH | NORMAL | NORMAL |
| 2025-05-21 | NORMAL | HIGH | HIGH |
| 2025-05-28 | HIGH | NORMAL | NORMAL |
| 2025-07-01 | NORMAL | LOW | LOW |
| 2025-07-15 | LOW | NORMAL | NORMAL |
| 2025-07-17 | NORMAL | LOW | LOW |
| 2025-07-22 | LOW | NORMAL | NORMAL |
| 2025-07-25 | NORMAL | LOW | LOW |
| 2025-08-01 | LOW | NORMAL | NORMAL |
| 2025-08-07 | NORMAL | LOW | LOW |
| 2025-08-12 | LOW | NORMAL | NORMAL |
| 2025-08-19 | NORMAL | LOW | LOW |
| 2025-08-22 | LOW | NORMAL | NORMAL |
| 2025-08-29 | NORMAL | LOW | LOW |
| 2025-10-10 | LOW | NORMAL | NORMAL |
| 2025-12-22 | NORMAL | LOW | LOW |
| 2026-01-21 | LOW | NORMAL | NORMAL |
| 2026-02-02 | NORMAL | LOW | LOW |
| 2026-02-06 | LOW | NORMAL | NORMAL |
| 2026-03-31 | NORMAL | HIGH | HIGH |
| 2026-04-13 | HIGH | NORMAL | NORMAL |
| 2026-04-30 | NORMAL | LOW | LOW |
| 2026-05-01 | LOW | NORMAL | NORMAL |
| 2026-05-07 | NORMAL | LOW | LOW |
| 2026-05-15 | LOW | NORMAL | NORMAL |
| 2026-05-21 | NORMAL | LOW | LOW |
| 2026-06-05 | LOW | NORMAL | NORMAL |
| 2026-07-20 | NORMAL | LOW | LOW |
| 2026-07-30 | LOW | NORMAL | NORMAL |
| 2026-08-17 | NORMAL | LOW | LOW |

See [implementation, formulas, calendar sources, CLI and validation](volatility-calibration.md). Complete local evidence was retained at `node_modules/.cache/volatility/volatility-report.local.json`; regenerate with the CLI if that ignored cache is removed. No authoritative assessment, schema, migration, frontend or trading behavior changed.
