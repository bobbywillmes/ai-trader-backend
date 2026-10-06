# BREADTH_V2 shadow assessment publication: Phase 6B

`BREADTH_V2_TERTILE_V1` assessments use the existing immutable `MarketRegimeDimensionAssessment` model with `dimension=BREADTH`. Their algorithm version, valid-attempt identity, and predecessor chain are separate from BREADTH_V1. They are authoritative evidence for V2 only; Market Regime composition and all trading consumers continue to use their existing authority.

## Phase 6C shadow automation

`BREADTH_V2_SHADOW_WORKER_ENABLED=false` is the default. Bobby should enable it only after the first real continuation assessment is accepted. The `breadth_v2_shadow_publication` worker runs once on startup and then hourly when enabled. Tiingo's existing worker remains the sole provider acquisition owner. The V2 worker reads stored evidence and calls the Phase 6A observation publisher first, followed by the Phase 6B assessment publisher. Each service retains its own timing, chronological catch-up bound, advisory lock, and immutable publication contract. An existing observation can still be followed by a new assessment; a blocked observation stops the assessment stage for that tick.

The existing worker-health status reports enabled state, liveness, and material failures. `GET /api/market-data/breadth-v2-shadow/status` adds the latest bounded stage counts, blocker codes, and `NOT_DUE`, `ALREADY_CURRENT`, `PROGRESSED`, `WAITING_FOR_EVIDENCE`, or `MATERIAL_FAILURE`. Temporary coverage gaps are waiting for evidence and do not fail worker health. Material calculation, identity, or chronology failures do. Repeated temporary gaps produce no orchestrator event; the publishing services retain their own bounded lifecycle events. Offline catch-up proceeds through their existing limits over successive hourly invocations. To roll back automation, set the switch to false and restart; manual observation and assessment endpoints remain available. This automation does not change Market Regime composition or trading authority.

## Input and timing

Each VALID assessment consumes one immutable `BREADTH_V2_MEASUREMENT_V1` observation set with exactly the 1, 5, and 20-session horizon children. Current classification reads their persisted `advanceShare` values and uses the frozen TERTILE bands, 5d/20d structural rule, and mild positive/mixed confirmation. It does not read current MarketBars again. The bounded evidence JSON records the set and horizon IDs/hashes, shares, states, structural path, transition counters, and predecessor.

`targetAt` is the target session's Tiingo 20:15 ET eligibility instant (`TIINGO_DAY_1_2015_ET_V1`). `validUntil` is the next expected reviewed market session's 20:15 ET instant. `dataThroughAt` retains the observation set's actual latest bar receipt time. A Tiingo response can arrive after 20:15, so migration `20260930120000_breadth_v2_delayed_evidence_assessment` allows this later timestamp **only** for `BREADTH_V2_TERTILE_V1` when it is no later than assessment completion. Other assessment timing constraints remain unchanged.

## First assessment: fixed-revision replay

`BREADTH_V2_BOOTSTRAP_V1` replays reviewed sessions from **2021-01-04** through the market session immediately before the chosen current target. It uses the **revision referenced by that target's production observation set** for the entire historical backcast (`TARGET_OBSERVATION_REVISION_FIXED_BACKCAST`). A revision need not have been effective in 2021. This deliberately matches the current-universe Phase 5 research and retains its survivorship-bias limitation.

The replay reads persisted Tiingo DAY_1 unadjusted bars in bounded Security batches and uses exact 1/5/20 session anchors, strict gaps, cumulative Tiingo split normalization, equal Security votes, and the frozen classifier. Historical coverage can be below the Phase 6A 99.5%/95% live publication gates. An unavailable historical raw state pauses both hysteresis counters. If the replay never establishes a valid state, publication fails closed. The replay writes no historical observation sets or assessments and stores only counts, a fingerprint, and pre-current continuation state in the current assessment. The first manual publication returns after that single current assessment; later calls perform bounded chronological catch-up.

Every later V2 assessment continues from the preceding VALID V2 assessment's persisted effective state and two bounded confirmation counters. A change in frozen Breadth revision changes future measurement populations but does not reset V2 hysteresis. The publisher stops at a missing or invalid next-session measurement and never skips ahead. Unresolved identical attempts are suppressed; after evidence is repaired by a new immutable measurement, the next attempt can become VALID. Manual catch-up is limited to 20 targets per call.

## Manual acceptance

1. Confirm the target's Phase 6A observation set with `GET /api/market-data/breadth-v2-observations/status` and the observation read endpoints.
2. Inspect `GET /api/market-data/breadth-v2-assessments/status`. Before the first assessment this read-only request runs the historical replay and previews the current classification, pre-current state, and projected transition. It can be expensive over the full historical population. It makes no provider calls or writes.
3. An owner may call `POST /api/market-data/breadth-v2-assessments/run` with `{}`. It respects timing, locks publication, and records immutable VALID, UNAVAILABLE, or FAILED attempts. It is not a force endpoint.
4. Inspect `/latest`, the paginated collection, or `/:id` under `/api/market-data/breadth-v2-assessments`. Confirm observation IDs/hashes, threshold states, replay fingerprint (bootstrap only), target/validity timestamps, and predecessor/counter continuity.

The system emits one bounded event for a bootstrap, effective transition, recovery, or material blocker. No event is emitted per Security or replayed historical session. Phase 6C may automate the accepted Tiingo → measurement → V2 assessment chain after manual evidence review; this phase does not grant Market Regime or trading authority.
