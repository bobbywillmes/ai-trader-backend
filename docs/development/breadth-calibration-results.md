# Breadth calibration: full available history (2021-09-16 .. 2026-09-16)

Recorded 2026-09-17 on `feat/external-signal-ingestion`. Candidate thresholds (0.45/0.55)
are unchanged from the frozen research request. This is a behavior report for the owner's
BREADTH_V1 decision, not a trading backtest, and not an authoritative assessment.

Dataset SHA-256: `b5fe0261790936423b2af880f237d81eccb6200808590f363b03dccd23480992`.

**1,255 expected sessions. 1,252 valid daily observations; 3 unavailable** — all three from
the grouped-daily entitlement boundary (2021-09-16 and 2021-09-17 fail directly; 2021-09-20
then fails too because its own required *previous* session, 2021-09-17, is itself
unavailable — a correct fail-closed cascade, not a bug). Classifiable history (all three
horizons present) begins **2021-10-14** after the 20-session warm-up, spans through
**2026-09-16**, and covers **1,233 classified sessions**.

## Effective state distribution

| Period | Valid | POSITIVE % | MIXED % | NEGATIVE % | Mean adv. share | Median adv. share | Transitions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2021 (partial) | 53 | 3.77 | 52.83 | 43.40 | 0.4949 | 0.4640 | 12 |
| 2022 | 251 | 4.78 | 47.81 | 47.41 | 0.4782 | 0.4740 | 51 |
| 2023 | 250 | 12.00 | 54.40 | 33.60 | 0.4949 | 0.4878 | 66 |
| 2024 | 252 | 4.37 | 62.70 | 32.94 | 0.4899 | 0.4948 | 53 |
| 2025 | 250 | 5.60 | 62.00 | 32.40 | 0.4883 | 0.4745 | 50 |
| 2026 (partial) | 177 | 2.82 | 68.93 | 28.25 | 0.4911 | 0.5044 | 32 |
| Overall | 1233 | 6.00 | 58.31 | 35.69 | 0.4887 | 0.4872 | 264 |

**264 effective transitions, 265 runs.** Median run duration is **3 valid sessions** — far
shorter than Volatility's 9. **43 runs last one day (16.2%)**; **114 last two days or fewer
(43.0%)**. This is a substantially choppier effective-state signal than either authoritative
dimension has shown at calibration time.

## Universe quality

| Metric | Min | Median | Max |
| --- | ---: | ---: | ---: |
| Point-in-time CS universe count | 5,054 | 5,320 | 6,246 |
| Eligible directional count | 4,821 | 5,008.5 | 5,621 |
| Excluded count | 52 | 182 | 438 |

No single day-over-day universe swing exceeded the 10% heuristic flag; the ~19% min/max
spread across 5 years reads as gradual net listing growth, not a data artifact.

## Strongest daily sessions

| Direction | Date | advanceShare | netBreadth |
| --- | --- | ---: | ---: |
| Most positive | 2025-04-09 | 0.9097 | 0.8194 |
| Most positive | 2022-10-04 | 0.8765 | 0.7531 |
| Most negative | 2022-06-13 | 0.0661 | -0.8679 |
| Most negative | 2024-08-05 | 0.0902 | -0.8195 |

(Full top-10 both directions are in the generated report/evidence file.) 2025-04-09 and
2022-06-13 both correspond to widely reported broad market moves (respectively, a
sharp relief rally and a sharp broad selloff), which is a reasonable sanity check on the
raw daily measure independent of the banding/hysteresis choice.

## Horizon agreement

- All three horizons agree: **16.87%** of eligible sessions.
- Exactly two of three agree: **73.56%**.
- 1-day disagrees with both 5d and 20d (which agree with each other): **37.31%**.
- The remaining ~36% of "two agree" sessions are breadth5/breadth20 disagreeing with
  each other while breadth1 sides with one of them — i.e., the two *smoothed* horizons
  frequently cross the band boundaries at different times, not only the noisy 1-day reading.

## Answers to the sanity questions (section 14)

1. **Does 2022 show sustained NEGATIVE breadth?** Partially. 2022 has the lowest POSITIVE
   share of any year (4.78%) and the highest NEGATIVE share (47.41%), consistent with a
   genuine bear-market year, but NEGATIVE narrowly edges MIXED rather than dominating outright.
2. **Do the stronger 2023-2024 advances show sustained POSITIVE breadth?** **No — and this is
   the most notable finding.** POSITIVE breadth is *rarer* in 2023-2024 (12.00% / 4.37%) than
   the raw daily mean/median advance-share would suggest, while MIXED grows to 54-63%. This
   is consistent with the well-documented narrow, mega-cap-concentrated character of that
   rally (a small number of large names carrying index returns while the median stock lagged)
   — a genuinely useful signal if that is the intended purpose of BREADTH, but it means
   BREADTH will *not* read POSITIVE merely because major indices are rising.
3. **Does MIXED capture divided participation?** Yes, but it captures far more than that:
   MIXED is the dominant state in **every single year** (47.8% to 68.9%), and POSITIVE never
   exceeds 12% in any year. Whether that balance is what the owner intends for a "broadly
   participating" state is the central open question this report surfaces.
4. **Does 1-day react quickly without being excessively noisy overall?** breadth1 itself is
   reactive by design (unsmoothed, per the frozen definition) and disagrees with the other
   two 37.31% of the time, but the median-of-three rule prevents it from single-handedly
   flipping the raw state (see next point).
5. **Does median-of-three prevent single-session shocks from redefining structure?** Yes,
   mechanically — a lone breadth1 reading can never move the raw state by itself, confirmed
   both by unit test and by the "1-day disagrees with both, which agree with each other" case
   never overriding the shared 5d/20d state. However, breadth5 and breadth20 disagreeing with
   *each other* (roughly 36% of sessions) is sufficient on its own to move the raw state, and
   that happens often enough to produce the short run lengths above.
6. **Does immediate deterioration + confirmed recovery behave sensibly?** The mechanism itself
   is exactly as specified (unit-tested exhaustively). Combined with how often the raw state
   changes (see above), the *net effect* is choppier than Volatility's equivalent hysteresis
   over the same calendar span (43 one-day runs here vs. 4 for Volatility; median run 3 vs. 9).
7. **Are there obvious pathological 1-day flips?** Some effective-state sequences flip back and
   forth within a handful of sessions repeatedly (e.g., late 2021 through early 2022 shows
   MIXED/NEGATIVE alternating roughly weekly; see the full transition table in the generated
   report). This is a direct, mechanical consequence of points 5-6 above, not a separate defect.
8. **Are 45%/55% bands producing sensible separation?** With this classifier and hysteresis,
   the bands produce a strongly MIXED-skewed distribution with a rarely-reached POSITIVE state
   (6.00% overall, never above 12% in any year) and a NEGATIVE state that is nearly as common
   as MIXED in the worst year. This reads as "too much MIXED, too little POSITIVE" against the
   3-way-balanced framing in the request, though whether that is a flaw or an accurate reading
   of a persistently mega-cap-led, narrow-breadth market era is an owner judgment call, not
   something this report resolves.
9. **Are universe counts stable enough that changes are market-driven?** Yes — see Universe
   quality above; no discontinuity flagged, and the range is consistent with gradual real
   listing/delisting activity over five years, not a provider or pagination artifact.

## What this does *not* establish

This report does not correlate BREADTH with forward returns, does not backtest a trading
rule, and does not compare BREADTH against TREND_V1/VOLATILITY_V1 co-movement. Those are
explicit non-goals of this pass. The single clearest open question for the next decision is
whether the observed run-length/MIXED-dominance behavior is acceptable for a background
regime dimension, or whether it indicates the bands (not touched in this pass) need
reconsideration in a future calibration-only iteration.

## Provider feasibility recap

- Grouped daily bars entitlement begins **2021-09-20** (rolling ~5-year window from the
  request date); 2021-09-16/17 return `403 NOT_AUTHORIZED`. Individual-ticker aggregates
  (Trend/Volatility) are entitled four calendar days earlier.
- Point-in-time universe verified non-survivorship-biased directly against RIVN (absent
  2021-01-01, present 2024-01-01) and TWTR (present 2022-01-01, absent 2024-01-01).
- `adjusted=true` grouped bars verified against NVDA's real 2024-06-10 10-for-1 split.
- **1,245 grouped-daily requests + an estimated ~7,470 universe pages ≈ 8,715 total
  requests** for the full run; no rate limiting was observed on this plan.

See [implementation, formulas, calendar sources and CLI](breadth-calibration.md). Complete
per-session evidence was generated locally to a gitignored cache/output path and is not
committed; regenerate with `npm run research:breadth -- --from 2021-09-16 --to 2026-09-16 --fetch --output <file>`.
No authoritative assessment, schema, migration, frontend, or trading behavior changed.
