# BREADTH_V2 production measurement: Phase 6A

`BREADTH_V2_MEASUREMENT_V1` is manual, immutable measurement evidence. It is separate from the legacy single-prior-session `MarketBreadthObservation` used by BREADTH_V1. One `MarketBreadthObservationSet` contains atomic 1, 5, and 20 market-session `MarketBreadthHorizonObservation` children. It does not publish a Market Regime assessment and has no trading authority.

## Measurement contract

- Source: persisted canonical TIINGO `DAY_1` `UNADJUSTED` MarketBars only. No provider request or Massive fallback.
- Population: latest frozen BreadthUniverseRevision with `effectiveFrom <= target session`, held fixed across all three anchors. Each Security has one vote, regardless of `Security.enabled`.
- Anchors: exactly 1, 5, and 20 reviewed market sessions before the target. A reviewed early close counts; weekends and CLOSED sessions do not.
- Gap policy: STRICT. Target, exact anchor, and every intervening split factor must be real and valid. No synthetic bars, carry-forward, or bridging.
- Price comparison: `rawAnchorClose / product(splitFactor after anchor through target)` versus raw target close, using the Phase 5A Decimal primitive (`RAW_CLOSE_CUMULATIVE_TIINGO_SPLIT_V1`). Equal values are UNCHANGED.
- `directionalCount = advancing + declining`, `advanceShare = advancing / directionalCount`, `netBreadth = (advancing - declining) / directionalCount`. UNCHANGED is outside the directional denominator. `coverageRatio = eligibleCount / universeCount`.

## Readiness

`BREADTH_V2_EVIDENCE_READINESS_V1` requires target coverage of at least **0.995**, comparable coverage of at least **0.95** for each horizon, and a positive directional count for each horizon. These are evidence gates, separate from the frozen `BREADTH_V2_TERTILE_V1` classifier. A blocker writes no observation set. A later manual run can retry after more immutable Tiingo evidence arrives.

Publication cannot be due before the Tiingo DAY_1 20:15 ET boundary. The first run targets only the latest eligible session. Subsequent runs catch up in chronological order, at most five sessions per invocation, stopping at the first blocker. Historical Phase 5 research output is never imported into these production tables.

## Manual acceptance

1. Confirm Tiingo daily acquisition and inspect `GET /api/market-data/breadth-v2-observations/status`. This is read-only and shows the exact first target the manual run would consider, its revision, three anchors, coverage, counts, hashes, readiness, and blocker. Before today's 20:15 ET Tiingo boundary, the target is the latest eligible prior reviewed session. If catch-up is pending, status previews the oldest pending session.
2. If READY, an owner may call `POST /api/market-data/breadth-v2-observations/run` with `{}`. This is a normal timing and readiness-gated write, not a force action.
3. Inspect `GET /api/market-data/breadth-v2-observations/latest`, the paginated collection, or `/:id`. Repeating a run for identical immutable evidence is idempotent; an identity/hash conflict fails closed.

The parent and children carry bounded provenance and deterministic canonical input hashes. They contain aggregate evidence, not per-Security JSON. SQL rejects UPDATE and DELETE on both tables. A successful manual publication emits one INFO SystemEvent. This phase does not create BREADTH_V2 assessments or a scheduled worker; Phase 6B will address assessment publication after manual acceptance.
