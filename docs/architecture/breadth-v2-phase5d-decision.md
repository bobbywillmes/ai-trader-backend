# BREADTH_V2 Phase 5D research decision

## Proposed specification

`BREADTH_V2_TERTILE_V1` is the frozen **proposed** production calculation contract in `src/services/breadth-v2.definition.ts`. This decision creates no publisher, production observation, Market Regime or Signal authority, strategy gate, OrderIntent, or trading effect. Phase 6 must design and review the immutable production evidence and publication boundary before any use.

| Item | Frozen decision |
| --- | --- |
| Family | TERTILE, using calibration-derived advance-share bands |
| Hysteresis | `MILD_POSITIVE_MIXED_CONFIRMATION` |
| States | POSITIVE, MIXED, NEGATIVE |
| Population | One explicitly frozen Breadth revision; equal weight, one Security/issue = one vote; `Security.enabled` is irrelevant |
| Input | Canonical Tiingo `DAY_1`, raw `UNADJUSTED`, positive split evidence |
| Split normalization | `RAW_CLOSE_CUMULATIVE_TIINGO_SPLIT_V1` |
| Gap policy | `STRICT`: exact real target/anchor and intervening split evidence; no synthetic bar, carry-forward, or implicit bridge |

The exact numeric bands are:

| Horizon | NEGATIVE at or below | POSITIVE at or above |
| --- | ---: | ---: |
| DAY_1 | `0.3775183266753999` | `0.6256031216081678` |
| DAY_5 | `0.4075077399380805` | `0.6133782078249895` |
| DAY_20 | `0.41043083900226757` | `0.6142910587355032` |

Values strictly between the bounds are MIXED. No rounded display value is used for classification. If any required horizon is unavailable, the raw assessment is unavailable. Five-day and 20-day agreement gives their state, including MIXED. Opposite directional 5d/20d states give MIXED. When exactly one structural horizon is directional and the other MIXED, DAY_1 must confirm that direction; otherwise raw is MIXED. DAY_1 cannot create direction by itself. The shared pure implementation calls the same structural and mild hysteresis helpers used for Phase 5B/5C research.

Mild hysteresis moves deterioration immediately by at most one level and requires two supporting valid assessments for one-level recovery. From effective POSITIVE, one raw MIXED holds POSITIVE; a second consecutive raw MIXED moves to MIXED. Raw NEGATIVE is never treated as mild and causes immediate one-level deterioration. Unavailable raw evidence pauses continuation. No smoothed assessment can directly jump POSITIVE ↔ NEGATIVE.

## Decision evidence and reasoning

The current-universe historical backcast used Breadth revision **2**, **2,877** members, 2021-01-04 through 2026-09-28. Calibration ended 2024-12-31; untouched validation began 2025-01-02 and ended 2026-09-28. Research contracts were `BREADTH_V2_RESEARCH_5A_V2`, `BREADTH_V2_CALIBRATION_5B_V1`, and `BREADTH_V2_VALIDATION_5C_V1`.

The reviewed Phase 5C artifact records canonical breadth input SHA-256 `620a26894ee2dd6348959842b5ab4904d0615c7c11281084ed88b42c6e6a4dc4` and frozen constituent SHA-256 `b0af80c6d0df43766bfb6c4a4ae1f47f0cee9290d5d88c9235c888b2ed0dc125`. These identify the reviewed research evidence; they do not restrict future production to revision 2.

QUARTILE is less sensitive and spends more time MIXED. NARROW is more sensitive and declares direction more readily. TERTILE occupies the middle sensitivity band. During the 435-session validation period, the three mild candidates spent 293, 222, and 173 sessions MIXED, respectively. Phase 5C found **zero** sessions with one family POSITIVE and another NEGATIVE; differences were principally sensitivity and timing.

TERTILE showed useful descriptive validation-period separation in regime-entry 20-session SPY price outcomes. The POSITIVE, MIXED, and NEGATIVE entry samples numbered 16, 39, and 22; their median forward price returns were approximately 1.67%, 1.89%, and −0.37%, and median maximum drawdowns were approximately −1.10%, −1.30%, and −2.42%. These small, overlapping samples support review of TERTILE as market-regime/risk evidence. They are not a trading rule, standalone return forecast, causal finding, or proof that TERTILE is universally superior.

## Research limitations

- The frozen current-universe backcast has survivorship bias; historical constituents were not reconstructed.
- Forward windows overlap, states persist, and observations are serially dependent. Regime-entry sampling reduces run-length weighting but does not make samples independent.
- SPY/RSP benchmarks are split-aware **price returns**, excluding dividends. They are not total returns or trading P&L.
- Unavailable benchmark windows were excluded from outcome summaries and reported with reasons. Benchmark provider provenance is recorded separately from Tiingo breadth evidence.
- Exact historical TREND_V1 and VOLATILITY_V1 effective-state replay was not integrated. No approximate context was substituted.
- Historical association does not establish that breadth causes later returns, drawdowns, Trend, or Volatility.

Phase 6 may consume this versioned definition to design production evidence and a publisher. It must decide the production minimum-coverage and failure contract separately; Phase 5D does not infer one from validation outcomes.
